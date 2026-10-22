// v0.6.6 batch-2 (payments integrity) tests — Claude cycle-1 section-2 D-1/E-4/D-4/B-2/F-2.
//
// Proves:
//  D-4: a declined Square card is NOT retried without the fee — one
//       POST /v2/payments only, and the fee/scope rejection (INSUFFICIENT_PERMISSIONS)
//       still gets its single no-fee retry.
//  B-2: the guest only ever sees mapped guest-safe error codes
//       (card_declined / insufficient_funds / payment_declined); the raw
//       Square code never reaches the API error code.
//  D-1: a resumed card payment whose PENDING row already carries a POS
//       tender ref resolves from the live POS detail and NEVER charges the
//       card again (Clover has no native charge idempotency).
//  E-4: a tender-blind POS (Helcim) cannot overcharge: the payable amount
//       is capped by our own settled payments, not by the POS's full total.
//  F-2: a refund whose outcome is unknown (network failure) leaves the
//       row PENDING and answers 409 — a definitive POS rejection marks it
//       FAILED and a later retry completes it.
//
// Run: PG_MEM=1 npx tsx --test tests/v066-payments-integrity.test.ts
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
const { refundPayment } = await import('../src/services/refunds.js');

// ---- fetch mock: routed by host --------------------------------------------
interface Call { url: string; method: string; body: Record<string, unknown> }
const calls: Call[] = [];
// Scenario state.
let declineCode = '';
let feeOrderPaid = false;
let helcimPaid = false;
let refundBehavior: 'ok' | 'network' | 'reject' = 'ok';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function sqOrder(id: string, total: number, paid: number) {
  return {
    id, location_id: 'SQLoc66', state: paid >= total ? 'COMPLETED' : 'OPEN',
    total_money: { amount: total, currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: total, currency: 'CAD' } }],
    tenders: paid > 0 ? [{ id: 'T1', amount_money: { amount: paid, currency: 'CAD' } }] : [],
  };
}
function clOrder() {
  return {
    id: 'CLORDER1', state: 'open', total: 2000, currency: 'CAD',
    lineItems: { elements: [{ name: 'Mocha', unitQty: 1, price: 2000 }] },
    payments: { elements: [{ id: 'CLPAY-EXISTING', amount: 2000, tender: { label: 'Card' } }] },
  };
}
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method, body });
    const u = new URL(url);
    if (u.hostname.includes('square')) {
      if (/\/v2\/orders\/(SQORD-[A-Z0-9]+)$/.test(u.pathname) && method === 'GET') {
        const id = RegExp.$1;
        const paid = id === 'SQORD-FEE' && feeOrderPaid ? 10000 : 0;
        return json({ order: sqOrder(id, id === 'SQORD-R' ? 5000 : 10000, paid) });
      }
      if (/\/v2\/orders\/SQORD-FEE\/pay$/.test(u.pathname)) return json({ order: sqOrder('SQORD-FEE', 10000, 10000) });
      if (/\/v2\/payments\/SQPAY-R1$/.test(u.pathname) && method === 'GET') {
        return json({
          payment: {
            id: 'SQPAY-R1', source_type: 'CARD', status: 'COMPLETED', order_id: 'SQORD-R',
            amount_money: { amount: 5000, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' },
          },
        });
      }
      if (u.pathname === '/v2/refunds' && method === 'POST') {
        if (refundBehavior === 'network') throw new TypeError('fetch failed');
        if (refundBehavior === 'reject') {
          return json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'REFUND_NOT_ALLOWED', detail: 'already refunded' }] }, 400);
        }
        return json({ refund: { id: 'SQREF1', status: 'COMPLETED' } });
      }
      if (u.pathname === '/v2/payments' && method === 'POST') {
        if (declineCode) {
          return json({ errors: [{ category: 'PAYMENT_ERROR', code: declineCode, detail: 'declined by test' }] }, 402);
        }
        if (body.app_fee_money) {
          return json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'INSUFFICIENT_PERMISSIONS', detail: 'app fee not authorized' }] }, 400);
        }
        feeOrderPaid = true;
        return json({ payment: { id: 'SQPAY-NF' } });
      }
      return json({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
    }
    if (u.hostname.includes('clover')) {
      if (/\/orders\/[^/]+$/.test(u.pathname) && method === 'GET') return json(clOrder());
      if (url.includes('/tenders')) return json({ elements: [{ id: 'T1', label: 'Card' }] });
      return json({ error: 'unexpected clover call in test' }, 500);
    }
    if (u.hostname.includes('helcim')) {
      if (url.includes('/invoices/777')) {
        return json({
          invoice: {
            invoiceId: 777, invoiceNumber: 'INV-777', amount: 100.0, currency: 'CAD',
            status: helcimPaid ? 'PAID' : 'DUE',
          },
        });
      }
      if (url.includes('/payment/purchase')) {
        helcimPaid = true;
        return json({ responseCode: '0', transactionId: 'HTXN1' });
      }
      return json({ error: 'unexpected helcim call in test' }, 500);
    }
    return json({ error: 'unexpected host in test' }, 500);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}
function paymentsTo(fragment: string): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.url.includes(fragment));
}

// ---- seed -------------------------------------------------------------------
const MERCHANT = 'm-p66';
const checks: Record<string, string> = {};
async function mkLoc(id: string, pos: string, ref: string) {
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ($1,$2,$3,$4,$4,$5,'CAD')`,
    [id, MERCHANT, pos, ref, `${pos}-66`],
  );
}
async function mkCred(pos: string, access: string, cardPriv = 'x', cardPub = 'x') {
  await query(
    `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, card_private_token_enc, card_public_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), MERCHANT, pos, `${pos}-merchant`, encryptSecret(access), encryptSecret('x'), encryptSecret(cardPriv), cardPub],
  );
}
async function mkCheck(key: string, loc: string, pos: string, ref: string, total: number) {
  const tId = randomUUID();
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
    [tId, loc, `T-${key}`, randomUUID().replace(/-/g, '')]);
  const cId = randomUUID();
  await query(
    `INSERT INTO checks(id, table_id, pos_type, external_check_ref, merchant_id, state, total_cents, currency)
     VALUES ($1,$2,$3,$4,$5,'OPEN',$6,'CAD')`,
    [cId, tId, pos, ref, MERCHANT, total],
  );
  checks[key] = cId;
}

describe('v0.6.6 payments integrity (D-1/E-4/D-4/B-2/F-2)', () => {
  before(async () => {
    installFetch();
    await migrate();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
       VALUES ($1,'square','sq-merchant',$2,$3)`,
      [MERCHANT, encryptSecret('x'), encryptSecret('x')],
    );
    await mkLoc('loc-sq66', 'square', 'SQLoc66');
    await mkLoc('loc-cl66', 'clover', 'CLM1');
    await mkLoc('loc-hc66', 'helcim', 'HCLOC');
    await mkCred('square', 'SQ-TOKEN');
    await mkCred('clover', 'CL-TOKEN', 'CL-ECOM-PRIV', 'CL-ECOM-PUB');
    await mkCred('helcim', 'HC-TOKEN');
    await mkCheck('D4', 'loc-sq66', 'square', 'SQORD-D4', 10000);
    await mkCheck('FEE', 'loc-sq66', 'square', 'SQORD-FEE', 10000);
    await mkCheck('CL', 'loc-cl66', 'clover', 'CLM1:CLORDER1', 2000);
    await mkCheck('HC', 'loc-hc66', 'helcim', '777', 10000);
    await mkCheck('RF', 'loc-sq66', 'square', 'SQORD-R', 5000);
    // D-1: a stranded card charge on the Clover check — PENDING row whose
    // tender ref was persisted before the DB work rolled back.
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, pos_tender_ref)
       VALUES ($1,$2,2000,0,'full','PENDING',$3,'CLPAY-EXISTING')`,
      [randomUUID(), checks.CL, '11111111-1111-4111-8111-111111111111'],
    );
    // E-4: one already-settled 6000c payment on the Helcim check (the POS
    // itself still reports the full 10000 as remaining — tender-blind).
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, external_payment_ref, remaining_after_cents)
       VALUES ($1,$2,6000,0,'full','COMPLETED',$3,'helcim-prior',4000)`,
      [randomUUID(), checks.HC, randomUUID(),],
    );
    // F-2: a settled card payment for the refund scenarios.
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, external_payment_ref)
       VALUES ($1,$2,5000,0,'full','COMPLETED',$3,'SQPAY-R1')`,
      [randomUUID(), checks.RF, randomUUID()],
    );
  });

  it('D-4 + B-2: a declined card is never retried without the fee; guest sees the mapped code', async () => {
    declineCode = 'CARD_DECLINED';
    const beforeCalls = paymentsTo('/v2/payments').length;
    let err: Error & { statusCode?: number; errorCode?: string };
    try {
      await payCheck({ checkId: checks.D4, mode: 'full', source: { kind: 'card', nonce: 'cnon:tok-decline' }, idempotencyKey: randomUUID() });
      assert.fail('payCheck must throw on a declined card');
    } catch (e) { err = e as typeof err; }
    assert.equal(paymentsTo('/v2/payments').length, beforeCalls + 1, 'a decline must not trigger the no-fee retry');
    assert.equal(err!.statusCode, 402);
    assert.equal(err!.errorCode, 'card_declined');
    assert.ok(!JSON.stringify(err!).includes('CARD_DECLINED'), 'the raw Square code must not reach the API error');
    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE check_id = $1`, [checks.D4]);
    assert.equal(row.rows[0].status, 'FAILED');
    declineCode = '';
  });

  it('B-2: more decline codes map; unknown codes fall back to payment_declined', async () => {
    for (const [raw, mapped] of [['INSUFFICIENT_FUNDS', 'insufficient_funds'], ['SOME_FUTURE_CODE', 'payment_declined']] as const) {
      declineCode = raw;
      let err: Error & { statusCode?: number; errorCode?: string };
      try {
        await payCheck({ checkId: checks.D4, mode: 'full', source: { kind: 'card', nonce: 'cnon:tok-x' }, idempotencyKey: randomUUID() });
        assert.fail('must throw');
      } catch (e) { err = e as typeof err; }
      assert.equal(err!.errorCode, mapped, `raw code ${raw}`);
    }
    declineCode = '';
  });

  it('D-4: a fee/scope rejection still gets its single no-fee retry', async () => {
    feeOrderPaid = false;
    const beforeCalls = paymentsTo('/v2/payments').length;
    const res = await payCheck({ checkId: checks.FEE, mode: 'full', source: { kind: 'card', nonce: 'cnon:tok-fee' }, idempotencyKey: randomUUID() });
    const posts = paymentsTo('/v2/payments');
    assert.equal(posts.length, beforeCalls + 2, 'exactly one no-fee retry');
    assert.ok(posts[posts.length - 2].body.app_fee_money, 'first attempt carries the fee');
    const retryBody = posts[posts.length - 1].body;
    assert.ok(!retryBody.app_fee_money, 'retry drops the fee');
    assert.ok(String(retryBody.idempotency_key).endsWith('-nf'), 'retry uses the derived key');
    assert.equal(res.paymentId, 'SQPAY-NF');
    // The fee accrues in the ledger instead of dying with the rejection.
    const fee = await query<{ method: string }>(
      `SELECT method FROM fee_ledger fl JOIN payments p ON p.id = fl.payment_row_id WHERE p.check_id = $1 AND fl.fee_cents > 0`,
      [checks.FEE],
    );
    assert.equal(fee.rows[0]?.method, 'accrued');
  });

  it('D-1: a resumed payment with a stored tender ref never charges the card again', async () => {
    const key = '11111111-1111-4111-8111-111111111111';
    const cloverPostsBefore = paymentsTo('/v1/orders').length + paymentsTo('/payments').length;
    const res = await payCheck({ checkId: checks.CL, mode: 'full', source: { kind: 'card', nonce: 'clv_tok123' }, idempotencyKey: key });
    assert.equal(res.paymentId, 'CLPAY-EXISTING');
    assert.equal(res.remainingCents, 0);
    assert.equal(res.replayed, false);
    const cloverPostsAfter = paymentsTo('/v1/orders').length + paymentsTo('/payments').length;
    assert.equal(cloverPostsAfter, cloverPostsBefore, 'no Clover charge call may be made for a resolved payment');
    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'COMPLETED');
    const check = await query<{ state: string }>(`SELECT state FROM checks WHERE id = $1`, [checks.CL]);
    assert.equal(check.rows[0].state, 'COMPLETED');
    // A second call with the same key replays the stored result.
    const replay = await payCheck({ checkId: checks.CL, mode: 'full', source: { kind: 'card', nonce: 'clv_tok123' }, idempotencyKey: key });
    assert.equal(replay.replayed, true);
  });

  it('E-4: a tender-blind adapter cannot overcharge beyond our settled payments', async () => {
    const beforeCalls = calls.filter((c) => c.url.includes('/payment/purchase')).length;
    let err: Error & { statusCode?: number };
    try {
      await payCheck({ checkId: checks.HC, mode: 'custom', amountCents: 5000, source: { kind: 'card', nonce: 'helcim-token-123' }, idempotencyKey: randomUUID() });
      assert.fail('must reject the over-cap payment');
    } catch (e) { err = e as typeof err; }
    assert.equal(err!.statusCode, 400);
    assert.equal(calls.filter((c) => c.url.includes('/payment/purchase')).length, beforeCalls, 'over-cap payment must not reach the POS');
    // The honest remainder (4000) works with one purchase of 40.00.
    const res = await payCheck({ checkId: checks.HC, mode: 'custom', amountCents: 4000, source: { kind: 'card', nonce: 'helcim-token-123' }, idempotencyKey: randomUUID() });
    assert.equal(res.paymentId, 'HTXN1');
    const purchase = calls.filter((c) => c.url.includes('/payment/purchase')).pop()!;
    assert.equal(purchase.body.amount, 40);
    assert.equal(res.remainingCents, 0);
  });

  it('F-2: an unknown refund outcome stays PENDING and answers 409', async () => {
    refundBehavior = 'network';
    const key = randomUUID();
    let err: Error & { statusCode?: number; errorCode?: string };
    try {
      await refundPayment({ paymentRowId: (await query<{ id: string }>(`SELECT id FROM payments WHERE external_payment_ref = 'SQPAY-R1'`)).rows[0].id, amountCents: 1000, idempotencyKey: key });
      assert.fail('must throw on unknown outcome');
    } catch (e) { err = e as typeof err; }
    assert.equal(err!.statusCode, 409);
    assert.equal(err!.errorCode, 'refund_state_unknown');
    const row = await query<{ status: string }>(`SELECT status FROM refunds WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'PENDING');
    // The same key retries safely without re-calling the POS.
    const postsBefore = calls.filter((c) => c.method === 'POST' && c.url.includes('/v2/refunds')).length;
    try {
      await refundPayment({ paymentRowId: (await query<{ id: string }>(`SELECT id FROM payments WHERE external_payment_ref = 'SQPAY-R1'`)).rows[0].id, amountCents: 1000, idempotencyKey: key });
      assert.fail('retry must throw too');
    } catch (e) { err = e as typeof err; }
    assert.equal(err!.statusCode, 409);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/v2/refunds')).length, postsBefore, 'a PENDING refund must not be re-sent');
  });

  it('F-2: a definitive rejection fails the refund and a retry completes it', async () => {
    refundBehavior = 'reject';
    const key = randomUUID();
    const paymentId = (await query<{ id: string }>(`SELECT id FROM payments WHERE external_payment_ref = 'SQPAY-R1'`)).rows[0].id;
    let err: Error & { statusCode?: number };
    try {
      await refundPayment({ paymentRowId: paymentId, amountCents: 1000, idempotencyKey: key });
      assert.fail('must throw on definitive rejection');
    } catch (e) { err = e as typeof err; }
    assert.equal(err!.statusCode, 400);
    let row = await query<{ status: string }>(`SELECT status FROM refunds WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'FAILED');
    refundBehavior = 'ok';
    const res = await refundPayment({ paymentRowId: paymentId, amountCents: 1000, idempotencyKey: key });
    assert.equal(res.pos_refund_ref, 'SQREF1');
    row = await query<{ status: string }>(`SELECT status FROM refunds WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'COMPLETED');
  });
});
