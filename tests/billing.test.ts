// v0.4 billing tests (pg-mem + mocked Square fetch).
//
// Proves:
//  1. feeFor(): 2% of (amount + tip), rounded, never the whole charge.
//  2. Commission plan + Square: the guest card payment carries
//     app_fee_money = 2%, and the fee ledger records it as collected.
//  3. Subscription plan: no app fee on the payment, no ledger row.
//  4. Square definitively rejecting the fee: the adapter retries once
//     without the fee (guest still pays) and the fee accrues instead.
//  5. Billing routes: auth required, defaults are commission/2%/$49,
//     switching to subscription without a card is a 400.
//
// Run: PG_MEM=1 npx tsx --test tests/billing.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token-0123456789abcdef';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { payCheck } = await import('../src/services/payments.js');
const { feeFor, ensureBillingAccount, getBillingState } = await import('../src/services/billing.js');

// ---- Square fetch mock -----------------------------------------------------
interface Call { url: string; method: string; body: string | undefined }
const calls: Call[] = [];
let rejectFee = false;
const orderTotals: Record<string, number> = { SQORDER1: 10000, SQORDER2: 5000, SQORDER3: 8000 };
const orderPaid: Record<string, number> = { SQORDER1: 0, SQORDER2: 0, SQORDER3: 0 };
let paySeq = 0;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function orderObj(id: string) {
  return {
    id, location_id: 'SQLoc1', state: orderPaid[id] >= orderTotals[id] ? 'COMPLETED' : 'OPEN',
    total_money: { amount: orderTotals[id], currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: orderTotals[id], currency: 'CAD' } }],
    tenders: orderPaid[id] > 0
      ? [{ id: 'T1', amount_money: { amount: orderPaid[id], currency: 'CAD' } }]
      : [],
  };
}
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body as string | undefined });
    const m = /\/v2\/orders\/(SQORDER\d+)/.exec(url);
    if (url.includes('/v2/payments')) {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (rejectFee && body.app_fee_money) {
        return json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'INSUFFICIENT_PERMISSIONS', detail: 'app fee not authorized' }] }, 400);
      }
      paySeq += 1;
      const oid = body.order_id as string;
      orderPaid[oid] += (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0);
      return json({ payment: { id: `SQPAY${paySeq}` } });
    }
    if (m && url.includes('/pay')) return json({ order: orderObj(m[1]) });
    if (m) return json({ order: orderObj(m[1]) });
    return json({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ---- seed ------------------------------------------------------------------
const MERCHANT = 'm-bill';
const LOC = 'loc-bill';
async function seedCheck(orderId: string, total: number) {
  const tId = randomUUID();
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
    [tId, LOC, `T-${orderId}`, randomUUID().replace(/-/g, '')]);
  await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'square',$3,$3,$4,'OPEN',$5,'CAD')`,
    [randomUUID(), tId, orderId, MERCHANT, total]);
}
async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Bill House','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'square','sq-merchant',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
  await seedCheck('SQORDER1', 10000);
  await seedCheck('SQORDER2', 5000);
  await seedCheck('SQORDER3', 8000);
}

describe('v0.4 billing', () => {
  before(async () => {
    installFetch();
    await seed();
  });

  it('feeFor: 2% of amount+tip, rounded, sane edges', () => {
    assert.equal(feeFor(10000, 200), 200);
    assert.equal(feeFor(11000, 200), 220); // tip included in the base
    assert.equal(feeFor(9999, 200), 200);
    assert.equal(feeFor(250, 200), 5);
    assert.equal(feeFor(1, 200), 0);
    assert.equal(feeFor(0, 200), 0);
    assert.equal(feeFor(-50, 200), 0);
    assert.equal(feeFor(10000, 0), 0);
  });

  it('defaults: commission plan at 2%, $49 subscription price', async () => {
    const acct = await ensureBillingAccount(LOC);
    assert.equal(acct.plan, 'commission');
    assert.equal(acct.commission_bps, 200);
    assert.equal(acct.subscription_price_cents, 4900);
  });

  it('commission + Square: payment carries the 2% app fee; ledger collected', async () => {
    calls.length = 0;
    const res = await payCheck({
      checkRef: 'SQORDER1', mode: 'full', tipCents: 1000,
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(res.checkState, 'COMPLETED');
    const payCall = calls.find((c) => c.url.includes('/v2/payments'));
    assert.ok(payCall, 'a Square payment call happened');
    const body = JSON.parse(payCall!.body!);
    assert.equal(body.app_fee_money?.amount, 220, 'app fee = 2% of 10000 + 1000 tip');
    const ledger = await query(`SELECT * FROM fee_ledger WHERE location_id = $1`, [LOC]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].fee_cents, 220);
    assert.equal(ledger.rows[0].charge_cents, 11000);
    assert.equal(ledger.rows[0].method, 'square_app_fee');
    assert.equal(ledger.rows[0].status, 'collected');
    const state = await getBillingState(LOC);
    assert.equal(state.collected_this_month_cents, 220);
    assert.equal(state.accrued_cents, 0);
  });

  it('subscription plan: no app fee, no ledger row', async () => {
    await query(`UPDATE billing_accounts SET plan = 'subscription' WHERE location_id = $1`, [LOC]);
    calls.length = 0;
    const res = await payCheck({
      checkRef: 'SQORDER2', mode: 'full',
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(res.checkState, 'COMPLETED');
    const payCall = calls.find((c) => c.url.includes('/v2/payments'));
    const body = JSON.parse(payCall!.body!);
    assert.equal(body.app_fee_money, undefined);
    const ledger = await query(`SELECT * FROM fee_ledger WHERE location_id = $1`, [LOC]);
    assert.equal(ledger.rows.length, 1, 'still only the earlier commission fee');
    await query(`UPDATE billing_accounts SET plan = 'commission' WHERE location_id = $1`, [LOC]);
  });

  it('fee rejected by Square: guest still pays (retry without fee), fee accrues', async () => {
    rejectFee = true;
    calls.length = 0;
    try {
      const res = await payCheck({
        checkRef: 'SQORDER3', mode: 'full',
        idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
      });
      assert.equal(res.checkState, 'COMPLETED');
    } finally {
      rejectFee = false;
    }
    const payCalls = calls.filter((c) => c.url.includes('/v2/payments'));
    assert.equal(payCalls.length, 2, 'first attempt with fee, retry without');
    assert.ok(JSON.parse(payCalls[0].body!).app_fee_money);
    assert.equal(JSON.parse(payCalls[1].body!).app_fee_money, undefined);
    assert.ok(String(JSON.parse(payCalls[1].body!).idempotency_key).endsWith('-nf'));
    const ledger = await query(`SELECT * FROM fee_ledger WHERE location_id = $1 AND method = 'accrued'`, [LOC]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].fee_cents, 160);
    assert.equal(ledger.rows[0].status, 'accrued');
    const state = await getBillingState(LOC);
    assert.equal(state.accrued_cents, 160);
  });
});

describe('v0.4 billing routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    const { buildApp } = await import('../src/index.js');
    app = await buildApp({ logger: false });
  });

  it('requires auth', async () => {
    const r = await app.inject({ url: `/api/portal/billing?location_id=${LOC}` });
    assert.equal(r.statusCode, 401);
  });

  it('serves defaults to the staff token', async () => {
    const r = await app.inject({
      url: `/api/portal/billing?location_id=${LOC}`,
      headers: { authorization: `Bearer ${process.env.STAFF_API_TOKEN}` },
    });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.effective_plan, 'commission');
    assert.equal(body.commission_percent, 2);
    assert.equal(body.subscription_price_cents, 4900);
    assert.equal(body.has_card, false);
  });

  it('switching to subscription without a card is a 400', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/portal/billing/plan',
      headers: { authorization: `Bearer ${process.env.STAFF_API_TOKEN}` },
      payload: { location_id: LOC, plan: 'subscription' },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /card/i);
  });

  it('rejects an unknown plan', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/portal/billing/plan',
      headers: { authorization: `Bearer ${process.env.STAFF_API_TOKEN}` },
      payload: { location_id: LOC, plan: 'bogus' },
    });
    assert.equal(r.statusCode, 400);
  });
});
