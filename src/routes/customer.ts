// Guest-facing API: QR resolve, bill view, payment, waiter call. All public (no staff auth).
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { assertSquareId, orderRemaining, retrieveOrder, SquareOrder } from '../square.js';
import { CARD_NONCE_RE, parsePaymentBody, payCheck } from '../services/payments.js';
import { badRequest, notFound } from '../http.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function billView(order: SquareOrder, row: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (order.line_items ?? []).map((li: any) => ({
    name: li.name,
    quantity: li.quantity,
    amount_cents: li.total_money?.amount ?? 0,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenders = (order.tenders ?? []).map((t: any) => ({
    amount_cents: t.amount_money?.amount ?? 0,
    tip_cents: t.tip_money?.amount ?? 0,
    type: t.type,
  }));
  return {
    id: row.id,
    square_order_id: row.square_order_id,
    state: row.state,
    total_cents: order.total_money?.amount ?? row.total_cents,
    currency: order.total_money?.currency ?? row.currency,
    remaining_cents: orderRemaining(order),
    items,
    tenders,
  };
}

export async function customerRoutes(app: FastifyInstance) {
  // Resolve a scanned QR token -> table + live bill of its open check.
  app.get('/api/t/:token', async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.*, l.square_location_id, l.currency FROM tables t
       JOIN locations l ON l.id = t.location_id
       WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table — ask staff for help');
    const table = t.rows[0];
    const c = await query(
      `SELECT * FROM checks WHERE table_id = $1 AND state = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
      [table.id],
    );
    let check = null;
    if (c.rowCount > 0) {
      const { order } = await retrieveOrder(c.rows[0].square_order_id);
      check = billView(order, c.rows[0]);
    }
    return { table: { id: table.id, name: table.name, state: table.state }, check };
  });

  // Bill detail for a check that has been linked to a table (arbitrary Square orders are not readable here).
  app.get('/api/checks/:orderId', async (req) => {
    const orderId = assertSquareId((req.params as { orderId: string }).orderId, 'orderId');
    const c = await query(`SELECT * FROM checks WHERE square_order_id = $1`, [orderId]);
    if (c.rowCount === 0) throw notFound('check not found');
    const { order } = await retrieveOrder(orderId);
    return { ...billView(order, c.rows[0]), square_state: order.state };
  });

  // Pay by card: full | equal | items | custom. See src/services/payments.ts.
  // card_nonce (Square Web Payments SDK token) and idempotency_key (client UUID v4) are REQUIRED.
  // There is deliberately no guest-reachable "external / no card" path: cash is recorded by staff
  // through POST /api/checks/:orderId/record-external-payment.
  app.post('/api/checks/:orderId/pay', async (req) => {
    const orderId = assertSquareId((req.params as { orderId: string }).orderId, 'orderId');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nonce = body.card_nonce;
    if (typeof nonce !== 'string' || !CARD_NONCE_RE.test(nonce)) {
      throw badRequest('card_nonce is required (token from the Square Web Payments SDK)');
    }
    const p = parsePaymentBody(body);
    return payCheck({ orderId, ...p, source: { kind: 'card', nonce } });
  });

  // Guest calls the waiter from the web app (physical button comes with hardware).
  app.post('/api/tables/:id/call-waiter', async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'call_waiter')`, [randomUUID(), tableId]);
    return { ok: true };
  });
}
