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
import { query, withAdvisoryLock } from '../db.js';
import { badRequest, conflict, forbidden, isClientError, notFound } from '../http.js';
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
  // F1-22: explicit columns (SELECT * shipped internal fields —
  // pos_tender_ref, idempotency_key, recorded_by — to portal clients) and
  // one grouped refund-sum query instead of an N+1 refundedSoFar per row.
  const r = await query<PaymentRow>(
    `SELECT id, check_id, square_payment_id, external_payment_ref, amount_cents, tip_cents,
            currency, status, payer_label, split_mode, created_at
     FROM payments WHERE check_id = $1 ORDER BY created_at ASC`,
    [checkId],
  );
  const sums = await query<{ payment_row_id: string; total: string }>(
    `SELECT payment_row_id, COALESCE(SUM(amount_cents), 0) AS total FROM refunds
     WHERE check_id = $1 AND status IN ('PENDING', 'COMPLETED') GROUP BY payment_row_id`,
    [checkId],
  );
  const byPayment = new Map(sums.rows.map((s) => [s.payment_row_id, Number(s.total ?? 0)]));
  return r.rows.map((p) => {
    const refunded = byPayment.get(p.id) ?? 0;
    const refundable = REFUNDABLE_STATUSES.includes(p.status)
      ? Math.max(0, p.amount_cents + p.tip_cents - refunded)
      : 0;
    return { ...p, refunded_cents: refunded, refundable_cents: refundable };
  });
}

async function reverseFees(payment: PaymentRow, totalRefundedAfter: number, refundRowId: string): Promise<void> {
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
    `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status, refund_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'reversal', $8, $9)`,
    [randomUUID(), fee.location_id, payment.id, fee.pos_payment_ref, fee.charge_cents, -delta, fee.currency, status, refundRowId],
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
  /** F-9 (defense in depth): the location the CALLER was authorized for —
   * the service asserts the payment actually belongs to it, so a future
   * route bug can't refund across locations. */
  expectedLocationId?: string;
  /** F-9: who is issuing the refund (portal user id or 'staff-token'). */
  actor?: string;
}): Promise<RefundResult> {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw badRequest('idempotency_key is required');
  }

  const payment = (await query<PaymentRow>(`SELECT * FROM payments WHERE id = $1`, [input.paymentRowId])).rows[0];
  if (!payment) throw notFound('payment not found');
  const ctx = await getCheckPos(payment.check_id);
  if (input.expectedLocationId && ctx.locationId !== input.expectedLocationId) {
    throw forbidden('payment does not belong to your location');
  }
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
    // F1-21: a replay naming a DIFFERENT amount is a different request —
    // say so (409, mirroring payCheck) instead of silently returning the
    // original amount as if it were what was asked for.
    if (input.amountCents !== undefined && input.amountCents !== existing.amount_cents) {
      throw conflict('idempotency_key was already used for a different refund amount', 'idempotency_key_reused');
    }
    if (existing.status === 'COMPLETED') {
      // F1-10: if the original call died after the POS refund but before
      // the fee reversal, the reversal was never retried — the replay path
      // returned early and the restaurant stayed overbilled forever.
      // reverseFees is cumulative and idempotent, so retry it here, under
      // the same per-payment lock the reservation uses.
      await withAdvisoryLock(
        `refund:${payment.id}`,
        async () => {
          const total = await refundedSoFar(payment.id);
          await reverseFees(payment, total, existing.id);
        },
        { runIfUnsupported: true },
      ).catch((e) => console.error('[refunds] fee reversal retry on replay failed:', e));
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

  // F-9: the refundable computation + reservation run under a per-payment
  // advisory lock — without it, two concurrent refunds with DIFFERENT
  // keys could both pass the remainder check and over-refund together.
  // The POS call itself stays outside the lock.
  const reserved = await withAdvisoryLock(`refund:${payment.id}`, async () => {
    const alreadyNow = await refundedSoFar(payment.id);
    const refundableNow = totalCharged - alreadyNow;

    // Reserve the refund row before calling the POS.
    const newRowId = existing?.id ?? randomUUID();
    if (existing) {
      // F1-12: FAILED-retry hardening. `existing` was read BEFORE the
      // lock; a concurrent retry of the same key could already be in
      // flight. Re-read inside the lock and flip the row with a
      // compare-and-set on status='FAILED', so exactly one retry owns it.
      // The amount is PINNED to the original: the POS call reuses the
      // same idempotency key, and a changed amount under a reused key
      // diverges the POS from our books (Square answers the original
      // payload or IDEMPOTENCY_KEY_REUSED) — a different amount needs a
      // new key, which the replay check above already enforces for
      // explicit amounts; the default-amount path lands here.
      const cur = (await query<RefundRow>(`SELECT * FROM refunds WHERE id = $1`, [existing.id])).rows[0];
      if (!cur || cur.status !== 'FAILED') {
        if (cur && cur.status === 'COMPLETED') return { kind: 'replay' as const, row: cur };
        throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
      }
      if (cur.amount_cents > refundableNow) {
        throw badRequest('the refundable remainder changed since the failed attempt; review the payment before retrying');
      }
      await query(
        `UPDATE refunds SET status = 'PENDING', amount_cents = $2, refunded_by = COALESCE($3, refunded_by)
         WHERE id = $1 AND status = 'FAILED'`,
        [existing.id, cur.amount_cents, input.actor ?? null],
      );
      const after = (await query<RefundRow>(`SELECT * FROM refunds WHERE id = $1`, [existing.id])).rows[0];
      if (!after || after.status !== 'PENDING' || after.amount_cents !== cur.amount_cents) {
        throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
      }
      return { kind: 'reserved' as const, rowId: existing.id, amount: cur.amount_cents, already: alreadyNow };
    } else {
      const amountNow = input.amountCents ?? refundableNow;
      if (!Number.isInteger(amountNow) || amountNow <= 0) throw badRequest('amount_cents must be a positive integer');
      if (amountNow > refundableNow) throw badRequest(`amount_cents exceeds the refundable remainder (${refundableNow})`);
      await query(
        `INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, reason, idempotency_key, refunded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (idempotency_key) DO NOTHING`,
        [newRowId, payment.id, payment.check_id, ctx.locationId, amountNow, payment.currency ?? 'CAD', input.reason ?? null, key, input.actor ?? null],
      );
      const stored = (await query<RefundRow>(`SELECT * FROM refunds WHERE idempotency_key = $1`, [key])).rows[0];
      if (!stored || stored.id !== newRowId) {
        // A concurrent request with the same key won the race.
        if (stored && stored.status === 'COMPLETED') return { kind: 'replay' as const, row: stored };
        throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
      }
      return { kind: 'reserved' as const, rowId: newRowId, amount: amountNow, already: alreadyNow };
    }
  }, { runIfUnsupported: true });
  if (reserved === null) {
    throw conflict('another refund for this payment is in progress — wait a moment and retry', 'refund_state_unknown');
  }
  if (reserved.kind === 'replay') {
    return summarize(reserved.row.id, reserved.row.pos_refund_ref, reserved.row.amount_cents, true);
  }
  const { rowId, amount, already } = reserved;

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
    // F1-10: the refund itself has SUCCEEDED at this point — a fee-reversal
    // failure must not turn it into a 409 (the retry would replay the
    // COMPLETED row, which now retries the reversal itself; see above).
    // It runs under the per-payment lock so two concurrent refunds of the
    // same payment can't both read the same already-reversed total.
    await withAdvisoryLock(`refund:${payment.id}`, () => reverseFees(payment, already + amount, rowId), {
      runIfUnsupported: true,
    }).catch((e) => console.error('[refunds] fee reversal failed (will retry on replay):', e));
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
    // F1-12: IDEMPOTENCY_KEY_REUSED means the POS saw this key before with
    // a different payload — the original attempt's outcome is NOT a clean
    // rejection, so it is unknown, never definitive.
    const keyReused =
      e instanceof SquareError &&
      Array.isArray(e.errors) &&
      e.errors.some((x) => (x as { code?: unknown })?.code === 'IDEMPOTENCY_KEY_REUSED');
    const definitive =
      !keyReused && status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (!definitive) {
      console.error(`[refunds] refund outcome unknown for payment ${payment.id} (row ${rowId} left PENDING):`, e);
      throw conflict('this refund is still being confirmed with the POS; check the payment before retrying', 'refund_state_unknown');
    }
    await query(`UPDATE refunds SET status = 'FAILED' WHERE id = $1`, [rowId]).catch(() => undefined);
    if (e instanceof SquareError) {
      // F-8: Square's raw error detail is logged, never echoed to the
      // client — provider internals are not a user-facing message.
      console.error(`[refunds] Square rejected refund for payment ${payment.id}:`, e.errors ?? e);
      throw badRequest('refund failed: the POS rejected the refund');
    }
    if (isClientError(e)) {
      // Our own adapter determination (cash tender, wrong status, ...):
      // its message is written for staff, surface it as-is.
      throw e;
    }
    throw badRequest('refund failed: the POS rejected the refund');
  }
}
