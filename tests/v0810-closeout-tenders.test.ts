// v0.8.10 regression tests for the Square close-out stall proven live
// 2026-10-25: after a guest charge (autocomplete:false), the order's
// net_amount_due_money stayed at the FULL total even though the new
// payment's tender sat on the order covering it — Square settles an
// authorized payment only at PayOrder. chargeCard's post-charge gate
// trusted net_amount_due, read "fully unpaid", and returned down the
// partial path: the payment parked at AUTHORIZED and the order never
// closed. (The v0.8.4 fixtures modelled net_amount_due as already 0,
// so the suite stayed green while the live path was broken.)
//
//  1. Full coverage by tenders + net_amount_due still showing the
//     full total -> chargeCard closes via PayOrder, remaining 0.
//  2. Genuine partial coverage -> returns the tender-based remaining
//     and does NOT call PayOrder.
//
// Run: PG_MEM=1 npx tsx --test tests/v0810-closeout-tenders.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { squareAdapter } = await import('../src/services/pos/square.js');
const { orderTenderRemaining } = await import('../src/square.js');

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// The trap fixture: tenders cover the bill (2760 incl. 360 tip on a
// 2400 total), but net_amount_due still shows the full 2400.
const authCoveredOrder = {
  id: 'ORD-AUTH-1',
  state: 'OPEN',
  total_money: { amount: 2400, currency: 'CAD' },
  net_amount_due_money: { amount: 2400, currency: 'CAD' },
  total_tip_money: { amount: 360, currency: 'CAD' },
  line_items: [{ name: 'Demo Burger', quantity: '2', total_money: { amount: 2400, currency: 'CAD' } }],
  tenders: [
    { id: 'T-A', payment_id: 'SQPAY-A', type: 'CARD', amount_money: { amount: 2760, currency: 'CAD' }, tip_money: { amount: 360, currency: 'CAD' } },
  ],
};
const closedOrder = {
  ...authCoveredOrder,
  state: 'COMPLETED',
  net_amount_due_money: { amount: 0, currency: 'CAD' },
};
const partialOrder = {
  id: 'ORD-PART-2',
  state: 'OPEN',
  total_money: { amount: 5000, currency: 'CAD' },
  net_amount_due_money: { amount: 5000, currency: 'CAD' },
  line_items: [{ name: 'Tasting menu', quantity: '1', total_money: { amount: 5000, currency: 'CAD' } }],
  tenders: [
    { id: 'T-P', payment_id: 'SQPAY-P', type: 'CARD', amount_money: { amount: 2000, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' } },
  ],
};

const payOrderCalls: string[] = [];
const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/v2/payments') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const id = body.order_id === 'ORD-AUTH-1' ? 'SQPAY-A' : 'SQPAY-P';
      return jsonRes({ payment: { id, status: 'APPROVED' } });
    }
    if (url.endsWith('/v2/orders/ORD-AUTH-1') && method === 'GET') return jsonRes({ order: authCoveredOrder });
    if (url.endsWith('/v2/orders/ORD-PART-2') && method === 'GET') return jsonRes({ order: partialOrder });
    if (url.endsWith('/v2/orders/ORD-AUTH-1/pay') && method === 'POST') {
      payOrderCalls.push('ORD-AUTH-1');
      return jsonRes({ order: closedOrder });
    }
    if (url.endsWith('/v2/orders/ORD-PART-2/pay') && method === 'POST') {
      payOrderCalls.push('ORD-PART-2');
      return jsonRes({ order: partialOrder });
    }
    return jsonRes({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
}

describe('v0.8.10 Square close-out judges coverage from tenders', () => {
  before(() => installFetch());
  after(() => { (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch; });

  it('orderTenderRemaining: amount minus tip is the coverage', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(orderTenderRemaining(authCoveredOrder as any), 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(orderTenderRemaining(partialOrder as any), 3000);
  });

  it('full tender coverage closes via PayOrder even when net_amount_due lags', async () => {
    payOrderCalls.length = 0;
    const out = await squareAdapter.chargeCard({
      checkId: 'ORD-AUTH-1',
      amountCents: 2400,
      currency: 'CAD',
      cardToken: 'cnon:card-nonce-ok',
      tipCents: 360,
      idempotencyKey: 'auth-close-1',
      priorPaymentIds: [],
      token: 'test-token',
    });
    assert.equal(out.paymentId, 'SQPAY-A');
    assert.equal(out.remainingCents, 0, 'covered order must report 0 remaining');
    assert.deepEqual(payOrderCalls, ['ORD-AUTH-1'], 'PayOrder must be called to settle the authorization');
  });

  it('genuine partial coverage returns tender-based remaining, no PayOrder', async () => {
    payOrderCalls.length = 0;
    const out = await squareAdapter.chargeCard({
      checkId: 'ORD-PART-2',
      amountCents: 2000,
      currency: 'CAD',
      cardToken: 'cnon:card-nonce-ok',
      tipCents: 0,
      idempotencyKey: 'auth-close-2',
      priorPaymentIds: [],
      token: 'test-token',
    });
    assert.equal(out.remainingCents, 3000);
    assert.deepEqual(payOrderCalls, [], 'PayOrder must not run for a partial payment');
  });
});
