// Excel report export tests (pg-mem + exceljs read-back).
//
// Proves GET /api/dashboard/export.xlsx returns a real .xlsx containing all
// four report sheets (Summary, Daily Breakdown, Revenue by Table, Feedback)
// with values matching the seeded data, and that location_id is required.
//
// Run: PG_MEM=1 npx tsx --test tests/report-export.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

const MERCHANT = 'm-ex';
const LOC = 'loc-ex';
const TA = randomUUID();

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Export House','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok1','FREE')`, [TA, LOC]);
  const checkId = randomUUID();
  await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'square','SQX1','SQX1',$3,'COMPLETED',11500,'CAD')`, [checkId, TA, MERCHANT]);
  await query(`INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key)
    VALUES ($1,$2,10000,1500,'full','COMPLETED',$3)`, [randomUUID(), checkId, randomUUID()]);
  await query(`INSERT INTO feedback(id, location_id, check_id, rating, comment) VALUES ($1,$2,$3,5,'Great night')`, [randomUUID(), LOC, checkId]);
}

describe('excel report export', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    await seed();
    app = await buildApp();
  });

  it('returns a valid xlsx with all four sheets and correct values', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/dashboard/export.xlsx?location_id=${LOC}&days=7`,
      headers: { authorization: 'Bearer test-staff-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    assert.match(String(res.headers['content-disposition']), /smart-table-report-last-7-days\.xlsx/);
    const buf = Buffer.from(res.rawPayload);
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'xlsx must be a zip archive');

    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buf as any);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Daily Breakdown', 'Revenue by Table', 'Feedback']);

    const rev = wb.getWorksheet('Revenue by Table')!;
    // Row 2 = T1: revenue $115.00 (10000+1500), 1 check, tips $15.00.
    assert.equal(rev.getRow(2).getCell(1).value, 'T1');
    assert.equal(rev.getRow(2).getCell(2).value, 115);
    assert.equal(rev.getRow(2).getCell(3).value, 1);
    assert.equal(rev.getRow(2).getCell(5).value, 15);

    const fb = wb.getWorksheet('Feedback')!;
    assert.equal(fb.getRow(2).getCell(2).value, 5);
    assert.equal(fb.getRow(2).getCell(3).value, 'Great night');

    const summary = wb.getWorksheet('Summary')!;
    let totalRevenue: unknown = null;
    summary.eachRow((row) => {
      if (row.getCell(1).value === 'Total revenue') totalRevenue = row.getCell(2).value;
    });
    assert.equal(totalRevenue, 115);
  });

  it('location_id is required', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/export.xlsx?days=7',
      headers: { authorization: 'Bearer test-staff-token' },
    });
    assert.equal(res.statusCode, 400);
  });
});
