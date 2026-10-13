// Square webhooks: order.updated / payment.updated drive the table state
// machine in real time. Handled idempotently via webhook_events; a periodic
// reconciliation job (see README) covers missed deliveries.
//
// Fail-closed: with NODE_ENV=production the app refuses to boot without
// SQUARE_WEBHOOK_SIGNATURE_KEY (config.assertSafeConfig). In non-production an unsigned
// webhook is accepted but a loud warning is printed for every one.
import { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { verifySquareWebhook } from '../crypto.js';

export const WEBHOOK_PATH = '/api/webhooks/square';

const firstValue = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || undefined;

/**
 * The exact URL Square signed. Default: APP_URL + path.
 * With TRUST_PROXY=1 it is rebuilt from X-Forwarded-Proto / X-Forwarded-Host (falling back to Host), so it
 * still matches when the public URL differs from APP_URL. A spoofed header cannot forge a signature:
 * the HMAC also needs the secret key.
 */
export function webhookNotificationUrl(
  headers: IncomingHttpHeaders,
  c: { trustProxy: boolean; appUrl: string } = config,
): string {
  if (c.trustProxy) {
    const proto = firstValue(headers['x-forwarded-proto']) ?? 'https';
    const host = firstValue(headers['x-forwarded-host']) ?? firstValue(headers.host);
    if (host && (proto === 'http' || proto === 'https')) return `${proto}://${host}${WEBHOOK_PATH}`;
  }
  return `${c.appUrl}${WEBHOOK_PATH}`;
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post(WEBHOOK_PATH, async (req, reply) => {
    const raw = ((req as unknown as { rawBody?: string }).rawBody ?? '');
    const signature = (req.headers['x-square-hmacsha256-signature'] as string) ?? '';

    if (config.squareWebhookKey) {
      if (!verifySquareWebhook(raw, signature, webhookNotificationUrl(req.headers))) {
        req.log.warn('webhook rejected: invalid signature');
        return reply.code(401).send({ error: 'invalid webhook signature' });
      }
    } else if (config.isProd) {
      // Unreachable in practice (boot is refused), kept as a second lock.
      req.log.error('webhook rejected: SQUARE_WEBHOOK_SIGNATURE_KEY is not configured');
      return reply.code(503).send({ error: 'webhook verification is not configured' });
    } else {
      const msg = '[smart-table] !!! UNVERIFIED WEBHOOK accepted: SQUARE_WEBHOOK_SIGNATURE_KEY is empty (non-production only) !!!';
      console.warn(msg);
      req.log.warn(msg);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evt = req.body as any;
    const eventId: string | undefined = evt?.event_id;
    if (!eventId) return { ok: true, skipped: 'no event_id' };

    const ins = await query(
      `INSERT INTO webhook_events(square_event_id, type) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING square_event_id`,
      [eventId, evt.type ?? null],
    );
    // rows.length, not rowCount: pg-mem misreports rowCount for ON CONFLICT DO NOTHING
    // on UNIQUE targets; RETURNING is portable on both pg-mem and real Postgres.
    if (ins.rows.length === 0) return { ok: true, deduped: true };

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
