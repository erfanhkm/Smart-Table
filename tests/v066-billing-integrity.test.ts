// v0.6.6 batch-2 (billing integrity) tests — Claude cycle-1 section-2 E-2/E-3/E-9.
//
// Proves:
//  1. recordFee is idempotent per (payment_row_id, method): a second
//     recording of the same payment's fee inserts no duplicate; a
//     different method is a different row; reversal rows may repeat.
//  2. processAccruedFees claims rows atomically under a batch id: a
//     successful charge flips exactly the claimed rows to 'charged', the
//     Square key is fees-<batchId>, and a second run charges nothing.
//  3. An unknown charge outcome (network error) leaves the rows in
//     'charging' — never released, never re-charged by a later run.
//  4. A definitive Square refusal releases the claim back to 'accrued'
//     so a later run can collect after the card is fixed.
//  5. switchPlan adopts an existing live Square subscription
//     (search-before-create) instead of creating a duplicate; with none
//     existing it creates exactly one.
//  6. saveCard uses deterministic Square idempotency keys: customer key
//     is st-cust-<locationId> (+reference_id), card key is stable for the
//     same card token and changes with a different token.
//
// Run: PG_MEM=1 npx tsx --test tests/v066-billing-integrity.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'plat-test-token';
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { recordFee, processAccruedFees, ensureBillingAccount, saveCard, switchPlan } = await import('../src/services/billing.js');

// ---- Square platform fetch mock -------------------------------------------
interface Call { url: string; method: string; body: Record<string, unknown> }
const calls: Call[] = [];
let payBehavior: 'ok' | 'decline' | 'network' = 'ok';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let searchResult: any[] = [];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function subCreates(): number {
  return calls.filter((c) => c.method === 'POST' && /\/v2\/subscriptions$/.test(c.url)).length;
}
function callsTo(fragment: string): Call[] {
  return calls.filter((c) => c.url.includes(fragment));
}
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body });
    if (url.includes('/v2/locations')) {
      return json({ locations: [{ id: 'PLATLOC', status: 'ACTIVE', currency: 'CAD', name: 'Platform' }] });
    }
    if (url.includes('/v2/subscriptions/search')) return json({ subscriptions: searchResult });
    if (url.includes('/v2/subscriptions')) {
      return json({ subscription: { id: 'SUB-NEW', status: 'ACTIVE', charged_through_date: '2026-11-22' } });
    }
    if (url.includes('/v2/catalog/object')) {
      return json({ catalog_object: { id: body?.object?.type === 'SUBSCRIPTION_PLAN' ? 'PLAN1' : 'VAR1' } });
    }
    if (url.includes('/v2/customers')) return json({ customer: { id: 'CUST1' } });
    if (url.includes('/v2/cards')) return json({ card: { id: 'CARD1', card_brand: 'VISA', last_4: '4242' } });
    if (url.includes('/v2/payments')) {
      if (payBehavior === 'network') throw new TypeError('fetch failed');
      if (payBehavior === 'decline') {
        return json({ errors: [{ category: 'PAYMENT_ERROR', code: 'CARD_DECLINED', detail: 'declined' }] }, 400);
      }
      return json({ payment: { id: 'PLATPAY1', status: 'COMPLETED' } });
    }
    return json({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ---- seed -------------------------------------------------------------------
const MERCHANT = 'm-v066';
async function seedLocation(loc: string) {
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ($1,$2,'square',$3,$3,$4,'CAD')`,
    [loc, MERCHANT, `SQ-${loc}`, `House ${loc}`],
  );
}
async function seedAccrued(loc: string, centsList: number[]) {
  for (const cents of centsList) {
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, charge_cents, fee_cents, currency, method, status)
       VALUES ($1,$2,$3,$4,$5,'CAD','accrued','accrued')`,
      [randomUUID(), loc, randomUUID(), cents * 50, cents],
    );
  }
}
async function setCard(loc: string) {
  await ensureBillingAccount(loc);
  await query(
    `UPDATE billing_accounts SET square_customer_id = 'CUST1', square_card_id = 'CARD1' WHERE location_id = $1`,
    [loc],
  );
}
async function feeRows(loc: string) {
  const r = await query<{ status: string; batch_id: string | null; platform_charge_ref: string | null; fee_cents: number }>(
    `SELECT status, batch_id, platform_charge_ref, fee_cents FROM fee_ledger WHERE location_id = $1 ORDER BY created_at ASC`,
    [loc],
  );
  return r.rows;
}

describe('v0.6.6 billing integrity (E-2/E-3/E-9)', () => {
  before(async () => {
    installFetch();
    await migrate();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
       VALUES ($1,'square','sq-merchant',$2,$3)`,
      [MERCHANT, encryptSecret('x'), encryptSecret('x')],
    );
  });

  it('recordFee: one original fee per payment per method; reversals may repeat', async () => {
    const loc = 'loc-fees';
    await seedLocation(loc);
    const payRow = 'pay-row-1';
    await recordFee({ locationId: loc, paymentRowId: payRow, posPaymentRef: 'P1', chargeCents: 5000, feeCents: 100, currency: 'CAD', method: 'accrued' });
    await recordFee({ locationId: loc, paymentRowId: payRow, posPaymentRef: 'P1', chargeCents: 5000, feeCents: 100, currency: 'CAD', method: 'accrued' });
    let rows = await feeRows(loc);
    assert.equal(rows.length, 1, 'duplicate accrued recording must be a no-op');
    await recordFee({ locationId: loc, paymentRowId: payRow, posPaymentRef: 'P1', chargeCents: 5000, feeCents: 100, currency: 'CAD', method: 'square_app_fee' });
    rows = await feeRows(loc);
    assert.equal(rows.length, 2, 'a different method is a different fee row');
    // Reversal rows: two partial refunds -> two rows, allowed by design.
    for (let i = 0; i < 2; i++) {
      await query(
        `INSERT INTO fee_ledger(id, location_id, payment_row_id, charge_cents, fee_cents, currency, method, status)
         VALUES ($1,$2,$3,5000,-40,'CAD','reversal','accrued')`,
        [randomUUID(), loc, payRow],
      );
    }
    rows = await feeRows(loc);
    assert.equal(rows.filter((r) => r.fee_cents === -40).length, 2);
  });

  it('processAccruedFees: claim -> charge -> charged exactly once', async () => {
    const loc = 'loc-claim-ok';
    await seedLocation(loc);
    await setCard(loc);
    await seedAccrued(loc, [3000, 2500]); // $55 total, due (>= $50)
    payBehavior = 'ok';
    const beforeCalls = callsTo('/v2/payments').length;
    const r1 = await processAccruedFees();
    assert.equal(r1.locationsCharged, 1);
    assert.equal(r1.totalCents, 5500);
    const pays = callsTo('/v2/payments');
    assert.equal(pays.length, beforeCalls + 1);
    const key = String(pays[pays.length - 1].body.idempotency_key);
    assert.ok(key.startsWith('fees-'), `charge key must derive from the batch id, got ${key}`);
    const rows = await feeRows(loc);
    assert.ok(rows.every((r) => r.status === 'charged' && r.platform_charge_ref === 'PLATPAY1' && r.batch_id));
    assert.equal(key, `fees-${rows[0].batch_id}`);
    const r2 = await processAccruedFees();
    assert.equal(r2.locationsCharged, 0);
    assert.equal(callsTo('/v2/payments').length, beforeCalls + 1, 'second run must not charge again');
  });

  it('processAccruedFees: unknown outcome holds the claim in charging', async () => {
    const loc = 'loc-claim-hold';
    await seedLocation(loc);
    await setCard(loc);
    await seedAccrued(loc, [6000]);
    payBehavior = 'network';
    const beforeCalls = callsTo('/v2/payments').length;
    const r1 = await processAccruedFees();
    assert.equal(r1.locationsCharged, 0);
    const rows = await feeRows(loc);
    assert.ok(rows.every((r) => r.status === 'charging' && r.batch_id), 'rows must stay claimed, not released');
    const r2 = await processAccruedFees();
    assert.equal(r2.locationsCharged, 0);
    assert.equal(callsTo('/v2/payments').length, beforeCalls + 1, 'held rows must never be re-charged');
    payBehavior = 'ok';
  });

  it('processAccruedFees: definitive refusal releases the claim for a later retry', async () => {
    const loc = 'loc-claim-release';
    await seedLocation(loc);
    await setCard(loc);
    await seedAccrued(loc, [6000]);
    payBehavior = 'decline';
    const r1 = await processAccruedFees();
    assert.equal(r1.locationsCharged, 0);
    let rows = await feeRows(loc);
    assert.ok(rows.every((r) => r.status === 'accrued' && !r.batch_id), 'declined batch must be released');
    payBehavior = 'ok';
    const r2 = await processAccruedFees();
    assert.equal(r2.locationsCharged, 1);
    rows = await feeRows(loc);
    assert.ok(rows.every((r) => r.status === 'charged'));
  });

  it('switchPlan: adopts an existing live subscription instead of duplicating', async () => {
    const loc = 'loc-adopt';
    await seedLocation(loc);
    await setCard(loc);
    searchResult = [{ id: 'SUB-EXISTING', status: 'ACTIVE', plan_variation_id: 'VAR1', charged_through_date: '2026-11-22' }];
    const createsBefore = subCreates();
    const state = await switchPlan(loc, 'subscription');
    assert.equal(state.effective_plan, 'subscription');
    assert.equal(subCreates(), createsBefore, 'no new subscription may be created when a live one exists');
    const acct = await query<{ square_subscription_id: string }>(
      `SELECT square_subscription_id FROM billing_accounts WHERE location_id = $1`, [loc],
    );
    assert.equal(acct.rows[0].square_subscription_id, 'SUB-EXISTING');
    searchResult = [];
  });

  it('switchPlan: creates exactly one subscription when none exists', async () => {
    const loc = 'loc-create';
    await seedLocation(loc);
    await setCard(loc);
    searchResult = [];
    const createsBefore = subCreates();
    const state = await switchPlan(loc, 'subscription');
    assert.equal(state.effective_plan, 'subscription');
    assert.equal(subCreates(), createsBefore + 1);
    const acct = await query<{ square_subscription_id: string }>(
      `SELECT square_subscription_id FROM billing_accounts WHERE location_id = $1`, [loc],
    );
    assert.equal(acct.rows[0].square_subscription_id, 'SUB-NEW');
  });

  it('saveCard: deterministic customer + card idempotency keys', async () => {
    const loc = 'loc-card';
    await seedLocation(loc);
    await saveCard(loc, { sourceId: 'cnon:tokA', email: 'owner@example.ca' });
    const custCalls = callsTo('/v2/customers').filter((c) => c.method === 'POST');
    assert.equal(custCalls.length, 1);
    assert.equal(custCalls[0].body.idempotency_key, `st-cust-${loc}`);
    assert.equal(custCalls[0].body.reference_id, loc);
    const cardCalls = callsTo('/v2/cards');
    assert.equal(cardCalls.length, 1);
    const keyA = String(cardCalls[0].body.idempotency_key);
    assert.ok(keyA.startsWith('st-card-') && keyA.length <= 45);
    // Same token again: customer is NOT recreated, card key is identical.
    await saveCard(loc, { sourceId: 'cnon:tokA', email: 'owner@example.ca' });
    assert.equal(callsTo('/v2/customers').filter((c) => c.method === 'POST').length, 1);
    const cardCalls2 = callsTo('/v2/cards');
    assert.equal(String(cardCalls2[cardCalls2.length - 1].body.idempotency_key), keyA);
    // Different token: different key (a real replacement still works).
    await saveCard(loc, { sourceId: 'cnon:tokB', email: 'owner@example.ca' });
    const cardCalls3 = callsTo('/v2/cards');
    assert.notEqual(String(cardCalls3[cardCalls3.length - 1].body.idempotency_key), keyA);
  });
});
