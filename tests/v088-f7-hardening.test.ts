// v0.8.8 F7 hardening tests — Claude cycle-2 chunk F7 (portal app.js).
//
// Source-shape assertions over public/portal/app.js (+ the metrics route),
// in the same style as v0611-smalls.test.ts. There is no DOM harness for
// the portal; these pin the load-bearing shapes of each F7 fix so a future
// edit cannot silently revert them.
//
// Run: PG_MEM=1 npx tsx --test tests/v088-f7-hardening.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../public/portal/app.js', import.meta.url), 'utf8');
const dash = await readFile(new URL('../src/routes/dashboard.ts', import.meta.url), 'utf8');

describe('v0.8.8 F7 portal hardening', () => {
  it('F7-7: money() validates the currency code before it can reach HTML', () => {
    assert.ok(src.includes("/^[A-Z]{3}$/.test(cur)"), 'money() must validate the currency code');
    assert.ok(!src.includes("return ((cents || 0) / 100).toFixed(2) + ' ' + (currency || 'CAD')"),
      'the old unvalidated fallback shape must be gone');
  });

  it('F7-7: the five raw numeric sites are wrapped in num()', () => {
    assert.ok(src.includes('${num(a.rating)}'), 'service-alert rating');
    assert.ok(src.includes('${num(menu.item_count)}'), 'onboarding item_count');
    assert.ok(src.includes('data-max="${num(p.refundable_cents)}"'), 'refund data-max attribute');
    assert.ok(src.includes('num(p.amount_cents) + num(p.tip_cents)'), 'payment total coercion');
    assert.ok(src.includes('${num(r.checks)}'), 'reports daily checks');
  });

  it('F7-4: cash attempts are a sig-keyed map; the single global slot is gone', () => {
    assert.ok(src.includes('function loadCashAttempts()'), 'map loader exists');
    assert.ok(src.includes('attempts[sig] = attempt'), 'attempt stored under its sig');
    assert.ok(!src.includes('memCash'), 'single-slot memCash must be gone');
    assert.ok(!src.includes('function loadCashAttempt()'), 'old single-attempt loader must be gone');
  });

  it('F7-4: recordCashPayment snapshots the drawer globals before awaiting', () => {
    const fn = src.slice(src.indexOf('async function recordCashPayment()'), src.indexOf('/* ---', src.indexOf('async function recordCashPayment()')));
    assert.ok(fn.includes('const checkId = drawerCheckId'), 'check id snapshot');
    assert.ok(fn.includes('const table = drawerTable'), 'table snapshot');
    assert.ok(!fn.includes('recordCashPaymentRaw(drawerCheckId'), 'record call must use the snapshot, not the global');
  });

  it('F7-5(b): freeTable sends force and confirmFreeTable handles open_check_exists', () => {
    assert.ok(src.includes('body: { force: !!force }'), 'freeTable must send the force flag');
    assert.ok(src.includes("e.code !== 'open_check_exists'"), 'confirmFreeTable must branch on the server code');
    assert.ok(!src.includes('Any open check is left untouched in Square'), 'the stale pre-F6-3 copy must be gone');
  });

  it('F7-2: the Orders fallback never fans out on 429/5xx', () => {
    assert.ok(src.includes('e.status === 429 || e.status >= 500'), 'fan-out guard on status');
    assert.ok(src.includes('err.status = res.status'), 'aggregate error carries its status');
    assert.ok(src.includes('pollsPausedUntil'), 'Retry-After pause exists');
  });

  it('F7-2/F7-L8: onboarding is fetched once per session, not per poll', () => {
    assert.ok(src.includes('let onboardingLoaded = false'), 'once-flag declared');
    assert.ok(src.includes('if (!onboardingLoaded)'), 'renderOverview guards the fetch');
  });

  it('F7-6: getLiveOrders refreshes tablesCache', () => {
    const fn = src.slice(src.indexOf('async function getLiveOrders()'), src.indexOf('function renderLiveOrders()'));
    assert.ok(fn.includes('tablesCache = oRes.tables.map'), 'cache rebuilt from the overview response');
  });

  it('F7-3: order detail + payments are sequence-guarded', () => {
    assert.ok(src.includes('let orderSeq = 0'), 'orderSeq declared');
    assert.ok(src.includes('if (seq !== orderSeq) return'), 'late writes dropped');
    assert.ok(src.includes('orderDetailCheckId === checkRef'), 'refund finally only refreshes its own check');
  });

  it('F7-L5: refunds use the strict cash amount parser', () => {
    const fn = src.slice(src.indexOf('async function startRefund('), src.indexOf('/* ---- idempotent cash'));
    assert.ok(fn.includes('parseCashAmount(raw)'), 'strict parser used');
    assert.ok(!fn.includes('parseFloat(String(raw)'), 'the lenient refund parse expression must be gone');
  });

  it('F7-8: the billing card instance is assigned only after attach succeeds', () => {
    const iCard = src.indexOf('const card = await payments.card()');
    const iAttach = src.indexOf("await card.attach('#billing-sq-card')");
    const iAssign = src.indexOf('billingCardInstance = card');
    assert.ok(iCard > 0 && iAttach > iCard && iAssign > iAttach, 'create → attach → assign order');
    assert.ok(!src.includes('billingCardInstance = await payments.card()'), 'old assign-first shape must be gone');
    assert.ok(src.includes('billingCardInstance.destroy'), 'renderBilling destroys the stale instance');
  });

  it('F7-L13: billing history failure is isolated from the page render', () => {
    const fn = src.slice(src.indexOf('async function renderBilling()'), src.indexOf('async function switchBillingPlan'));
    assert.ok(fn.includes('history stays empty'), 'isolated history catch present');
  });

  it('F7-L1: metrics returns the location currency and Reports uses it', () => {
    assert.ok(dash.includes('currency: loc.rows[0]?.currency'), 'metrics route returns currency');
    assert.ok(src.includes("const repCur = met.currency || 'CAD'"), 'reports read it');
    assert.ok(!src.includes("money(r.revenue_cents, 'CAD')"), 'no hard-coded CAD left in the daily rows');
  });

  it('F7-1: renders are serialized and failures surface the stale banner', () => {
    assert.ok(src.includes('renderQueuedView'), 'render queue exists');
    assert.ok(src.includes('noteRenderFailure'), 'failure counter exists');
    assert.ok(src.includes('AbortController'), 'GET timeout exists');
    assert.ok(!src.includes("if (currentView === 'staff' || currentView === 'devices' || currentView === 'billing' || currentView === 'settings') return;\n  renderView"),
      'poll skip list must now include reports');
  });

  it('F7-L2: link-check uses the generic POS route, not the Square-only one', () => {
    assert.ok(src.includes('/api/pos-open-checks'), 'generic route used');
    assert.ok(!src.includes('/api/square-open-orders'), 'Square-only route must be gone from the portal');
    assert.ok(!src.includes('Link a Square check'), 'Square-only wording must be gone');
  });

  it('F7-L4: attempt maps are TTL-pruned and cleared on reset', () => {
    assert.ok(src.includes('ATTEMPT_TTL_MS'), 'TTL constant exists');
    assert.ok(src.includes('clearRefundAttempts()'), 'refund attempts cleared in resetUi');
    assert.ok(src.includes('clearCashAttempts()'), 'cash attempts cleared in resetUi');
  });
});
