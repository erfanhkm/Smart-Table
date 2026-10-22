// v0.6.7 batch-3 tests — Claude cycle-1 section-2 hygiene/robustness.
//
// Proves:
//  1. D-7: ensureFreshSquareToken returns the stored token untouched when
//     expiry is far away; refreshes (and persists to BOTH token stores)
//     when expired/near-expiry; a failed refresh falls back to the
//     stored token instead of throwing.
//  2. E-8: effectivePlan treats a lapsed subscription as commission
//     (non-ACTIVE status, or paid-through in the past) and an ACTIVE,
//     paid-up subscription as subscription.
//  3. C-7: loyalty counts a visit only against a settled payment, once
//     per check.
//  4. C-6: a receipt email binds to the payment_id, claims the one-send
//     slot atomically, and refuses a second send for the same payment.
//  5. C-8: call-waiter lives under the table token; the old bare-UUID
//     route is gone.
//  6. C-9: an order attempt that fails with an UNKNOWN outcome stays
//     PENDING (same key resumable after the stale window), while a
//     definitive POS rejection marks it FAILED.
//  7. D-14: card-config responses carry only publishable fields.
//
// Run: PG_MEM=1 npx tsx --test tests/v067-batch3.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'sq-test-token';
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';
process.env.SQUARE_APP_ID = 'sq0idp-test';
process.env.SQUARE_APP_SECRET = 'sq-secret-test';
process.env.RESEND_API_KEY = 're_test_key';
process.env.RECEIPT_FROM_EMAIL = 'receipts@smarttablepay.com';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret, decryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { ensureFreshSquareToken, refreshExpiringTokens } = await import('../src/services/pos/token-refresh.js');
const { effectivePlan } = await import('../src/services/billing.js');

// ---- fetch mock -------------------------------------------------------------
let oauthBehavior: 'ok' | 'fail' = 'ok';
let orderBehavior: 'ok' | 'network' | 'decline' = 'ok';
const resendCalls: unknown[] = [];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const CATALOG = {
  objects: [
    {
      type: 'ITEM',
      id: 'item1',
      item_data: {
        name: 'Burger',
        variations: [
          { id: 'var1', item_variation_data: { name: 'Regular', price_money: { amount: 1200, currency: 'CAD' } } },
        ],
      },
    },
  ],
};

function orderObj(id: string) {
  return {
    id,
    state: 'OPEN',
    line_items: [
      { uid: 'li1', name: 'Burger', quantity: '1', base_price_money: { amount: 1200, currency: 'CAD' }, total_money: { amount: 1200, currency: 'CAD' } },
    ],
    total_money: { amount: 1200, currency: 'CAD' },
    tenders: [],
  };
}

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('api.resend.com')) {
      resendCalls.push(init?.body);
      return json({ id: 'email_1' });
    }
    if (url.includes('/oauth2/token')) {
      if (oauthBehavior === 'fail') return json({ errors: [{ code: 'BAD', detail: 'nope' }] }, 400);
      return json({ access_token: 'sq-FRESH-token', refresh_token: 'sq-FRESH-refresh', expires_at: '2099-01-01T00:00:00Z', merchant_id: 'm-test' });
    }
    if (url.includes('/v2/catalog/search-catalog-items')) return json(CATALOG);
    if (url.includes('/v2/catalog/search')) return json(CATALOG);
    if (url.includes('/v2/orders') && method === 'POST') {
      if (orderBehavior === 'network') throw new TypeError('fetch failed');
      if (orderBehavior === 'decline') {
        return json({ errors: [{ code: 'BAD_REQUEST', category: 'INVALID_REQUEST_ERROR', detail: 'bad order' }] }, 400);
      }
      return json({ order: orderObj('ord-c9') });
    }
    const m = /\/v2\/orders\/([\w-]+)$/.exec(url);
    if (m && method === 'GET') return json({ order: orderObj(m[1]) });
    return origFetch(input as string, init);
  }) as typeof fetch;
}

// ---- seed helpers -----------------------------------------------------------
async function seedSquareMerchant(suffix: string, expiresAt: string | null): Promise<{ merchantId: string; locationId: string }> {
  const merchantId = randomUUID();
  const locationId = randomUUID();
  await query(
    `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES ($1,'square',$2,$2,$3,$4,$5)`,
    [merchantId, `sqm-${suffix}`, encryptSecret('sq-OLD-token'), encryptSecret('sq-OLD-refresh'), expiresAt],
  );
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, qr_ordering_enabled, loyalty_enabled, loyalty_visits_required, loyalty_reward_text)
     VALUES ($1,$2,'square',$3,$3,'Loc','CAD',false,true,true,5,'Free dessert')`,
    [locationId, merchantId, `SQL-${suffix}`],
  );
  await query(
    `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES ($1,$2,'square',$3,$4,$5,$6)`,
    [randomUUID(), merchantId, `sqm-${suffix}`, encryptSecret('sq-OLD-token'), encryptSecret('sq-OLD-refresh'), expiresAt],
  );
  return { merchantId, locationId };
}

describe('v0.6.7 batch 3', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  before(async () => {
    installFetch();
    await migrate();
    app = await buildApp({ logger: false });
  });

  after(async () => {
    if (app) await app.close();
    // NOTE: the fetch mock stays installed for the whole file — the later
    // describes share it (restoring it here broke their POS/Resend calls).
  });

  it('D-7: a token with distant expiry is used as-is (no refresh call)', async () => {
    const { merchantId } = await seedSquareMerchant('fresh', '2099-06-01T00:00:00Z');
    const cred = await query<{ refresh_token_enc: string; token_expires_at: string }>(
      `SELECT refresh_token_enc, token_expires_at FROM pos_credentials WHERE merchant_id = $1`,
      [merchantId],
    );
    const out = await ensureFreshSquareToken({
      merchantId,
      currentToken: 'sq-OLD-token',
      refreshTokenEnc: cred.rows[0].refresh_token_enc,
      expiresAt: cred.rows[0].token_expires_at,
    });
    assert.equal(out, 'sq-OLD-token');
  });

  it('D-7: an expired token is refreshed and persisted to both stores', async () => {
    oauthBehavior = 'ok';
    const { merchantId } = await seedSquareMerchant('stale', '2020-01-01T00:00:00Z');
    const cred = await query<{ refresh_token_enc: string; token_expires_at: string }>(
      `SELECT refresh_token_enc, token_expires_at FROM pos_credentials WHERE merchant_id = $1`,
      [merchantId],
    );
    const out = await ensureFreshSquareToken({
      merchantId,
      currentToken: 'sq-OLD-token',
      refreshTokenEnc: cred.rows[0].refresh_token_enc,
      expiresAt: cred.rows[0].token_expires_at,
    });
    assert.equal(out, 'sq-FRESH-token');
    const after1 = await query<{ access_token_enc: string }>(
      `SELECT access_token_enc FROM pos_credentials WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(decryptSecret(after1.rows[0].access_token_enc), 'sq-FRESH-token');
    const after2 = await query<{ access_token_enc: string }>(
      `SELECT access_token_enc FROM merchants WHERE id = $1`,
      [merchantId],
    );
    assert.equal(decryptSecret(after2.rows[0].access_token_enc), 'sq-FRESH-token');
  });

  it('D-7: a failed refresh falls back to the stored token', async () => {
    oauthBehavior = 'fail';
    const { merchantId } = await seedSquareMerchant('badrefresh', '2020-01-01T00:00:00Z');
    const cred = await query<{ refresh_token_enc: string; token_expires_at: string }>(
      `SELECT refresh_token_enc, token_expires_at FROM pos_credentials WHERE merchant_id = $1`,
      [merchantId],
    );
    const out = await ensureFreshSquareToken({
      merchantId,
      currentToken: 'sq-OLD-token',
      refreshTokenEnc: cred.rows[0].refresh_token_enc,
      expiresAt: cred.rows[0].token_expires_at,
    });
    assert.equal(out, 'sq-OLD-token');
    oauthBehavior = 'ok';
  });

  it('D-7: the backstop sweep reports unrefreshable credentials', async () => {
    const merchantId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
       VALUES ($1,'square',$2,'','')`,
      [merchantId, 'sqm-norefresh'],
    );
    await query(
      `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,$2,'square','sqm-norefresh',$3,$4, now() + interval '3 days')`,
      [randomUUID(), merchantId, encryptSecret('sq-OLD-token'), encryptSecret('')],
    );
    const r = await refreshExpiringTokens();
    assert.ok(r.unrefreshable >= 1);
  });

  it('E-8: effectivePlan enforces subscription lapse', () => {
    const base = {
      location_id: 'loc-x',
      plan: 'subscription',
      pending_plan: null,
      commission_bps: 200,
      square_customer_id: null,
      square_card_id: null,
      square_subscription_id: 'sub1',
      square_plan_variation_id: null,
      subscription_status: 'ACTIVE',
      subscription_paid_through: '2099-01-01',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    assert.equal(effectivePlan(base), 'subscription');
    assert.equal(effectivePlan({ ...base, subscription_status: 'DEACTIVATED' }), 'commission');
    assert.equal(effectivePlan({ ...base, subscription_paid_through: '2020-01-01' }), 'commission');
    assert.equal(effectivePlan({ ...base, plan: 'commission' }), 'commission');
  });
});

describe('v0.6.7 batch 3 — guest endpoints (HTTP)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let locationId = '';
  let tableId = '';
  let tableToken = '';
  let checkId = '';

  before(async () => {
    app = await buildApp({ logger: false });
    const s = await seedSquareMerchant('guest', '2099-06-01T00:00:00Z');
    locationId = s.locationId;
    tableId = randomUUID();
    tableToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'SEATED')`,
      [tableId, locationId, tableToken],
    );
    checkId = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'ord-guest','ord-guest','square',$4,'OPEN',1200,'CAD')`,
      [checkId, tableId, locationId, s.merchantId],
    );
  });

  after(async () => {
    if (app) await app.close();
  });

  it('C-8: call-waiter works under the table token; the bare-UUID route is gone', async () => {
    const ok = await app.inject({ method: 'POST', url: `/api/t/${tableToken}/call-waiter` });
    assert.equal(ok.statusCode, 200);
    const ev = await query(`SELECT COUNT(*)::int AS n FROM events WHERE table_id = $1 AND type = 'call_waiter'`, [tableId]);
    assert.equal(ev.rows[0].n, 1);
    const gone = await app.inject({ method: 'POST', url: `/api/tables/${tableId}/call-waiter` });
    assert.equal(gone.statusCode, 404);
    const bad = await app.inject({ method: 'POST', url: `/api/t/nope-token/call-waiter` });
    assert.equal(bad.statusCode, 400);
  });

  it('C-7: loyalty counts only against a settled payment, once per check', async () => {
    const phone = '6045551234';
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/t/${tableToken}/loyalty`,
        payload: { phone },
      });
    const before1 = await post();
    assert.equal(before1.statusCode, 200);
    assert.equal(before1.json().counted, false);
    assert.equal(before1.json().visits, 0);

    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
       VALUES ($1,$2,1200,0,'COMPLETED',$3,'pay-ref-1','CAD')`,
      [randomUUID(), checkId, randomUUID()],
    );
    const after1 = await post();
    assert.equal(after1.json().counted, true);
    assert.equal(after1.json().visits, 1);
    const again = await post();
    assert.equal(again.json().counted, false);
    assert.equal(again.json().visits, 1);
  });

  it('C-6: receipt binds to the payment, sends once, then refuses', async () => {
    const post = (paymentId?: string) =>
      app.inject({
        method: 'POST',
        url: `/api/t/${tableToken}/receipt-email`,
        payload: { email: 'guest@example.com', ...(paymentId ? { payment_id: paymentId } : {}) },
      });
    resendCalls.length = 0;
    const first = await post('pay-ref-1');
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, true);
    assert.equal(resendCalls.length, 1);
    const second = await post('pay-ref-1');
    assert.equal(second.statusCode, 400);
    assert.equal(resendCalls.length, 1);
    const wrongTable = await app.inject({
      method: 'POST',
      url: `/api/t/other-token/receipt-email`,
      payload: { email: 'guest@example.com', payment_id: 'pay-ref-1' },
    });
    assert.equal(wrongTable.statusCode, 400);
  });

  it('D-14: card-config returns only publishable fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/checks/ord-guest/card-config?table_token=${tableToken}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.publishableKey, 'publishableKey present');
    const raw = JSON.stringify(body).toLowerCase();
    assert.ok(!raw.includes('private'), 'no private material');
    assert.ok(!raw.includes('secret'), 'no secret material');
    assert.ok(!raw.includes('access_token'), 'no access token');
  });
});

describe('v0.6.7 batch 3 — C-9 order outcome semantics', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let tableToken = '';

  before(async () => {
    app = await buildApp({ logger: false });
    const s = await seedSquareMerchant('order', '2099-06-01T00:00:00Z');
    tableToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T9',$3,'SEATED')`,
      [randomUUID(), s.locationId, tableToken],
    );
  });

  after(async () => {
    if (app) await app.close();
  });

  const orderPayload = (key: string) => ({
    method: 'POST',
    url: `/api/t/${tableToken}/order`,
    payload: { items: [{ menu_item_id: 'var1', quantity: 1 }], idempotency_key: key },
  });

  it('C-9: unknown outcome leaves the order PENDING and the same key resumes it', async () => {
    orderBehavior = 'network';
    const key = randomUUID();
    const first = await app.inject(orderPayload(key));
    assert.equal(first.statusCode, 500);
    const row1 = await query<{ status: string }>(`SELECT status FROM order_requests WHERE idempotency_key = $1`, [key]);
    assert.equal(row1.rows[0].status, 'PENDING');
    // Age the reservation past the stale window, POS recovers, same key resumes.
    await query(`UPDATE order_requests SET created_at = now() - interval '3 minutes' WHERE idempotency_key = $1`, [key]);
    orderBehavior = 'ok';
    const second = await app.inject(orderPayload(key));
    assert.equal(second.statusCode, 200);
    const row2 = await query<{ status: string }>(`SELECT status FROM order_requests WHERE idempotency_key = $1`, [key]);
    assert.equal(row2.rows[0].status, 'COMPLETED');
  });

  it('C-9: a definitive POS rejection marks the order FAILED and the key is dead', async () => {
    orderBehavior = 'decline';
    const key = randomUUID();
    const first = await app.inject(orderPayload(key));
    assert.ok(first.statusCode >= 400);
    const row = await query<{ status: string }>(`SELECT status FROM order_requests WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'FAILED');
    orderBehavior = 'ok';
    const retry = await app.inject(orderPayload(key));
    assert.equal(retry.statusCode, 400);
  });
});

describe('v0.6.7 batch 3 — F-4 guest script externalization', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  before(async () => {
    app = await buildApp({ logger: false });
  });

  after(async () => {
    if (app) await app.close();
  });

  it('/t/app.js is served as JavaScript (the :token route must not swallow it)', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/app.js' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /javascript/);
    assert.ok(res.body.length > 10_000, 'the real guest app script');
  });

  it('/t/:token still serves the guest page, with no unsafe-inline in its CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/some-token' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    const csp = String(res.headers['content-security-policy'] ?? '');
    assert.ok(csp.includes("script-src 'self'"), 'script-src self present');
    assert.ok(!csp.includes("'unsafe-inline' https://*.squarecdn"), 'unsafe-inline dropped from script-src');
    assert.ok(res.body.includes('/t/app.js'), 'page references the external script');
  });
});
