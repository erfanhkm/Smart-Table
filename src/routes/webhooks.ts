// POS webhooks drive the table state machine in real time.
//
// v0.3 multi-POS:
// - Square keeps its verified dedicated handler at /api/webhooks/square
//   (order.updated / payment.updated). Unchanged behavior.
// - Other POS use /api/webhooks/:posType, which verifies via the location's
//   adapter (adapter.parseWebhookEvent) and applies the normalized PosEvents.
//   Handled idempotently via webhook_events; a periodic reconciliation job
//   (see README) covers missed deliveries.
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
import { assertPosType, PosType } from '../services/pos/types.js';
import { getAdapter } from '../services/pos/registry.js';

export const WEBHOOK_PATH = '/api/webhooks/square';

/**
 * The exact URL Square signed: pinned to APP_URL + path (v0.6.4). This used to
 * be rebuilt from X-Forwarded-Proto / X-Forwarded-Host when behind a proxy —
 * deterministic config beats client-influenced headers: a forwarder that
 * stopped sending those headers (or a second proxy hop) silently broke
 * signature verification for every webhook. APP_URL is the URL registered in
 * the Square dashboard, so it is the URL Square signs.
 */
export function webhookNotificationUrl(
  c: { appUrl: string } = config,
): string {
  return `${c.appUrl}${WEBHOOK_PATH}`;
}

/**
 * Map a Square payment status onto our internal payment status, or null when
 * the event must not touch the row (v0.6.4). Square's raw vocabulary must
 * never be stored verbatim: an APPROVED event arriving after a COMPLETED one
 * (out-of-order delivery) previously REGRESSED the row.
 */
export function mapSquarePaymentStatus(s: unknown): string | null {
  if (s === 'APPROVED') return 'AUTHORIZED';
  if (s === 'COMPLETED') return 'COMPLETED';
  // CANCELED / unknown: our own cancel + refund flows own those transitions.
  return null;
}

/** Forward-only ordering for payment statuses; terminal states rank highest. */
export function paymentStatusRank(s: string): number {
  switch (s) {
    case 'PENDING': return 0;
    case 'AUTHORIZED': return 1;
    case 'COMPLETED': return 2;
    default: return 3; // FAILED / REFUNDED / anything terminal
  }
}

/** Apply one normalized check.closed event to our tables. */
async function applyCheckClosed(posType: PosType, checkRef: string): Promise<void> {
  const c = await query(
    `UPDATE checks SET state='COMPLETED' WHERE pos_type=$1 AND external_check_ref=$2 RETURNING id, table_id`,
    [posType, checkRef],
  );
  if (c.rowCount > 0 && c.rows[0].table_id) {
    await query(`UPDATE tables SET state='PAID' WHERE id=$1`, [c.rows[0].table_id]);
    await query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,'paid')`, [
      randomUUID(),
      c.rows[0].table_id,
      c.rows[0].id,
    ]);
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  // ---- Square (verified, unchanged) ----
  app.post(WEBHOOK_PATH, async (req, reply) => {
    const raw = ((req as unknown as { rawBody?: string }).rawBody ?? '');
    const signature = (req.headers['x-square-hmacsha256-signature'] as string) ?? '';

    if (config.squareWebhookKey) {
      if (!verifySquareWebhook(raw, signature, webhookNotificationUrl())) {
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
      `INSERT INTO webhook_events(square_event_id, pos_type, type) VALUES ($1,'square',$2)
       ON CONFLICT DO NOTHING RETURNING square_event_id`,
      [eventId, evt.type ?? null],
    );
    // rows.length, not rowCount: pg-mem misreports rowCount for ON CONFLICT DO NOTHING
    // on UNIQUE targets; RETURNING is portable on both pg-mem and real Postgres.
    if (ins.rows.length === 0) return { ok: true, deduped: true };

    // v0.6.4: if processing throws, remove the dedupe row before rethrowing —
    // the 500 makes Square retry, and the retry must not be deduped away
    // (previously the row was inserted first and a failure lost the event).
    try {
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
        const mapped = p?.id ? mapSquarePaymentStatus(p.status) : null;
        if (p?.id && mapped) {
          const cur = await query(`SELECT status FROM payments WHERE square_payment_id=$1`, [p.id]);
          const row = cur.rows[0] as { status: string } | undefined;
          // Forward-only: never regress a terminal/further-along status.
          if (row && paymentStatusRank(mapped) > paymentStatusRank(row.status)) {
            await query(`UPDATE payments SET status=$1 WHERE square_payment_id=$2`, [mapped, p.id]);
          }
        }
      }
    } catch (e) {
      await query(`DELETE FROM webhook_events WHERE square_event_id=$1`, [eventId]).catch(() => undefined);
      throw e;
    }
    return { ok: true };
  });

  // ---- Generic handler for every other POS ----
  app.post('/api/webhooks/:posType', async (req, reply) => {
    let posType: PosType;
    try {
      posType = assertPosType((req.params as { posType: string }).posType);
    } catch {
      return reply.code(404).send({ error: 'unknown POS' });
    }
    if (posType === 'square') {
      return reply.code(404).send({ error: 'use /api/webhooks/square for Square' });
    }
    const adapter = getAdapter(posType);
    const raw = ((req as unknown as { rawBody?: string }).rawBody ?? '');

    let events;
    try {
      events = await adapter.parseWebhookEvent({
        headers: req.headers as Record<string, string | string[] | undefined>,
        rawBody: raw,
        body: req.body,
        notificationUrl: `${config.appUrl}/api/webhooks/${posType}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log.warn(`webhook rejected for ${posType}: ${msg}`);
      return reply.code(401).send({ error: 'invalid webhook signature' });
    }

    let applied = 0;
    for (const e of events) {
      if (!e.eventId) continue;
      const ins = await query(
        `INSERT INTO webhook_events(square_event_id, pos_type, type) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING RETURNING square_event_id`,
        [`${posType}:${e.eventId}`, posType, e.rawType],
      );
      if (ins.rows.length === 0) continue; // deduped
      if (e.type === 'check.closed' && e.checkId) {
        try {
          await applyCheckClosed(posType, e.checkId);
        } catch (err) {
          // Same rule as the Square handler: a failed apply must not stay
          // deduped — remove the row so the provider's retry reprocesses it.
          await query(`DELETE FROM webhook_events WHERE square_event_id=$1`, [`${posType}:${e.eventId}`]).catch(
            () => undefined,
          );
          throw err;
        }
        applied++;
      }
      // check.updated needs no action (bills are read live); payment.recorded
      // is reconciled via the payments table + reconciliation job.
    }
    return { ok: true, applied };
  });
}
