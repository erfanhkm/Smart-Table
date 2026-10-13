// Square webhooks: order.updated / payment.updated drive the table state
// machine in real time. Handled idempotently via webhook_events; a periodic
// reconciliation job (see README) covers missed deliveries.
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { verifySquareWebhook } from '../crypto.js';

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/square', async (req, reply) => {
    const raw = ((req as unknown as { rawBody?: string }).rawBody ?? '');
    const signature = (req.headers['x-square-hmacsha256-signature'] as string) ?? '';
    const notificationUrl = `${config.appUrl}/api/webhooks/square`;

    if (config.squareWebhookKey && !verifySquareWebhook(raw, signature, notificationUrl)) {
      return reply.code(401).send({ error: 'invalid webhook signature' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evt = req.body as any;
    const eventId: string | undefined = evt?.event_id;
    if (!eventId) return { ok: true, skipped: 'no event_id' };

    const ins = await query(
      `INSERT INTO webhook_events(square_event_id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [eventId, evt.type ?? null],
    );
    if (ins.rowCount === 0) return { ok: true, deduped: true };

    if (evt.type === 'order.updated') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = evt.data?.object?.order as any;
      if (order?.id && order.state === 'COMPLETED') {
        const c = await query(`UPDATE checks SET state='COMPLETED' WHERE square_order_id=$1 RETURNING id, table_id`, [
          order.id,
        ]);
        if (c.rowCount > 0 && c.rows[0].table_id) {
          await query(`UPDATE tables SET state='PAID' WHERE id=$1`, [c.rows[0].table_id]);
          await query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,'paid')`, [
            randomUUID(),
            c.rows[0].table_id,
            c.rows[0].id,
          ]);
        }
      }
    } else if (evt.type === 'payment.updated') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = evt.data?.object?.payment as any;
      if (p?.id && p.status) {
        await query(`UPDATE payments SET status=$1 WHERE square_payment_id=$2`, [p.status, p.id]);
      }
    }
    return { ok: true };
  });
}
