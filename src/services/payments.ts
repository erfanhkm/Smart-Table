// Payment orchestration: split-bill logic, concurrency guard, idempotency.
//
// Flow: validate amount against the LIVE Square remaining (tenders are the
// source of truth) inside a DB transaction with a row lock on the check,
// create the Square payment (card nonce or EXTERNAL), then PayOrder when the
// balance hits zero. Every Square call carries a stored idempotency key.
import { randomUUID } from 'node:crypto';
import { forUpdate, withTx } from '../db.js';
import { createPayment, orderRemaining, payOrder, retrieveOrder } from '../square.js';
import { badRequest } from '../http.js';

export type SplitMode = 'full' | 'equal' | 'items' | 'custom';

export interface PayCheckInput {
  orderId: string;
  mode: SplitMode;
  amountCents?: number;
  tipCents?: number;
  cardNonce?: string;
  payerLabel?: string;
}

export interface PayCheckResult {
  paymentId: string;
  remainingCents: number;
  checkState: 'OPEN' | 'COMPLETED';
  currency: string;
}

export async function payCheck(input: PayCheckInput): Promise<PayCheckResult> {
  return withTx(async (client) => {
    const chk = await client.query(`SELECT * FROM checks WHERE square_order_id = $1${forUpdate()}`, [input.orderId]);
    if (chk.rowCount === 0) throw badRequest('check is not linked to a table yet — link it first');
    const check = chk.rows[0];

    // Live state from Square; tenders are the source of truth.
    const { order } = await retrieveOrder(input.orderId);
    const remaining = orderRemaining(order);
    if (remaining <= 0) throw badRequest('check is already fully paid');
    const currency: string = order.total_money.currency;

    let amount = input.amountCents ?? remaining;
    if (input.mode === 'full') amount = remaining;
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      throw badRequest(`amount_cents must be between 1 and ${remaining}`);
    }

    const existing = await client.query(`SELECT COUNT(*)::int AS n FROM payments WHERE check_id = $1`, [check.id]);
    const isFirst = (existing.rows[0]?.n ?? 0) === 0;

    const idem = randomUUID();
    await client.query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, payer_label, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7)`,
      [randomUUID(), check.id, amount, input.tipCents ?? 0, input.mode, input.payerLabel ?? null, idem],
    );

    let squarePaymentId: string;
    try {
      const { payment } = await createPayment({
        orderId: input.orderId,
        amountCents: amount,
        currency,
        // Card nonce from Square Web Payments SDK in production; EXTERNAL records
        // an outside payment (cash / another rail) — the sandbox-proven path.
        sourceId: input.cardNonce ?? 'EXTERNAL',
        tipCents: input.tipCents ?? 0,
        autocomplete: false,
        idempotencyKey: idem,
      });
      squarePaymentId = payment.id;
    } catch (e) {
      await client.query(`UPDATE payments SET status='FAILED' WHERE idempotency_key=$1`, [idem]);
      throw e;
    }
    await client.query(`UPDATE payments SET status='AUTHORIZED', square_payment_id=$1 WHERE idempotency_key=$2`, [
      squarePaymentId,
      idem,
    ]);

    const newRemaining = remaining - amount;
    let checkState: 'OPEN' | 'COMPLETED' = 'OPEN';
    if (newRemaining <= 0) {
      const rows = await client.query(
        `SELECT square_payment_id FROM payments WHERE check_id=$1 AND status='AUTHORIZED' AND square_payment_id IS NOT NULL`,
        [check.id],
      );
      const ids: string[] = rows.rows.map((r) => r.square_payment_id);
      await payOrder(input.orderId, ids, randomUUID());
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
      checkState = 'COMPLETED';
    } else if (check.table_id) {
      await client.query(`UPDATE tables SET state='PAYING' WHERE id=$1 AND state IN ('SEATED','PAYING')`, [check.table_id]);
      await client.query(`INSERT INTO events(id, table_id, check_id, type) VALUES($1,$2,$3,$4)`, [
        randomUUID(),
        check.table_id,
        check.id,
        isFirst ? 'first_payment' : 'partial_payment',
      ]);
    }
    return { paymentId: squarePaymentId, remainingCents: Math.max(0, newRemaining), checkState, currency };
  });
}
