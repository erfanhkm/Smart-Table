// v0.4.1 refund routes (restaurant portal): list a check's payments with
// their refundable remainders, and refund a card payment (full or
// partial). Portal users only ever touch their own location; the
// staff-token caller may act on any location (same pattern as billing).
import { FastifyInstance, FastifyRequest } from 'fastify';
import { staffOnly } from '../auth.js';
import { badRequest, forbidden, notFound } from '../http.js';
import { query } from '../db.js';
import { listCheckPayments, refundPayment } from '../services/refunds.js';

async function locationOfCheck(checkId: string): Promise<string | null> {
  const r = await query<{ location_id: string }>(
    `SELECT t.location_id FROM checks c JOIN tables t ON t.id = c.table_id WHERE c.id = $1`,
    [checkId],
  );
  return r.rows[0]?.location_id ?? null;
}

/** Portal check references are POS order ids (same convention as /api/checks/:ref). */
async function resolveCheckRow(ref: string): Promise<{ id: string; location_id: string } | null> {
  const r = await query<{ id: string; location_id: string }>(
    `SELECT c.id, t.location_id FROM checks c JOIN tables t ON t.id = c.table_id
     WHERE c.id = $1 OR c.external_check_ref = $1 OR c.square_order_id = $1`,
    [ref],
  );
  return r.rows[0] ?? null;
}

function assertScope(req: FastifyRequest, locationId: string | null): void {
  if (!locationId) throw badRequest('check not found');
  const u = req.portalUser;
  if (u && u.location_id !== locationId) throw forbidden('not your location');
}

export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/portal/checks/:checkId/payments', staffOnly, async (req) => {
    const ref = String((req.params as { checkId: string }).checkId ?? '');
    const check = await resolveCheckRow(ref);
    assertScope(req, check?.location_id ?? null);
    const payments = await listCheckPayments((check as { id: string }).id);
    return {
      payments: payments.map((p) => ({
        id: p.id,
        amount_cents: p.amount_cents,
        tip_cents: p.tip_cents,
        currency: p.currency,
        status: p.status,
        payer_label: p.payer_label,
        split_mode: p.split_mode,
        created_at: p.created_at,
        refunded_cents: p.refunded_cents,
        refundable_cents: p.refundable_cents,
      })),
    };
  });

  app.post('/api/portal/payments/:paymentId/refund', staffOnly, async (req) => {
    const paymentId = String((req.params as { paymentId: string }).paymentId ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = (await query<{ check_id: string }>(`SELECT check_id FROM payments WHERE id = $1`, [paymentId])).rows[0];
    if (!row) throw notFound('payment not found');
    assertScope(req, await locationOfCheck(row.check_id));
    return refundPayment({
      paymentRowId: paymentId,
      amountCents: typeof body.amount_cents === 'number' ? body.amount_cents : undefined,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 190) : undefined,
      idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : '',
    });
  });
}
