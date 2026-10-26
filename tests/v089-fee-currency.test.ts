// v0.8.9 regression test for the app-fee currency rejection, proven live
// 2026-10-25: with the demo location switched to the CAD Square sandbox
// account, a guest charge carrying app_fee_money was rejected by Square
// with 400 BAD_REQUEST "This application is not allowed to accept
// currency CAD" (the app lives under a US test account). The D-4 fee
// classifier didn't recognize the shape, so the guest payment FAILED
// instead of degrading to the designed no-fee retry + ledger accrual.
//
//  1. A fee'd charge rejected with the application-currency error is
//     retried ONCE without the fee and resolves with feeCollected=false.
//  2. A definitive card decline on a fee'd charge still throws — the
//     classifier must not swallow real declines.
//
// Run: PG_MEM=1 npx tsx --test tests/v089-fee-currency.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { squareAdapter } = await import('../src/services/pos/square.js');

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let mode: 'currency-error' | 'decline' = 'currency-error';
const paymentBodies: { app_fee_money?: unknown; idempotency_key?: string }[] = [];

const closedCadOrder = {
  id: 'ORD-CAD-1',
  state: 'OPEN',
  total_money: { amount: 2400, currency: 'CAD' },
  net_amount_due_money: { amount: 0, currency: 'CAD' },
  total_tip_money: { amount: 360, currency: 'CAD' },
  line_items: [{ name: 'Demo Burger', quantity: '2', total_money: { amount: 2400, currency: 'CAD' } }],
  tenders: [
    { id: 'T-CAD', payment_id: 'SQPAY-CAD', type: 'CARD', amount_money: { amount: 2760, currency: 'CAD' }, tip_money: { amount: 360, currency: 'CAD' } },
  ],
};

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/v2/payments') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      paymentBodies.push(body);
      if (mode === 'decline') {
        return jsonRes({ errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'CARD_DECLINED', detail: 'Card declined.' }] }, 402);
      }
      if (body.app_fee_money) {
        return jsonRes(
          { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'This application is not allowed to accept currency CAD.' }] },
          400,
        );
      }
      return jsonRes({ payment: { id: 'SQPAY-CAD', status: 'APPROVED' } });
    }
    if (url.endsWith('/v2/orders/ORD-CAD-1') && method === 'GET') return jsonRes({ order: closedCadOrder });
    if (url.endsWith('/v2/orders/ORD-CAD-1/pay') && method === 'POST') return jsonRes({ order: closedCadOrder });
    return jsonRes({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
}

describe('v0.8.9 Square app-fee currency rejection', () => {
  before(() => installFetch());
  after(() => { (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch; });

  it('retries without the fee and resolves with feeCollected=false', async () => {
    mode = 'currency-error';
    paymentBodies.length = 0;
    const out = await squareAdapter.chargeCard({
      checkId: 'ORD-CAD-1',
      amountCents: 2400,
      currency: 'CAD',
      cardToken: 'cnon:card-nonce-ok',
      tipCents: 360,
      idempotencyKey: 'fee-currency-1',
      appFeeCents: 55,
      priorPaymentIds: [],
      token: 'test-token',
    });
    assert.equal(out.paymentId, 'SQPAY-CAD');
    assert.equal(out.feeCollected, false, 'fee must be reported uncollected so it accrues');
    assert.equal(out.remainingCents, 0);
    assert.equal(paymentBodies.length, 2, 'exactly one retry');
    assert.ok(paymentBodies[0].app_fee_money, 'first attempt carries the fee');
    assert.equal(paymentBodies[1].app_fee_money, undefined, 'retry drops the fee');
    assert.equal(paymentBodies[1].idempotency_key, 'fee-currency-1-nf', 'retry uses the derived -nf key');
  });

  it('a definitive card decline on a fee’d charge still throws, with no retry', async () => {
    mode = 'decline';
    paymentBodies.length = 0;
    await assert.rejects(
      squareAdapter.chargeCard({
        checkId: 'ORD-CAD-1',
        amountCents: 2400,
        currency: 'CAD',
        cardToken: 'cnon:card-nonce-declined',
        tipCents: 360,
        idempotencyKey: 'fee-currency-2',
        appFeeCents: 55,
      priorPaymentIds: [],
        token: 'test-token',
      }),
    );
    assert.equal(paymentBodies.length, 1, 'a decline must never be retried');
  });
});
