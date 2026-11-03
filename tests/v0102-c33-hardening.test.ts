// v0.10.2 — Claude cycle-3 C3-3 hardening tests (pg-mem + mocked POS fetch).
//
// Proves:
//  C3-3-1  a failed PayOrder after a successful Square authorization is
//          reported as UNKNOWN remaining (null), never as fully paid (0);
//          the PayOrder idempotency key is deterministic (<key>:payorder).
//          A successful PayOrder still reports 0.
//  C3-3-3  refundPayment on an APPROVED order-attached payment older than
//          10 minutes says the payment is STUCK (close-out never ran),
//          while a fresh one keeps the "still settling" message.
//  C3-3-4  the Square payment.updated webhook applies forward-only
//          transitions: PENDING -> AUTHORIZED -> COMPLETED, and a late
//          APPROVED event never regresses a COMPLETED row.
//  Low     listOpenChecks skips one malformed order instead of failing
//          the whole list.
//  Low     the shared menu cache is single-flight: concurrent misses for
//          one location share one underlying catalog fetch.
//
// Run: PG_MEM=1 npx tsx --test tests/v0102-c33-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'sq-test-token';
process.env.SQUARE_APP_ID = 'sq0idp-test';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { squareAdapter } = await import('../src/services/pos/square.js');
const { getMenuCached } = await import('../src/services/pos/menu-cache.js');
const { buildApp } = await import('../src/index.js');

// ---- fetch mock -------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let payOrderFails = false;
const payOrderKeys: string[] = [];

function coveredOrder() {
  return {
    id: 'ORD-C33', location_id: 'SQLoc1', state: 'OPEN',
    total_money: { amount: 5000, currency: 'CAD' },
    // Stale on purpose: net_amount_due does not fall for authorize-only
    // payments (v0.8.10) — tender coverage is the truth here.
    net_amount_due_money: { amount: 5000, currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: 5000, currency: 'CAD' } }],
    tenders: [{
      id: 'T1', payment_id: 'SQPAY-C33', type: 'CARD',
      amount_money: { amount: 5000, currency: 'CAD' },
      tip_money: { amount: 0, currency: 'CAD' },
    }],
  };
}

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    if (u.pathname === '/v2/payments' && method === 'POST') {
      return json({ payment: { id: 'SQPAY-C33', status: 'APPROVED' } });
    }
    if (u.pathname === '/v2/orders/ORD-C33' && method === 'GET') {
      return json({ order: coveredOrder() });
    }
    if (/\/v2\/orders\/[^/]+\/pay$/.test(u.pathname) && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { idempotency_key?: string };
      payOrderKeys.push(String(body.idempotency_key ?? ''));
      if (payOrderFails) return json({ errors: [{ code: 'GENERIC_DECLINE', detail: 'payorder boom' }] }, 500);
      return json({ order: { ...coveredOrder(), state: 'COMPLETED' } });
    }
    if (u.pathname === '/v2/orders/search' && method === 'POST') {
      return json({
        orders: [
          {
            id: 'ORD-GOOD', location_id: 'SQLoc1', state: 'OPEN', created_at: '2026-11-03T00:00:00Z',
            total_money: { amount: 1000, currency: 'CAD' },
            net_amount_due_money: { amount: 1000, currency: 'CAD' },
            line_items: [], tenders: [],
          },
          // Malformed: no total_money and no net_amount_due_money.
          { id: 'ORD-BAD', location_id: 'SQLoc1', state: 'OPEN', line_items: [], tenders: [] },
        ],
      });
    }
    if (u.pathname === '/v2/payments/SQPAY-STUCK' && method === 'GET') {
      return json({
        payment: {
          id: 'SQPAY-STUCK', source_type: 'CARD', status: 'APPROVED', order_id: 'ORD-C33',
          created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
          amount_money: { amount: 5000, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' },
        },
      });
    }
    if (u.pathname === '/v2/payments/SQPAY-FRESH' && method === 'GET') {
      return json({
        payment: {
          id: 'SQPAY-FRESH', source_type: 'CARD', status: 'APPROVED', order_id: 'ORD-C33',
          created_at: new Date().toISOString(),
          amount_money: { amount: 5000, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' },
        },
      });
    }
    return json({ errors: [{ code: 'NOT_FOUND', detail: `unexpected: ${method} ${url}` }] }, 404);
  }) as typeof fetch;
}

// ---- tests ------------------------------------------------------------------
describe('v0.10.2 C3-3 hardening', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const PAY_ID = randomUUID();

  before(async () => {
    installFetch();
    await migrate();
    // Seed for the webhook flow test: merchant/location/table/check/payment.
    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ('m-c33','square','sq-m',$1,$2)`, [encryptSecret('x'), encryptSecret('x')]);
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
       VALUES ('loc-c33','m-c33','square','SQLoc1','SQLoc1','C33 House','CAD')`,
    );
    const tId = randomUUID();
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,'loc-c33','1',$2,'SEATED')`,
      [tId, randomUUID().replace(/-/g, '')]);
    const cId = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,'loc-c33','square','ORD-C33','ORD-C33','m-c33','OPEN',5000,'CAD')`,
      [cId, tId],
    );
    await query(
      `INSERT INTO payments(id, check_id, square_payment_id, amount_cents, status, idempotency_key)
       VALUES ($1,$2,'SQPAY-W1',5000,'PENDING','k-c33-w1')`,
      [PAY_ID, cId],
    );
    app = await buildApp();
    await app.ready();
  });

  after(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
  });

  it('C3-3-1: a failed PayOrder after authorization reports unknown remaining, with a deterministic key', async () => {
    payOrderFails = true;
    payOrderKeys.length = 0;
    const res = await squareAdapter.chargeCard!({
      checkId: 'ORD-C33', amountCents: 5000, currency: 'CAD', cardToken: 'cnon:test',
      tipCents: 0, idempotencyKey: 'pay-c33-1', priorPaymentIds: [], token: 'tok',
    });
    assert.equal(res.paymentId, 'SQPAY-C33');
    assert.equal(res.remainingCents, null);
    assert.deepEqual(payOrderKeys, ['pay-c33-1:payorder']);
  });

  it('C3-3-1: a successful PayOrder still reports fully paid', async () => {
    payOrderFails = false;
    payOrderKeys.length = 0;
    const res = await squareAdapter.chargeCard!({
      checkId: 'ORD-C33', amountCents: 5000, currency: 'CAD', cardToken: 'cnon:test',
      tipCents: 0, idempotencyKey: 'pay-c33-2', priorPaymentIds: [], token: 'tok',
    });
    assert.equal(res.remainingCents, 0);
    assert.deepEqual(payOrderKeys, ['pay-c33-2:payorder']);
  });

  it('C3-3-3: an old APPROVED order payment is reported stuck; a fresh one is still settling', async () => {
    await assert.rejects(
      squareAdapter.refundPayment!({ paymentId: 'SQPAY-STUCK', amountCents: 5000, currency: 'CAD', idempotencyKey: 'r1', token: 'tok' }),
      /stuck/,
    );
    await assert.rejects(
      squareAdapter.refundPayment!({ paymentId: 'SQPAY-FRESH', amountCents: 5000, currency: 'CAD', idempotencyKey: 'r2', token: 'tok' }),
      /still settling/,
    );
  });

  it('Low: listOpenChecks skips a malformed order and keeps the good one', async () => {
    const list = await squareAdapter.listOpenChecks('SQLoc1', 'tok');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ORD-GOOD');
    assert.equal(list[0].remainingCents, 1000);
  });

  it('Low: the menu cache is single-flight for concurrent misses', async () => {
    let calls = 0;
    const stub = {
      posType: 'square',
      getMenu: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return [{ id: 'm1', name: 'X', description: null, priceCents: 100, currency: 'CAD', category: null, imageUrl: null }];
      },
    };
    const [a, b] = await Promise.all([
      getMenuCached(stub as never, 'square', 'LOC-SF', undefined),
      getMenuCached(stub as never, 'square', 'LOC-SF', undefined),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    const c = await getMenuCached(stub as never, 'square', 'LOC-SF', undefined);
    assert.equal(calls, 1); // cache hit after the flight lands
    assert.equal(c.length, 1);
  });

  it('C3-3-4: payment.updated moves forward only and never regresses a COMPLETED row', async () => {
    const evt = (eid: string, status: string) => ({
      method: 'POST' as const, url: '/api/webhooks/square',
      payload: { event_id: eid, type: 'payment.updated', data: { object: { payment: { id: 'SQPAY-W1', status } } } },
    });
    const status = async () => (await query(`SELECT status FROM payments WHERE id=$1`, [PAY_ID])).rows[0].status;
    assert.equal((await app.inject(evt('evt-c33-1', 'APPROVED'))).statusCode, 200);
    assert.equal(await status(), 'AUTHORIZED');
    assert.equal((await app.inject(evt('evt-c33-2', 'COMPLETED'))).statusCode, 200);
    assert.equal(await status(), 'COMPLETED');
    assert.equal((await app.inject(evt('evt-c33-3', 'APPROVED'))).statusCode, 200);
    assert.equal(await status(), 'COMPLETED');
  });
});
