// Staff API: table CRUD, QR codes, check linking, waiter calls.
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { config } from '../config.js';
import { badRequest } from '../http.js';
import { getTables } from '../services/floor.js';

export async function tableRoutes(app: FastifyInstance) {
  app.get('/api/tables', async (req) => {
    const { location_id } = req.query as { location_id?: string };
    return { tables: await getTables(location_id) };
  });

  app.post('/api/tables', async (req) => {
    const { location_id, name } = (req.body ?? {}) as { location_id?: string; name?: string };
    if (!location_id || !name) throw badRequest('location_id and name are required');
    const id = randomUUID();
    const qrToken = randomUUID().replace(/-/g, '');
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')`, [
      id,
      location_id,
      name,
      qrToken,
    ]);
    return { id, name, qr_token: qrToken, qr_url: `${config.appUrl}/t/${qrToken}` };
  });

  // Printable QR PNG for the table tent card.
  app.get('/api/tables/:id/qr', async (req, reply) => {
    const t = await query(`SELECT qr_token FROM tables WHERE id = $1`, [(req.params as { id: string }).id]);
    if (t.rowCount === 0) throw badRequest('table not found');
    const png = await QRCode.toBuffer(`${config.appUrl}/t/${t.rows[0].qr_token}`, { width: 512, margin: 2 });
    return reply.type('image/png').send(png);
  });

  // Link a Square order (created in the POS) to this table.
  app.post('/api/tables/:id/link-check', async (req) => {
    const tableId = (req.params as { id: string }).id;
    const { square_order_id, total_cents, currency } = (req.body ?? {}) as {
      square_order_id?: string;
      total_cents?: number;
      currency?: string;
    };
    if (!square_order_id) throw badRequest('square_order_id is required');
    const t = await query(`SELECT id FROM tables WHERE id = $1`, [tableId]);
    if (t.rowCount === 0) throw badRequest('table not found');
    await query(
      `INSERT INTO checks(id, table_id, square_order_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'OPEN',$4,$5)
       ON CONFLICT (square_order_id) DO UPDATE SET table_id = EXCLUDED.table_id, state = 'OPEN'`,
      [randomUUID(), tableId, square_order_id, total_cents ?? 0, currency ?? 'CAD'],
    );
    await query(`UPDATE tables SET state = 'SEATED' WHERE id = $1`, [tableId]);
    await query(
      `INSERT INTO events(id, table_id, check_id, type)
       VALUES ($1,$2,(SELECT id FROM checks WHERE square_order_id = $3),'seated')`,
      [randomUUID(), tableId, square_order_id],
    );
    return { ok: true };
  });

  // Reset the table for the next party.
  app.post('/api/tables/:id/free', async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`UPDATE tables SET state = 'FREE' WHERE id = $1`, [tableId]);
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'freed')`, [randomUUID(), tableId]);
    return { ok: true };
  });

  // Acknowledge a waiter call (used for the response-time metric).
  app.post('/api/tables/:id/ack-call', async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'waiter_ack')`, [randomUUID(), tableId]);
    return { ok: true };
  });
}
