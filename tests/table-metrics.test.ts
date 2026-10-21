// Idea 5 — per-table revenue analytics tests (pg-mem).
//
// Proves GET /api/dashboard/metrics returns a `tables` breakdown that:
//  1. Sums settled payments (amount+tip) per table and subtracts completed
//     refunds attributed to that table's checks.
//  2. Ignores PENDING/FAILED payments and non-completed refunds.
//  3. Counts distinct settled checks, average bill, tips and revenue share.
//  4. Includes zero-revenue tables (complete floor heatmap) and sorts by
//     revenue desc.
//
// Run: PG_MEM=1 npx tsx --test tests/table-metrics.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

const MERCHANT = 'm-tm';
const LOC = 'loc-tm';
const TA = randomUUID();
const TB = randomUUID();
const TC = randomUUID();

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Metric House','CAD')`, [LOC, MERCHANT]);
  for (const [id, name] of [[TA, 'T1'], [TB, 'T2'], [TC, 'T3']] as const) {
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')`, [id, LOC, name, 'tok-' + name]);
  }
  const checkA1 = randomUUID(); const checkA2 = randomUUID(); const checkB1 = randomUUID();
  for (const [cid, tid] of [[checkA1, TA], [checkA2, TA], [checkB1, TB]] as const) {
    await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
      VALUES ($1,$2,'square',$3,$3,$4,'COMPLETED',0,'CAD')`, [cid, tid, 'SQ-' + cid.slice(0, 6), MERCHANT]);
  }
  const pay = (checkId: string, amount: number, tip: number, status: string) =>
    query(`INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key)
           VALUES ($1,$2,$3,$4,'full',$5,$6)`, [randomUUID(), checkId, amount, tip, status, randomUUID()]);
  // Table T1: two settled checks: (10000+1500) + (5000+500) = 17000, tips 2000.
  await pay(checkA1, 10000, 1500, 'COMPLETED');
  await pay(checkA2, 5000, 500, 'AUTHORIZED');
  // Noise that must be ignored:
  await pay(checkA1, 99999, 0, 'PENDING');
  await pay(checkA2, 88888, 0, 'FAILED');
  // Table T2: one settled check (20000+3000) = 23000, tips 3000.
  await pay(checkB1, 20000, 3000, 'COMPLETED');
  // Completed refund of 2000 against a T1 check; a PENDING refund must not count.
  await query(`INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, status, idempotency_key)
    VALUES ($1,'p-x',$2,$3,2000,'CAD','COMPLETED',$4)`, [randomUUID(), checkA1, LOC, randomUUID()]);
  await query(`INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, status, idempotency_key)
    VALUES ($1,'p-y',$2,$3,7000,'CAD','PENDING',$4)`, [randomUUID(), checkA1, LOC, randomUUID()]);
  return { checkA1 };
}

describe('idea 5: per-table revenue analytics', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    await seed();
    app = await buildApp();
  });

  it('metrics.tables aggregates per table with refunds, shares and zero tables', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/dashboard/metrics?location_id=${LOC}&days=7`,
      headers: { authorization: 'Bearer test-staff-token' },
    });
    assert.equal(res.statusCode, 200);
    const { tables } = JSON.parse(res.body);
    assert.equal(tables.length, 3);
    // Sorted by revenue desc: T2 (23000) > T1 (17000-2000=15000) > T3 (0).
    assert.equal(tables[0].table_name, 'T2');
    assert.equal(tables[0].revenue_cents, 23000);
    assert.equal(tables[0].checks, 1);
    assert.equal(tables[0].avg_bill_cents, 23000);
    assert.equal(tables[0].tips_cents, 3000);
    assert.equal(tables[1].table_name, 'T1');
    assert.equal(tables[1].revenue_cents, 15000);
    assert.equal(tables[1].checks, 2);
    assert.equal(tables[1].avg_bill_cents, 7500);
    assert.equal(tables[1].tips_cents, 2000);
    assert.equal(tables[2].table_name, 'T3');
    assert.equal(tables[2].revenue_cents, 0);
    assert.equal(tables[2].checks, 0);
    // Shares of the positive total (38000): T2 ≈ 60.5%, T1 ≈ 39.5%.
    assert.ok(Math.abs(tables[0].share_pct - 60.5) < 0.2, `share T2 ${tables[0].share_pct}`);
    assert.ok(Math.abs(tables[1].share_pct - 39.5) < 0.2, `share T1 ${tables[1].share_pct}`);
  });
});
