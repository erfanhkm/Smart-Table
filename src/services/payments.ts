// Payment orchestration: split-bill logic, concurrency guard, idempotency.
//
// v0.3 multi-POS: payCheck() resolves the check's location -> pos_type ->
// adapter + per-merchant token (see src/services/pos/context.ts). A Square
// location only ever talks to Square; a Clover location only to Clover.
//
// Flow of payCheck():
//  A) (autocommit, BEFORE the main transaction) reserve the client-supplied
//     idempotency_key by inserting a PENDING payments row, insert-or-return-existing:
//       - key already finished (AUTHORIZED/COMPLETED) -> return the stored result, NO charge;
//       - key FAILED                                   -> 409, use a new key;
//       - key still PENDING (earlier attempt died / outcome unknown) -> resume with the
//         SAME key, which is also the POS idempotency key, so the POS will not charge twice.
//  B) transaction with a row lock on the check: validate against the LIVE POS remaining
//     (tenders are the source of truth), record the payment through the location's
//     adapter, record the result on the payments row.
//
// Card payments (source.kind === 'card') are only implemented for Square
// (Web Payments SDK nonce). Other POS return a clear 400.
// EXTERNAL (cash / outside rails) goes through adapter.recordExternalPayment()
// for every POS and is reachable from the staff-only endpoint.
import { randomUUID } from 'node:crypto';
import { forUpdate, query, withTx } from '../db.js';
import {
  createPayment, orderRemaining, payOrder, retrieveOrder, SquareError, squareErrorCode,
} from '../square.js';
import { getCheckPos, TENDER_BLIND_POS } from './pos/context.js';
import { effectivePlan, ensureBillingAccount, feeFor, recordFee } from './billing.js';
import { badRequest, conflict, httpError, isClientError } from '../http.js';

export type SplitMode = 'full' | 'equal' | 'items' | 'custom';
const SPLIT_MODES: readonly SplitMode[] = ['full', 'equal', 'items', 'custom'];

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Square Web Payments SDK card tokens look like `cnon:...` (sandbox test token: `cnon:card-nonce-ok`).
 * This is an allow-list on purpose: it makes 'EXTERNAL', 'CASH' and stored-card ids unreachable from the guest endpoint.
 */
export const CARD_NONCE_RE = /^cnon:[A-Za-z0-9_-]{1,200}$/;

export type PaymentSource =
  | { kind: 'card'; nonce: string } // guest path: Square Web Payments SDK token (Square locations only)
  | { kind: 'external'; label: string }; // staff path: cash / other rails recorded as external

export interface PayCheckInput {
  /** POS-native check reference (Square order id, Clover order id, Shopify draft id, Helcim invoice id). */
  checkRef: string;
  /**
   * Internal checks.id. REQUIRED since v0.7.3 (F1-5): the caller must
   * already have resolved and authorized the check (guest table-token
   * binding, staff location scoping). The old bare-ref fallback resolved
   * `external_check_ref = $1 OR square_order_id = $1` with rows[0] and no
   * location filter — external refs are only unique per location, never
   * globally, so that path could charge the wrong tenant's check.
   */
  checkId: string;
  mode: SplitMode;
  amountCents?: number;
  tipCents?: number;
  idempotencyKey: string;
  source: PaymentSource;
  payerLabel?: string;
  /** D-11: the guest's IP (from the HTTP request) for POS fraud APIs. */
  clientIp?: string;
}

export interface PayCheckResult {
  paymentId: string;
  remainingCents: number;
  checkState: 'OPEN' | 'COMPLETED';
  currency: string;
  /** true when this response is the stored result of an earlier request with the same idempotency_key (nothing was charged now). */
  replayed: boolean;
}

interface PaymentRow {
  id: string;
  check_id: string;
  square_payment_id: string | null;
  external_payment_ref: string | null;
  amount_cents: number;
  tip_cents: number;
  split_mode: string | null;
  status: string;
  idempotency_key: string;
  remaining_after_cents: number | null;
  check_state: string | null;
  currency: string | null;
  pos_tender_ref: string | null;
  /** F1-2: set in autocommit immediately BEFORE the POS charge call. */
  charge_started_at: string | null;
}

const TIP_MSG = 'tip_cents must be an integer between 0 and the amount being paid';

/** Shared body validation for the guest pay and the staff record-external-payment endpoints. */
export function parsePaymentBody(body: unknown): {
  mode: SplitMode;
  amountCents?: number;
  tipCents: number;
  idempotencyKey: string;
  payerLabel?: string;
} {
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
    throw badRequest('request body must be a JSON object');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const mode = b.mode;
  if (typeof mode !== 'string' || !SPLIT_MODES.includes(mode as SplitMode)) {
    throw badRequest('mode must be one of: full | equal | items | custom');
  }

  let amountCents: number | undefined;
  if (b.amount_cents !== undefined && b.amount_cents !== null) {
    if (typeof b.amount_cents !== 'number' || !Number.isSafeInteger(b.amount_cents) || b.amount_cents <= 0) {
      throw badRequest('amount_cents must be a positive integer');
    }
    amountCents = b.amount_cents;
  }

  let tipCents = 0;
  if (b.tip_cents !== undefined && b.tip_cents !== null) {
    if (typeof b.tip_cents !== 'number' || !Number.isSafeInteger(b.tip_cents) || b.tip_cents < 0) {
      throw badRequest(TIP_MSG);
    }
    tipCents = b.tip_cents;
  }
  if (amountCents !== undefined && tipCents > amountCents) throw badRequest(TIP_MSG);

  const key = b.idempotency_key;
  if (typeof key !== 'string' || !UUID_V4_RE.test(key)) {
    throw badRequest('idempotency_key is required and must be a UUID v4');
  }

  let payerLabel: string | undefined;
  if (b.payer_label !== undefined && b.payer_label !== null) {
    if (typeof b.payer_label !== 'string' || b.payer_label.length > 64) {
      throw badRequest('payer_label must be a string of at most 64 characters');
    }
    payerLabel = b.payer_label.trim() || undefined;
  }

  return { mode: mode as SplitMode, amountCents, tipCents, idempotencyKey: key.toLowerCase(), payerLabel };
}

function assertSameRequest(
  row: PaymentRow,
  exp: { checkId: string; mode: SplitMode; amountCents?: number; tipCents: number },
): void {
  // F1-16: an omitted amount only matches a first attempt that also had
  // none (a stored 0). Previously ANY omitted amount matched ANY stored
  // amount, so a resumed request could silently change the charged sum.
  const sameAmount =
    exp.mode === 'full' ||
    (exp.amountCents !== undefined && row.amount_cents === exp.amountCents) ||
    (exp.amountCents === undefined && row.amount_cents === 0);
  if (row.check_id !== exp.checkId || row.split_mode !== exp.mode || row.tip_cents !== exp.tipCents || !sameAmount) {
    throw conflict('idempotency_key was already used for a different payment request', 'idempotency_key_reused');
  }
}

/** Stored result for a finished key; null for a PENDING key (caller resumes); throws for FAILED. */
function replayFrom(row: PaymentRow): PayCheckResult | null {
  if (row.status === 'AUTHORIZED' || row.status === 'COMPLETED') {
    return {
      paymentId: row.external_payment_ref ?? row.square_payment_id ?? '',
      remainingCents: row.remaining_after_cents ?? 0,
      checkState: row.check_state === 'COMPLETED' ? 'COMPLETED' : 'OPEN',
      currency: row.currency ?? '',
      replayed: true,
    };
  }
  if (row.status === 'FAILED') {
    throw conflict('this payment attempt failed; start a new attempt with a new idempotency_key', 'payment_failed');
  }
  return null;
}

/**
 * HTTP status carried by a POS CLIENT error, if any. POS clients use
 * `.status`; our own httpError uses `.statusCode` — deliberately NOT read
 * here: payCheck's own validation errors (invalid(), badRequest) thrown
 * inside the transaction must never be misclassified as POS declines.
 */
function posHttpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * A 4xx (other than timeout/rate-limit) from any POS client is a definitive
 * rejection — EXCEPT 401/403/404 (F1-3): a dead merchant token or a vanished
 * POS order is a CONNECTION problem, not a card decline. Marking those
 * FAILED told the guest their card failed and hid a broken POS link.
 */
function isDefinitivePosError(e: unknown): boolean {
  const status = posHttpStatus(e);
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429 &&
    status !== 401 &&
    status !== 403 &&
    status !== 404
  );
}

/** F1-3: statuses that mean "the POS link is broken", never "the card declined". */
function isPosUnavailableError(e: unknown): boolean {
  const status = posHttpStatus(e);
  return status !== undefined && (status === 401 || status === 403 || status === 404 || status >= 500);
}

/** Raw POS error code from the error object (server logs only — never sent to guests). */
function rawPosErrorCode(e: unknown): string | null {
  if (e instanceof SquareError) return squareErrorCode(e);
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

/**
 * B-2: guests only ever see this small stable enum — raw POS/provider
 * decline codes (Square's GENERIC_DECLINE, ADDRESS_VERIFICATION_FAILURE,
 * ...) are provider internals and stay in the server log. An unmapped raw
 * code yields null, and the caller falls back to 'payment_declined'.
 */
const GUEST_SAFE_ERROR_CODES: Record<string, string> = {
  CARD_DECLINED: 'card_declined',
  GENERIC_DECLINE: 'card_declined',
  DO_NOT_HONOR: 'card_declined',
  FRAUD_REJECTED: 'card_declined',
  TRANSACTION_REJECTED: 'card_declined',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  CVV_FAILURE: 'cvv_failed',
  INVALID_CVV: 'cvv_failed',
  INVALID_EXPIRATION: 'card_expired',
  EXPIRATION_FAILURE: 'card_expired',
  EXPIRED_CARD: 'card_expired',
  INVALID_CARD: 'invalid_card',
  INVALID_CARD_DATA: 'invalid_card',
  CARD_NOT_SUPPORTED: 'card_not_supported',
  UNSUPPORTED_CARD: 'card_not_supported',
  AUTHENTICATION_REQUIRED: 'authentication_required',
  VERIFICATION_REQUIRED: 'authentication_required',
  LIMIT_EXCEEDED: 'limit_exceeded',
  CARD_VELOCITY_EXCEEDED: 'limit_exceeded',
};

function posErrorCode(e: unknown): string | null {
  const raw = rawPosErrorCode(e);
  return raw ? (GUEST_SAFE_ERROR_CODES[raw] ?? null) : null;
}

export async function payCheck(input: PayCheckInput): Promise<PayCheckResult> {
  const checkRef = String(input.checkRef ?? '').trim();
  if (checkRef.length > 255) throw badRequest('invalid check reference');
  // F1-5: resolution is by internal id only (see PayCheckInput.checkId).
  if (!input.checkId) throw badRequest('checkId is required');
  const key = String(input.idempotencyKey).toLowerCase();
  if (!UUID_V4_RE.test(key)) throw badRequest('idempotency_key must be a UUID v4');
  const tipCents = input.tipCents ?? 0;
  if (!Number.isSafeInteger(tipCents) || tipCents < 0) throw badRequest(TIP_MSG);
  const requested = input.amountCents;
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested <= 0) throw badRequest('amount_cents must be a positive integer');
    if (tipCents > requested) throw badRequest(TIP_MSG);
  }
  // F1-4: a split mode without an amount used to charge the FULL remaining
  // balance (amount = requested ?? remaining). The mode is a promise that
  // the guest chose a share — never silently upgrade it to the whole bill.
  if (input.mode !== 'full' && requested === undefined) {
    throw badRequest('amount_cents is required for split payments');
  }

  // Resolve the check -> its location -> the location's POS adapter + token.
  // From here on, every POS call goes through ctx.adapter: a Clover location
  // can never reach Square and vice versa.
  const chk = await query<{ id: string }>(`SELECT id FROM checks WHERE id = $1`, [input.checkId]);
  if (chk.rowCount === 0) throw badRequest('check is not linked to a table yet — link it first');
  const checkId = chk.rows[0].id;
  const ctx = await getCheckPos(checkId);
  const { adapter, posType, token } = ctx;
  const nativeRef = ctx.checkRef;
  // F1-15: a location with no configured currency used to skip the D-6
  // mismatch check silently. Locations always carry CAD by schema default,
  // so a missing value means broken data — refuse outside demo mode.
  if (!ctx.currency && !ctx.demo) {
    throw badRequest('this location has no billing currency configured');
  }

  if (input.source.kind === 'card' && !adapter.chargeCard) {
    throw badRequest(`card payments are not supported for ${posType} locations yet`);
  }
  // Card token allow-list per POS (what the guest browser SDK returns).
  // F1-17: use the strict exported pattern for Square (it was defined but
  // unused while a looser inline regex ran), and bound every POS's token.
  if (input.source.kind === 'card') {
    const t = input.source.nonce;
    const ok =
      posType === 'square' ? CARD_NONCE_RE.test(t) :
      posType === 'clover' ? /^clv_[A-Za-z0-9_-]{1,200}$/i.test(t) :
      posType === 'helcim' ? t.length >= 8 && t.length <= 200 :
      false;
    if (!ok) throw badRequest('invalid card token');
  }

  // ---- Phase A: reserve the idempotency key (autocommit, before the main transaction) ----
  const myRowId = randomUUID();
  await query(
    `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, payer_label, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [myRowId, checkId, requested ?? 0, tipCents, input.mode, input.payerLabel ?? null, key],
  );
  const found = await query<PaymentRow>(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
  const reservation = found.rows[0];
  if (!reservation) throw new Error('payment reservation vanished');
  // Portable "created by us" check: pg-mem reports rowCount=1 even when ON CONFLICT
  // DO NOTHING skips the insert, so compare the row id instead of trusting rowCount.
  const created = reservation.id === myRowId;
  if (!created) {
    assertSameRequest(reservation, { checkId, mode: input.mode, amountCents: requested, tipCents });
    const replay = replayFrom(reservation);
    if (replay) return replay; // already done: return the stored result, do NOT charge again
  }
  const resumed = !created; // an earlier attempt with this key is still PENDING (outcome unknown)

  // Set once the POS has accepted the charge; after that a failure must never be recorded as "FAILED".
  let chargeCreated = false;

  try {
    return await withTx(async (client): Promise<PayCheckResult> => {
      const lockedCheck = await client.query(`SELECT * FROM checks WHERE id = $1${forUpdate()}`, [checkId]);
      const check = lockedCheck.rows[0];
      if (!check) throw badRequest('check not found');

      // Re-read our row under the lock: a concurrent request with the same key may have finished meanwhile.
      const cur = await client.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
      const curRow = cur.rows[0] as PaymentRow | undefined;
      if (!curRow) throw conflict('payment attempt was cancelled; start again', 'payment_cancelled');
      const replay = replayFrom(curRow);
      if (replay) return replay;

      // Live state from the location's POS; tenders are the source of truth.
      // Square keeps its verified raw-order path; other POS go through the adapter.
      let remaining: number;
      let currency: string;
      let posTotalCents = 0;
      if (posType === 'square') {
        const { order } = await retrieveOrder(nativeRef, token);
        remaining = orderRemaining(order);
        currency = order?.total_money?.currency;
      } else {
        const detail = await adapter.getCheckDetail(nativeRef, token);
        remaining = detail.remainingCents;
        currency = detail.currency;
        posTotalCents = detail.totalCents;
      }
      if (!currency) throw new Error('POS check has no currency');

      // D-6: the LOCATION's currency is authoritative. A POS check whose
      // currency disagrees means the location is bound to a POS account
      // in another currency — charging would settle in the wrong currency
      // while our books record the location's. Refuse (the demo location
      // is exempt: its sandbox account is USD while the location is CAD,
      // and it never moves real money).
      if (ctx.currency && currency.toUpperCase() !== ctx.currency.toUpperCase()) {
        if (ctx.demo) {
          console.warn(`[pay] demo location currency mismatch: location=${ctx.currency} POS=${currency} (allowed for demo)`);
        } else {
          throw badRequest(
            `this check is in ${currency} but the location bills in ${ctx.currency} — the POS account currency does not match the location`,
          );
        }
      }

      // E-4 + F1-1: tender-blind adapters report the FULL total as
      // remaining even after earlier payments settled (their detail has no
      // tender list), so the chargeable remaining is computed from our own
      // ledger. Three corrections over the original cap:
      //  - amounts only: tips are extra money ON TOP of the bill, so
      //    subtracting them from the bill total under-collected by the tip
      //    sum and the check could never close;
      //  - the base is the FRESH POS total (the link-time total_cents is a
      //    snapshot — a discount applied in the POS afterwards must lower
      //    what guests can be charged);
      //  - PENDING rows that already carry a tender ref are counted: the
      //    charge landed at the POS even though our row never finalized.
      if (TENDER_BLIND_POS.has(posType)) {
        const base = posTotalCents > 0 ? posTotalCents : check.total_cents;
        if (base > 0) {
          const settled = await client.query<{ s: string }>(
            `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments
             WHERE check_id = $1 AND (status IN ('AUTHORIZED','COMPLETED')
               OR (status = 'PENDING' AND pos_tender_ref IS NOT NULL))`,
            [checkId],
          );
          remaining = Math.max(0, base - Number(settled.rows[0]?.s ?? 0));
        }
      }

      // D-1 resume guard: a resumed PENDING row that already carries a
      // persisted POS tender ref means the first attempt DID create the
      // charge — the ref is written the moment the charge lands, outside
      // the transaction. Such a request must never reach the adapter's
      // charge again: some adapters (Clover) have no native idempotency
      // on their charge endpoint, so a blind retry double-charges the
      // guest. The outcome is resolved from the live POS detail instead.
      // v0.7.3 (F1-8): the guard now covers external payments too, not
      // just card — a resumed cash recording with a ref must not record
      // the same money twice either.
      const resumeResolved = resumed && !!curRow.pos_tender_ref;

      // F1-2: a resumed attempt whose charge_started_at marker is set but
      // which never landed a tender ref sits in the crash window between
      // "the POS charged" and "the ref write persisted". On adapters
      // WITHOUT native idempotency a blind retry can charge twice, so the
      // attempt stops here and staff/reconcile resolve it — never a guess.
      if (resumed && !resumeResolved && curRow.charge_started_at && !adapter.nativeIdempotency) {
        throw httpError(
          409,
          'the earlier attempt may have been charged; staff will verify the bill before any new charge',
          'payment_needs_reconciliation',
        );
      }

      // For a resumed key, a failed validation may mean "the first attempt already charged": never answer
      // with a plain 400 that invites a second charge under a new key.
      const invalid = (msg: string): Error =>
        resumed
          ? httpError(
              409,
              'could not confirm the earlier attempt with this idempotency_key; check the bill balance before paying again',
              'payment_state_unknown',
            )
          : badRequest(msg);

      let amount: number;
      if (resumeResolved) {
        // The amount that matters is the one the first attempt charged.
        amount = curRow.amount_cents;
      } else {
        if (remaining <= 0) throw invalid('check is already fully paid');
        amount = requested ?? remaining;
        if (input.mode === 'full') amount = remaining;
        if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
          throw invalid(`amount_cents must be between 1 and ${remaining}`);
        }
        // F1-18: through invalid(), not badRequest — on a resumed key a
        // plain 400 makes the client discard the attempt and start a new
        // key, which is exactly what the resume semantics exist to avoid.
        if (tipCents > amount) throw invalid(TIP_MSG);
      }

      // Non-Square adapters record external payments atomically (no split
      // authorize/PayOrder flow): they only support full-balance payments.
      if (posType !== 'square' && input.source.kind === 'external' && amount !== remaining) {
        throw invalid(`partial payments are not supported for ${posType}; pay the full remaining balance`);
      }

      const existing = await client.query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED')`,
        [check.id],
      );
      const isFirst = (existing.rows[0]?.n ?? 0) === 0;

      let externalPaymentId: string;
      let newRemaining: number;
      let resultCurrency = currency;

      // F1-2: durable "a charge is about to happen" marker, written in
      // autocommit BEFORE any POS charge call in the branches below. If
      // the process dies between the charge and the tender-ref write, a
      // resumed request finds this marker (see the guard above) instead
      // of charging blind on adapters without native idempotency.
      const markChargeStarted = async (): Promise<void> => {
        await query(
          `UPDATE payments SET charge_started_at = now() WHERE idempotency_key = $1 AND charge_started_at IS NULL`,
          [key],
        ).catch((e) => console.error('[payments] failed to persist charge_started_at:', e));
      };

      if (resumeResolved) {
        // D-1: resolve the stranded charge WITHOUT charging again. The
        // shared completion tail below finalizes the row/check/table from
        // these values, exactly as if the charge had just returned.
        chargeCreated = true; // money exists at the POS; a failure from here must never mark the row FAILED
        externalPaymentId = curRow.pos_tender_ref!;
        // `remaining` already excludes this charge: live tenders reflect
        // it on tender-capable POS, and the F1-1 cap counts PENDING rows
        // carrying a tender ref on tender-blind ones.
        newRemaining = remaining;
        // Commission fee, if the first attempt died before recording it
        // (card only — external recordings never carry a fee; mirrors
        // reconcile F-7; an existing fee row makes this a no-op).
        if (input.source.kind === 'card' && ctx.locationId) {
          try {
            const priorFee = await query<{ n: number }>(
              `SELECT COUNT(*)::int AS n FROM fee_ledger WHERE payment_row_id = $1 AND method IN ('square_app_fee','accrued')`,
              [reservation.id],
            );
            if ((priorFee.rows[0]?.n ?? 0) === 0) {
              const acct = await ensureBillingAccount(ctx.locationId);
              if (effectivePlan(acct) === 'commission') {
                const fee = feeFor(curRow.amount_cents + curRow.tip_cents, acct.commission_bps);
                if (fee > 0) {
                  await recordFee({
                    locationId: ctx.locationId,
                    paymentRowId: reservation.id,
                    posPaymentRef: externalPaymentId,
                    chargeCents: curRow.amount_cents + curRow.tip_cents,
                    feeCents: fee,
                    currency,
                    method: posType === 'square' ? 'square_app_fee' : 'accrued',
                  });
                }
              }
            }
          } catch (feeErr) {
            console.error('[payments] resume fee recording failed:', feeErr);
          }
        }
      } else if (input.source.kind === 'card') {
        // ---- Card payment via the location's adapter ----
        // The adapter charges the provider SDK token and closes the POS
        // check when the payment covers the balance. priorPaymentIds lets
        // Square PayOrder close a check paid across several card attempts.
        const prior = await client.query(
          `SELECT COALESCE(external_payment_ref, square_payment_id) AS pid FROM payments
           WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED')
             AND COALESCE(external_payment_ref, square_payment_id) IS NOT NULL
           ORDER BY created_at ASC`,
          [check.id],
        );
        // v0.4 billing: on the commission plan, this charge carries our 2%
        // fee. Square locations collect it in-flight as an application fee;
        // other POS accrue it in the fee ledger for monthly collection.
        // Subscription-plan locations are never charged per payment.
        let feeCents = 0;
        if (ctx.locationId) {
          const acct = await ensureBillingAccount(ctx.locationId).catch((e) => {
            // Never silent (v0.6.4): a billing lookup failure means this charge
            // goes out with NO fee — that must be visible in the logs.
            console.error('[payments] ensureBillingAccount failed; charging without a fee:', e);
            return null;
          });
          if (acct && effectivePlan(acct) === 'commission') {
            feeCents = feeFor(amount + tipCents, acct.commission_bps);
          }
        }
        await markChargeStarted();
        const res = await adapter.chargeCard!({
          checkId: nativeRef,
          amountCents: amount,
          currency,
          cardToken: input.source.nonce,
          tipCents,
          idempotencyKey: key,
          priorPaymentIds: prior.rows.map((r) => String(r.pid)),
          card: ctx.card,
          token,
          appFeeCents: posType === 'square' ? feeCents : 0,
          clientIp: input.clientIp,
        });
        chargeCreated = true;
        externalPaymentId = res.paymentId;
        newRemaining = res.remainingCents;
        resultCurrency = res.currency || currency;
        if (feeCents > 0 && ctx.locationId) {
          // Autocommit on purpose (same reasoning as the H5 tender-ref write
          // below): Square may already have taken this fee, so the ledger
          // row must survive even if the surrounding transaction rolls back.
          await recordFee({
            locationId: ctx.locationId,
            paymentRowId: reservation.id,
            posPaymentRef: res.paymentId,
            chargeCents: amount + tipCents,
            feeCents,
            currency: resultCurrency,
            method: posType === 'square' && res.feeCollected ? 'square_app_fee' : 'accrued',
          }).catch((e) => {
            // Never silent (v0.6.4): if this write fails, money was taken (or a
            // fee is owed) with no ledger row — reconciliation needs the log.
            console.error('[payments] recordFee failed after a successful charge:', e);
          });
        }
        // H5 fix: persist the POS reference outside the transaction (see above).
        await query(
          `UPDATE payments SET pos_tender_ref = $2, amount_cents = $3, tip_cents = $4
           WHERE idempotency_key = $1 AND status = 'PENDING'`,
          [key, res.paymentId, amount, tipCents],
        ).catch((e) => console.error('[payments] failed to persist pos_tender_ref:', e));
      } else if (posType === 'square') {
        // ---- Square orchestration (unchanged verified flow; order already retrieved above) ----
        // This branch only runs for EXTERNAL (cash) payments now; card
        // payments go through adapter.chargeCard above.
        await markChargeStarted();
        const { payment } = await createPayment(
          {
            orderId: nativeRef,
            amountCents: amount,
            currency,
            sourceId: 'EXTERNAL',
            tipCents,
            autocomplete: false,
            idempotencyKey: key, // same key as our payments row => Square dedupes a resumed request
            externalSource: input.source.kind === 'external' ? input.source.label : undefined,
          },
          token,
        );
        chargeCreated = true;
        externalPaymentId = payment.id;
        newRemaining = remaining - amount;
        // H5 fix: persist the POS reference outside the transaction (see above).
        await query(
          `UPDATE payments SET pos_tender_ref = $2, amount_cents = $3, tip_cents = $4
           WHERE idempotency_key = $1 AND status = 'PENDING'`,
          [key, payment.id, amount, tipCents],
        ).catch((e) => console.error('[payments] failed to persist pos_tender_ref:', e));
      } else {
        // ---- Generic external payment via the location's adapter ----
        await markChargeStarted();
        const res = await adapter.recordExternalPayment(
          nativeRef,
          amount,
          currency,
          input.source.kind === 'external' ? input.source.label : 'card',
          key,
          token,
        );
        chargeCreated = true;
        externalPaymentId = res.paymentId;
        newRemaining = res.remainingCents;
        resultCurrency = res.currency || currency;
        // H5 parity with the card/Square branches: persist the POS ref
        // outside the transaction so a rollback leaves the row reconcilable.
        await query(
          `UPDATE payments SET pos_tender_ref = $2, amount_cents = $3, tip_cents = $4
           WHERE idempotency_key = $1 AND status = 'PENDING'`,
          [key, res.paymentId, amount, tipCents],
        ).catch((e) => console.error('[payments] failed to persist pos_tender_ref:', e));
      }

      const completes = newRemaining <= 0;
      const checkState: 'OPEN' | 'COMPLETED' = completes ? 'COMPLETED' : 'OPEN';

      await client.query(
        `UPDATE payments SET status='AUTHORIZED', square_payment_id=$1, external_payment_ref=$2, amount_cents=$3, tip_cents=$4,
           remaining_after_cents=$5, check_state=$6, currency=$7
         WHERE idempotency_key=$8`,
        [posType === 'square' ? externalPaymentId : null, externalPaymentId, amount, tipCents, Math.max(0, newRemaining), checkState, resultCurrency, key],
      );

      if (completes) {
        // Square EXTERNAL (cash) payments still need the explicit PayOrder
        // close here; Square CARD payments were already closed inside
        // adapter.chargeCard, and other adapters close inside
        // recordExternalPayment/chargeCard.
        if (posType === 'square' && input.source.kind === 'external') {
          const rows = await client.query(
            `SELECT square_payment_id FROM payments WHERE check_id=$1 AND status='AUTHORIZED' AND square_payment_id IS NOT NULL`,
            [check.id],
          );
          const ids: string[] = rows.rows.map((r) => r.square_payment_id);
          await payOrder(nativeRef, ids, `${key}:payorder`, token);
        }
        await client.query(`UPDATE payments SET status='COMPLETED' WHERE check_id=$1 AND status='AUTHORIZED'`, [check.id]);
        await client.query(`UPDATE checks SET state='COMPLETED' WHERE id=$1`, [check.id]);
        if (check.table_id) {
          await client.query(`UPDATE tables SET state='PAID' WHERE id=$1`, [check.table_id]);
          await client.query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,'paid')`, [
            randomUUID(),
            check.table_id,
            check.id,
          ]);
        }
      } else if (check.table_id) {
        await client.query(`UPDATE tables SET state='PAYING' WHERE id=$1 AND state IN ('SEATED','PAYING')`, [check.table_id]);
        await client.query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,$4)`, [
          randomUUID(),
          check.table_id,
          check.id,
          isFirst ? 'first_payment' : 'partial_payment',
        ]);
      }
      return { paymentId: externalPaymentId, remainingCents: Math.max(0, newRemaining), checkState, currency: resultCurrency, replayed: false };
    });
  } catch (e) {
    // The transaction has rolled back here, so these writes are outside it and do persist.
    if (chargeCreated) {
      // The POS accepted money but our DB work rolled back. Leave the row PENDING
      // (retry with the same key resumes safely) and surface it loudly; a reconciliation job must pick these up.
      console.error(`[payments] RECONCILE: POS payment created but bill not closed (check ${nativeRef}, key ${key}):`, e);
      throw httpError(
        409,
        'the payment was taken but the bill could not be closed; ask staff to check the table',
        'payment_needs_reconciliation',
      );
    }
    if (isPosUnavailableError(e)) {
      // F1-3: the POS LINK failed (dead merchant token, vanished order,
      // POS 5xx) — not a decline. The row stays PENDING so the same key
      // resumes once the connection is fixed, and the guest hears "ask
      // staff", never "your card failed".
      console.error(`[payments] POS unavailable while paying (key ${key}):`, e);
      throw httpError(503, 'the payment service is temporarily unavailable — please ask staff', 'pos_unavailable');
    }
    if (isDefinitivePosError(e)) {
      // The POS rejected the request outright (declined card, bad token, ...): terminal for this key.
      // v0.6.4: the ref guards mirror the key-freeing DELETE below — if a
      // tender ref was already persisted (H5), a charge may exist at the POS
      // and the row must stay reconcilable instead of being marked FAILED.
      await query(
        `UPDATE payments SET status='FAILED' WHERE idempotency_key=$1 AND status='PENDING'
         AND pos_tender_ref IS NULL AND external_payment_ref IS NULL AND square_payment_id IS NULL`,
        [key],
      ).catch(() => undefined);
      // B-2: the raw provider code stays in the server log; the guest only
      // ever receives the mapped guest-safe code.
      console.error(`[payments] POS definitively rejected payment (key ${key}): raw code ${rawPosErrorCode(e) ?? 'n/a'} — ${e instanceof Error ? e.message.slice(0, 200) : ''}`);
      const code = posErrorCode(e);
      throw httpError(402, 'the payment could not be completed', code ?? 'payment_declined');
    }
    if (created && isClientError(e)) {
      // Our own validation failed before anything was charged: free the key so it can be reused.
      await query(
        `DELETE FROM payments WHERE idempotency_key=$1 AND status='PENDING' AND external_payment_ref IS NULL AND square_payment_id IS NULL`,
        [key],
      ).catch(() => undefined);
    }
    throw e;
  }
}
