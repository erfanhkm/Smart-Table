// v0.10.6: Claude cycle-3 chunk C3-7 fixes (portal frontend).
//
// Two layers, matching the repo's existing patterns:
//  - Source-shape assertions over public/portal/app.js (+ the touched
//    server routes), in the v088 style: there is no DOM harness for the
//    portal, so these pin the load-bearing shapes of each C3-7 fix.
//  - Behavioural route tests (pg-mem + fetch mock) for the server-side
//    halves: open-checks-detail fetched_at, billing tiers block, bill
//    view tip_cents, devices `now`, and link-check on a Clover location.
//
// Run: PG_MEM=1 npx tsx --test tests/v0106-c37-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['test', 'token'].join('-');
process.env.SQUARE_ENV = 'sandbox';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const portal = await readFile(new URL('../public/portal/app.js', import.meta.url), 'utf8');
const portalHtml = await readFile(new URL('../public/portal/index.html', import.meta.url), 'utf8');
const staffSrc = await readFile(new URL('../src/routes/staff.ts', import.meta.url), 'utf8');
const deviceSrc = await readFile(new URL('../src/routes/device.ts', import.meta.url), 'utf8');
const customerSrc = await readFile(new URL('../src/routes/customer.ts', import.meta.url), 'utf8');
const billingRouteSrc = await readFile(new URL('../src/routes/billing.ts', import.meta.url), 'utf8');

describe('v0.10.6 C3-7 portal source shapes', () => {
  it('C3-7-1: list and detail renders use separate sequence counters', () => {
    assert.ok(portal.includes('let detailSeq = 0'), 'detail counter declared');
    const detail = portal.slice(portal.indexOf('async function renderOrderDetail('), portal.indexOf('/* ---- refunds'));
    assert.ok(detail.includes('const seq = ++detailSeq'), 'renderOrderDetail uses detailSeq');
    assert.ok(!detail.includes('++orderSeq'), 'renderOrderDetail must not touch the list counter');
    const payments = portal.slice(portal.indexOf('async function loadOrderPayments('), portal.indexOf('/* One attempt = one idempotency key per (payment, amount)'));
    assert.ok(payments.includes('seq !== detailSeq'), 'payments guard uses detailSeq');
    assert.ok(!payments.includes('orderSeq'), 'payments guard must not use the list counter');
  });

  it('C3-7-1: detail render is stale-while-revalidate, refresh skips an interacted panel', () => {
    assert.ok(portal.includes('if (!sameCheck) box.innerHTML'), 'only a different check blanks the panel');
    assert.ok(portal.includes('orderDetailCheckId === t.checkId'), 'same-check detection');
    assert.ok(portal.includes('function detailPanelBusy()'), 'interaction guard exists');
    assert.ok(portal.includes('!detailPanelBusy()'), 'auto-refresh consults the guard');
    assert.ok(portal.includes("box.matches(':hover')"), 'hover counts as interaction');
  });

  it('C3-7-2: "as of" label uses server fetched_at + stale flag', () => {
    assert.ok(portal.includes('fetchedAt: data && typeof data.fetched_at'), 'aggregate meta is carried through');
    assert.ok(portal.includes("may be out of date — refreshing"), 'stale label suffix');
    assert.ok(portal.includes('new Date(fetchedAt)'), 'label renders the fetch time, not render time');
    assert.ok(!portal.includes("'as of ' + new Date().toLocaleTimeString()"), 'old render-time label is gone');
  });

  it('C3-7-2: GET deadline survives until the body is read; QR fetch has a timeout', () => {
    assert.ok(portal.includes('res.__stDeadline = deadline'), 'deadline rides the response');
    assert.ok(portal.includes('function clearResponseDeadline(res)'), 'deadline clearer exists');
    const readJsonBody = portal.slice(portal.indexOf('async function readJson('), portal.indexOf('const PortalAPI'));
    assert.ok(readJsonBody.includes('clearResponseDeadline(res)'), 'readJson clears the deadline after the body read');
    const qr = portal.slice(portal.indexOf('async getQrBlob('), portal.indexOf('async getLocations('));
    assert.ok(qr.includes('setTimeout(() => ctl.abort(), 15000)'), 'QR fetch has the 15s abort');
    assert.ok(qr.includes('await res.blob()'), 'QR deadline held through the blob read');
  });

  it('C3-7-3: linkCheck sends external_check_id; showLinkCheck guards drawer identity', () => {
    assert.ok(portal.includes('body: { external_check_id: externalCheckId }'), 'generic field is sent');
    assert.ok(!portal.includes('body: { square_order_id: squareOrderId }'), 'legacy-only body is gone');
    const show = portal.slice(portal.indexOf('async function showLinkCheck('), portal.indexOf('async function confirmFreeTable('));
    assert.ok(show.includes('drawerTable !== table'), 'drawer-identity guard after the fetch');
    assert.ok(show.includes('seqAtEntry !== drawerSeq'), 'drawer-sequence guard after the fetch');
  });

  it('C3-7-4: tier-switch copy comes from st.tiers; live subscription keeps its price; dates formatted', () => {
    const sw = portal.slice(portal.indexOf('async function switchBillingTier('), portal.indexOf('async function initBillingCardForm('));
    assert.ok(sw.includes('st.tiers[tier]'), 'tier prices read from server data');
    assert.ok(sw.includes('keeps its existing price'), 'price-keeps warning in the confirm');
    assert.ok(!sw.includes('pricing becomes $49.99/month or 1% commission.'), 'hard-coded Starter price gone');
    assert.ok(!sw.includes('pricing becomes $99/month or 2% commission,'), 'hard-coded Base price gone');
    assert.ok(portal.includes('function fmtPaidThrough(v)'), 'date formatter exists');
    assert.equal((portal.match(/fmtPaidThrough\(st\.subscription_paid_through\)/g) || []).length, 2, 'both paid-through renders use it');
    assert.ok(!portal.includes('esc(st.subscription_paid_through)'), 'raw paid-through render is gone');
    assert.ok(portal.includes('sets the price of your NEXT subscription'), 'tier card carries the price-keeps note');
  });

  it('C3-7 Low: cash 403/404/429 are confirmed rejections (attempt key dropped)', () => {
    const cash = portal.slice(portal.indexOf('async function recordCashPayment()'), portal.indexOf('/* ---', portal.indexOf('async function recordCashPayment()')));
    assert.ok(cash.includes('res.status === 403 || res.status === 404 || res.status === 429'), 'classification widened');
  });

  it('C3-7 Low: forced-free copy matches the v0.10.5 ABANDONED behaviour', () => {
    assert.ok(!portal.includes('stays open and must still be settled'), 'stale copy gone');
    assert.ok(portal.includes('abandons that check'), 'abandon copy present');
    assert.ok(portal.includes('can no longer be paid from the guest QR page'), 'consequence spelled out');
  });

  it('C3-7 Low: onboarding load failure retries; table-creation errors surface', () => {
    assert.ok(portal.includes('if (ok) onboardingLoaded = true'), 'once-flag set only on success');
    assert.ok(!portal.includes('onboardingLoaded = true;\n    loadOnboarding()'), 'flag no longer set before the load');
    assert.ok(portal.includes('id="ob-tables-result"'), 'error line exists in the wizard');
    assert.ok(portal.includes("$('ob-tables-result')"), 'quick-tables writes its errors there');
  });

  it('C3-7 Low: tender lines net the tip out; Reports compares numbers; timeAgo guards NaN', () => {
    assert.ok(portal.includes('function tenderLine(x, currency)'), 'tender line helper exists');
    assert.equal((portal.match(/tenderLine\(x, (check|detail)\.currency\)/g) || []).length, 2, 'detail + drawer both use it');
    assert.ok(portal.includes('revenue_cents: num(x.revenue_cents)'), 'Reports coerces revenue to a number');
    const ta = portal.slice(portal.indexOf('const timeAgo = '), portal.indexOf('/* v0.10.6 (C3-7 Low): POS tender amounts'));
    assert.ok(ta.includes('Number.isFinite(t)'), 'timeAgo guards invalid dates');
  });

  it('C3-7 Low: loadScriptOnce waits for the load event; card config fails closed', () => {
    assert.ok(portal.includes('const scriptLoads = new Map()'), 'promise-cached loader');
    assert.ok(portal.includes("existing.dataset.stLoaded === '1'"), 'existing tag must prove it loaded');
    assert.ok(portal.includes("if (!cfg.extra || !cfg.extra.environment || !cfg.extra.locationId)"), 'missing extra guarded');
    assert.ok(portal.includes("cfg.extra.environment === 'production'"), 'environment explicitly mapped');
    assert.ok(!portal.includes("cfg.extra.environment === 'sandbox' ? 'sandbox.' : ''"), 'missing env no longer selects production');
  });

  it('C3-7 Low: tier fetch failure fails closed on the Devices nav', () => {
    assert.ok(portal.includes('let portalTier = null'), 'tier starts unknown');
    assert.ok(portal.includes("portalTier === 'base' ? '' : 'none'"), 'nav visible only for a KNOWN base tier');
    assert.ok(portal.includes('if (portalTier === null)'), 'devices view retries the tier load');
  });

  it('C3-7 Low: device online uses the server clock; pairing code display auto-hides', () => {
    assert.ok(portal.includes('devData.now'), 'server now consumed');
    assert.ok(portal.includes('serverNow - seen.getTime() < 90_000'), 'online judged on server time');
    assert.ok(portal.includes('Pairing code hidden'), 'pairing display auto-hides');
  });

  it('C3-7 Low: role matrix View reports matches the staffOnly backend', () => {
    assert.ok(portal.includes("['View reports', true, true, true]"), 'waiters can read reports, like the API');
  });

  it('C3-7 Low: cash dialog prefills + locks the amount for tender-blind POS', () => {
    assert.ok(portal.includes("detail.pos_type === 'shopify' || detail.pos_type === 'helcim'"), 'tender-blind detection');
    assert.ok(portal.includes('readonly'), 'amount input locked');
    assert.ok(portal.includes('locked to the remaining balance'), 'lock explained');
  });

  it('C3-6-5 remainder: must_change_password gates the portal UI', () => {
    assert.ok(portal.includes('must_change_password: !!data.user.must_change_password'), 'login captures the flag');
    const enter = portal.slice(portal.indexOf('function enterApp()'), portal.indexOf('/* Forced password change'));
    assert.ok(enter.includes("openModal('modal-password')"), 'gate opens before normal use');
    assert.ok(portal.includes("'/api/portal/change-password'"), 'gate posts to the change route');
    assert.ok(portal.includes("m.id !== 'modal-password'"), 'Escape cannot dismiss the gate');
    assert.ok(portalHtml.includes('id="modal-password"'), 'modal markup exists');
    assert.ok(portalHtml.includes('id="password-form"'), 'form markup exists');
    assert.ok(portalHtml.includes('id="pw-current"') && portalHtml.includes('id="pw-new"') && portalHtml.includes('id="pw-confirm"'), 'fields exist');
    assert.ok(portal.includes("$('password-form').addEventListener('submit', submitPasswordChange)"), 'form wired');
  });

  it('server shapes: fetched_at, devices now, bill tip_cents, billing tiers', () => {
    assert.ok(staffSrc.includes('fetched_at: hit.at'), 'cache hit reports its fetch time');
    assert.ok(staffSrc.includes('stale: true, fetched_at: hit.at'), 'stale path reports flag + time');
    assert.ok(deviceSrc.includes('now: new Date().toISOString()'), 'devices list carries server now');
    assert.ok(customerSrc.includes('tip_cents: t.tipCents ?? 0'), 'bill view carries tip_cents');
    assert.ok(billingRouteSrc.includes('TIER_DEFAULTS'), 'billing present() reads TIER_DEFAULTS');
    assert.ok(billingRouteSrc.includes('tiers: {'), 'billing present() exposes the tiers block');
  });
});

/* ------------------------------------------------------------------ */
/* behavioural route tests                                             */
/* ------------------------------------------------------------------ */
const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

const STAFF = { authorization: 'Bearer ' + ['test', 'token'].join('-') };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Square order backing the aggregate + bill-view tests: $100 total, one
// $115 tender = $100 toward the bill + $15 tip.
const SQ_ORDER = {
  id: 'SQORD-TIP', location_id: 'SQLoc106', state: 'OPEN',
  total_money: { amount: 10000, currency: 'CAD' },
  line_items: [{ uid: 'li1', name: 'Steak', quantity: '1', total_money: { amount: 10000, currency: 'CAD' } }],
  tenders: [{ id: 'TND1', type: 'CARD', amount_money: { amount: 11500, currency: 'CAD' }, tip_money: { amount: 1500, currency: 'CAD' } }],
};
const CLOVER_ORDER = {
  id: 'CLORD1', state: 'open', total: 4200, currency: 'CAD',
  lineItems: { elements: [{ name: 'Pasta', price: 4200 }] },
  payments: { elements: [] as unknown[] },
};

function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/v2/orders/SQORD-TIP')) return json({ order: SQ_ORDER });
    if (url.includes('/v2/locations')) return json({ locations: [{ id: 'PLATLOC', status: 'ACTIVE', currency: 'CAD', name: 'Platform' }] });
    if (url.includes('/v2/subscriptions/search')) return json({ subscriptions: [] });
    if (/apisandbox\.dev\.clover\.com\/v3\/merchants\/M106\/orders\/CLORD1/.test(url)) return json(CLOVER_ORDER);
    if (/apisandbox\.dev\.clover\.com\/v3\/merchants\/M106\/orders\?/.test(url)) return json({ elements: [CLOVER_ORDER] });
    return json({ error: `unmocked fetch: ${url}` }, 500);
  }) as typeof fetch;
  return () => { (globalThis as unknown as { fetch: typeof fetch }).fetch = orig; };
}

const SQ_LOC = 'loc-c37-sq';
const SQ_TABLE = randomUUID();
const CL_LOC = 'loc-c37-cl';
const CL_TABLE = randomUUID();
let app: Awaited<ReturnType<typeof buildApp>>;
let restoreFetch: (() => void) | undefined;

describe('v0.10.6 C3-7 route behaviour', () => {
  before(async () => {
    await migrate();
    restoreFetch = installFetch();
    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ('m-c37-sq','square','sq-merchant-106',$1,$2)`, [encryptSecret('x'), encryptSecret('x')]);
    await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
      VALUES ($1,'m-c37-sq','square','SQLoc106','SQLoc106','C37 Square House','CAD')`, [SQ_LOC]);
    await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ($1,'m-c37-sq','square','sq-merchant-106',$2,$3)`, [randomUUID(), encryptSecret('sq-tok'), encryptSecret('x')]);
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'1','tok-c37-sq','SEATED')`, [SQ_TABLE, SQ_LOC]);
    await query(`INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
      VALUES ($1,$2,$3,'square','SQORD-TIP','SQORD-TIP','m-c37-sq','OPEN',10000,'CAD')`, [randomUUID(), SQ_TABLE, SQ_LOC]);

    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ('m-c37-cl','clover','M106',$1,$2)`, [encryptSecret('x'), encryptSecret('x')]);
    await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
      VALUES ($1,'m-c37-cl','clover','M106','loc-c37-cl','C37 Clover House','CAD')`, [CL_LOC]);
    await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ($1,'m-c37-cl','clover','M106',$2,$3)`, [randomUUID(), encryptSecret('clover-tok'), encryptSecret('x')]);
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'9','tok-c37-cl','SEATED')`, [CL_TABLE, CL_LOC]);

    app = await buildApp();
    await app.ready();
  });
  after(() => { restoreFetch?.(); });

  it('open-checks-detail carries fetched_at (stable across the 4s cache window)', async () => {
    const r1 = await app.inject({ method: 'GET', url: `/api/portal/open-checks-detail?location_id=${SQ_LOC}`, headers: STAFF });
    assert.equal(r1.statusCode, 200);
    const b1 = r1.json();
    assert.equal(typeof b1.fetched_at, 'number', 'fetched_at is a ms epoch');
    assert.ok(Math.abs(Date.now() - b1.fetched_at) < 60_000, 'fetched_at is the server fetch time');
    assert.equal(b1.orders.length, 1);
    assert.equal(b1.orders[0].paid, 10000, 'paid nets the $15 tip out of the $115 tender');
    assert.equal(b1.orders[0].remaining, 0);
    const r2 = await app.inject({ method: 'GET', url: `/api/portal/open-checks-detail?location_id=${SQ_LOC}`, headers: STAFF });
    assert.equal(r2.json().fetched_at, b1.fetched_at, 'cache hit reports the ORIGINAL fetch time');
  });

  it('bill view carries tip_cents per tender (portal detail math)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/checks/SQORD-TIP?table_token=tok-c37-sq` });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.tenders.length, 1);
    assert.equal(b.tenders[0].amount_cents, 11500, 'amount stays tip-inclusive (F2-13)');
    assert.equal(b.tenders[0].tip_cents, 1500, 'tip slice is exposed for netting');
    assert.equal(b.remaining_cents, 0);
  });

  it('billing state exposes the server tier table', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/portal/billing?location_id=${SQ_LOC}`, headers: STAFF });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.deepEqual(b.tiers, {
      starter: { subscription_price_cents: 4999, commission_bps: 100 },
      base: { subscription_price_cents: 9900, commission_bps: 200 },
    });
  });

  it('devices list carries the server clock', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/portal/devices?location_id=${SQ_LOC}`, headers: STAFF });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.deepEqual(b.devices, []);
    assert.equal(typeof b.now, 'string');
    assert.ok(Math.abs(Date.now() - new Date(b.now).getTime()) < 60_000, 'now is the server time');
  });

  it('C3-7-3: link-check works for a Clover location via external_check_id; legacy field is refused', async () => {
    // Clover check refs are composite (<merchantId>:<orderId>).
    const bad = await app.inject({
      method: 'POST', url: `/api/tables/${CL_TABLE}/link-check`, headers: STAFF,
      payload: { square_order_id: 'M106:CLORD1' },
    });
    assert.equal(bad.statusCode, 400, 'square_order_id-only is refused for non-Square');
    assert.match(bad.json().error || '', /external_check_id/);

    const ok = await app.inject({
      method: 'POST', url: `/api/tables/${CL_TABLE}/link-check`, headers: STAFF,
      payload: { external_check_id: 'M106:CLORD1' },
    });
    assert.equal(ok.statusCode, 200, `external_check_id links the Clover check: ${ok.body}`);
    const row = await query(`SELECT state, total_cents FROM checks WHERE location_id = $1 AND external_check_ref = 'M106:CLORD1'`, [CL_LOC]);
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].state, 'OPEN');
    assert.equal(Number(row.rows[0].total_cents), 4200, 'total comes from the POS, not the client');
  });
});
