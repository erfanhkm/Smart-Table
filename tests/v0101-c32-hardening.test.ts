// v0.10.1 — Claude cycle-3 chunk C3-2 fixes (billing + reconcile):
//   C3-2-1  sweepMissingFees: 48h window, stored fee decision honored,
//           external (cash) payments excluded, Square cash noise gone;
//           payCheck stamps fee_decision/fee_bps (migration 032).
//   C3-2-2  resolveStuckFeeCharges: a resend ERROR (IDEMPOTENCY_KEY_REUSED,
//           401, ...) routes to manual review — never releases the batch.
//   C3-2-3  toYmd: DATE-column values normalized to 'YYYY-MM-DD' strings
//           at the billing-account read choke points.
//   C3-2-4  setLocationTier: same-tier no-op, customized pricing preserved
//           across tier changes, explicit resetPricing; device print/call
//           routes enforce tier at use time.
//   C3-2-5  syncSubscription: subscription-id-guarded fold-in + CAS flip.
//   C3-2-6  processAccruedFees: 401 is platform-side (batch held, no
//           backoff), per-currency charges, $1 minimum charge.
//   C3-2-7  reconcile: tender-coverage close decision.
//   C3-2-8  reconcile: due check in SQL — backed-off rows can no longer
//           starve newer stranded payments out of the window.
//   C3-2-9  billingHistory: rate derived from each fee row, row currency,
//           no fabricated invoice amounts.
//   C3-2-10 saveCard: subscription moves to the new card BEFORE the
//           account points at it; a failed move keeps the old card and
//           surfaces an error.
//   C3-2-11 reconcile: inconsistent POS detail (remaining < total, zero
//           tenders) goes to manual review, never FAILED.
//
// Run: PG_MEM=1 npx tsx --test tests/v0101-c32-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
process.env.SQUARE_ACCESS_TOKEN = 'test-square-token';
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';
process.env.SQUARE_LOCATION_ID = 'SQLOC1';
process.env.SQUARE_ENV = 'sandbox';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = 'x';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const {
  toYmd, ensureBillingAccount, setLocationTier, getBillingState, syncSubscription,
  sweepMissingFees, resolveStuckFeeCharges, processAccruedFees, billingHistory, saveCard,
} = await import('../src/services/billing.js');
const { reconcilePendingPayments } = await import('../src/services/reconcile.js');
const { payCheck } = await import('../src/services/payments.js');
const { buildApp } = await import('../src/index.js');
const { hashToken } = await import('../src/routes/portal.js');

// ---- Square fetch mock (one install for the whole file) --------------------
interface Call { url: string; method: string; body: Record<string, unknown> }
const calls: Call[] = [];
const disabledCards: string[] = [];
type PlatMode = 'ok' | 'key-reused' | 'unauthorized';
let platMode: PlatMode = 'ok';
let subCardUpdateFails = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SUBS: Record<string, any> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const INVOICES: Record<string, any> = {};
interface OrderCfg { total: number; tenders?: { id: string; amount: number; tip?: number }[]; netDue?: number }
const ORDERS: Record<string, OrderCfg> = {};
const orderPaid: Record<string, number> = {};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function orderObj(id: string) {
  const cfg = ORDERS[id];
  const paid = orderPaid[id] ?? 0;
  const tenders = cfg.tenders ?? (paid > 0 ? [{ id: `T-${id}`, amount: paid }] : []);
  return {
    id, location_id: 'SQLoc1', state: paid >= cfg.total ? 'COMPLETED' : 'OPEN',
    total_money: { amount: cfg.total, currency: 'CAD' },
    ...(cfg.netDue !== undefined ? { net_amount_due_money: { amount: cfg.netDue, currency: 'CAD' } } : {}),
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: cfg.total, currency: 'CAD' } }],
    tenders: tenders.map((t) => ({
      id: t.id, type: 'CARD',
      amount_money: { amount: t.amount, currency: 'CAD' },
      ...(t.tip ? { tip_money: { amount: t.tip, currency: 'CAD' } } : {}),
    })),
  };
}
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method, body });
    if (url.includes('/v2/locations')) {
      return json({ locations: [{ id: 'PLATLOC', status: 'ACTIVE', currency: 'CAD', name: 'Platform' }] });
    }
    const om = /\/v2\/orders\/([^/?]+)(\/pay)?/.exec(url);
    if (om && ORDERS[om[1]]) {
      return json({ order: orderObj(om[1]) });
    }
    if (url.endsWith('/v2/payments') && method === 'POST') {
      if (body.customer_id) {
        // Platform-account charge (accrued fee collection / resolver resend).
        if (platMode === 'key-reused') {
          return json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'IDEMPOTENCY_KEY_REUSED', detail: 'key reused with different parameters' }] }, 400);
        }
        if (platMode === 'unauthorized') {
          return json({ errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'token revoked' }] }, 401);
        }
        return json({ payment: { id: `PLATPAY-${randomUUID().slice(0, 8)}`, status: 'COMPLETED' } });
      }
      // Merchant charge (payCheck): track the order's paid total.
      const oid = body.order_id as string;
      if (oid && ORDERS[oid]) {
        orderPaid[oid] = (orderPaid[oid] ?? 0) + (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0);
      }
      return json({ payment: { id: `SQPAY-${randomUUID().slice(0, 8)}`, status: 'APPROVED' } });
    }
    if (/\/v2\/cards\/[^/]+\/disable/.test(url)) {
      disabledCards.push(/\/v2\/cards\/([^/]+)\/disable/.exec(url)![1]);
      return json({});
    }
    if (url.endsWith('/v2/cards') && method === 'POST') {
      return json({ card: { id: 'CARD-NEW', card_brand: 'VISA', last_4: '1111' } });
    }
    if (url.includes('/v2/customers')) return json({ customer: { id: 'CUST1' } });
    const sm = /\/v2\/subscriptions\/([^/?]+)/.exec(url);
    if (sm && method === 'GET') {
      const sub = SUBS[sm[1]];
      return sub ? json({ subscription: sub }) : json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
    }
    if (sm && method === 'POST') {
      if (subCardUpdateFails) return json({ errors: [{ code: 'BAD_REQUEST', detail: 'card update refused' }] }, 400);
      return json({ subscription: { id: sm[1], status: 'ACTIVE' } });
    }
    if (url.includes('/v2/subscriptions/search')) return json({ subscriptions: [] });
    if (url.endsWith('/v2/subscriptions') && method === 'POST') {
      return json({ subscription: { id: 'SUB-NEW', status: 'ACTIVE', charged_through_date: '2026-12-01' } });
    }
    if (url.includes('/v2/catalog/object')) return json({ catalog_object: { id: 'VAR1' } });
    const im = /\/v2\/invoices\/([^/?]+)/.exec(url);
    if (im && INVOICES[im[1]]) return json({ invoice: INVOICES[im[1]] });
    return json({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
}

// ---- seed helpers -----------------------------------------------------------
async function seedLoc(loc: string, opts: { posType?: string; tier?: string; demo?: boolean } = {}): Promise<void> {
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, square_location_id, name, currency, tier, demo)
     VALUES ($1,'m-c32',$2,$3,$4,'CAD',$5,$6)`,
    [loc, opts.posType ?? 'square', `SQ-${loc}`, `House ${loc}`, opts.tier ?? 'base', opts.demo ?? false],
  );
}
async function seedCheck(loc: string, ref: string, posType = 'square'): Promise<string> {
  const tId = randomUUID();
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
    [tId, loc, `T-${ref}`, randomUUID().replace(/-/g, '')]);
  const cId = randomUUID();
  await query(
    `INSERT INTO checks(id, location_id, table_id, pos_type, external_check_ref, state) VALUES ($1,$2,$3,$4,$5,'OPEN')`,
    [cId, loc, tId, posType, ref],
  );
  return cId;
}
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

before(async () => {
  installFetch();
  await migrate();
});

// ---- C3-2-3: date normalization ---------------------------------------------
describe('C3-2-3 toYmd + account normalization', () => {
  it('toYmd: Date -> local calendar components, string passthrough, junk -> null', () => {
    assert.equal(toYmd(new Date(2026, 0, 1, 23, 59)), '2026-01-01');
    assert.equal(toYmd(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
    assert.equal(toYmd('2026-11-02'), '2026-11-02');
    assert.equal(toYmd('2026-11-02T05:00:00.000Z'), '2026-11-02');
    assert.equal(toYmd(null), null);
    assert.equal(toYmd(undefined), null);
    assert.equal(toYmd(42), null);
    assert.equal(toYmd('not a date'), null);
  });

  it('billing accounts come back with a string paid-through', async () => {
    const loc = 'loc-dates';
    await seedLoc(loc);
    await ensureBillingAccount(loc);
    await query(
      `UPDATE billing_accounts SET plan = 'subscription', subscription_paid_through = '2026-12-15' WHERE location_id = $1`,
      [loc],
    );
    const acct = await ensureBillingAccount(loc);
    assert.equal(typeof acct.subscription_paid_through, 'string');
    assert.equal(acct.subscription_paid_through, '2026-12-15');
    const state = await getBillingState(loc);
    assert.equal(state.effective_plan, 'subscription', 'paid-through in the future keeps the subscription plan');
  });
});

// ---- C3-2-5: syncSubscription compare-and-set --------------------------------
describe('C3-2-5 syncSubscription CAS', () => {
  it('pending flip still lands in the uncontended case', async () => {
    const loc = 'loc-sync1';
    await seedLoc(loc);
    await ensureBillingAccount(loc);
    await query(
      `UPDATE billing_accounts SET plan = 'subscription', pending_plan = 'commission',
         square_subscription_id = 'SUB-S1', subscription_status = 'ACTIVE', subscription_paid_through = $2
       WHERE location_id = $1`,
      [loc, day(10)],
    );
    SUBS['SUB-S1'] = { id: 'SUB-S1', status: 'CANCELED', canceled_date: day(-1) };
    const acct = await ensureBillingAccount(loc);
    const out = await syncSubscription(acct);
    assert.equal(out.plan, 'commission');
    assert.equal(out.pending_plan, null);
    assert.equal(out.subscription_status, 'CANCELED');
  });

  it('a subscription-id change mid-sync blocks the stale fold-in AND the flip', async () => {
    const loc = 'loc-sync2';
    await seedLoc(loc);
    await ensureBillingAccount(loc);
    await query(
      `UPDATE billing_accounts SET plan = 'subscription', pending_plan = 'commission',
         square_subscription_id = 'SUB-S2', subscription_status = 'ACTIVE', subscription_paid_through = $2
       WHERE location_id = $1`,
      [loc, day(30)],
    );
    const stale = await ensureBillingAccount(loc);
    // The owner re-subscribes while the scheduled sync is in flight: the
    // row now points at a NEW subscription and the pending switch is gone.
    await query(
      `UPDATE billing_accounts SET square_subscription_id = 'SUB-NEW2', pending_plan = NULL WHERE location_id = $1`,
      [loc],
    );
    SUBS['SUB-S2'] = { id: 'SUB-S2', status: 'CANCELED', canceled_date: day(-1) };
    const out = await syncSubscription(stale);
    assert.equal(out.square_subscription_id, 'SUB-NEW2');
    assert.equal(out.plan, 'subscription', 'the stale sync must not flip the plan');
    assert.equal(out.subscription_status, 'ACTIVE', 'the stale CANCELED status must not be written over the new subscription');
    const row = await query<{ plan: string; subscription_status: string }>(
      `SELECT plan, subscription_status FROM billing_accounts WHERE location_id = $1`, [loc]);
    assert.equal(row.rows[0].plan, 'subscription');
    assert.equal(row.rows[0].subscription_status, 'ACTIVE');
  });
});

// ---- C3-2-4: tier changes ------------------------------------------------------
describe('C3-2-4 setLocationTier pricing semantics', () => {
  it('same-tier re-select is a no-op and preserves customized pricing', async () => {
    const loc = 'loc-tier-noop';
    await seedLoc(loc, { tier: 'base' });
    await ensureBillingAccount(loc);
    await query(`UPDATE billing_accounts SET commission_bps = 150, subscription_price_cents = 8000 WHERE location_id = $1`, [loc]);
    const st = await setLocationTier(loc, 'base');
    assert.equal(st.tier, 'base');
    assert.equal(st.account.commission_bps, 150, 'a no-op re-save must not wipe negotiated pricing');
    assert.equal(st.account.subscription_price_cents, 8000);
  });

  it('tier change applies the new defaults to an UN-customized account', async () => {
    const loc = 'loc-tier-defaults';
    await seedLoc(loc, { tier: 'starter' });
    const acct = await ensureBillingAccount(loc);
    assert.equal(acct.commission_bps, 100);
    const st = await setLocationTier(loc, 'base');
    assert.equal(st.tier, 'base');
    assert.equal(st.account.commission_bps, 200);
    assert.equal(st.account.subscription_price_cents, 9900);
  });

  it('tier change preserves customized pricing; explicit reset applies defaults', async () => {
    const loc = 'loc-tier-custom';
    await seedLoc(loc, { tier: 'base' });
    await ensureBillingAccount(loc);
    await query(`UPDATE billing_accounts SET commission_bps = 150, subscription_price_cents = 8000 WHERE location_id = $1`, [loc]);
    const st = await setLocationTier(loc, 'starter');
    assert.equal(st.tier, 'starter');
    assert.equal(st.account.commission_bps, 150, 'negotiated pricing survives a tier change');
    assert.equal(st.account.subscription_price_cents, 8000);
    const st2 = await setLocationTier(loc, 'base', { resetPricing: true });
    assert.equal(st2.account.commission_bps, 200, 'an explicit reset moves to the tier defaults');
    assert.equal(st2.account.subscription_price_cents, 9900);
  });
});

// ---- C3-2-1: the sweep ---------------------------------------------------------
describe('C3-2-1 sweepMissingFees honors the stored fee decision', () => {
  const LOC_HC = 'loc-sweep-hc';
  const LOC_SQ = 'loc-sweep-sq';
  async function seedPayment(loc: string, checkId: string, opts: {
    ref: string; amount: number; ageMin?: number; ageDays?: number;
    decision?: string; bps?: number; recordedBy?: string;
  }): Promise<string> {
    const pid = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key,
         external_payment_ref, remaining_after_cents, check_state, currency, fee_decision, fee_bps, recorded_by)
       VALUES ($1,$2,$3,0,'full','COMPLETED',$4,$5,0,'COMPLETED','CAD',$6,$7,$8)`,
      [pid, checkId, opts.amount, randomUUID(), opts.ref, opts.decision ?? null, opts.bps ?? null, opts.recordedBy ?? null],
    );
    if (opts.ageDays) {
      await query(`UPDATE payments SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [pid, String(opts.ageDays)]);
    } else {
      await query(`UPDATE payments SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
        [pid, String(opts.ageMin ?? 30)]);
    }
    return pid;
  }
  async function feeOf(pid: string) {
    const r = await query<{ n: number; fee: number }>(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX(fee_cents), 0) AS fee FROM fee_ledger WHERE payment_row_id = $1`,
      [pid],
    );
    return r.rows[0];
  }

  it('external/subscription decisions skipped; commission decision honored at stored bps; window bounded', async () => {
    await seedLoc(LOC_HC, { posType: 'helcim' });
    await seedLoc(LOC_SQ, { posType: 'square' });
    const hcCheck = await seedCheck(LOC_HC, 'HC-SWEEP', 'helcim');
    const sqCheck = await seedCheck(LOC_SQ, 'SQ-SWEEP', 'square');
    await ensureBillingAccount(LOC_HC);
    await ensureBillingAccount(LOC_SQ);
    // The helcim location has SINCE switched to subscription — its stored
    // commission decisions must still be honored (and vice versa below).
    await query(`UPDATE billing_accounts SET plan = 'subscription' WHERE location_id = $1`, [LOC_HC]);

    const pExternalStored = await seedPayment(LOC_HC, hcCheck, { ref: 'HC-EXT-1', amount: 5000, decision: 'external' });
    const pExternalLegacy = await seedPayment(LOC_HC, hcCheck, { ref: 'HC-EXT-2', amount: 5000, recordedBy: 'staff:owner' });
    const pSubscription = await seedPayment(LOC_HC, hcCheck, { ref: 'HC-SUB-1', amount: 5000, decision: 'subscription' });
    const pCommission = await seedPayment(LOC_HC, hcCheck, { ref: 'HC-COM-1', amount: 10000, decision: 'commission', bps: 300 });
    const pTooOld = await seedPayment(LOC_HC, hcCheck, { ref: 'HC-OLD-1', amount: 10000, decision: 'commission', bps: 200, ageDays: 3 });
    const pSqExternal = await seedPayment(LOC_SQ, sqCheck, { ref: 'SQ-EXT-1', amount: 5000, decision: 'external' });
    const pSqCommission = await seedPayment(LOC_SQ, sqCheck, { ref: 'SQ-COM-1', amount: 7000, decision: 'commission', bps: 200 });

    const res = await sweepMissingFees();
    assert.equal(res.recorded, 1, 'exactly the one in-window stored-commission gap is recorded');
    assert.equal(res.squareMissing, 1, 'exactly the one Square card gap is flagged; the Square cash row is silent');
    assert.deepEqual(await feeOf(pCommission), { n: 1, fee: 300 }, 'stored 3% bps honored despite the plan switch');
    assert.equal((await feeOf(pExternalStored)).n, 0, 'stored external: never a fee');
    assert.equal((await feeOf(pExternalLegacy)).n, 0, 'legacy staff-recorded (recorded_by) counts as external');
    assert.equal((await feeOf(pSubscription)).n, 0, 'stored subscription decision: no fee even though... plan honored');
    assert.equal((await feeOf(pTooOld)).n, 0, 'outside the 48h window: history is never re-judged');
    assert.equal((await feeOf(pSqExternal)).n, 0);
    assert.equal((await feeOf(pSqCommission)).n, 0, 'Square gaps are flagged, never accrued');
  });
});

// ---- C3-2-2: the stuck-batch resolver -------------------------------------------
describe('C3-2-2 resolveStuckFeeCharges never releases on a resend error', () => {
  const LOC = 'loc-resolver';
  async function seedBatch(batchId: string, cents: number): Promise<void> {
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, charge_cents, fee_cents, currency, method, status, batch_id, claimed_at)
       VALUES ($1,$2,$3,10000,$4,'CAD','accrued','charging',$5, now() - interval '1 hour')`,
      [randomUUID(), LOC, randomUUID(), cents, batchId],
    );
  }
  async function batchStatus(batchId: string) {
    const r = await query<{ status: string; batch_id: string | null }>(
      `SELECT status, batch_id FROM fee_ledger WHERE batch_id = $1 OR (batch_id IS NULL AND id = $1)`, [batchId]);
    return r.rows;
  }
  async function rowsOf(batchId: string) {
    const r = await query<{ status: string; platform_charge_ref: string | null }>(
      `SELECT status, platform_charge_ref FROM fee_ledger WHERE batch_id = $1`, [batchId]);
    return r.rows;
  }
  void batchStatus;

  before(async () => {
    await seedLoc(LOC);
    await ensureBillingAccount(LOC);
    await query(`UPDATE billing_accounts SET square_customer_id = 'CUST1', square_card_id = 'CARD1' WHERE location_id = $1`, [LOC]);
  });

  it('IDEMPOTENCY_KEY_REUSED on resend -> manual review, batch untouched', async () => {
    await seedBatch('batch-key-reused', 500);
    platMode = 'key-reused';
    const r = await resolveStuckFeeCharges();
    assert.equal(r.resolved, 0);
    assert.equal(r.manualReview, 1);
    const rows = await rowsOf('batch-key-reused');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'charging', 'a key-reuse error proves the original reached Square — never release');
  });

  it('401 on resend -> manual review too (both stuck batches re-flagged, none released)', async () => {
    await seedBatch('batch-unauth', 700);
    platMode = 'unauthorized';
    const r = await resolveStuckFeeCharges();
    assert.equal(r.resolved, 0);
    assert.equal(r.manualReview, 2, 'the key-reused batch and the 401 batch both route to manual review');
    assert.equal((await rowsOf('batch-unauth'))[0].status, 'charging');
    assert.equal((await rowsOf('batch-key-reused'))[0].status, 'charging');
  });

  it('a clean resend still resolves the batches (happy path unchanged)', async () => {
    platMode = 'ok';
    const r = await resolveStuckFeeCharges();
    assert.equal(r.resolved, 2);
    assert.equal((await rowsOf('batch-key-reused'))[0].status, 'charged');
    assert.equal((await rowsOf('batch-unauth'))[0].status, 'charged');
    assert.ok((await rowsOf('batch-key-reused'))[0].platform_charge_ref);
  });
});

// ---- C3-2-6: accrued fee collection ----------------------------------------------
describe('C3-2-6 processAccruedFees classification, currencies, minimum', () => {
  async function seedAccrued(loc: string, rows: { cents: number; currency?: string; method?: string; ageDays?: number }[]): Promise<void> {
    for (const row of rows) {
      const id = randomUUID();
      await query(
        `INSERT INTO fee_ledger(id, location_id, payment_row_id, charge_cents, fee_cents, currency, method, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'accrued')`,
        [id, loc, randomUUID(), Math.abs(row.cents) * 50, row.cents, row.currency ?? 'CAD', row.method ?? 'accrued'],
      );
      if (row.ageDays) {
        await query(`UPDATE fee_ledger SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [id, String(row.ageDays)]);
      }
    }
  }
  async function withCard(loc: string): Promise<void> {
    await seedLoc(loc);
    await ensureBillingAccount(loc);
    await query(`UPDATE billing_accounts SET square_customer_id = 'CUST1', square_card_id = 'CARD1' WHERE location_id = $1`, [loc]);
  }
  async function ledgerOf(loc: string) {
    const r = await query<{ status: string; fee_cents: number; currency: string }>(
      `SELECT status, fee_cents, currency FROM fee_ledger WHERE location_id = $1 ORDER BY fee_cents`, [loc]);
    return r.rows;
  }

  it('401 from Square is platform-side: batch held in charging, NO backoff recorded', async () => {
    const loc = 'loc-fees-401';
    await withCard(loc);
    await seedAccrued(loc, [{ cents: 6000 }]);
    platMode = 'unauthorized';
    await processAccruedFees();
    const rows = await ledgerOf(loc);
    assert.equal(rows[0].status, 'charging', 'unknown/platform outcome: the claim is held, not released');
    const acct = await query<{ fee_charge_failures: number; fee_charge_next_attempt_at: string | null }>(
      `SELECT fee_charge_failures, fee_charge_next_attempt_at FROM billing_accounts WHERE location_id = $1`, [loc]);
    assert.equal(acct.rows[0].fee_charge_failures, 0, 'a platform failure must not climb the decline backoff');
    assert.equal(acct.rows[0].fee_charge_next_attempt_at, null);
    platMode = 'ok';
  });

  it('mixed currencies are claimed and charged per currency', async () => {
    const loc = 'loc-fees-mix';
    await withCard(loc);
    await seedAccrued(loc, [{ cents: 6000, currency: 'CAD' }, { cents: 7000, currency: 'USD' }]);
    calls.length = 0;
    const r = await processAccruedFees();
    assert.equal(r.locationsCharged, 1);
    assert.equal(r.totalCents, 13000);
    const charges = calls.filter((c) => c.url.endsWith('/v2/payments') && c.body.customer_id);
    assert.equal(charges.length, 2, 'one charge per currency, never a mixed sum');
    const seen = charges.map((c) => `${(c.body.amount_money as { currency: string }).currency}:${(c.body.amount_money as { amount: number }).amount}`).sort();
    assert.deepEqual(seen, ['CAD:6000', 'USD:7000']);
    const rows = await ledgerOf(loc);
    assert.ok(rows.every((x) => x.status === 'charged'));
  });

  it('a post-claim net balance under $1 is released to keep accruing, never charged', async () => {
    const loc = 'loc-fees-tiny';
    await withCard(loc);
    // Due via the 25-day branch (net +50 after a reversal nets in).
    await seedAccrued(loc, [
      { cents: 5000, ageDays: 30 },
      { cents: -4950, method: 'reversal', ageDays: 30 },
    ]);
    calls.length = 0;
    await processAccruedFees();
    const charges = calls.filter((c) => c.url.endsWith('/v2/payments') && c.body.customer_id);
    assert.equal(charges.length, 0, 'Square minimum is $1 — a 50-cent charge is never attempted');
    const rows = await ledgerOf(loc);
    assert.ok(rows.every((x) => x.status === 'accrued'), 'the claim was released back to accrued');
  });
});

// ---- C3-2-7 / C3-2-8 / C3-2-11: reconcile ------------------------------------------
describe('C3-2 reconcile: due-filter in SQL, inconsistent detail, tender coverage', () => {
  const LOC = 'loc-recon';
  async function seedPending(checkId: string, opts: {
    ref: string; amount: number; attempts?: number; ageMin?: number; lastReconMinAgo?: number;
  }): Promise<string> {
    const pid = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key,
         external_payment_ref, reconcile_attempts, currency)
       VALUES ($1,$2,$3,0,'full','PENDING',$4,$5,$6,'CAD')`,
      [pid, checkId, opts.amount, randomUUID(), opts.ref, opts.attempts ?? 0],
    );
    await query(`UPDATE payments SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [pid, String(opts.ageMin ?? 120)]);
    if (opts.lastReconMinAgo !== undefined) {
      await query(`UPDATE payments SET last_reconcile_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
        [pid, String(opts.lastReconMinAgo)]);
    }
    return pid;
  }
  async function rowOf(pid: string) {
    const r = await query<{ status: string; reconcile_attempts: number; last_reconcile_error: string | null }>(
      `SELECT status, reconcile_attempts, last_reconcile_error FROM payments WHERE id = $1`, [pid]);
    return r.rows[0];
  }

  before(async () => {
    // demo=true: the platform env token stands in for the merchant
    // credential, exactly like the F2 hardening suite seeds its locations.
    await seedLoc(LOC, { demo: true });
  });

  it('510 not-yet-due rows cannot starve due rows out of the window (C3-2-8)', async () => {
    const checkId = await seedCheck(LOC, 'STARVE-CHECK');
    ORDERS['STARVE-CHECK'] = { total: 4000, tenders: [{ id: 'T-DUE', amount: 4000 }] };
    for (let i = 0; i < 510; i++) {
      await seedPending(checkId, { ref: `STRV-${i}`, amount: 1000, attempts: 8, lastReconMinAgo: 10 });
    }
    const due = await seedPending(checkId, { ref: 'STARVE-DUE', amount: 4000, attempts: 0 });
    const r = await reconcilePendingPayments();
    assert.equal(r.reconciled, 1, 'the due row was reached and settled');
    const dueRow = await rowOf(due);
    assert.equal(dueRow.status, 'COMPLETED');
    const sample = await query<{ reconcile_attempts: number }>(
      `SELECT reconcile_attempts FROM payments WHERE check_id = $1 AND external_payment_ref LIKE 'STRV-%' LIMIT 1`, [checkId]);
    assert.equal(sample.rows[0].reconcile_attempts, 8, 'not-due rows were never touched');
  });

  it('remaining < total with ZERO tenders is manual review, never FAILED (C3-2-11)', async () => {
    const checkId = await seedCheck(LOC, 'INCONSISTENT-CHECK');
    ORDERS['INCONSISTENT-CHECK'] = { total: 5000, tenders: [], netDue: 2000 };
    // Past the 24h give-up horizon: without the C3-2-11 guard this exact
    // shape fell into the FAILED branch.
    const pid = await seedPending(checkId, { ref: 'INCONS', amount: 5000, attempts: 0, ageMin: 25 * 60 });
    await reconcilePendingPayments();
    const row = await rowOf(pid);
    assert.equal(row.status, 'PENDING', 'the row stays reconcilable instead of being declared dead');
    assert.match(row.last_reconcile_error ?? '', /inconsistent/, 'flagged as an inconsistent POS detail');
  });

  it('tenders covering the total close the check even when net_amount_due_money disagrees (C3-2-7)', async () => {
    const checkId = await seedCheck(LOC, 'COVERAGE-CHECK');
    // Square says 2000 still due, but its own tender list covers the total.
    ORDERS['COVERAGE-CHECK'] = { total: 5000, tenders: [{ id: 'T-COV', amount: 5000 }], netDue: 2000 };
    const pid = await seedPending(checkId, { ref: 'COVERED', amount: 5000, attempts: 0 });
    const r = await reconcilePendingPayments();
    assert.equal(r.reconciled, 1);
    const row = await rowOf(pid);
    assert.equal(row.status, 'COMPLETED');
  });
});

// ---- C3-2-10: saveCard --------------------------------------------------------------
describe('C3-2-10 saveCard moves the subscription before the account follows', () => {
  const LOC = 'loc-cardmove';
  before(async () => {
    await seedLoc(LOC);
    await ensureBillingAccount(LOC);
    await query(
      `UPDATE billing_accounts SET square_customer_id = 'CUST1', square_card_id = 'CARD-OLD',
         square_subscription_id = 'SUB-CARDMOVE' WHERE location_id = $1`,
      [LOC],
    );
  });

  it('a failed subscription move keeps the old card and disables the NEW one', async () => {
    subCardUpdateFails = true;
    disabledCards.length = 0;
    await assert.rejects(
      () => saveCard(LOC, { sourceId: 'cnon:card-nonce-ok' }),
      (e: unknown) => (e as { statusCode?: number; errorCode?: string }).statusCode === 502
        && (e as { errorCode?: string }).errorCode === 'card_move_failed',
    );
    const acct = await ensureBillingAccount(LOC);
    assert.equal(acct.square_card_id, 'CARD-OLD', 'the account never points at a card the subscription does not use');
    assert.ok(disabledCards.includes('CARD-NEW'), 'the orphaned new card is disabled, not left live');
    assert.ok(!disabledCards.includes('CARD-OLD'), 'the working card is untouched');
  });

  it('a successful move switches the account and only then disables the old card', async () => {
    subCardUpdateFails = false;
    disabledCards.length = 0;
    const acct = await saveCard(LOC, { sourceId: 'cnon:card-nonce-ok' });
    assert.equal(acct.square_card_id, 'CARD-NEW');
    assert.equal(acct.card_last4, '1111');
    assert.ok(disabledCards.includes('CARD-OLD'));
  });
});

// ---- C3-2-9: billingHistory ------------------------------------------------------------
describe('C3-2-9 billingHistory derives rates from the rows', () => {
  const LOC = 'loc-history';
  before(async () => {
    await seedLoc(LOC);
    await ensureBillingAccount(LOC);
    // Account NOW sits at 1%; the historical rows were charged at 2%.
    await query(`UPDATE billing_accounts SET commission_bps = 100, square_subscription_id = 'SUB-HIST' WHERE location_id = $1`, [LOC]);
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, charge_cents, fee_cents, currency, method, status)
       VALUES ($1,$2,$3,10000,200,'CAD','accrued','accrued')`,
      [randomUUID(), LOC, randomUUID()],
    );
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, charge_cents, fee_cents, currency, method, status)
       VALUES ($1,$2,$3,5000,100,'EUR','square_app_fee','collected')`,
      [randomUUID(), LOC, randomUUID()],
    );
    SUBS['SUB-HIST'] = { id: 'SUB-HIST', status: 'ACTIVE', charged_through_date: day(20), invoice_ids: ['INV-NONE', 'INV-OK'] };
    INVOICES['INV-NONE'] = { id: 'INV-NONE', created_at: new Date().toISOString(), status: 'PAID', payment_requests: [] };
    INVOICES['INV-OK'] = {
      id: 'INV-OK', created_at: new Date().toISOString(), status: 'PAID',
      payment_requests: [{ total_completed_amount_money: { amount: 9900, currency: 'CAD' } }],
    };
  });

  it('fee rows describe their own rate and currency; amount-less invoices are skipped', async () => {
    const rows = await billingHistory(LOC);
    const fees = rows.filter((x) => x.kind === 'commission_fee');
    assert.equal(fees.length, 2);
    const cad = fees.find((x) => x.currency === 'CAD')!;
    assert.match(cad.description, /2% fee on a \$100\.00/, 'the rate comes from the row, not the current account');
    const eur = fees.find((x) => x.currency === 'EUR')!;
    assert.match(eur.description, /EUR 50\.00/, 'non-dollar rows render with their currency code');
    const invoices = rows.filter((x) => x.kind === 'subscription_invoice');
    assert.equal(invoices.length, 1, 'an invoice with no extractable amount is omitted, never priced from the current plan');
    assert.equal(invoices[0].amount_cents, 9900);
  });
});

// ---- C3-2-1: payCheck stamps the fee decision ----------------------------------------------
describe('C3-2-1 payCheck stamps fee_decision (migration 032)', () => {
  const MERCHANT = 'm-c32-pay';
  const LOC = 'loc-paystamp';
  const checkIds: Record<string, string> = {};
  async function seedPayCheck(orderId: string, total: number): Promise<void> {
    ORDERS[orderId] = { total };
    orderPaid[orderId] = 0;
    const tId = randomUUID();
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
      [tId, LOC, `T-${orderId}`, randomUUID().replace(/-/g, '')]);
    const cId = randomUUID();
    checkIds[orderId] = cId;
    await query(
      `INSERT INTO checks(id, location_id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state)
       VALUES ($1,$2,$3,'square',$4,$4,$5,'OPEN')`,
      [cId, LOC, tId, orderId, MERCHANT],
    );
  }
  async function decisionOf(checkId: string) {
    const r = await query<{ fee_decision: string | null; fee_bps: number | null }>(
      `SELECT fee_decision, fee_bps FROM payments WHERE check_id = $1 ORDER BY created_at DESC LIMIT 1`, [checkId]);
    return r.rows[0];
  }

  before(async () => {
    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ($1,'square','sq-merchant-c32',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
    await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
      VALUES ($1,$2,'square','SQLOC-PS','SQLOC-PS','Pay House','CAD')`, [LOC, MERCHANT]);
    await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ($1,$2,'square','sq-merchant-c32',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
    await seedPayCheck('PC-ORD-1', 10000);
    await seedPayCheck('PC-ORD-2', 5000);
    await seedPayCheck('PC-ORD-3', 8000);
  });

  it('commission card payment stamps commission + the bps in force', async () => {
    const res = await payCheck({
      checkRef: 'PC-ORD-1', checkId: checkIds['PC-ORD-1'], mode: 'full',
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(res.checkState, 'COMPLETED');
    const d = await decisionOf(checkIds['PC-ORD-1']);
    assert.equal(d.fee_decision, 'commission');
    assert.equal(d.fee_bps, 200);
  });

  it('staff-recorded external payment stamps external', async () => {
    const res = await payCheck({
      checkRef: 'PC-ORD-2', checkId: checkIds['PC-ORD-2'], mode: 'full',
      idempotencyKey: randomUUID(), source: { kind: 'external', label: 'Smart Table staff' },
      recordedBy: 'staff:tester',
    });
    assert.equal(res.checkState, 'COMPLETED');
    const d = await decisionOf(checkIds['PC-ORD-2']);
    assert.equal(d.fee_decision, 'external');
    assert.equal(d.fee_bps, null);
  });

  it('subscription card payment stamps subscription', async () => {
    await query(`UPDATE billing_accounts SET plan = 'subscription' WHERE location_id = $1`, [LOC]);
    const res = await payCheck({
      checkRef: 'PC-ORD-3', checkId: checkIds['PC-ORD-3'], mode: 'full',
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.equal(res.checkState, 'COMPLETED');
    const d = await decisionOf(checkIds['PC-ORD-3']);
    assert.equal(d.fee_decision, 'subscription');
  });
});

// ---- C3-2-4: device tier enforced at use time ------------------------------------------------
describe('C3-2-4 device routes enforce tier at use time', () => {
  const LOC = 'loc-device-gate';
  const DEV = randomUUID();
  const TBL = randomUUID();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const devAuth = { authorization: 'Bearer devtok-c32' };
  const staffAuth = { authorization: 'Bearer test-staff-token' };

  before(async () => {
    await seedLoc(LOC, { tier: 'base' });
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'SEATED')`,
      [TBL, LOC, randomUUID().replace(/-/g, '')]);
    await query(`INSERT INTO devices(id, location_id, table_id, token_hash) VALUES ($1,$2,$3,$4)`,
      [DEV, LOC, TBL, hashToken('devtok-c32')]);
    await query(`INSERT INTO print_jobs(id, device_id, location_id, table_id, lines, status)
      VALUES ($1,$2,$3,$4,'["LINE1"]','pending')`, [randomUUID(), DEV, LOC, TBL]);
    app = await buildApp({ logger: false });
  });
  after(async () => { await app.close(); });

  it('base tier: the device can fetch its print jobs', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: devAuth });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { jobs: unknown[] }).jobs.length, 1);
  });

  it('after a downgrade to starter, print fetch + call + staff print all refuse (403)', async () => {
    await query(`UPDATE locations SET tier = 'starter' WHERE id = $1`, [LOC]);
    const jobs = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: devAuth });
    assert.equal(jobs.statusCode, 403, 'a downgraded location cannot keep printing receipts');
    const call = await app.inject({ method: 'POST', url: '/api/device/call', headers: devAuth, payload: {} });
    assert.equal(call.statusCode, 403, 'a downgraded location cannot raise waiter calls');
    const staffPrint = await app.inject({
      method: 'POST', url: `/api/tables/${TBL}/print-job`, headers: staffAuth, payload: { lines: ['X'] },
    });
    assert.equal(staffPrint.statusCode, 403);
    const state = await app.inject({ method: 'GET', url: '/api/device/state', headers: devAuth });
    assert.equal(state.statusCode, 200, 'passive state display stays available');
  });
});
