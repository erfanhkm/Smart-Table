// v0.3 POS isolation tests (pg-mem + mocked fetch).
//
// Proves:
//  1. A location's pos_type alone determines which POS is called:
//     square -> connect.squareup.com only, clover -> api.clover.com only,
//     shopify -> *.myshopify.com only.
//  2. Per-merchant credentials are never crossed: the token sent to Clover
//     is the Clover token, never the Square token.
//  3. Single-POS-per-location: adding a second POS credential while open
//     checks exist on the first is refused.
//  4. A check whose pos_type disagrees with its location's pos_type is never
//     routed (defence in depth).
//
// Run: PG_MEM=1 ENCRYPTION_KEY=<64 hex> npx tsx --test tests/pos-isolation.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { getLocationPos, getCheckPos, storePosCredential } = await import('../src/services/pos/context.js');
const { payCheck } = await import('../src/services/payments.js');

// ---- fetch mock: records every call, routes by host ----
interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined }
const calls: Call[] = [];
const checkIdsByRef: Record<string, string> = {};
let cloverPaid = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const SQ_ORDER = {
  id: 'SQORDER1', location_id: 'SQLoc1', state: 'OPEN',
  total_money: { amount: 1000, currency: 'CAD' },
  line_items: [{ name: 'Latte', quantity: '1', total_money: { amount: 1000, currency: 'CAD' } }],
  tenders: [],
};
const clOrder = () => ({
  id: 'CLORDER1', state: 'open', total: 2000, currency: 'CAD',
  lineItems: { elements: [{ name: 'Mocha', unitQty: 1, price: 2000 }] },
  payments: { elements: cloverPaid ? [{ id: 'CLPAY1', amount: 2000, tender: { label: 'Cash' } }] : [] },
});
const SH_DRAFT = {
  id: 99, name: '#D9', status: 'open', currency: 'USD', total_price: '15.00',
  line_items: [{ title: 'Bagel', quantity: 1, price: '15.00' }],
};

function installFetch() {
  const orig = globalThis.fetch;
  // NOTE: assign to globalThis.fetch directly — `(globalThis as T) = v`
  // rebinds globalThis itself (TS erases the assertion), silently breaking the mock.
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers, body: init?.body as string | undefined });
    const u = new URL(url);
    if (u.hostname.includes('square')) {
      if (url.includes('/v2/orders/search')) return json({ orders: [SQ_ORDER] });
      if (url.includes('/v2/orders/SQORDER1') && !url.includes('/pay')) return json({ order: SQ_ORDER });
      if (url.includes('/v2/payments')) return json({ payment: { id: 'SQPAY1' } });
      if (url.includes('/pay')) return json({ order: { ...SQ_ORDER, state: 'COMPLETED' } });
      return json({ orders: [] });
    }
    if (u.hostname.includes('clover')) {
      if (url.includes('/tenders')) return json({ elements: [{ id: 'TENDER1', label: 'Cash' }, { id: 'TENDER2', label: 'Card' }] });
      // Ecommerce API: pay the order (card payments). Runs on scl-sandbox.dev.clover.com.
      // After paying, the order re-read shows it paid (cloverPaid flag).
      if (/\/v1\/orders\/[^/]+\/pay$/.test(u.pathname) && calls[calls.length - 1].method === 'POST') {
        cloverPaid = true;
        return json({ id: 'CLPAY2', status: 'succeeded' });
      }
      if (url.includes('/payments') && calls[calls.length - 1].method === 'POST') {
        cloverPaid = true;
        return json({ id: 'CLPAY1' });
      }
      if (/\/orders\/[^/]+$/.test(u.pathname)) return json(clOrder());
      return json({ elements: [clOrder()] });
    }
    if (u.hostname.includes('myshopify')) {
      if (url.includes('/draft_orders.json')) return json({ draft_orders: [SH_DRAFT] });
      if (url.includes('/complete.json')) return json({ draft_order: { ...SH_DRAFT, status: 'completed' } });
      return json({ draft_order: SH_DRAFT });
    }
    return json({ error: 'unexpected host in test' }, 500);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

const MERCHANT = 'm-test';
let sqLoc = '', clLoc = '', shLoc = '';

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  const mkLoc = async (id: string, pos: string, ref: string) => {
    await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
      VALUES ($1,$2,$3,$4,$4,$5,'CAD')`, [id, MERCHANT, pos, ref, `${pos}-name`]);
  };
  sqLoc = 'loc-sq'; clLoc = 'loc-cl'; shLoc = 'loc-sh';
  await mkLoc(sqLoc, 'square', 'SQLoc1');
  await mkLoc(clLoc, 'clover', 'CLM1');
  await mkLoc(shLoc, 'shopify', 'test.myshopify.com');
  // Distinct per-POS credentials for the SAME merchant.
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'square','sq-merchant',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, card_public_token, card_private_token_enc)
    VALUES ($1,$2,'clover','CLM1',$3,$4,'CL-ECOM-PUBLIC',$5)`, [randomUUID(), MERCHANT, encryptSecret('CL-TOKEN'), encryptSecret('x'), encryptSecret('CL-ECOM-PRIVATE')]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'shopify','test-shop',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SH-TOKEN'), encryptSecret('x')]);
  // One table per location + one open check each.
  for (const [loc, pos, ref] of [[sqLoc, 'square', 'SQORDER1'], [clLoc, 'clover', 'CLM1:CLORDER1'], [shLoc, 'shopify', 'test.myshopify.com:99']] as const) {
    const tId = randomUUID();
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
      [tId, loc, `T-${pos}`, randomUUID().replace(/-/g, '')]);
    const cId = randomUUID();
    checkIdsByRef[ref] = cId;
    await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
      VALUES ($1,$2,$3,$4,$5,$6,'OPEN',1000,'CAD')`,
      [cId, tId, pos, ref, pos === 'square' ? ref : null, MERCHANT]);
  }
}

describe('v0.3 POS isolation', () => {
  let restore: () => void;
  before(async () => {
    restore = installFetch();
    await seed();
  });

  it('square location resolves the square adapter and only calls Square', async () => {
    calls.length = 0;
    const ctx = await getLocationPos(sqLoc);
    assert.equal(ctx.posType, 'square');
    assert.equal(ctx.adapter.posType, 'square');
    assert.equal(ctx.token, 'SQ-TOKEN');
    const open = await ctx.adapter.listOpenChecks(ctx.locationRef, ctx.token);
    assert.equal(open.length, 1);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.match(c.url, /square/, `square location called non-square host: ${c.url}`);
    assert.equal(calls[0].headers['authorization'], 'Bearer SQ-TOKEN');
  });

  it('clover location resolves the clover adapter and only calls Clover', async () => {
    calls.length = 0;
    const ctx = await getLocationPos(clLoc);
    assert.equal(ctx.posType, 'clover');
    assert.equal(ctx.token, 'CL-TOKEN');
    const open = await ctx.adapter.listOpenChecks(ctx.locationRef, ctx.token);
    assert.equal(open.length, 1);
    assert.ok(open[0].id.startsWith('CLM1:'), 'clover check id must be self-contained (mId:orderId)');
    for (const c of calls) assert.match(c.url, /clover/, `clover location called non-clover host: ${c.url}`);
    assert.equal(calls[0].headers['authorization'], 'Bearer CL-TOKEN');
  });

  it('shopify location resolves the shopify adapter and only calls Shopify', async () => {
    calls.length = 0;
    const ctx = await getLocationPos(shLoc);
    assert.equal(ctx.posType, 'shopify');
    assert.equal(ctx.token, 'SH-TOKEN');
    const open = await ctx.adapter.listOpenChecks(ctx.locationRef, ctx.token);
    assert.equal(open.length, 1);
    assert.ok(open[0].id.startsWith('test.myshopify.com:'), 'shopify check id must be self-contained (shop:draftId)');
    for (const c of calls) assert.match(c.url, /myshopify/, `shopify location called non-shopify host: ${c.url}`);
    assert.equal(calls[0].headers['x-shopify-access-token'], 'SH-TOKEN');
  });

  it('credentials never cross POS boundaries', async () => {
    const sq = await getLocationPos(sqLoc);
    const cl = await getLocationPos(clLoc);
    const sh = await getLocationPos(shLoc);
    assert.equal(sq.token, 'SQ-TOKEN');
    assert.equal(cl.token, 'CL-TOKEN');
    assert.equal(sh.token, 'SH-TOKEN');
    assert.notEqual(sq.token, cl.token);
  });

  it('external payment on a clover location only touches Clover', async () => {
    calls.length = 0;
    cloverPaid = false;
    const res = await payCheck({
      checkRef: 'CLM1:CLORDER1',
      checkId: checkIdsByRef['CLM1:CLORDER1'],
      mode: 'full',
      idempotencyKey: randomUUID(),
      source: { kind: 'external', label: 'Cash' },
    });
    assert.equal(res.checkState, 'COMPLETED');
    assert.ok(calls.length > 0);
    for (const c of calls) assert.match(c.url, /clover/, `clover payment called non-clover host: ${c.url}`);
    const rows = await query<{ external_payment_ref: string; status: string }>(
      `SELECT external_payment_ref, status FROM payments ORDER BY created_at DESC LIMIT 1`);
    assert.equal(rows.rows[0].external_payment_ref, 'CLPAY1');
    assert.equal(rows.rows[0].status, 'COMPLETED');
  });

  it('card payment on a POS without chargeCard (shopify) is rejected', async () => {
    await assert.rejects(
      () => payCheck({
        checkRef: 'test.myshopify.com:99',
        checkId: checkIdsByRef['test.myshopify.com:99'],
        mode: 'full',
        idempotencyKey: randomUUID(),
        source: { kind: 'card', nonce: 'cnon:test' },
      }),
      /card payments are not supported for shopify/,
    );
  });

  it('card payment on a clover location routes to the clover adapter', async () => {
    // Reset the mock: the earlier external-payment test marked the order paid.
    cloverPaid = false;
    calls.length = 0;
    // The mock Ecommerce charge returns CLCHG1; the v3 payment record + order
    // re-read flow through the mocked fetch.
    const r = await payCheck({
      checkRef: 'CLM1:CLORDER1',
      checkId: checkIdsByRef['CLM1:CLORDER1'],
      mode: 'full',
      idempotencyKey: randomUUID(),
      source: { kind: 'card', nonce: 'clv_testtoken123' },
    });
    assert.equal(r.checkState, 'COMPLETED');
    assert.ok(calls.some((c) => /\/v1\/orders\/[^/]+\/pay$/.test(new URL(c.url).pathname)), 'Ecommerce order pay was called');
    assert.ok(!calls.some((c) => c.url.includes('square')), 'Square was never touched');
  });

  it('refuses a second POS credential while open checks exist on the first', async () => {
    await assert.rejects(
      () => storePosCredential({
        merchantId: MERCHANT,
        posType: 'helcim',
        externalMerchantRef: 'H1',
        accessToken: 'H-TOKEN',
      }),
      /already has open checks on a different POS/,
    );
  });

  it('never routes a check whose pos_type disagrees with its location', async () => {
    const t = await query<{ id: string }>(`SELECT id FROM tables WHERE location_id = $1 LIMIT 1`, [sqLoc]);
    const badId = randomUUID();
    await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, merchant_id, state, total_cents, currency)
      VALUES ($1,$2,'clover','CLM1:EVIL',$3,'OPEN',100,'CAD')`, [badId, t.rows[0].id, MERCHANT]);
    await assert.rejects(() => getCheckPos(badId), /POS mismatch/);
  });
});
