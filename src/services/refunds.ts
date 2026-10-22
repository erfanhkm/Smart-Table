// v0.4.1 refunds: staff refund guest card payments from the portal.
//
// Rules:
//  - Only real card payments are refundable, and only through the POS that
//    took them (cash never moved through Smart Table — refund it at the
//    till). The Square adapter verifies the tender type against Square's
//    own payment object; POS without a refund implementation get a clear
//    400 here.
//  - Amount defaults to the full still-refundable remainder
//    (amount + tip - refunds already made). Partial refunds are allowed.
//  - Idempotent: the client supplies an idempotency key; the refund row is
//    reserved BEFORE the POS call (same pattern as payCheck), so a retry
//    or a double-click can never refund twice. A PENDING row means the
//    outcome is unknown — we answer 409 rather than guessing.
//  - Billing: a refunded payment gives its commission back. Square returns
//    an in-flight application fee proportionally with the refund, and an
//    accrued fee simply nets against future accruals — both are recorded
//    as negative fee_ledger rows (method 'reversal') so every SUM-based
//    report stays truthful.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { badRequest, conflict, isClientError, notFound } from '../http.js';
import { getCheckPos } from './pos/context.js';
import { SquareError } from '../square.js';

interface PaymentRow {
  id: string;
  check_id: string;
  square_payment_id: string | null;
  external_payment_ref: string | null;
  amount_cents: number;
  tip_cents: number;
  currency: string | null;
  status: string;
  payer_label: string | null;
  split_mode: string | null;
  created_at: string;
}

export interface PaymentWithRefunds extends PaymentRow {
  refunded_cents: number;
  refundable_cents: number;
}

interface RefundRow {
  id: string;
  payment_row_id: string;
  amount_cents: number;
  status: string;
  pos_refund_ref: string | null;
}

const REFUNDABLE_STATUSES = ['AUTHORIZED', 'COMPLETED'];

async function refundedSoFar(paymentRowId: string): Promise<number> {
  const r = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
     WHERE payment_row_id = $1 AND status IN ('PENDING', 'COMPLETED')`,
    [paymentRowId],
  );
  return Number(r.rows[0]?.total ?? 0);
}

export async function listCheckPayments(checkId: string): Promise<PaymentWithRefunds[]> {
  const r = await query<PaymentRow>(
    `SELECT * FROM payments WHERE check_id = $1 ORDER BY created_at ASC`,
    [checkId],
  );
  const out: PaymentWithRefunds[] = [];
  for (const p of r.rows) {
    const refunded = await refundedSoFar(p.id);
    const refundable = REFUNDABLE_STATUSES.includes(p.status)
      ? Math.max(0, p.amount_cents + p.tip_cents - refunded)
      : 0;
    out.push({ ...p, refunded_cents: refunded, refundable_cents: refundable });
  }
  return out;
}

async function reverseFees(payment: PaymentRow, totalRefundedAfter: number): Promise<void> {
  const fees = await query<{
    id: string; location_id: string; charge_cents: number; fee_cents: number;
    currency: string; status: string; pos_payment_ref: string | null;
  }>(
    `SELECT * FROM fee_ledger WHERE payment_row_id = $1 AND method IN ('square_app_fee', 'accrued') AND fee_cents > 0`,
    [payment.id],
  );
  const fee = fees.rows[0];
  if (!fee || fee.charge_cents <= 0) return;
  const prev = await query<{ total: string }>(
    `SELECT COALESCE(SUM(-fee_cents), 0) AS total FROM fee_ledger WHERE payment_row_id = $1 AND method = 'reversal'`,
    [payment.id],
  );
  const alreadyReversed = Number(prev.rows[0]?.total ?? 0);
  const target = Math.min(
    fee.fee_cents,
    Math.round((fee.fee_cents * totalRefundedAfter) / fee.charge_cents),
  );
  const delta = target - alreadyReversed;
  if (delta <= 0) return;
  // collected: Square hands the application fee back with the refund.
  // accrued: nets against fees not yet charged. charged: becomes an
  // 'accrued' credit that offsets the restaurant's future fees.
  const status = fee.status === 'collected' ? 'collected' : 'accrued';
  await query(
    `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'reversal', $8)`,
    [randomUUID(), fee.location_id, payment.id, fee.pos_payment_ref, fee.charge_cents, -delta, fee.currency, status],
  );
}

export interface RefundResult {
  refund_id: string;
  pos_refund_ref: string | null;
  amount_cents: number;
  refunded_cents: number;
  refundable_cents: number;
  replayed: boolean;
}

export async function refundPayment(input: {
  paymentRowId: string;
  amountCents?: number;
  reason?: string;
  idempotencyKey: string;
}): Promise<RefundResult> {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw badRequest('idempotency_key is required');
  }

  const payment = (await query<PaymentRow>(`SELECT * FROM payments WHERE id = $1`, [input.paymentRowId])).rows[0];
  if (!payment) throw notFound('payment not found');
  const ctx = await getCheckPos(payment.check_id);
  const totalCharged = payment.amount_cents + payment.tip_cents;

  const summarize = async (refundRowId: string, posRef: string | null, amount: number, replayed: boolean): Promise<RefundResult> => {
    const refunded = await refundedSoFar(payment.id);
    return {
      refund_id: refundRowId,
      pos_refund_ref: posRef,
      amount_cents: amount,
      refunded_cents: refunded,
      refundable_cents: Math.max(0, totalCharged - refunded),
      replayed,
    };
  };

  // Idempotent replay: a finished refund under this key returns as-is.
  const existing = (await query<RefundRow>(`SELECT * FROM refunds WHERE idempotency_key = $1`, [key])).rows[0];
  if (existing) {
    if (existing.payment_row_id !== payment.id) throw badRequest('idempotency_key was used for a different payment');
    if (existing.status === 'COMPLETED') {
      return summarize(existing.id, existing.pos_refund_ref, existing.amount_cents, true);
    }
    if (existing.status === 'PENDING') {
      throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
    }
    // FAILED: fall through and retry on the same row.
  }

  if (!REFUNDABLE_STATUSES.includes(payment.status)) {
    throw badRequest(`payment is ${payment.status} and cannot be refunded`);
  }
  const posPaymentRef = payment.external_payment_ref ?? payment.square_payment_id;
  if (!posPaymentRef) throw badRequest('payment has no POS reference to refund');
  if (!ctx.adapter.refundPayment) {
    throw badRequest(`refunds are not available for ${ctx.posType} yet`);
  }

  const already = await refundedSoFar(payment.id);
  const refundable = totalCharged - already;
  const amount = input.amountCents ?? refundable;
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('amount_cents must be a positive integer');
  if (amount > refundable) throw badRequest(`amount_cents exceeds the refundable remainder (${refundable})`);

  // Reserve the refund row before calling the POS.
  const rowId = existing?.id ?? randomUUID();
  if (existing) {
    await query(`UPDATE refunds SET status = 'PENDING', amount_cents = $2 WHERE id = $1`, [rowId, amount]);
  } else {
    await query(
      `INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, reason, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING`,
      [rowId, payment.id, payment.check_id, ctx.locationId, amount, payment.currency ?? 'CAD', input.reason ?? null, key],
    );
    const stored = (await query<RefundRow>(`SELECT * FROM refunds WHERE idempotency_key = $1`, [key])).rows[0];
    if (!stored || stored.id !== rowId) {
      // A concurrent request with the same key won the race.
      if (stored?.status === 'COMPLETED') return summarize(stored.id, stored.pos_refund_ref, stored.amount_cents, true);
      throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
    }
  }

  try {
    const res = await ctx.adapter.refundPayment({
      paymentId: posPaymentRef,
      amountCents: amount,
      currency: payment.currency ?? 'CAD',
      idempotencyKey: key,
      reason: input.reason,
      token: ctx.token,
    });
    await query(`UPDATE refunds SET status = 'COMPLETED', pos_refund_ref = $2 WHERE id = $1`, [rowId, res.refundId]);
    await reverseFees(payment, already + amount);
    return summarize(rowId, res.refundId, amount, false);
  } catch (e) {
    // F-2 state machine: FAILED only on a DEFINITIVE rejection — an error
    // carrying a 4xx status (our own adapter determinations throw
    // badRequest; POS clients throw status-carrying errors), other than
    // timeout/rate-limit. Anything else (network failure, timeout,
    // 408/429, POS 5xx) leaves the outcome UNKNOWN: the refund may have
    // landed at the POS, so the row stays PENDING and the caller gets the
    // same 409 the replay path uses — never a FAILED that would invite a
    // second refund of the same money.
    const rawStatus = (e as { status?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;
    const status = typeof rawStatus === 'number' ? rawStatus : undefined;
    const definitive = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (!definitive) {
      console.error(`[refunds] refund outcome unknown for payment ${payment.id} (row ${rowId} left PENDING):`, e);
      throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
    }
    await query(`UPDATE refunds SET status = 'FAILED' WHERE id = $1`, [rowId]).catch(() => undefined);
    if (e instanceof SquareError) {
      const detail = String(e.errors?.[0]?.detail ?? 'Square rejected the refund');
      throw badRequest(`refund failed: ${detail.slice(0, 200)}`);
    }
    if (isClientError(e)) {
      // Our own adapter determination (cash tender, wrong status, ...):
      // its message is written for staff, surface it as-is.
      throw e;
    }
    throw badRequest('refund failed: the POS rejected the refund');
  }
}
