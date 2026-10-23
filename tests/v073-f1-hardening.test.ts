// v0.7.3 — Claude cycle-2 F1 hardening tests (pg-mem + mocked POS fetch).
//
// Proves:
//  F1-4  a split mode without amount_cents is refused before any POS call
//  F1-3  a POS 401 is a 503 pos_unavailable (not a card decline); the row
//        stays PENDING and the same key resumes once the link recovers
//  F1-2  a resumed attempt with charge_started_at but no tender ref on a
//        non-idempotent adapter (Clover) stops with 409, never re-charges
//  F1-10 a fee reversal lost after a successful refund is retried on the
//        idempotent replay path (and carries the refund_id)
//  F1-21 replaying a refund key with a different amount is a 409
//  F1-12 a FAILED refund retry pins the original amount + updates the actor
//  F1-22 listCheckPayments exposes no internal payment columns
//  F1-6  sweepMissingFees records accrued fees for non-Square gaps and
//        only flags Square gaps (never double-bills an in-flight fee)
//
// Run: PG_MEM=1 npx tsx --test tests/v073-f1-hardening.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { payCheck } = await import('../src/services/payments.js');
const { refundPayment, listCheckPayments } = await import('../src/services/refunds.js');
const { sweepMissingFees } = await import('../src/services/billing.js');

// ---- fetch mock -------------------------------------------------------------
interface Call { url: string; method: string }
const calls: Call[] = [];
let orderAuthFails = false;
let refundRejects = false;
const orderTotals: Record<string, number> = { SQORD1: 10000, SQORD2: 5000 };
const orderPaid: Record<string, number> = { SQORD1: 0, SQORD2: 0 };
let paySeq = 0;
let refundCalls = 0;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function sqOrder(id: string) {
  return {
    id, location_id: 'SQLoc1', state: orderPaid[id] >= orderTotals[id] ? 'COMPLETED' : 'OPEN',
    total_money: { amount: orderTotals[id], currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: orderTotals[id], currency: 'CAD' } }],
    tenders: orderPaid[id] > 0 ? [{ id: 'T1', amount_money: { amount: orderPaid[id], currency: 'CAD' } }] : [],
  };
}
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const u = new URL(url);
    if (u.hostname.includes('clover')) {
      if (/\/orders\/[^/]+$/.test(u.pathname) && method === 'GET') {
        return json({
          id: 'CLORDER1', state: 'open', total: 2000, currency: 'CAD',
          lineItems: { elements: [{ name: 'Mocha', unitQty: 1, price: 2000 }] },
          payments: { elements: [] },
        });
      }
      if (url.includes('/tenders')) return json({ elements: [{ id: 'T1', label: 'Card' }] });
      return json({ error: 'unexpected clover call' }, 500);
    }
    // Square
    const orderM = /\/v2\/orders\/(SQORD\d+)$/.exec(u.pathname);
    if (orderM && method === 'GET') {
      if (orderAuthFails) return json({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'bad token' }] }, 401);
      return json({ order: sqOrder(orderM[1]) });
    }
    if (/\/v2\/orders\/SQORD\d+\/pay$/.test(u.pathname)) {
      const id = /SQORD\d+/.exec(u.pathname)![0];
      return json({ order: sqOrder(id) });
    }
    if (u.pathname === '/v2/payments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { order_id?: string; amount_money?: { amount?: number }; tip_money?: { amount?: number } };
      paySeq += 1;
      const pid = `SQPAY${paySeq}`;
      if (body.order_id && orderTotals[body.order_id] !== undefined) {
        orderPaid[body.order_id] += (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0);
      }
      return json({ payment: { id: pid, status: 'COMPLETED' } });
    }
    const payGetM = /\/v2\/payments\/([A-Za-z0-9]+)$/.exec(u.pathname);
    if (payGetM && method === 'GET') {
      return json({
        payment: {
          id: payGetM[1], source_type: 'CARD', status: 'COMPLETED',
          amount_money: { amount: 100, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' },
        },
      });
    }
    if (u.pathname === '/v2/refunds' && method === 'POST') {
      refundCalls += 1;
      if (refundRejects) {
        return json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'REFUND_NOT_ALLOWED', detail: 'nope' }] }, 400);
      }
      return json({ refund: { id: `SQREF${refundCalls}`, status: 'COMPLETED' } });
    }
    return json({ errors: [{ code: 'NOT_FOUND', detail: `unexpected: ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ---- seed -------------------------------------------------------------------
const MERCHANT = 'm-f1';
const checkIds: Record<string, string> = {};
async function seedCheck(key: string, loc: string, pos: string, ref: string, total: number) {
  const tId = randomUUID();
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
    [tId, loc, `T-${key}`, randomUUID().replace(/-/g, '')]);
  const cId = randomUUID();
  checkIds[key] = cId;
  await query(
    `INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,'CAD')`,
    [cId, tId, loc, pos, ref, pos === 'square' ? ref : null, MERCHANT, total],
  );
}

describe('v0.7.3 F1 hardening', () => {
  before(async () => {
    installFetch();
    await migrate();
    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
    for (const [loc, pos, ref] of [['loc-sq-f1', 'square', 'SQLoc1'], ['loc-cl-f1', 'clover', 'CLM1'], ['loc-hc-f1', 'helcim', 'HCLOC']] as const) {
      await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
        VALUES ($1,$2,$3,$4,$5,$6,'CAD')`, [loc, MERCHANT, pos, ref, ref, `Loc ${pos}`]);
      await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, card_public_token, card_private_token_enc)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), MERCHANT, pos, pos === 'square' ? 'sq-merchant' : ref, encryptSecret('TOK'), encryptSecret('x'),
         pos === 'clover' ? 'CL-PUB' : null, pos === 'clover' ? encryptSecret('CL-PRIV') : null]);
    }
    await seedCheck('SQ1', 'loc-sq-f1', 'square', 'SQORD1', 10000);
    await seedCheck('SQ2', 'loc-sq-f1', 'square', 'SQORD2', 5000);
    await seedCheck('CL1', 'loc-cl-f1', 'clover', 'CLM1:CLORDER1', 2000);
    await seedCheck('HC1', 'loc-hc-f1', 'helcim', 'HCINV1', 5000);
  });

  it('F1-4: split mode without amount_cents is refused before any POS call', async () => {
    const payCallsBefore = calls.filter((c) => c.url.includes('/v2/payments') && c.method === 'POST').length;
    await assert.rejects(
      () => payCheck({
        checkRef: 'SQORD1', checkId: checkIds.SQ1, mode: 'custom',
        idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
      }),
      /amount_cents is required for split payments/,
    );
    assert.equal(calls.filter((c) => c.url.includes('/v2/payments') && c.method === 'POST').length, payCallsBefore);
  });

  it('F1-3: POS 401 -> 503 pos_unavailable, row stays PENDING, same key resumes after recovery', async () => {
    const key = randomUUID();
    orderAuthFails = true;
    let err: Error & { statusCode?: number; errorCode?: string };
    try {
      await payCheck({
        checkRef: 'SQORD1', checkId: checkIds.SQ1, mode: 'full', tipCents: 1000,
        idempotencyKey: key, source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
      });
      assert.fail('must throw');
    } catch (e) { err = e as typeof err; }
    assert.equal(err!.statusCode, 503);
    assert.equal(err!.errorCode, 'pos_unavailable');
    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'PENDING', 'a broken POS link must not mark the attempt FAILED');
    orderAuthFails = false;
    const res = await payCheck({
      checkRef: 'SQORD1', checkId: checkIds.SQ1, mode: 'full', tipCents: 1000,
      idempotencyKey: key, source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(res.checkState, 'COMPLETED');
  });

  it('F1-2: charge_started_at without a ref on Clover stops with 409 and never charges', async () => {
    const strandedKey = '22222222-2222-4222-8222-222222222222';
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, charge_started_at)
       VALUES ($1,$2,2000,0,'full','PENDING',$3, now())`,
      [randomUUID(), checkIds.CL1, strandedKey],
    );
    const cloverPostsBefore = calls.filter((c) => c.url.includes('clover') && c.method === 'POST').length;
    let err: Error & { statusCode?: number; errorCode?: string };
    try {
      await payCheck({
        checkRef: 'CLM1:CLORDER1', checkId: checkIds.CL1, mode: 'full',
        idempotencyKey: strandedKey, source: { kind: 'card', nonce: 'clv_tok123' },
      });
      assert.fail('must throw');
    } catch (e) { err = e as typeof err; }
    assert.equal(err!.statusCode, 409);
    assert.equal(err!.errorCode, 'payment_needs_reconciliation');
    assert.equal(calls.filter((c) => c.url.includes('clover') && c.method === 'POST').length, cloverPostsBefore, 'no charge call may happen');
  });

  let sq1PaymentId = '';
  let refundKey = '';
  let refundRowId = '';
  it('F1-10: a fee reversal lost after a successful refund is retried on replay (with refund_id)', async () => {
    const pay = await query<{ id: string }>(
      `SELECT id FROM payments WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED') ORDER BY created_at DESC LIMIT 1`,
      [checkIds.SQ1],
    );
    sq1PaymentId = pay.rows[0].id;
    refundKey = randomUUID();
    const r1 = await refundPayment({ paymentRowId: sq1PaymentId, idempotencyKey: refundKey, actor: 'user-1' });
    refundRowId = r1.refund_id;
    const rev1 = await query<{ n: number; rid: string | null }>(
      `SELECT COUNT(*)::int AS n, MAX(refund_id) AS rid FROM fee_ledger WHERE payment_row_id = $1 AND method = 'reversal'`,
      [sq1PaymentId],
    );
    assert.equal(rev1.rows[0].n, 1, 'the refund reversed the fee once');
    assert.equal(rev1.rows[0].rid, refundRowId, 'the reversal row carries its refund_id');
    // Simulate the lost reversal (the original F1-10 failure mode).
    await query(`DELETE FROM fee_ledger WHERE payment_row_id = $1 AND method = 'reversal'`, [sq1PaymentId]);
    const r2 = await refundPayment({ paymentRowId: sq1PaymentId, idempotencyKey: refundKey, actor: 'user-1' });
    assert.equal(r2.replayed, true);
    const rev2 = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM fee_ledger WHERE payment_row_id = $1 AND method = 'reversal'`,
      [sq1PaymentId],
    );
    assert.equal(rev2.rows[0].n, 1, 'the replay retried the reversal');
  });

  it('F1-21: replaying a refund key with a different amount is a 409', async () => {
    await assert.rejects(
      () => refundPayment({ paymentRowId: sq1PaymentId, amountCents: 123, idempotencyKey: refundKey }),
      (e: unknown) => (e as { statusCode?: number }).statusCode === 409 &&
        (e as { errorCode?: string }).errorCode === 'idempotency_key_reused',
    );
  });

  it('F1-12: FAILED retry pins the original amount and records the new actor', async () => {
    const pay2 = await payCheck({
      checkRef: 'SQORD2', checkId: checkIds.SQ2, mode: 'full',
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(pay2.checkState, 'COMPLETED');
    const row2 = await query<{ id: string }>(
      `SELECT id FROM payments WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED') LIMIT 1`, [checkIds.SQ2],
    );
    const failKey = randomUUID();
    refundRejects = true;
    await assert.rejects(
      () => refundPayment({ paymentRowId: row2.rows[0].id, amountCents: 2000, idempotencyKey: failKey, actor: 'user-1' }),
      /POS rejected the refund/,
    );
    const failed = await query<{ status: string }>(`SELECT status FROM refunds WHERE idempotency_key = $1`, [failKey]);
    assert.equal(failed.rows[0].status, 'FAILED');
    // A retry naming a different amount is refused outright (key reuse guard).
    await assert.rejects(
      () => refundPayment({ paymentRowId: row2.rows[0].id, amountCents: 3000, idempotencyKey: failKey, actor: 'user-9' }),
      (e: unknown) => (e as { statusCode?: number }).statusCode === 409,
    );
    refundRejects = false;
    const callsBefore = refundCalls;
    const ok = await refundPayment({ paymentRowId: row2.rows[0].id, idempotencyKey: failKey, actor: 'user-9' });
    assert.equal(ok.amount_cents, 2000, 'the retry used the ORIGINAL amount, not a recomputed remainder');
    assert.equal(refundCalls, callsBefore + 1, 'exactly one new POS refund call');
    const after = await query<{ status: string; refunded_by: string | null }>(
      `SELECT status, refunded_by FROM refunds WHERE idempotency_key = $1`, [failKey],
    );
    assert.equal(after.rows[0].status, 'COMPLETED');
    assert.equal(after.rows[0].refunded_by, 'user-9');
  });

  it('F1-22: listCheckPayments exposes no internal columns', async () => {
    const list = await listCheckPayments(checkIds.SQ1);
    assert.ok(list.length >= 1);
    const first = list[0] as unknown as Record<string, unknown>;
    assert.equal('pos_tender_ref' in first, false);
    assert.equal('idempotency_key' in first, false);
    assert.equal('recorded_by' in first, false);
    assert.equal(first.refunded_cents, 11000);
  });

  it('F1-6: sweep records accrued fees for non-Square gaps, only flags Square gaps', async () => {
    // A settled Helcim payment with no fee row (the recordFee write was lost).
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, external_payment_ref, remaining_after_cents, check_state, currency)
       VALUES ($1,$2,5000,0,'full','COMPLETED',$3,'HCPAY1',0,'COMPLETED','CAD')`,
      [randomUUID(), checkIds.HC1, randomUUID()],
    );
    // A settled Square payment with no fee row: in-flight fee — flag only.
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, external_payment_ref, remaining_after_cents, check_state, currency)
       VALUES ($1,$2,700,0,'full','COMPLETED',$3,'SQORPHAN',0,'COMPLETED','CAD')`,
      [randomUUID(), checkIds.SQ1, randomUUID()],
    );
    await query(`UPDATE payments SET created_at = now() - interval '20 minutes' WHERE external_payment_ref IN ('HCPAY1','SQORPHAN')`);
    const res = await sweepMissingFees();
    assert.ok(res.recorded >= 1, 'the Helcim gap was recorded');
    assert.ok(res.squareMissing >= 1, 'the Square gap was flagged');
    const hcFee = await query<{ n: number; fee: number }>(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX(fee_cents),0) AS fee FROM fee_ledger f
       JOIN payments p ON p.id = f.payment_row_id
       WHERE p.external_payment_ref = 'HCPAY1' AND f.method = 'accrued'`,
    );
    assert.equal(hcFee.rows[0].n, 1);
    assert.equal(hcFee.rows[0].fee, 100, '2% of 5000');
    const sqFee = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM fee_ledger f JOIN payments p ON p.id = f.payment_row_id
       WHERE p.external_payment_ref = 'SQORPHAN'`,
    );
    assert.equal(sqFee.rows[0].n, 0, 'no accrued row may be created for a Square in-flight fee');
  });
});
