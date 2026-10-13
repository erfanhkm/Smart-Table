// Guest-facing API: QR resolve, bill view, payment, waiter call.
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { orderRemaining, retrieveOrder, SquareOrder } from '../square.js';
import { payCheck, SplitMode } from '../services/payments.js';
import { badRequest } from '../http.js';

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

  // Bill detail for an order (used by staff app too).
  app.get('/api/checks/:orderId', async (req) => {
    const { orderId } = req.params as { orderId: string };
    const { order } = await retrieveOrder(orderId);
    const c = await query(`SELECT * FROM checks WHERE square_order_id = $1`, [orderId]);
    return { ...billView(order, c.rowCount ? c.rows[0] : { id: null, square_order_id: orderId }), square_state: order.state };
  });

  // Pay: full | equal | items | custom. See src/services/payments.ts.
  app.post('/api/checks/:orderId/pay', async (req) => {
    const { orderId } = req.params as { orderId: string };
    const body = (req.body ?? {}) as {
      mode?: SplitMode;
      amount_cents?: number;
      tip_cents?: number;
      card_nonce?: string;
      payer_label?: string;
    };
    if (!body.mode || !['full', 'equal', 'items', 'custom'].includes(body.mode)) {
      throw badRequest('mode must be one of: full | equal | items | custom');
    }
    return payCheck({
      orderId,
      mode: body.mode,
      amountCents: body.amount_cents,
      tipCents: body.tip_cents,
      cardNonce: body.card_nonce,
      payerLabel: body.payer_label,
    });
  });

  // Guest calls the waiter from the web app (physical button comes with hardware).
  app.post('/api/tables/:id/call-waiter', async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'call_waiter')`, [randomUUID(), tableId]);
    return { ok: true };
  });
}
