// Staff helpers: locations and live open orders from Square (for linking checks).
import { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { config } from '../config.js';
import { searchOpenOrders } from '../square.js';

export async function staffRoutes(app: FastifyInstance) {
  app.get('/api/locations', async () => {
    const r = await query(`SELECT id, square_location_id, name, currency FROM locations ORDER BY name`);
    return { locations: r.rows };
  });

  app.get('/api/square-open-orders', async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const locId = location_id ?? config.squareLocationId;
    if (!locId) return { orders: [], note: 'SQUARE_LOCATION_ID not set' };
    const { orders } = await searchOpenOrders(locId);
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
}
