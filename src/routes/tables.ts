// Staff API: table CRUD, QR codes, check linking, waiter calls.
// Every route here is staff-only (bearer STAFF_API_TOKEN, see src/auth.ts).
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound } from '../http.js';
import { getTables } from '../services/floor.js';
import { staffOnly } from '../auth.js';
import { assertSquareId, retrieveOrder, SquareError } from '../square.js';

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

  // Link a Square order (created in the POS) to this table.
  // The order is fetched from Square: it must exist, be OPEN and belong to the SAME Square location as
  // the table. Total and currency come from Square, never from the client.
  app.post('/api/tables/:id/link-check', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { square_order_id?: unknown };
    const orderId = assertSquareId(body.square_order_id, 'square_order_id'); // 400 before any DB/Square call

    const t = await query(
      `SELECT t.id, t.location_id, l.square_location_id, l.merchant_id
       FROM tables t JOIN locations l ON l.id = t.location_id
       WHERE t.id = $1`,
      [tableId],
    );
    if (t.rowCount === 0) throw notFound('table not found');
    const table = t.rows[0];

    let order;
    try {
      ({ order } = await retrieveOrder(orderId));
    } catch (e) {
      if (e instanceof SquareError && e.status === 404) throw notFound('order not found in Square');
      throw e;
    }
    if (!order || order.location_id !== table.square_location_id) {
      throw forbidden('order does not belong to this table\'s Square location');
    }
    if (order.state !== 'OPEN') throw badRequest('order is not open');

    const totalCents: number = order.total_money?.amount ?? 0;
    const currency: string = order.total_money?.currency ?? 'CAD';

    await query(
      `INSERT INTO checks(id, table_id, square_order_id, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,$4,'OPEN',$5,$6)
       ON CONFLICT (square_order_id) DO UPDATE SET
         table_id = EXCLUDED.table_id, merchant_id = EXCLUDED.merchant_id, state = 'OPEN'`,
      [randomUUID(), tableId, orderId, table.merchant_id, totalCents, currency],
    );
    await query(`UPDATE tables SET state = 'SEATED' WHERE id = $1`, [tableId]);
    await query(
      `INSERT INTO events(id, table_id, check_id, type)
       VALUES ($1,$2,(SELECT id FROM checks WHERE square_order_id = $3),'seated')`,
      [randomUUID(), tableId, orderId],
    );
    return { ok: true };
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
