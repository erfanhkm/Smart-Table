// Staff API: table CRUD, QR codes, check linking, waiter calls.
// Every route here is staff-only (bearer STAFF_API_TOKEN, see src/auth.ts).
//
// v0.3 multi-POS: link-check resolves the location's adapter from its
// pos_type. Accepts `external_check_id` (generic) or the legacy
// `square_order_id` (Square locations only, portal compat).
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { query, withAdvisoryLock } from '../db.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';
import { getTables } from '../services/floor.js';
import { logAudit } from '../services/audit.js';
import { getLocationPos } from '../services/pos/context.js';
import { assertNotDemoLocation } from '../services/demo-guard.js';
import { PosCheckDetail } from '../services/pos/types.js';
import { retrieveOrder, SquareError } from '../square.js';
import { assertPortalLocation, requirePortalRole, scopedLocationId, staffOnly } from '../auth.js';

/** Load a table and pin it to the calling portal user's location (v0.6.5, C-2). */
async function loadTableScoped(req: FastifyRequest, tableId: string): Promise<{ id: string; location_id: string }> {
  const t = await query<{ id: string; location_id: string }>(
    `SELECT id, location_id FROM tables WHERE id = $1`,
    [tableId],
  );
  // F6-8: one message for missing and foreign tables alike — no oracle.
  if (t.rowCount === 0) throw notFound('not found');
  assertPortalLocation(req, t.rows[0].location_id);
  return t.rows[0];
}

export async function tableRoutes(app: FastifyInstance) {
  app.get('/api/tables', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const scopedId = scopedLocationId(req, location_id);
    return { tables: await getTables(scopedId) };
  });

  app.post('/api/tables', staffOnly, async (req) => {
    const { location_id, name } = (req.body ?? {}) as { location_id?: unknown; name?: unknown };
    // Portal users create tables only in their own location, owner/manager only (C-2/C-10).
    requirePortalRole(req, 'owner', 'manager');
    const scopedId = scopedLocationId(req, typeof location_id === 'string' ? location_id : undefined);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
      throw badRequest('name is required (1-64 characters)');
    }
    const loc = await query(`SELECT id FROM locations WHERE id = $1`, [scopedId]);
    if (loc.rowCount === 0) throw badRequest('unknown location_id');
    // C-15: cumulative per-location ceiling (per-call caps alone let a
    // location grow tables without bound). 200 is far above any real
    // dining room. F6-13: the count + insert run under the location's
    // advisory lock so concurrent creates can't overshoot the cap.
    const created = await withAdvisoryLock(
      `tables:${scopedId}`,
      async () => {
        const cnt = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tables WHERE location_id = $1`, [scopedId]);
        if ((cnt.rows[0]?.n ?? 0) >= 200) throw badRequest('table limit reached for this location (200)');
        const id = randomUUID();
        const qrToken = randomUUID().replace(/-/g, '');
        await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')`, [
          id,
          scopedId,
          name.trim(),
          qrToken,
        ]);
        return { id, qrToken };
      },
      { runIfUnsupported: true },
    );
    if (!created) throw conflict('another table change is in progress; please retry', 'table_create_busy');
    return { id: created.id, name: name.trim(), qr_token: created.qrToken, qr_url: `${config.appUrl}/t/${created.qrToken}` };
  });

  // Printable QR PNG for the table tent card (staff-only: the QR token is the table's guest credential).
  app.get('/api/tables/:id/qr', staffOnly, async (req, reply) => {
    const tableId = (req.params as { id: string }).id;
    // F6-13: the PNG IS the guest credential — owner/manager only. (The
    // platform-wide /api no-store hook covers its cache header.)
    requirePortalRole(req, 'owner', 'manager');
    await loadTableScoped(req, tableId);
    const t = await query(`SELECT qr_token FROM tables WHERE id = $1`, [tableId]);
    if (t.rowCount === 0) throw notFound('not found');
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
    if (t.rowCount === 0) throw notFound('not found');
    const table = t.rows[0];
    assertPortalLocation(req, table.location_id);
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

    // v0.6.5 (C-4): check identity is (location_id, pos_type, ref) and the
    // insert is DO NOTHING. The old DO UPDATE re-pointed another tenant's
    // check to this table and re-opened it — the exact thing the ordering
    // route's M1 fix forbids. A conflict here means: same location already
    // has this ref — another table or a completed check is a hard 409; the
    // same table re-linking is idempotent and just refreshes totals.
    const newCheckId = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,$9)
       ON CONFLICT (location_id, pos_type, external_check_ref) DO NOTHING`,
      [
        newCheckId,
        tableId,
        table.location_id,
        ctx.posType === 'square' ? checkRef : null,
        checkRef,
        ctx.posType,
        table.merchant_id,
        detail.totalCents,
        detail.currency,
      ],
    );
    // Was it created? Compare ids — never trust RETURNING/rowCount with
    // ON CONFLICT DO NOTHING (pg-mem returns the pre-existing row).
    const ex = await query<{ id: string; table_id: string | null; state: string }>(
      `SELECT id, table_id, state FROM checks WHERE location_id = $1 AND pos_type = $2 AND external_check_ref = $3`,
      [table.location_id, ctx.posType, checkRef],
    );
    const existing = ex.rows[0];
    if (!existing) throw conflict('check could not be linked', 'check_link_conflict');
    let checkId: string;
    if (existing.id === newCheckId) {
      checkId = newCheckId;
    } else {
      if (existing.table_id !== tableId) {
        throw conflict('check is already linked to another table', 'check_linked_elsewhere');
      }
      if (existing.state === 'COMPLETED') throw conflict('check is already completed', 'check_completed');
      await query(`UPDATE checks SET total_cents = $1, currency = $2 WHERE id = $3`, [
        detail.totalCents,
        detail.currency,
        existing.id,
      ]);
      checkId = existing.id;
    }
    await query(`UPDATE tables SET state = 'SEATED' WHERE id = $1`, [tableId]);
    await query(`INSERT INTO events(id, table_id, check_id, type) VALUES ($1,$2,$3,'seated')`, [
      randomUUID(),
      tableId,
      checkId,
    ]);
    return { ok: true };
  });

  // Rotate the table's QR token (staff-only). Invalidates the old QR immediately:
  // use when a tent card is lost/stolen, or rotate periodically. Returns the
  // new token + URL; reprint via GET /api/tables/:id/qr.
  app.post('/api/tables/:id/rotate-qr', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    requirePortalRole(req, 'owner', 'manager');
    const tbl = await loadTableScoped(req, tableId);
    // v0.8.12 (F9-3): rotating a demo location's QR would kill the
    // token the marketing site publishes — refused for demo locations.
    await assertNotDemoLocation(tbl.location_id, 'QR rotation');
    const qrToken = randomUUID().replace(/-/g, '');
    await query(`UPDATE tables SET qr_token = $1 WHERE id = $2`, [qrToken, tableId]);
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'qr_rotated')`, [randomUUID(), tableId]);
    await logAudit({
      actorType: req.portalUser ? 'portal_user' : 'staff_token',
      actorId: req.portalUser?.id ?? null,
      role: req.portalUser?.role ?? null,
      ip: req.ip,
      action: 'qr_rotated',
      target: tableId,
    });
    return { qr_token: qrToken, qr_url: `${config.appUrl}/t/${qrToken}` };
  });

  // Reset the table for the next party.
  // F6-3: freeing used to leave OPEN checks (and their group-pay claims)
  // attached to the table — the next party could be shown, and pay, the
  // previous party's bill. Now: an OPEN check blocks the free with a 409
  // unless the caller explicitly forces it; a forced free drops the open
  // checks' item claims so a stale claim can never be paid against.
  app.post('/api/tables/:id/free', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    requirePortalRole(req, 'owner', 'manager');
    const tbl = await loadTableScoped(req, tableId);
    const force = (req.body as { force?: unknown } | null)?.force === true;
    const open = await query<{ id: string }>(`SELECT id FROM checks WHERE table_id = $1 AND state = 'OPEN'`, [tableId]);
    if (open.rowCount > 0 && !force) {
      throw conflict(
        'this table still has an open check — settle it first, or free the table with force: true',
        'open_check_exists',
      );
    }
    if (open.rowCount > 0) {
      const ids = open.rows.map((r) => r.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      await query(`DELETE FROM item_claims WHERE check_id IN (${placeholders})`, ids);
    }
    await query(`UPDATE tables SET state = 'FREE' WHERE id = $1`, [tableId]);
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'freed')`, [randomUUID(), tableId]);
    await logAudit({
      actorType: req.portalUser ? 'portal_user' : 'staff_token',
      actorId: req.portalUser?.id ?? null,
      role: req.portalUser?.role ?? null,
      ip: req.ip,
      action: 'table_freed',
      locationId: tbl.location_id,
      target: tableId,
      detail: open.rowCount > 0 ? `forced with ${open.rowCount} open check(s); claims cleared` : null,
    });
    return { ok: true };
  });

  // Acknowledge a waiter call (used for the response-time metric).
  // F6-13: only record an ack when a call is actually open (latest
  // call_waiter newer than the latest ack) — phantom acks skewed the
  // response-time metric and hid unanswered calls.
  app.post('/api/tables/:id/ack-call', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    await loadTableScoped(req, tableId);
    const last = await query<{ type: string }>(
      `SELECT type FROM events WHERE table_id = $1 AND type IN ('call_waiter','waiter_ack')
       ORDER BY created_at DESC LIMIT 1`,
      [tableId],
    );
    if (last.rowCount === 0 || last.rows[0].type !== 'call_waiter') {
      return { ok: true, no_open_call: true };
    }
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'waiter_ack')`, [randomUUID(), tableId]);
    return { ok: true };
  });
}
