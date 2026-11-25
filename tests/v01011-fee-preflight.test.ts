// v0.10.11 regression test for the app-fee PRE-FLIGHT, from the live
// failure of 2026-11-25: a guest paying the $25.20 CAD demo check was
// told "card declined" and the payments row landed FAILED, yet Square
// held NO payment object at all — the fee'd CreatePayment was rejected
// at validation (the standing application-currency app-fee rejection:
// the app owner's account is USD, the charge is CAD), and the designed
// no-fee retry never landed, because a fee rejection can consume the
// guest's single-use card nonce before the fee is validated.
//
// The fix decides the fee BEFORE the first attempt: when the platform
// (application owner) currency differs from the charge currency, the
// charge goes out fee-free and the fee accrues in the ledger.
//
//  1. Platform USD + charge CAD + fee -> exactly ONE CreatePayment,
//     WITHOUT app_fee_money, feeCollected=false.
//  2. Platform CAD + charge CAD + fee -> the fee rides in-flight,
//     feeCollected=true.
//  3. Platform currency lookup fails -> historical behaviour preserved:
//     fee attempted, currency rejection, one no-fee retry.
//
// Run: PG_MEM=1 npx tsx --test tests/v01011-fee-preflight.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
if (!process.env.SQUARE_ACCESS_TOKEN) process.env.SQUARE_ACCESS_TOKEN = 'plat-token';

const { squareAdapter } = await import('../src/services/pos/square.js');
const { invalidatePlatformCurrencyCache } = await import('../src/square.js');

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let platMode: 'USD' | 'CAD' | 'error' = 'USD';
const paymentBodies: { app_fee_money?: unknown; idempotency_key?: string }[] = [];

const closedOrder = {
  id: 'ORD-1',
  state: 'OPEN',
  total_money: { amount: 2520, currency: 'CAD' },
  net_amount_due_money: { amount: 0, currency: 'CAD' },
  line_items: [{ name: 'Demo Burger', quantity: '2', total_money: { amount: 2520, currency: 'CAD' } }],
  tenders: [
    { id: 'T-1', payment_id: 'SQPAY-1', type: 'CARD', amount_money: { amount: 2520, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' } },
  ],
};

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/v2/locations') && method === 'GET') {
      if (platMode === 'error') return jsonRes({ errors: [{ code: 'INTERNAL', detail: 'boom' }] }, 500);
      return jsonRes({ locations: [{ id: 'PLAT-LOC', status: 'ACTIVE', currency: platMode, name: 'Platform' }] });
    }
    if (url.endsWith('/v2/payments') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      paymentBodies.push(body);
      if (body.app_fee_money && platMode !== 'CAD') {
        // Live Square shape when the application owner's account
        // currency (here USD, or an undecidable lookup) differs from
        // the CAD charge currency.
        return jsonRes(
          { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'This application is not allowed to accept currency CAD.' }] },
          400,
        );
      }
      return jsonRes({ payment: { id: 'SQPAY-1', status: 'APPROVED' } });
    }
    if (url.endsWith('/v2/orders/ORD-1') && method === 'GET') return jsonRes({ order: closedOrder });
    if (url.endsWith('/v2/orders/ORD-1/pay') && method === 'POST') return jsonRes({ order: closedOrder });
    return jsonRes({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
}

const chargeArgs = {
  checkId: 'ORD-1',
  amountCents: 2520,
  currency: 'CAD',
  cardToken: 'cnon:card-nonce-ok',
  tipCents: 0,
  priorPaymentIds: [] as string[],
  token: 'merchant-token',
  appFeeCents: 50,
};

describe('v0.10.11 Square app-fee pre-flight', () => {
  before(() => installFetch());
  after(() => { (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch; });

  it('platform currency != charge currency: fee skipped in-flight, single fee-free charge', async () => {
    platMode = 'USD';
    invalidatePlatformCurrencyCache();
    paymentBodies.length = 0;
    const out = await squareAdapter.chargeCard({ ...chargeArgs, idempotencyKey: 'preflight-1' });
    assert.equal(out.paymentId, 'SQPAY-1');
    assert.equal(out.feeCollected, false, 'fee must accrue, not ride in-flight');
    assert.equal(out.remainingCents, 0);
    assert.equal(paymentBodies.length, 1, 'the doomed fee attempt must never happen');
    assert.equal(paymentBodies[0].app_fee_money, undefined);
    assert.equal(paymentBodies[0].idempotency_key, 'preflight-1', 'the guest key is used directly, not the -nf retry key');
  });

  it('platform currency == charge currency: fee rides in-flight as before', async () => {
    platMode = 'CAD';
    invalidatePlatformCurrencyCache();
    paymentBodies.length = 0;
    const out = await squareAdapter.chargeCard({ ...chargeArgs, idempotencyKey: 'preflight-2' });
    assert.equal(out.paymentId, 'SQPAY-1');
    assert.equal(out.feeCollected, true, 'matching currencies: the fee is collected in-flight');
    assert.equal(paymentBodies.length, 1, 'no retry needed when the fee is accepted');
    assert.deepEqual(paymentBodies[0].app_fee_money, { amount: 50, currency: 'CAD' });
  });

  it('platform currency lookup fails: historical attempt-and-retry is preserved', async () => {
    platMode = 'error';
    invalidatePlatformCurrencyCache();
    paymentBodies.length = 0;
    const out = await squareAdapter.chargeCard({ ...chargeArgs, idempotencyKey: 'preflight-3' });
    assert.equal(out.paymentId, 'SQPAY-1');
    assert.equal(out.feeCollected, false);
    assert.equal(paymentBodies.length, 2, 'fee attempted once, then the no-fee retry');
    assert.ok(paymentBodies[0].app_fee_money);
    assert.equal(paymentBodies[1].app_fee_money, undefined);
    assert.equal(paymentBodies[1].idempotency_key, 'preflight-3-nf');
  });
});
