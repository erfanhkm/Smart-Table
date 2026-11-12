// v0.10.7: Claude cycle-3 chunk C3-8 fixes (guest frontend + admin + dashboard).
//
// Two layers, matching the repo's existing patterns:
//  - Source-shape assertions over the four reviewed client surfaces (and
//    the touched server routes), in the v0811/v0106 style: there is no
//    DOM harness for these pages, so these pin the load-bearing shapes.
//  - A behavioural route test (pg-mem) for the one server change with
//    runtime semantics: loyalty phone normalization (L14).
//
// Run: PG_MEM=1 npx tsx --test tests/v0107-c38-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['c38', 'staff', 'token'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const guest = await readFile(new URL('../public/t/app.js', import.meta.url), 'utf8');
const guestHtml = await readFile(new URL('../public/t/index.html', import.meta.url), 'utf8');
const admin = await readFile(new URL('../public/admin/app.js', import.meta.url), 'utf8');
const dash = await readFile(new URL('../public/dashboard/app.js', import.meta.url), 'utf8');
const dashHtml = await readFile(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const indexSrc = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const staffSrc = await readFile(new URL('../src/routes/staff.ts', import.meta.url), 'utf8');
const customerSrc = await readFile(new URL('../src/routes/customer.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('v0.10.7 C3-8 guest source shapes', () => {
  it('H3: paid figures net the tip out of tip-inclusive tenders', () => {
    assert.ok(guest.includes('td.amount_cents - (td.tip_cents || 0)'), 'Already-paid rows net the tip');
    assert.ok(guest.includes('s + td.amount_cents - (td.tip_cents || 0)'), 'Group Pay paidSoFar nets the tip');
  });

  it('M1/M2: receipt adds up (share line + tip row) and the tip is priced before paying', () => {
    assert.ok(guest.includes("t('yourShareOfCheck')"), 'receipt share line exists');
    assert.ok(guest.includes("t('tipWord')"), 'receipt tip row exists');
    assert.ok(guest.includes('itemsSum !== src.amount_cents'), 'share line replaces items that cannot sum to the payment');
    assert.ok(guest.includes("t('shareTipTotal'"), 'Share + Tip = Total line renders with the tip chips');
  });

  it('M4: decimal comma parses as a decimal; capping is announced', () => {
    assert.ok(guest.includes("raw.replace(/,(\\d{1,2})$/, '.$1')"), 'trailing comma + 1-2 digits becomes the decimal point');
    assert.ok(guest.includes("t('cappedNotice'"), 'over-balance amount announces the cap on change');
    assert.ok(guest.includes("if (ch === '،') return ','"), 'Arabic comma normalized to a separator');
  });

  it('M5: equal split is labelled as splitting the REMAINING balance', () => {
    assert.ok(guest.includes("t('splitRest', { n: people })"), 'equal stepper uses the remaining-balance copy');
    assert.ok(!guest.includes("t('splitAmong'"), 'old split-of-total copy no longer rendered');
  });

  it('M6: a bare {} success body never reports a $0.00 balance', () => {
    assert.ok(guest.includes('Number.isFinite(data.remainingCents)'), 'remainingCents is type-checked');
    assert.ok(guest.includes('snapCheck.remaining_cents - a.amount'), 'falls back to snapshot math');
    assert.ok(!guest.includes('data.remainingCents ?? 0'), 'the ?? 0 fallback is gone');
  });

  it('M7: wallet country follows the check currency', () => {
    assert.ok(guest.includes("USD: 'US'"), 'currency→country map present');
    assert.ok(!guest.includes("countryCode: 'CA',"), 'hardcoded CA removed');
  });

  it('M9: the guest\'s own payment is remembered for the completed-check screen', () => {
    assert.ok(guest.includes('lastPayment = {'), 'payment snapshot stored on every success');
    assert.ok(guest.includes('lastPayment.order_id === check.square_order_id'), 'snapshot is scoped to its check');
    assert.ok(guest.includes('noticeHtml() + renderSuccessState()'), 'completed branch renders the notice area');
  });

  it('M10: a blocked attempt can be re-checked with the same key (no 24h dead end)', () => {
    assert.ok(!guest.includes('if (a && a.blocked) return;'), 'processPayment no longer refuses blocked attempts');
    const upd = guest.slice(guest.indexOf('function updatePayButton('), guest.indexOf('function render(force'));
    assert.ok(upd.includes('a.blocked'), 'updatePayButton handles blocked attempts');
    assert.ok(!upd.includes('btn.disabled = true'), 'the blocked button is not hard-disabled');
  });

  it('M11: the Square card attaches before the first Pay tap', () => {
    assert.ok(guest.includes('async function ensureSquareCard(cfg)'), 'pre-attach helper exists');
    const tok = guest.slice(guest.indexOf('async function squareTokenize('), guest.indexOf('// ---- wallets'));
    assert.ok(tok.includes('ensureSquareCard(cfg)'), 'tokenize reuses the pre-attached card');
    assert.ok(!tok.includes('.attach('), 'tokenize no longer attaches inline');
    assert.ok(guest.includes('ensureSquareCard(cfg).catch(() => {})'), 'updatePayButton warms the iframe');
  });

  it('M12: the Clover form clears on every settle', () => {
    const form = guest.slice(guest.indexOf('function cloverCardForm('), guest.indexOf('async function cloverTokenize('));
    assert.ok(form.includes("c.innerHTML = '';"), 'validation settle clears the form');
    const tok = guest.slice(guest.indexOf('async function cloverTokenize('), guest.indexOf('// Helcim'));
    assert.ok(tok.includes("$('card-container').innerHTML = '';"), 'PAN fields leave the DOM after the form resolves');
  });

  it('M13: wallet rebuilds are debounced', () => {
    assert.ok(guest.includes('walletState.pendingKey = key'), 'pending key tracked');
    assert.ok(guest.includes('}, 600);'), '600ms debounce timer');
  });

  it('M14: only https: review links render', () => {
    assert.ok(guest.includes("new URL(ratingResult?.google_review_url).protocol === 'https:'"), 'scheme allow-list on the client');
    assert.ok(guest.includes('safeReviewUrl'), 'guarded URL variable used for the anchor');
  });

  it('M15: print capability fails closed on the client', () => {
    assert.ok(guest.includes("printEnabled = !!data.capabilities && data.capabilities.print === true"), 'strict true check');
    assert.ok(!guest.includes('data.capabilities.print !== false'), 'fail-open default removed');
  });

  it('M22: guest notices use i18n strings, not raw server text or English literals', () => {
    for (const lit of ["'Card payments are not available at this location.'", "'Payment could not be processed.'", "'Could not send receipt.'", "'Order could not be placed.'", "'Card entry failed — please try again.'", "'That payment option is not available on this device.'", "'Payment was not completed.'", "'Card could not be tokenized. Please try again.'", "'Could not start the payment form.'", "'Payment cancelled.'", "'Square payments library failed to load.'"]) {
      assert.ok(!guest.includes(lit), `literal removed: ${lit}`);
    }
    assert.ok(guest.includes("setNotice(t('joinFailed'))"), 'loyalty failure is localized');
    assert.ok(guest.includes("setNotice(t('claimFailed'))"), 'claim failure is localized');
  });

  it('L1/L2/L3/L4/L7/L10/L11 lows', () => {
    assert.ok(guest.includes("cfg.extra?.environment !== 'production' && cfg.extra?.environment !== 'sandbox'"), 'L1 env allow-list');
    assert.ok(guest.includes('भुगतान संसाधित हो रहा है'), 'L2 Hindi processing typo fixed');
    assert.ok(!guest.includes('भुगताना'), 'L2 typo gone');
    assert.ok(guest.includes("n: r.visits_remaining ?? ''"), 'L3 loyalty n passes as a number (plural _1 can fire)');
    assert.ok(guest.includes('id="loyalty-phone" dir="ltr"'), 'L4 phone input LTR');
    assert.ok(guest.includes('id="receipt-email" dir="ltr"'), 'L4 email input LTR');
    assert.ok(guest.includes('id="cc-num" dir="ltr"'), 'L4 card inputs LTR');
    assert.ok(guest.includes('function syncFooterPadding()'), 'L7 footer-height padding sync');
    assert.ok(guest.includes("case 'rc-reprint': requestReceiptPrint();"), 'L10 print retry keeps the receipt choice');
    assert.ok(guest.includes('}, 180000);'), 'L11 Helcim modal timeout');
    assert.ok(guest.includes('receiptEmailDraft = e.target.value'), 'M20 receipt email draft tracked');
    assert.ok(guest.includes('value="${esc(receiptEmailDraft)}"'), 'M20 draft restored on re-render');
  });

  it('H1/L8/L9: guest shell CSS', () => {
    const count = guestHtml.slice(guestHtml.indexOf('.cart-sticky-count'), guestHtml.indexOf('.cart-sticky-total'));
    assert.ok(!count.includes('letter-spacing'), 'H1: no letter-spacing on the cart count');
    assert.ok(!count.includes('text-transform'), 'H1: no uppercase transform on the cart count');
    assert.ok(guestHtml.includes('font-size: 1rem; margin-bottom: 16px; }'), 'L8: rating textarea is 16px (no iOS zoom)');
    assert.ok(!guestHtml.includes('email-toggle'), 'L9: dead print-CSS selector removed');
    assert.ok(!guestHtml.includes('[data-action="print"]'), 'L9: dead print-CSS selector removed');
  });
});

describe('v0.10.7 C3-8 admin source shapes', () => {
  it('M17: a session epoch guards every render in load()', () => {
    assert.ok(admin.includes('let sessionEpoch = 0'), 'epoch declared');
    assert.ok(admin.includes('sessionEpoch++;'), 'signOut bumps the epoch');
    assert.ok(admin.includes('if (epoch !== sessionEpoch) return;'), 'stale loads render nothing');
  });

  it('L15/L16 lows', () => {
    assert.ok(admin.includes("'Copy failed — select the password and copy it manually'"), 'L15 copy button reports failure');
    assert.ok(admin.includes('await navigator.clipboard.writeText(pw)'), 'L15 clipboard result is awaited');
    assert.ok(admin.includes('const tierEl = document.querySelector'), 'L16 radio groups null-checked');
    assert.ok(!admin.includes('input[name="nr-tier"]:checked\').value'), 'L16 unchecked-radio crash removed');
  });
});

describe('v0.10.7 C3-8 dashboard source shapes', () => {
  it('H2: cash attempts are kept per (order, amount) with a TTL sweep', () => {
    assert.ok(dash.includes('function loadCashMap()'), 'attempt map loader');
    assert.ok(dash.includes('function loadCash(sig)'), 'lookup is per-signature');
    assert.ok(dash.includes('const CASH_TTL_MS = 24 * 60 * 60 * 1000'), '24h TTL like the guest attempts');
    assert.ok(dash.includes('let a = loadCash(sig);'), 'recordCash looks up its own signature');
    assert.ok(dash.includes('clearCash(sig)'), 'clears only its own signature');
    assert.ok(!dash.includes('function loadCash() { if (memCash) return memCash;'), 'single global slot removed');
  });

  it('M18/M19/L17/L18/L19 dashboard lows', () => {
    assert.ok(dash.includes('let dashSeq = 0'), 'M18 fetch sequence guard');
    assert.ok(dash.includes('seq !== dashSeq || locId() !== id'), 'M18 stale responses dropped');
    assert.ok(dash.includes('pollInFlight'), 'M18 poll in-flight guard');
    assert.ok(dash.includes("closeDrawer(); selectedTable = null; loadDashboardData();"), 'M18 switch closes the drawer');
    assert.ok(dash.includes("pollFailures >= 3"), 'M19 offline after consecutive failures');
    assert.ok(dash.includes('Connection lost — retrying'), 'M19 visible offline label');
    assert.ok(dashHtml.includes('id="conn-status"'), 'M19 status span is addressable');
    const qr = dash.slice(dash.indexOf('async function fetchAndShowQR()'), dash.indexOf('async function addTable()'));
    assert.ok(qr.indexOf("window.open('', '_blank')") < qr.indexOf('/qr`'), 'L17 popup opens before the fetch');
    assert.ok(!qr.includes('onclick='), 'L17 no inline onclick in the QR document');
    assert.ok(dash.includes('let drawerSeq = 0'), 'L18 drawer sequence token');
    const poll = dash.slice(dash.indexOf('async function pollDashboard()'), dash.indexOf('function renderMetrics'));
    assert.ok(poll.includes('/api/dashboard/metrics'), 'L19 metrics ride the poll');
    assert.ok(dash.includes('function applyTierVisibility()'), 'L19 Starter hides waiter-call UI');
    assert.ok(staffSrc.includes('name, currency, tier,'), 'L19 /api/locations carries tier');
  });

  it('M21: the dashboard script is external and version-pinned; CSP drops unsafe-inline', () => {
    assert.ok(dashHtml.includes('<script src="/dashboard/app.js?v=0.10.10" defer></script>'), 'versioned script URL');
    assert.ok(!dashHtml.includes("'use strict'"), 'no inline script left in the shell');
    const route = indexSrc.slice(indexSrc.indexOf("app.get('/dashboard'"), indexSrc.indexOf('// Restaurant portal'));
    assert.ok(route.includes("script-src 'self';"), 'dashboard script-src is self-only');
    assert.ok(!route.includes("script-src 'self' 'unsafe-inline'"), 'no script unsafe-inline');
    assert.ok(indexSrc.includes("urlPath === '/dashboard/app.js'") || indexSrc.includes("'/dashboard/app.js'"), 'app.js is on the no-cache pin list');
    assert.equal(pkg.version, '0.10.10', 'package.json at 0.10.10');
  });
});

describe('v0.10.7 C3-8 server behaviour', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let locationId = '';
  let tableToken = '';

  before(async () => {
    const { migrate } = await import('../src/migrate.js');
    const { query } = await import('../src/db.js');
    const { encryptSecret } = await import('../src/crypto.js');
    const { buildApp } = await import('../src/index.js');
    await migrate();
    app = await buildApp({ logger: false });
    const merchantId = randomUUID();
    locationId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,'square',$2,$2,$3,$4,'2099-06-01T00:00:00Z')`,
      [merchantId, 'sqm-c38', encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, qr_ordering_enabled, loyalty_enabled, loyalty_visits_required, loyalty_reward_text)
       VALUES ($1,$2,'square','SQL-C38','SQL-C38','C38 House','CAD',false,true,true,5,'Free dessert')`,
      [locationId, merchantId],
    );
    const tableId = randomUUID();
    tableToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'L14',$3,'SEATED')`, [tableId, locationId, tableToken]);
    const mkCheck = async (ref: string) => {
      const id = randomUUID();
      await query(
        `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
         VALUES ($1,$2,$3,$4,$4,'square',$5,'OPEN',2400,'CAD')`,
        [id, tableId, locationId, ref, merchantId],
      );
      return id;
    };
    // One visit counts per CHECK — the two submissions must ride two
    // different checks, like two real visits.
    const checks: Record<string, string> = { 'pay-c38-a': await mkCheck('ord-c38'), 'pay-c38-b': await mkCheck('ord-c38-b') };
    for (const ref of ['pay-c38-a', 'pay-c38-b']) {
      await query(
        `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
         VALUES ($1,$2,1200,0,'COMPLETED',$3,$4,'CAD')`,
        [randomUUID(), checks[ref], randomUUID(), ref],
      );
    }
  });

  after(async () => { await app?.close(); });

  it('L14: "+1 604…" and "604…" are the same loyalty member', async () => {
    const { query } = await import('../src/db.js');
    const loy = (body: unknown) => app.inject({ method: 'POST', url: `/api/t/${tableToken}/loyalty`, payload: body as Record<string, unknown> });
    const first = await loy({ phone: '6045550101', payment_id: 'pay-c38-a' });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().visits, 1);
    const intl = await loy({ phone: '+1 (604) 555-0101', payment_id: 'pay-c38-b' });
    assert.equal(intl.statusCode, 200, intl.body);
    assert.equal(intl.json().visits, 2, 'the +1 form must continue the same membership, not start a new one');
    const rows = await query(`SELECT visit_count FROM loyalty_visits WHERE location_id = $1`, [locationId]);
    assert.equal(rows.rowCount, 1, 'exactly one loyalty row exists for the location');
    assert.equal(Number(rows.rows[0].visit_count), 2);
  });

  it('L14 source shape: normalization happens before the hash', () => {
    assert.ok(customerSrc.includes("rawDigits.length === 11 && rawDigits.startsWith('1') ? rawDigits.slice(1) : rawDigits"), 'NANP country-code strip');
  });
});
