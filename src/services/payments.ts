// Payment orchestration: split-bill logic, concurrency guard, idempotency.
//
// Flow of payCheck():
//  A) (autocommit, BEFORE the main transaction) reserve the client-supplied
//     idempotency_key by inserting a PENDING payments row, insert-or-return-existing:
//       - key already finished (AUTHORIZED/COMPLETED) -> return the stored result, NO charge;
//       - key FAILED                                   -> 409, use a new key;
//       - key still PENDING (earlier attempt died / outcome unknown) -> resume with the
//         SAME key, which is also the Square idempotency key, so Square will not charge twice.
//  B) transaction with a row lock on the check: validate against the LIVE Square remaining
//     (tenders are the source of truth), create the Square payment, PayOrder when the
//     balance hits zero, record the result on the payments row.
//
// Card payments (source.kind === 'card') are the only guest-reachable path. EXTERNAL
// (cash / outside rails) is only reachable from the staff-only endpoint.
import { randomUUID } from 'node:crypto';
import { forUpdate, query, withTx } from '../db.js';
import {
  assertSquareId, createPayment, orderRemaining, payOrder, retrieveOrder, SquareError, squareErrorCode,
} from '../square.js';
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
  | { kind: 'card'; nonce: string } // guest path: Square Web Payments SDK token
  | { kind: 'external'; label: string }; // staff path: cash / other rails recorded as external

export interface PayCheckInput {
  orderId: string;
  mode: SplitMode;
  amountCents?: number;
  tipCents?: number;
  idempotencyKey: string;
  source: PaymentSource;
  payerLabel?: string;
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
  amount_cents: number;
  tip_cents: number;
  split_mode: string | null;
  status: string;
  idempotency_key: string;
  remaining_after_cents: number | null;
  check_state: string | null;
  currency: string | null;
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
  const sameAmount = exp.mode === 'full' || exp.amountCents === undefined || row.amount_cents === exp.amountCents;
  if (row.check_id !== exp.checkId || row.split_mode !== exp.mode || row.tip_cents !== exp.tipCents || !sameAmount) {
    throw conflict('idempotency_key was already used for a different payment request', 'idempotency_key_reused');
  }
}

/** Stored result for a finished key; null for a PENDING key (caller resumes); throws for FAILED. */
function replayFrom(row: PaymentRow): PayCheckResult | null {
  if (row.status === 'AUTHORIZED' || row.status === 'COMPLETED') {
    return {
      paymentId: row.square_payment_id ?? '',
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

export async function payCheck(input: PayCheckInput): Promise<PayCheckResult> {
  const orderId = assertSquareId(input.orderId, 'orderId');
  const key = String(input.idempotencyKey).toLowerCase();
  if (!UUID_V4_RE.test(key)) throw badRequest('idempotency_key must be a UUID v4');
  const tipCents = input.tipCents ?? 0;
  if (!Number.isSafeInteger(tipCents) || tipCents < 0) throw badRequest(TIP_MSG);
  const requested = input.amountCents;
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested <= 0) throw badRequest('amount_cents must be a positive integer');
    if (tipCents > requested) throw badRequest(TIP_MSG);
  }

  // ---- Phase A: reserve the idempotency key (autocommit, before the main transaction) ----
  const chk = await query<{ id: string }>(`SELECT id FROM checks WHERE square_order_id = $1`, [orderId]);
  if (chk.rowCount === 0) throw badRequest('check is not linked to a table yet — link it first');
  const checkId = chk.rows[0].id;

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

  // Set once Square has accepted the charge; after that a failure must never be recorded as "FAILED".
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

      // Live state from Square; tenders are the source of truth.
      const { order } = await retrieveOrder(orderId);
      const remaining = orderRemaining(order);
      const currency: string | undefined = order?.total_money?.currency;
      if (!currency) throw new Error('Square order has no total_money.currency');

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

      if (remaining <= 0) throw invalid('check is already fully paid');
      let amount = requested ?? remaining;
      if (input.mode === 'full') amount = remaining;
      if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
        throw invalid(`amount_cents must be between 1 and ${remaining}`);
      }
      if (tipCents > amount) throw badRequest(TIP_MSG);

      const existing = await client.query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED')`,
        [check.id],
      );
      const isFirst = (existing.rows[0]?.n ?? 0) === 0;

      const { payment } = await createPayment({
        orderId,
        amountCents: amount,
        currency,
        sourceId: input.source.kind === 'card' ? input.source.nonce : 'EXTERNAL',
        tipCents,
        autocomplete: false,
        idempotencyKey: key, // same key as our payments row => Square dedupes a resumed request
        externalSource: input.source.kind === 'external' ? input.source.label : undefined,
      });
      chargeCreated = true;
      const squarePaymentId: string = payment.id;

      const newRemaining = remaining - amount;
      const completes = newRemaining <= 0;
      const checkState: 'OPEN' | 'COMPLETED' = completes ? 'COMPLETED' : 'OPEN';

      await client.query(
        `UPDATE payments SET status='AUTHORIZED', square_payment_id=$1, amount_cents=$2, tip_cents=$3,
           remaining_after_cents=$4, check_state=$5, currency=$6
         WHERE idempotency_key=$7`,
        [squarePaymentId, amount, tipCents, Math.max(0, newRemaining), checkState, currency, key],
      );

      if (completes) {
        const rows = await client.query(
          `SELECT square_payment_id FROM payments WHERE check_id=$1 AND status='AUTHORIZED' AND square_payment_id IS NOT NULL`,
          [check.id],
        );
        const ids: string[] = rows.rows.map((r) => r.square_payment_id);
        await payOrder(orderId, ids, randomUUID());
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
      return { paymentId: squarePaymentId, remainingCents: Math.max(0, newRemaining), checkState, currency, replayed: false };
    });
  } catch (e) {
    // The transaction has rolled back here, so these writes are outside it and do persist.
    if (chargeCreated) {
      // Square holds/charged money but our DB work rolled back (e.g. PayOrder failed). Leave the row PENDING
      // (retry with the same key resumes safely) and surface it loudly; a reconciliation job must pick these up.
      console.error(`[payments] RECONCILE: Square payment created but bill not closed (order ${orderId}, key ${key}):`, e);
      throw httpError(
        409,
        'the payment was taken but the bill could not be closed; ask staff to check the table',
        'payment_needs_reconciliation',
      );
    }
    if (e instanceof SquareError) {
      const definitive = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
      if (definitive) {
        // Square rejected the request outright (declined card, bad token, ...): terminal for this key.
        await query(`UPDATE payments SET status='FAILED' WHERE idempotency_key=$1 AND status='PENDING'`, [key]).catch(
          () => undefined,
        );
        const code = squareErrorCode(e);
        throw httpError(402, 'the payment could not be completed', code ?? 'payment_declined');
      }
      // 5xx / timeout / rate limit: outcome unknown. Keep the key PENDING so the client can retry with the SAME key.
    } else if (created && isClientError(e)) {
      // Our own validation failed before anything was charged: free the key so it can be reused.
      await query(
        `DELETE FROM payments WHERE idempotency_key=$1 AND status='PENDING' AND square_payment_id IS NULL`,
        [key],
      ).catch(() => undefined);
    }
    throw e;
  }
}
