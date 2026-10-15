// Staff API: table CRUD, QR codes, check linking, waiter calls.
// Every route here is staff-only (bearer STAFF_API_TOKEN, see src/auth.ts).
//
// v0.3 multi-POS: link-check resolves the location's adapter from its
// pos_type. Accepts `external_check_id` (generic) or the legacy
// `square_order_id` (Square locations only, portal compat).
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound } from '../http.js';
import { getTables } from '../services/floor.js';
import { getLocationPos } from '../services/pos/context.js';
import { PosCheckDetail } from '../services/pos/types.js';
import { retrieveOrder, SquareError } from '../square.js';
import { staffOnly } from '../auth.js';

export async function tableRoutes(app: FastifyInstance) {
  app.get('/api/tables', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    if (!location_id) throw badRequest('location_id is required');
    return { tables: await getTables(location_id) };
  });

  app.post('/api/tables', staffOnly, async (req) => {
    const { location_id, name } = (req.body ?? {}) as { location_id?: unknown; name?: unknown };
    if (typeof location_id !== 'string' || !location_id) throw badRequest('location_id and name are required');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
      throw badRequest('name is required (1-64 characters)');
    }
    const loc = await query(`SELECT id FROM locations WHERE id = $1`, [location_id]);
    if (loc.rowCount === 0) throw badRequest('unknown location_id');
    const id = randomUUID();
    const qrToken = randomUUID().replace(/-/g, '');
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')`, [
      id,
      location_id,
      name.trim(),
      qrToken,
    ]);
    return { id, name: name.trim(), qr_token: qrToken, qr_url: `${config.appUrl}/t/${qrToken}` };
  });

  // Printable QR PNG for the table tent card (staff-only: the QR token is the table's guest credential).
  app.get('/api/tables/:id/qr', staffOnly, async (req, reply) => {
    const t = await query(`SELECT qr_token FROM tables WHERE id = $1`, [(req.params as { id: string }).id]);
    if (t.rowCount === 0) throw notFound('table not found');
    const png = await QRCode.toBuffer(`${config.appUrl}/t/${t.rows[0].qr_token}`, { width: 512, margin: 2 });
    return reply.type('image/png').send(png);
  });

  // Link a POS check (created in the POS) to this table.
  // The check is fetched from the location's POS: it must exist, be OPEN and
  // belong to the SAME POS location as the table. Total and currency come
  // from the POS, never from the client.
  app.post('/api/tables/:id/link-check', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { external_check_id?: unknown; square_order_id?: unknown };
    const rawRef = body.external_check_id ?? body.square_order_id;
    if (typeof rawRef !== 'string' || !rawRef.trim() || rawRef.length > 255) {
      throw badRequest('external_check_id is required');
    }
    const checkRef = rawRef.trim();

    const t = await query(
      `SELECT t.id, t.location_id, l.merchant_id
       FROM tables t JOIN locations l ON l.id = t.location_id
       WHERE t.id = $1`,
      [tableId],
    );
    if (t.rowCount === 0) throw notFound('table not found');
    const table = t.rows[0];
    const ctx = await getLocationPos(table.location_id);

    // Legacy portal compat: square_order_id is only honored on Square locations.
    if (body.square_order_id !== undefined && body.external_check_id === undefined && ctx.posType !== 'square') {
      throw badRequest('square_order_id is only valid for Square locations; send external_check_id');
    }

    let detail: PosCheckDetail;
    if (ctx.posType === 'square') {
      // Verified path: raw Square order carries the location id for the
      // same-location check.
      let order;
      try {
        ({ order } = await retrieveOrder(checkRef, ctx.token));
      } catch (e) {
        if (e instanceof SquareError && e.status === 404) throw notFound('order not found in Square');
        throw e;
      }
      if (!order || order.location_id !== ctx.locationRef) {
        throw forbidden("order does not belong to this table's Square location");
      }
      const { squareAdapter } = await import('../services/pos/square.js');
      detail = await squareAdapter.getCheckDetail(checkRef, ctx.token);
    } else {
      try {
        detail = await ctx.adapter.getCheckDetail(checkRef, ctx.token);
      } catch (e) {
        const status = (e as { status?: unknown })?.status;
        if (status === 404) throw notFound('check not found in the POS');
        throw e;
      }
      // Portable same-location check: the check must be among the open
      // checks of this location.
      const open = await ctx.adapter.listOpenChecks(ctx.locationRef, ctx.token);
      if (!open.some((o) => o.id === detail.id)) {
        throw forbidden("check does not belong to this table's POS location");
      }
    }
    if (detail.state !== 'OPEN') throw badRequest('check is not open');

    await query(
      `INSERT INTO checks(id, table_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8)
       ON CONFLICT (pos_type, external_check_ref) DO UPDATE SET
         table_id = EXCLUDED.table_id, merchant_id = EXCLUDED.merchant_id, state = 'OPEN',
         total_cents = EXCLUDED.total_cents, currency = EXCLUDED.currency`,
      [
        randomUUID(),
        tableId,
        ctx.posType === 'square' ? checkRef : null,
        checkRef,
        ctx.posType,
        table.merchant_id,
        detail.totalCents,
        detail.currency,
      ],
    );
    await query(`UPDATE tables SET state = 'SEATED' WHERE id = $1`, [tableId]);
    await query(
      `INSERT INTO events(id, table_id, check_id, type)
       VALUES ($1,$2,(SELECT id FROM checks WHERE pos_type = $3 AND external_check_ref = $4),'seated')`,
      [randomUUID(), tableId, ctx.posType, checkRef],
    );
    return { ok: true };
  });

  // Rotate the table's QR token (staff-only). Invalidates the old QR immediately:
  // use when a tent card is lost/stolen, or rotate periodically. Returns the
  // new token + URL; reprint via GET /api/tables/:id/qr.
  app.post('/api/tables/:id/rotate-qr', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    const t = await query(`SELECT id FROM tables WHERE id = $1`, [tableId]);
    if (t.rowCount === 0) throw notFound('table not found');
    const qrToken = randomUUID().replace(/-/g, '');
    await query(`UPDATE tables SET qr_token = $1 WHERE id = $2`, [qrToken, tableId]);
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'qr_rotated')`, [randomUUID(), tableId]);
    return { qr_token: qrToken, qr_url: `${config.appUrl}/t/${qrToken}` };
  });

  // Reset the table for the next party.
  app.post('/api/tables/:id/free', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`UPDATE tables SET state = 'FREE' WHERE id = $1`, [tableId]);
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'freed')`, [randomUUID(), tableId]);
    return { ok: true };
  });

  // Acknowledge a waiter call (used for the response-time metric).
  app.post('/api/tables/:id/ack-call', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'waiter_ack')`, [randomUUID(), tableId]);
    return { ok: true };
  });
}
