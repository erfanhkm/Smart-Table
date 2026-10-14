// Staff helpers: locations, live open orders from Square (for linking checks), and
// recording cash / outside-rail payments. All routes are staff-only.
import { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { assertSquareId, searchOpenOrders } from '../square.js';
import { parsePaymentBody, payCheck } from '../services/payments.js';
import { staffOnly } from '../auth.js';

export async function staffRoutes(app: FastifyInstance) {
  app.get('/api/locations', staffOnly, async (req) => {
    // Portal users only ever see their own location: without this, a second
    // restaurant's owner could operate on the first location in the list.
    const u = req.portalUser;
    if (u) {
      const r = await query(`SELECT id, square_location_id, name, currency FROM locations WHERE id = $1`, [
        u.location_id,
      ]);
      return { locations: r.rows };
    }
    const r = await query(`SELECT id, square_location_id, name, currency FROM locations ORDER BY name`);
    return { locations: r.rows };
  });

  // location_id = OUR location id (as returned by /api/locations); it is resolved to the Square location here.
  app.get('/api/square-open-orders', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    if (!location_id) throw badRequest('location_id is required');
    const loc = await query<{ square_location_id: string }>(
      `SELECT square_location_id FROM locations WHERE id = $1`,
      [location_id],
    );
    if (loc.rowCount === 0) throw notFound('unknown location_id');
    const { orders } = await searchOpenOrders(assertSquareId(loc.rows[0].square_location_id, 'square_location_id'));
    return {
      orders: (orders ?? []).map((o) => ({
        id: o.id,
        total_money: o.total_money,
        state: o.state,
        created_at: o.created_at,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: (o.line_items ?? []).map((li: any) => `${li.quantity}x ${li.name}`).join(', '),
      })),
    };
  });

  // Staff records a payment that happened outside Square (cash, ...). Square gets it as an EXTERNAL payment.
  // Same body as the guest endpoint minus card_nonce (idempotency_key is required here too).
  app.post('/api/checks/:orderId/record-external-payment', staffOnly, async (req) => {
    const orderId = assertSquareId((req.params as { orderId: string }).orderId, 'orderId');
    const p = parsePaymentBody(req.body);
    return payCheck({ orderId, ...p, source: { kind: 'external', label: 'Smart Table staff' } });
  });
}
