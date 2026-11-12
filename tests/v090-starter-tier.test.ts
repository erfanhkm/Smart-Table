// v0.9.0: Starter tier — printed QR codes only ($49.99/mo or 1%
// commission, NO device / printing / waiter button) alongside Base
// ($99/mo or 2%, with the STT-101 device).
//
// Proves:
//  1. Migration 031: locations.tier defaults to 'base'; the CHECK
//     constraint rejects anything outside starter/base.
//  2. Billing defaults follow the tier at account creation
//     (starter 100bps/4999, base 200bps/9900) and getBillingState
//     exposes the tier.
//  3. setLocationTier flips the defaults both ways; the billing tier
//     route validates + applies; onboarding state reports tier + options.
//  4. Tier-based amounts: a starter subscription is created at 4999
//     (Square plan-variation price) and a starter commission payment
//     carries a 1% app fee.
//  5. Device gates: claim-code minting and device claim are 403
//     (devices_not_included) for starter; base claims still work.
//  6. Guest capabilities: the bill payload reports tier + print=false
//     for starter (true for base); receipt-print for starter answers
//     not_available_on_plan and never creates a print job.
//
// Run: PG_MEM=1 npx tsx --test tests/v090-starter-tier.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['test', 'token'].join('-');
process.env.SQUARE_ACCESS_TOKEN = ['test', 'token'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { hashToken } = await import('../src/routes/portal.js');
const { hashClaimCode } = await import('../src/routes/device.js');
const { payCheck } = await import('../src/services/payments.js');
const {
  ensureBillingAccount, getBillingState, setLocationTier, switchPlan,
} = await import('../src/services/billing.js');

const STAFF = { authorization: 'Bearer ' + ['test', 'token'].join('-') };

// ---- Square fetch mock (guest orders/payments + platform billing) --------
interface Call { url: string; method: string; body: Record<string, unknown> }
const calls: Call[] = [];
const orderTotals: Record<string, number> = { 'SQORD-C1': 10000 };
const orderPaid: Record<string, number> = {};
let paySeq = 0;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function orderObj(id: string) {
  const total = orderTotals[id] ?? 1200;
  const paid = orderPaid[id] ?? 0;
  return {
    id, location_id: 'SQLoc1', state: paid >= total ? 'COMPLETED' : 'OPEN',
    total_money: { amount: total, currency: 'CAD' },
    line_items: [{ uid: 'li1', name: 'Item', quantity: '1', base_price_money: { amount: total, currency: 'CAD' }, total_money: { amount: total, currency: 'CAD' } }],
    tenders: paid > 0 ? [{ id: 'T1', amount_money: { amount: paid, currency: 'CAD' } }] : [],
  };
}
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method, body });
    if (url.includes('/v2/locations')) {
      return json({ locations: [{ id: 'PLATLOC', status: 'ACTIVE', currency: 'CAD', name: 'Platform' }] });
    }
    if (url.includes('/v2/subscriptions/search')) return json({ subscriptions: [] });
    if (/\/v2\/subscriptions$/.test(url) && method === 'POST') {
      return json({ subscription: { id: 'SUB1', status: 'ACTIVE', charged_through_date: '2026-12-01' } });
    }
    if (url.includes('/v2/catalog/object')) {
      return json({ catalog_object: { id: body?.object?.type === 'SUBSCRIPTION_PLAN' ? 'PLAN1' : 'VAR1' } });
    }
    if (url.includes('/v2/customers')) return json({ customer: { id: 'CUST1' } });
    if (url.includes('/v2/cards')) return json({ card: { id: 'CARD1', card_brand: 'VISA', last_4: '4242' } });
    if (url.includes('/v2/payments')) {
      paySeq += 1;
      const oid = body.order_id as string;
      if (oid) orderPaid[oid] = (orderPaid[oid] ?? 0) + (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0);
      return json({ payment: { id: `SQPAY${paySeq}` } });
    }
    const m = /\/v2\/orders\/([\w-]+)/.exec(url);
    if (m && url.includes('/pay')) return json({ order: orderObj(m[1]) });
    if (m) return json({ order: orderObj(m[1]) });
    return json({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ---- seed ------------------------------------------------------------------
const MERCHANT = 'm-v090';
const LOC_STARTER = 'loc-v090-starter';
const LOC_BASE = 'loc-v090-base';
const LOC_FLEX = 'loc-v090-flex';
const LOC_SUB = 'loc-v090-sub';
const LOC_COMM = 'loc-v090-comm';
const T_STARTER = randomUUID();
const T_BASE = randomUUID();
const TOK_STARTER = `tok-s-${randomUUID().replace(/-/g, '')}`;
const TOK_BASE = `tok-b-${randomUUID().replace(/-/g, '')}`;
let app: Awaited<ReturnType<typeof buildApp>>;

async function seedLocation(loc: string, tier: 'starter' | null) {
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency${tier ? ', tier' : ''})
     VALUES ($1,$2,'square',$3,$3,$4,'CAD'${tier ? ',$5' : ''})`,
    tier ? [loc, MERCHANT, `SQ-${loc}`, `House ${loc}`, tier] : [loc, MERCHANT, `SQ-${loc}`, `House ${loc}`],
  );
}

before(async () => {
  installFetch();
  await migrate();
  app = await buildApp({ logger: false });
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'square','sq-merchant',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
  await seedLocation(LOC_STARTER, 'starter');
  await seedLocation(LOC_BASE, null); // no tier column value -> migration default
  await seedLocation(LOC_FLEX, 'starter');
  await seedLocation(LOC_SUB, 'starter');
  await seedLocation(LOC_COMM, 'starter');
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'SEATED')`,
    [T_STARTER, LOC_STARTER, TOK_STARTER]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'SEATED')`,
    [T_BASE, LOC_BASE, TOK_BASE]);
});

describe('v0.9.0 starter tier', () => {
  it('migration 031: tier defaults to base and rejects other values', async () => {
    const r = await query<{ tier: string }>(`SELECT tier FROM locations WHERE id = $1`, [LOC_BASE]);
    assert.equal(r.rows[0].tier, 'base');
    await assert.rejects(
      query(`INSERT INTO locations(id, merchant_id, pos_type, square_location_id, tier) VALUES ($1,$2,'square',$3,'gold')`,
        [randomUUID(), MERCHANT, `SQ-bad-${randomUUID()}`]),
    );
  });

  it('billing defaults follow the tier at account creation', async () => {
    const starter = await ensureBillingAccount(LOC_STARTER);
    assert.equal(starter.plan, 'commission');
    assert.equal(starter.commission_bps, 100);
    assert.equal(starter.subscription_price_cents, 4999);
    const base = await ensureBillingAccount(LOC_BASE);
    assert.equal(base.commission_bps, 200);
    assert.equal(base.subscription_price_cents, 9900);
    assert.equal((await getBillingState(LOC_STARTER)).tier, 'starter');
    assert.equal((await getBillingState(LOC_BASE)).tier, 'base');
  });

  it('setLocationTier applies the tier defaults both ways', async () => {
    let st = await setLocationTier(LOC_FLEX, 'base');
    assert.equal(st.tier, 'base');
    assert.equal(st.account.commission_bps, 200);
    assert.equal(st.account.subscription_price_cents, 9900);
    st = await setLocationTier(LOC_FLEX, 'starter');
    assert.equal(st.tier, 'starter');
    assert.equal(st.account.commission_bps, 100);
    assert.equal(st.account.subscription_price_cents, 4999);
    const loc = await query<{ tier: string }>(`SELECT tier FROM locations WHERE id = $1`, [LOC_FLEX]);
    assert.equal(loc.rows[0].tier, 'starter');
  });

  it('billing tier route validates and applies; billing state shows the tier', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/api/portal/billing/tier', headers: STAFF,
      payload: { location_id: LOC_FLEX, tier: 'gold' },
    });
    assert.equal(bad.statusCode, 400);
    const ok = await app.inject({
      method: 'POST', url: '/api/portal/billing/tier', headers: STAFF,
      payload: { location_id: LOC_FLEX, tier: 'base' },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const body = ok.json() as { tier: string; commission_bps: number; subscription_price_cents: number };
    assert.equal(body.tier, 'base');
    assert.equal(body.commission_bps, 200);
    assert.equal(body.subscription_price_cents, 9900);
    const state = await app.inject({
      method: 'GET', url: `/api/portal/billing?location_id=${LOC_FLEX}`, headers: STAFF,
    });
    assert.equal((state.json() as { tier: string }).tier, 'base');
  });

  it('onboarding state reports the tier and both tier options', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/onboarding?location_id=${LOC_STARTER}`, headers: STAFF,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      tier: string;
      tier_options: { tier: string; subscription_price_cents: number; commission_bps: number }[];
    };
    assert.equal(body.tier, 'starter');
    const byTier = Object.fromEntries(body.tier_options.map((o) => [o.tier, o]));
    assert.equal(byTier.starter.subscription_price_cents, 4999);
    assert.equal(byTier.starter.commission_bps, 100);
    assert.equal(byTier.base.subscription_price_cents, 9900);
    assert.equal(byTier.base.commission_bps, 200);
  });

  it('starter subscription is created at the $49.99 tier price', async () => {
    await ensureBillingAccount(LOC_SUB);
    await query(
      `UPDATE billing_accounts SET square_customer_id = 'CUST1', square_card_id = 'CARD1' WHERE location_id = $1`,
      [LOC_SUB],
    );
    calls.length = 0;
    const st = await switchPlan(LOC_SUB, 'subscription');
    assert.equal(st.effective_plan, 'subscription');
    assert.equal(st.account.subscription_price_cents, 4999);
    const variation = calls.find(
      (c) => c.url.includes('/v2/catalog/object') && (c.body.object as { type?: string })?.type === 'SUBSCRIPTION_PLAN_VARIATION',
    );
    assert.ok(variation, 'a plan variation was created');
    const data = (variation!.body.object as {
      subscription_plan_variation_data: { phases: { pricing: { price_money: { amount: number } } }[] };
    }).subscription_plan_variation_data;
    assert.equal(data.phases[0].pricing.price_money.amount, 4999);
    const cache = await query<{ value: string }>(
      `SELECT value FROM billing_settings WHERE key = 'sq_plan_variation_starter_4999_CAD'`,
    );
    assert.equal(cache.rows[0]?.value, 'VAR1');
  });

  it('starter commission payment carries a 1% app fee', async () => {
    const tId = randomUUID();
    const cId = randomUUID();
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'TC',$3,'SEATED')`,
      [tId, LOC_COMM, randomUUID().replace(/-/g, '')]);
    await query(`INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
      VALUES ($1,$2,$3,'square','SQORD-C1','SQORD-C1',$4,'OPEN',10000,'CAD')`,
      [cId, tId, LOC_COMM, MERCHANT]);
    calls.length = 0;
    const res = await payCheck({
      checkRef: 'SQORD-C1', checkId: cId, mode: 'full', tipCents: 1000,
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(res.checkState, 'COMPLETED');
    const payCall = calls.find((c) => c.url.includes('/v2/payments'));
    assert.ok(payCall, 'a Square payment call happened');
    assert.equal((payCall!.body.app_fee_money as { amount: number })?.amount, 110, 'app fee = 1% of 10000 + 1000 tip');
    const ledger = await query<{ fee_cents: number }>(
      `SELECT fee_cents FROM fee_ledger WHERE location_id = $1`, [LOC_COMM],
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].fee_cents, 110);
  });

  it('device claim-code minting is refused for starter (403 devices_not_included)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/portal/devices/claim-code', headers: STAFF,
      payload: { table_id: T_STARTER },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /devices_not_included/);
  });

  it('device claim is refused for starter and the code is not consumed; base claim works', async () => {
    const starterCode = '31415926';
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at) VALUES ($1,$2,$3,$4)`,
      [hashClaimCode(starterCode), LOC_STARTER, T_STARTER, new Date(Date.now() + 10 * 60_000).toISOString()],
    );
    const refused = await app.inject({
      method: 'POST', url: '/api/device/claim', payload: { code: starterCode },
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.body, /devices_not_included/);
    const codeRow = await query<{ used_at: string | null }>(
      `SELECT used_at FROM device_claim_codes WHERE location_id = $1`, [LOC_STARTER],
    );
    assert.equal(codeRow.rows[0].used_at, null, 'the refused claim must not consume the code');
    const devs = await query(`SELECT id FROM devices WHERE location_id = $1`, [LOC_STARTER]);
    assert.equal(devs.rowCount, 0);

    const baseCode = '27182818';
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at) VALUES ($1,$2,$3,$4)`,
      [hashClaimCode(baseCode), LOC_BASE, T_BASE, new Date(Date.now() + 10 * 60_000).toISOString()],
    );
    const ok = await app.inject({
      method: 'POST', url: '/api/device/claim', payload: { code: baseCode },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok((ok.json() as { device_token?: string }).device_token);
  });

  it('guest bill payload exposes tier + print capability per tier', async () => {
    const s = await app.inject({ method: 'GET', url: `/api/t/${TOK_STARTER}` });
    assert.equal(s.statusCode, 200, s.body);
    const sb = s.json() as { tier: string; capabilities: { print: boolean } };
    assert.equal(sb.tier, 'starter');
    assert.equal(sb.capabilities.print, false);
    const b = await app.inject({ method: 'GET', url: `/api/t/${TOK_BASE}` });
    assert.equal(b.statusCode, 200, b.body);
    const bb = b.json() as { tier: string; capabilities: { print: boolean } };
    assert.equal(bb.tier, 'base');
    assert.equal(bb.capabilities.print, true);
  });

  it('receipt-print for starter is not_available_on_plan and creates no job', async () => {
    const checkId = randomUUID();
    await query(`INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
      VALUES ($1,$2,$3,'ord-v090','ord-v090','square',$4,'OPEN',1200,'CAD')`,
      [checkId, T_STARTER, LOC_STARTER, MERCHANT]);
    const paymentId = randomUUID();
    await query(`INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
      VALUES ($1,$2,1200,150,'COMPLETED',$3,'pay-v090-1','CAD')`,
      [paymentId, checkId, randomUUID()]);
    const res = await app.inject({
      method: 'POST', url: `/api/t/${TOK_STARTER}/receipt-print`,
      payload: { payment_id: 'pay-v090-1' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { ok: boolean; printed: boolean; reason?: string };
    assert.equal(body.ok, true);
    assert.equal(body.printed, false);
    assert.equal(body.reason, 'not_available_on_plan');
    const jobs = await query(`SELECT id FROM print_jobs WHERE location_id = $1`, [LOC_STARTER]);
    assert.equal(jobs.rowCount, 0);
    const pay = await query<{ receipt_printed_at: string | null }>(
      `SELECT receipt_printed_at FROM payments WHERE id = $1`, [paymentId],
    );
    assert.equal(pay.rows[0].receipt_printed_at, null, 'the one-print slot must not be claimed');
  });
});
