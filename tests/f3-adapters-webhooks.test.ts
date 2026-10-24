// v0.8.3 F3 hardening tests (Claude cycle-2 chunk F3: POS adapters + webhooks).
//
//  F3-1  a failed read-back AFTER a successful charge must not be reported
//        as a payment failure: Clover chargeCard/recordExternalPayment and
//        Helcim chargeCard resolve with remainingCents = null (unknown)
//        instead of throwing a definitive-looking error.
//  F3-3  Helcim: an unverified non-"0" responseCode is an UNKNOWN outcome
//        (502), never a definitive decline (402).
//  F3-6  Shopify/Helcim recordExternalPayment: partial amounts rejected;
//        already-settled invoices/drafts replay as success; CANCELLED /
//        REFUNDED invoices are never a "successful replay".
//  F3-4  generic webhook: a CLOSED POS state with money still owing does
//        NOT close our check; fully settled does.
//  F3-5  Square order.updated: a late COMPLETED event for an old check
//        must not flip a re-seated table to PAID or duplicate 'paid' events.
//  F3-11 Square refund.updated (COMPLETED) raises an external_refund alert.
//  F3-13 generic webhook errors are classified: 503 config / 401 signature /
//        400 malformed — not 401 for everything.
//
// Run: PG_MEM=1 npx tsx --test tests/f3-adapters-webhooks.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.CLOVER_WEBHOOK_KEY = 'clover-test-key';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { cloverAdapter } = await import('../src/services/pos/clover.js');
const { helcimAdapter } = await import('../src/services/pos/helcim.js');
const { shopifyAdapter } = await import('../src/services/pos/shopify.js');

// ---------------------------------------------------------------------------
// Fetch mock, keyed by URL fragments. One install for the whole file; the
// adapter describes run FIRST (they use adapter-scoped fixtures), the webhook
// describes seed their own state into the same DB afterwards.
// ---------------------------------------------------------------------------
type Handler = (url: string, init: { method?: string }) => Response;
const routes: { match: RegExp; handler: Handler }[] = [];
function route(match: RegExp, handler: Handler) { routes.push({ match, handler }); }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let restoreFetch: (() => void) | null = null;
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    for (const r of routes) if (r.match.test(url)) return r.handler(url, init ?? {});
    return json({ error: `unmocked fetch: ${url}` }, 500);
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = orig; };
}

// Mutable Clover order fixture for the webhook tests (F3-4): flipped from
// "closed but unpaid" to "closed and settled" between the two events.
const cloverWebhookOrder = {
  id: 'O1', state: 'closed', total: 1000, currency: 'CAD',
  lineItems: { elements: [{ name: 'Soup', price: 1000 }] },
  payments: { elements: [] as unknown[] },
};

function installRoutes() {
  // ---- Clover ecom pay (F3-1/F3-2 fixtures) ----
  route(/scl-sandbox\.dev\.clover\.com\/v1\/orders\/ORDFAIL\/pay/, () => json({ id: 'CPAY-FAIL' }));
  route(/scl-sandbox\.dev\.clover\.com\/v1\/orders\/ORDOK\/pay/, () => json({ id: 'CPAY-OK' }));
  // Clover external payment POST must be registered BEFORE the general
  // ORDFAIL order route (first match wins; the general regex also matches
  // the /payments URL).
  route(/apisandbox\.dev\.clover\.com\/v3\/merchants\/M1\/orders\/ORDFAIL\/payments/, () => json({ id: 'CPAY-EXT' }));
  // Clover v3 order read: ORDFAIL read-back 401s (expired OAuth), ORDOK is fine.
  route(/apisandbox\.dev\.clover\.com\/v3\/merchants\/M1\/orders\/ORDFAIL/, () => json({ message: 'unauthorized' }, 401));
  route(/apisandbox\.dev\.clover\.com\/v3\/merchants\/M1\/orders\/ORDOK/, () => json({
    id: 'ORDOK', state: 'closed', total: 5000, currency: 'CAD',
    lineItems: { elements: [{ name: 'Steak', price: 5000 }] },
    payments: { elements: [{ id: 'p1', amount: 5000, tender: { label: 'Credit Card' } }] },
  }));
  // Clover external payment: POST payments succeeds, read-back 401s (same M1/ORDFAIL).
  route(/apisandbox\.dev\.clover\.com\/v3\/merchants\/M1\/tenders/, () => json({
    elements: [{ id: 'TND1', label: 'Cash', enabled: true }],
  }));
  // Clover webhook re-fetch (F3-4).
  route(/apisandbox\.dev\.clover\.com\/v3\/merchants\/MCWH\/orders\/O1/, () => json(cloverWebhookOrder));

  // ---- Helcim fixtures (invoice id decides the scenario) ----
  const invoices: Record<string, Record<string, unknown>> = {
    '555': { invoiceId: 555, invoiceNumber: 'INV-555', status: 'CANCELLED', amount: 100, currency: 'CAD', lineItems: [] },
    '556': { invoiceId: 556, invoiceNumber: 'INV-556', status: 'DUE', amount: 100, currency: 'CAD', lineItems: [] },
    '557': { invoiceId: 557, invoiceNumber: 'INV-557', status: 'PAID', amount: 100, currency: 'CAD', lineItems: [] },
    '901': { invoiceId: 901, invoiceNumber: 'INV-901', status: 'DUE', amount: 50, currency: 'CAD', lineItems: [] },
    '902': { invoiceId: 902, invoiceNumber: 'INV-902', status: 'DUE', amount: 50, currency: 'CAD', lineItems: [] },
  };
  let helcim902Gets = 0;
  route(/api\.helcim\.com\/v2\/invoices\/(\d+)/, (url, init) => {
    const id = /invoices\/(\d+)/.exec(url)![1];
    if ((init.method ?? 'GET') === 'PUT') {
      // recordExternalPayment settling invoice 556.
      return json({ invoice: { ...invoices[id], status: 'PAID' } });
    }
    if (id === '902') {
      helcim902Gets++;
      // 1st GET = chargeCard's raw invoice read (ok). 2nd = the post-charge
      // getCheckDetail read-back — fails, as in F3-1.
      if (helcim902Gets >= 2) return json({ errors: 'boom' }, 500);
    }
    return json({ invoice: invoices[id] });
  });
  route(/api\.helcim\.com\/v2\/payment\/purchase/, (url) => {
    // The invoiceNumber in the body decides: INV-901 declines w/ code 05,
    // INV-902 approves with code 0.
    return json({ responseCode: 'x', transactionId: 'TX' }); // replaced below by body-aware mock
  });
  // Body-aware purchase mock (registered LAST so it wins for purchase URL):
  routes.pop();
  route(/api\.helcim\.com\/v2\/payment\/purchase/, (_url, init) => {
    const body = JSON.parse(String((init as { body?: string }).body ?? '{}')) as { invoiceNumber?: string };
    if (body.invoiceNumber === 'INV-901') return json({ responseCode: '05', transactionId: 'TX901' });
    return json({ responseCode: '0', transactionId: 'TX902' });
  });

  // ---- Shopify fixtures ----
  let shopifyPuts = 0;
  const drafts: Record<string, Record<string, unknown>> = {
    '777': { id: 777, status: 'completed', total_price: '100.00', currency: 'CAD', order_id: 999888, line_items: [] },
    '778': { id: 778, status: 'open', total_price: '100.00', currency: 'CAD', line_items: [] },
  };
  route(/testshop\.myshopify\.com\/admin\/api\/[^/]+\/draft_orders\/(\d+)\.json/, (url, init) => {
    const id = /draft_orders\/(\d+)\.json/.exec(url)![1];
    return json({ draft_order: drafts[id] });
  });
  route(/testshop\.myshopify\.com\/admin\/api\/[^/]+\/draft_orders\/(\d+)\/complete\.json/, (url) => {
    shopifyPuts++;
    const id = /draft_orders\/(\d+)\/complete/.exec(url)![1];
    return json({ draft_order: { ...drafts[id], status: 'completed', order_id: 555111 } });
  });
  Object.assign(globalThis, { __shopifyPuts: () => shopifyPuts });
}

// ---------------------------------------------------------------------------
describe('F3-1/F3-3/F3-6: adapter money-moved semantics', () => {
  before(() => { installFetch(); installRoutes(); });
  after(() => { restoreFetch?.(); });

  it('Clover chargeCard: post-charge read-back 401 still returns the payment, remaining null', async () => {
    const res = await cloverAdapter.chargeCard({
      checkId: 'M1:ORDFAIL', amountCents: 5000, currency: 'CAD', cardToken: 'clv_tok',
      tipCents: 0, idempotencyKey: 'k-f3-1', card: { privateToken: 'priv' }, token: 'oauth',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.equal(res.paymentId, 'CPAY-FAIL');
    assert.equal(res.remainingCents, null);
  });

  it('Clover chargeCard: healthy read-back returns the real remaining', async () => {
    const res = await cloverAdapter.chargeCard({
      checkId: 'M1:ORDOK', amountCents: 5000, currency: 'CAD', cardToken: 'clv_tok',
      tipCents: 0, idempotencyKey: 'k-f3-2', card: { privateToken: 'priv' }, token: 'oauth',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.equal(res.paymentId, 'CPAY-OK');
    assert.equal(res.remainingCents, 0);
  });

  it('Clover recordExternalPayment: read-back failure still returns the recorded payment', async () => {
    const res = await cloverAdapter.recordExternalPayment('M1:ORDFAIL', 5000, 'CAD', 'cash', 'k-f3-3', 'oauth');
    assert.equal(res.paymentId, 'CPAY-EXT');
    assert.equal(res.remainingCents, null);
  });

  it('Helcim chargeCard: non-"0" responseCode is outcome-unknown (502), not a definitive decline', async () => {
    await assert.rejects(
      () => helcimAdapter.chargeCard({
        checkId: '901', amountCents: 5000, currency: 'CAD', cardToken: 'tok',
        tipCents: 0, idempotencyKey: 'k-f3-4', card: { privateToken: 'priv' }, token: 'api-tok',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => e?.status === 502,
    );
  });

  it('Helcim chargeCard: approval + failed read-back returns the payment, remaining null', async () => {
    const res = await helcimAdapter.chargeCard({
      checkId: '902', amountCents: 5000, currency: 'CAD', cardToken: 'tok',
      tipCents: 0, idempotencyKey: 'k-f3-5', card: { privateToken: 'priv' }, token: 'api-tok',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.equal(res.paymentId, 'TX902');
    assert.equal(res.remainingCents, null);
  });

  it('Helcim recordExternalPayment: a CANCELLED invoice is not a successful replay', async () => {
    await assert.rejects(
      () => helcimAdapter.recordExternalPayment('555', 10000, 'CAD', 'cash', 'k-f3-6', 'api-tok'),
      /invoice is CANCELLED/,
    );
  });

  it('Helcim recordExternalPayment: partial amount on a DUE invoice is rejected', async () => {
    await assert.rejects(
      () => helcimAdapter.recordExternalPayment('556', 5000, 'CAD', 'cash', 'k-f3-7', 'api-tok'),
      /partial external payments/,
    );
  });

  it('Helcim recordExternalPayment: full amount settles; PAID invoice replays', async () => {
    const settled = await helcimAdapter.recordExternalPayment('556', 10000, 'CAD', 'cash', 'k-f3-8', 'api-tok');
    assert.equal(settled.remainingCents, 0);
    assert.equal(settled.replayed, false);
    const replay = await helcimAdapter.recordExternalPayment('557', 10000, 'CAD', 'cash', 'k-f3-9', 'api-tok');
    assert.equal(replay.replayed, true);
    assert.equal(replay.remainingCents, 0);
  });

  it('Shopify recordExternalPayment: already-completed draft replays without a second complete', async () => {
    const puts = (globalThis as unknown as { __shopifyPuts: () => number }).__shopifyPuts;
    const before = puts();
    const res = await shopifyAdapter.recordExternalPayment('testshop.myshopify.com:777', 10000, 'CAD', 'cash', 'k-f3-10', 'shpat');
    assert.equal(res.replayed, true);
    assert.equal(res.paymentId, '999888');
    assert.equal(puts(), before);
  });

  it('Shopify recordExternalPayment: partial amount rejected; full amount completes', async () => {
    await assert.rejects(
      () => shopifyAdapter.recordExternalPayment('testshop.myshopify.com:778', 5000, 'CAD', 'cash', 'k-f3-11', 'shpat'),
      /partial external payments/,
    );
    const res = await shopifyAdapter.recordExternalPayment('testshop.myshopify.com:778', 10000, 'CAD', 'cash', 'k-f3-12', 'shpat');
    assert.equal(res.replayed, false);
    assert.equal(res.paymentId, '555111');
    assert.equal(res.remainingCents, 0);
  });
});

// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
const SQ_TABLE = randomUUID();
const SQ_OLD_CHECK = randomUUID();
const SQ_NEW_CHECK = randomUUID();
const SQ_LOC = 'loc-f3-sq';
const CL_TABLE = randomUUID();
const CL_CHECK = randomUUID();

async function seedWebhooks() {
  await migrate();
  // Square location/table/checks: OLD completed long ago, NEW open (re-seated).
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ('m-f3-sq','square','sq-merchant',$1,$2)`, [encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,'m-f3-sq','square','SQLocF3','SQLocF3','F3 Square House','CAD')`, [SQ_LOC]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T5','tok-f3-sq','SEATED')`, [SQ_TABLE, SQ_LOC]);
  await query(`INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,$3,'square','SQOLD1','SQOLD1','m-f3-sq','COMPLETED',5000,'CAD')`, [SQ_OLD_CHECK, SQ_TABLE, SQ_LOC]);
  await query(`INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,$3,'square','SQNEW1','SQNEW1','m-f3-sq','OPEN',7000,'CAD')`, [SQ_NEW_CHECK, SQ_TABLE, SQ_LOC]);
  await query(`INSERT INTO payments(id, check_id, square_payment_id, amount_cents, status, idempotency_key)
    VALUES ($1,$2,'SQPAYR1',7000,'COMPLETED','k-f3-refund')`, [randomUUID(), SQ_NEW_CHECK]);
  // Clover location/credentials/table/check for the generic handler.
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ('m-f3-cl','clover','MCWH',$1,$2)`, [encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ('loc-f3-cl','m-f3-cl','clover','MCWH','loc-f3-cl','F3 Clover House','CAD')`);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'m-f3-cl','clover','MCWH',$2,$3)`, [randomUUID(), encryptSecret('clover-tok'), encryptSecret('x')]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,'loc-f3-cl','T9','tok-f3-cl','SEATED')`, [CL_TABLE]);
  await query(`INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'loc-f3-cl','clover','MCWH:O1','m-f3-cl','OPEN',1000,'CAD')`, [CL_CHECK, CL_TABLE]);
}

describe('F3-4/F3-5/F3-11/F3-13: webhook behavior', () => {
  before(async () => {
    installFetch(); // routes are module-level; re-wrap after describe 1's restore
    await seedWebhooks();
    app = await buildApp();
    await app.ready();
  });
  after(() => { restoreFetch?.(); });

  it('F3-5: a late COMPLETED event for the old check does not flip the re-seated table', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/webhooks/square',
      payload: { event_id: 'evt-f3-late', type: 'order.updated', data: { object: { order: { id: 'SQOLD1', state: 'COMPLETED' } } } },
    });
    assert.equal(res.statusCode, 200);
    const t = await query(`SELECT state FROM tables WHERE id=$1`, [SQ_TABLE]);
    assert.equal(t.rows[0].state, 'SEATED');
    const ev = await query(`SELECT COUNT(*)::int AS n FROM events WHERE check_id=$1 AND type='paid'`, [SQ_OLD_CHECK]);
    assert.equal(ev.rows[0].n, 0);
  });

  it('F3-5: the live check completes + flips the table exactly once across duplicate events', async () => {
    for (const eid of ['evt-f3-new-1', 'evt-f3-new-2']) {
      const res = await app.inject({
        method: 'POST', url: '/api/webhooks/square',
        payload: { event_id: eid, type: 'order.updated', data: { object: { order: { id: 'SQNEW1', state: 'COMPLETED' } } } },
      });
      assert.equal(res.statusCode, 200);
    }
    const c = await query(`SELECT state FROM checks WHERE id=$1`, [SQ_NEW_CHECK]);
    assert.equal(c.rows[0].state, 'COMPLETED');
    const t = await query(`SELECT state FROM tables WHERE id=$1`, [SQ_TABLE]);
    assert.equal(t.rows[0].state, 'PAID');
    const ev = await query(`SELECT COUNT(*)::int AS n FROM events WHERE check_id=$1 AND type='paid'`, [SQ_NEW_CHECK]);
    assert.equal(ev.rows[0].n, 1);
  });

  it('F3-11: a Square refund completed out-of-band raises an external_refund alert', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/webhooks/square',
      payload: { event_id: 'evt-f3-refund', type: 'refund.updated', data: { object: { refund: { id: 'RF1', payment_id: 'SQPAYR1', status: 'COMPLETED' } } } },
    });
    assert.equal(res.statusCode, 200);
    const a = await query(`SELECT kind, comment FROM service_alerts WHERE table_id=$1 AND kind='external_refund'`, [SQ_TABLE]);
    assert.equal(a.rowCount, 1);
    assert.match(a.rows[0].comment, /RF1/);
  });

  it('F3-13: a bad Clover webhook key is a 401; an unimplemented POS parser is a 503', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/api/webhooks/clover',
      headers: { 'x-clover-auth': 'wrong-key' },
      payload: { merchants: {} },
    });
    assert.equal(bad.statusCode, 401);
    const helcim = await app.inject({ method: 'POST', url: '/api/webhooks/helcim', payload: {} });
    assert.equal(helcim.statusCode, 503);
  });

  it('F3-4: a CLOSED-but-unpaid Clover order does not close the check; settled does', async () => {
    const evt = (ts: number) => ({
      method: 'POST', url: '/api/webhooks/clover',
      headers: { 'x-clover-auth': 'clover-test-key' },
      payload: { merchants: { MCWH: [{ objectId: 'O:O1', type: 'UPDATE', ts }] } },
    });
    const r1 = await app.inject(evt(1001));
    assert.equal(r1.statusCode, 200);
    let c = await query(`SELECT state FROM checks WHERE id=$1`, [CL_CHECK]);
    assert.equal(c.rows[0].state, 'OPEN');
    cloverWebhookOrder.payments.elements = [{ id: 'p1', amount: 1000, tender: { label: 'Cash' } }];
    const r2 = await app.inject(evt(1002));
    assert.equal(r2.statusCode, 200);
    c = await query(`SELECT state FROM checks WHERE id=$1`, [CL_CHECK]);
    assert.equal(c.rows[0].state, 'COMPLETED');
    const t = await query(`SELECT state FROM tables WHERE id=$1`, [CL_TABLE]);
    assert.equal(t.rows[0].state, 'PAID');
  });
});
