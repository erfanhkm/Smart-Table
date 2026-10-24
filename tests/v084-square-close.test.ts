// v0.8.4 regression tests for the Square close-out bug proven live
// 2026-10-24: a guest's charge (with tip + app fee) SUCCEEDED at Square,
// then chargeCard's PayOrder call rejected because its payment-id list
// omitted a pre-existing POS tender (recorded directly in Square — no
// row in our payments table). chargeCard threw, payments.ts marked the
// paid bill FAILED and the Square payment id was lost.
//
//  1. orderRemaining prefers Square's net_amount_due_money (tip-aware).
//  2. orderRemaining fallback subtracts each tender's tip exactly once.
//  3. chargeCard closes a fully covered order with EVERY tendered
//     payment id from the order itself (external tender included).
//  4. chargeCard still resolves (payment id + remaining 0) when PayOrder
//     rejects AFTER the charge landed — never orphans a paid bill.
//  5. chargeCard resolves with remainingCents null when the post-charge
//     order read fails (F3-1 semantics).
//  6. chargeCard still throws on a definitive card decline (no charge
//     landed — the failure must surface).
//  7. A partial payment returns the tip-aware remaining and does NOT
//     call PayOrder.
//
// Run: PG_MEM=1 npx tsx --test tests/v084-square-close.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { orderRemaining } = await import('../src/square.js');
const { squareAdapter } = await import('../src/services/pos/square.js');

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Mutable Square fixtures ------------------------------------------------
let paymentsMode: 'ok' | 'decline' = 'ok';
let payOrderMode: 'ok' | 'fail' = 'ok';
const payOrderBodies: { payment_ids?: string[] }[] = [];

const closedOrder = {
  id: 'ORD-CLOSE-1',
  state: 'OPEN',
  total_money: { amount: 2400, currency: 'USD' },
  net_amount_due_money: { amount: 0, currency: 'USD' },
  total_tip_money: { amount: 210, currency: 'USD' },
  line_items: [{ name: 'Demo Burger', quantity: '2', total_money: { amount: 2400, currency: 'USD' } }],
  tenders: [
    { id: 'T-EXT', payment_id: 'EXTPAY1', type: 'OTHER', amount_money: { amount: 1000, currency: 'USD' }, tip_money: { amount: 0, currency: 'USD' } },
    { id: 'T-CARD', payment_id: 'SQPAY1', type: 'CARD', amount_money: { amount: 1610, currency: 'USD' }, tip_money: { amount: 210, currency: 'USD' } },
  ],
};
const partialOrder = {
  id: 'ORD-PART-1',
  state: 'OPEN',
  total_money: { amount: 13000, currency: 'CAD' },
  net_amount_due_money: { amount: 8000, currency: 'CAD' },
  line_items: [{ name: 'Tasting menu', quantity: '1', total_money: { amount: 13000, currency: 'CAD' } }],
  tenders: [
    { id: 'T-P', payment_id: 'SQPAY1', type: 'CARD', amount_money: { amount: 5750, currency: 'CAD' }, tip_money: { amount: 750, currency: 'CAD' } },
  ],
};

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/v2/payments') && method === 'POST') {
      if (paymentsMode === 'decline') {
        return jsonRes({ errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'CARD_DECLINED', detail: 'Card declined.' }] }, 402);
      }
      return jsonRes({ payment: { id: 'SQPAY1', status: 'APPROVED' } });
    }
    if (url.endsWith('/v2/orders/ORD-CLOSE-1') && method === 'GET') return jsonRes({ order: closedOrder });
    if (url.endsWith('/v2/orders/ORD-PART-1') && method === 'GET') return jsonRes({ order: partialOrder });
    if (url.endsWith('/v2/orders/ORD-NOREAD-1') && method === 'GET') {
      return jsonRes({ errors: [{ code: 'INTERNAL_SERVER_ERROR', detail: 'boom' }] }, 500);
    }
    if (url.endsWith('/v2/orders/ORD-CLOSE-1/pay') && method === 'POST') {
      payOrderBodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (payOrderMode === 'fail') {
        return jsonRes({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'payment ids do not cover the order' }] }, 400);
      }
      return jsonRes({ order: { ...closedOrder, state: 'COMPLETED' } });
    }
    return jsonRes({ errors: [{ code: 'NOT_FOUND', detail: `unmocked ${method} ${url}` }] }, 404);
  }) as typeof fetch;
}

const baseArgs = {
  amountCents: 1400,
  currency: 'USD',
  cardToken: 'cnon:card-nonce-ok',
  tipCents: 210,
  priorPaymentIds: [] as string[],
  token: 'test-token',
  appFeeCents: 32,
};

describe('v0.8.4 Square close-out', () => {
  before(() => installFetch());
  after(() => { globalThis.fetch = origFetch; });

  it('orderRemaining prefers net_amount_due_money (tips excluded)', () => {
    assert.equal(orderRemaining(closedOrder as never), 0);
    assert.equal(orderRemaining(partialOrder as never), 8000);
  });

  it('orderRemaining fallback subtracts each tender tip exactly once', () => {
    const noNet = {
      total_money: { amount: 13000, currency: 'CAD' },
      tenders: [{ amount_money: { amount: 5750 }, tip_money: { amount: 750 } }],
    };
    assert.equal(orderRemaining(noNet as never), 8000);
    const noTipField = {
      total_money: { amount: 2400, currency: 'USD' },
      tenders: [{ amount_money: { amount: 1000 } }],
    };
    assert.equal(orderRemaining(noTipField as never), 1400);
  });

  it('chargeCard closes with EVERY tendered payment id from the order', async () => {
    paymentsMode = 'ok'; payOrderMode = 'ok'; payOrderBodies.length = 0;
    const res = await squareAdapter.chargeCard!({ ...baseArgs, checkId: 'ORD-CLOSE-1', idempotencyKey: 'k-close-1' });
    assert.equal(res.paymentId, 'SQPAY1');
    assert.equal(res.remainingCents, 0);
    assert.equal(res.feeCollected, true);
    assert.equal(payOrderBodies.length, 1);
    assert.deepEqual(payOrderBodies[0].payment_ids, ['EXTPAY1', 'SQPAY1']);
  });

  it('chargeCard resolves even when PayOrder rejects after the charge landed', async () => {
    paymentsMode = 'ok'; payOrderMode = 'fail'; payOrderBodies.length = 0;
    const res = await squareAdapter.chargeCard!({ ...baseArgs, checkId: 'ORD-CLOSE-1', idempotencyKey: 'k-close-2' });
    assert.equal(res.paymentId, 'SQPAY1');
    assert.equal(res.remainingCents, 0);
  });

  it('chargeCard returns remainingCents null when the post-charge read fails', async () => {
    paymentsMode = 'ok';
    const res = await squareAdapter.chargeCard!({ ...baseArgs, checkId: 'ORD-NOREAD-1', idempotencyKey: 'k-noread' });
    assert.equal(res.paymentId, 'SQPAY1');
    assert.equal(res.remainingCents, null);
  });

  it('chargeCard throws on a definitive card decline (nothing landed)', async () => {
    paymentsMode = 'decline';
    await assert.rejects(
      squareAdapter.chargeCard!({ ...baseArgs, checkId: 'ORD-CLOSE-1', idempotencyKey: 'k-decline' }),
    );
    paymentsMode = 'ok';
  });

  it('a partial payment returns the tip-aware remaining and skips PayOrder', async () => {
    payOrderBodies.length = 0;
    const res = await squareAdapter.chargeCard!({
      ...baseArgs, checkId: 'ORD-PART-1', idempotencyKey: 'k-part',
      amountCents: 5000, tipCents: 750, currency: 'CAD', appFeeCents: 115,
    });
    assert.equal(res.remainingCents, 8000);
    assert.equal(payOrderBodies.length, 0);
  });
});
