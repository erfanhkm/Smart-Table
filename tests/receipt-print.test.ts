// v0.8.0: guest-chosen receipt printing on the table's STT-101 device.
//
// Proves POST /api/t/:token/receipt-print:
//  1. unknown table token -> 400
//  2. no paired device -> printed:false / no_device, no job, no claim
//  3. paired device -> printed:true, ONE print_jobs row whose lines carry
//     the restaurant, the check items and this payment's settled total;
//     payments.receipt_printed_at is claimed
//  4. second call for the same payment -> already_printed, still one job
//  5. a payment_id from another table -> 400 (never leaks across tables)
//
// Run: PG_MEM=1 npx tsx --test tests/receipt-print.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'sq-test-token';
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';
process.env.SQUARE_APP_ID = 'sq0idp-test';
process.env.SQUARE_APP_SECRET = 'sq-test-secret';
process.env.RESEND_API_KEY = 're_test_key';
process.env.RECEIPT_FROM_EMAIL = 'receipts@smarttablepay.com';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function orderObj(id: string) {
  return {
    id,
    state: 'OPEN',
    line_items: [
      { uid: 'li1', name: 'Burger', quantity: '1', base_price_money: { amount: 1200, currency: 'CAD' }, total_money: { amount: 1200, currency: 'CAD' } },
    ],
    total_money: { amount: 1200, currency: 'CAD' },
    tenders: [],
  };
}

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = /\/v2\/orders\/([\w-]+)$/.exec(url);
    if (m && method === 'GET') return json({ order: orderObj(m[1]) });
    return origFetch(input as string, init);
  }) as typeof fetch;
}

describe('v0.8.0 guest receipt print', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let locationId = '';
  let tableId = '';
  let tableToken = '';
  let checkId = '';
  let paymentRowId = '';

  before(async () => {
    installFetch();
    await migrate();
    app = await buildApp({ logger: false });

    const merchantId = randomUUID();
    locationId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,'square',$2,$2,$3,$4,'2099-06-01T00:00:00Z')`,
      [merchantId, 'sqm-rp', encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, qr_ordering_enabled, loyalty_enabled, loyalty_visits_required, loyalty_reward_text)
       VALUES ($1,$2,'square','SQL-RP','SQL-RP','Testaurant','CAD',false,true,true,5,'Free dessert')`,
      [locationId, merchantId],
    );
    await query(
      `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,$2,'square','sqm-rp',$3,$4,'2099-06-01T00:00:00Z')`,
      [randomUUID(), merchantId, encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    tableId = randomUUID();
    tableToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'SEATED')`,
      [tableId, locationId, tableToken],
    );
    checkId = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'ord-rp','ord-rp','square',$4,'OPEN',1200,'CAD')`,
      [checkId, tableId, locationId, merchantId],
    );
    paymentRowId = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
       VALUES ($1,$2,1200,150,'COMPLETED',$3,'pay-rp-1','CAD')`,
      [paymentRowId, checkId, randomUUID()],
    );
  });

  after(async () => {
    if (app) await app.close();
  });

  const post = (token: string, paymentId?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/t/${token}/receipt-print`,
      payload: paymentId ? { payment_id: paymentId } : {},
    });

  it('unknown table token -> 400', async () => {
    const res = await post('nope-token', 'pay-rp-1');
    assert.equal(res.statusCode, 400);
  });

  it('no paired device -> no_device, no job, no claim', async () => {
    const res = await post(tableToken, 'pay-rp-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().printed, false);
    assert.equal(res.json().reason, 'no_device');
    const jobs = await query(`SELECT COUNT(*)::int AS n FROM print_jobs WHERE table_id = $1`, [tableId]);
    assert.equal(jobs.rows[0].n, 0);
    const pay = await query(`SELECT receipt_printed_at FROM payments WHERE id = $1`, [paymentRowId]);
    assert.equal(pay.rows[0].receipt_printed_at, null);
  });

  it('paired device -> one job with the receipt lines, claim set', async () => {
    await query(
      `INSERT INTO devices(id, location_id, table_id, token_hash) VALUES ($1,$2,$3,'hash-rp')`,
      [randomUUID(), locationId, tableId],
    );
    const res = await post(tableToken, 'pay-rp-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().printed, true);
    assert.ok(res.json().job_id);
    const jobs = await query(`SELECT lines, check_id FROM print_jobs WHERE table_id = $1`, [tableId]);
    assert.equal(jobs.rows.length, 1);
    assert.equal(jobs.rows[0].check_id, checkId);
    const lines = JSON.parse(jobs.rows[0].lines) as string[];
    const text = lines.join('\n');
    assert.ok(text.includes('Testaurant'), 'restaurant name on the receipt');
    assert.ok(text.includes('Burger'), 'check item on the receipt');
    assert.ok(text.includes('$13.50'), 'settled total (1200 + 150 tip) on the receipt');
    assert.ok(lines.every((l) => l.length <= 80), 'every line fits the print-job contract');
    const pay = await query(`SELECT receipt_printed_at FROM payments WHERE id = $1`, [paymentRowId]);
    assert.ok(pay.rows[0].receipt_printed_at, 'print slot claimed');
  });

  it('second call for the same payment -> already_printed, still one job', async () => {
    const res = await post(tableToken, 'pay-rp-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().printed, false);
    assert.equal(res.json().reason, 'already_printed');
    const jobs = await query(`SELECT COUNT(*)::int AS n FROM print_jobs WHERE table_id = $1`, [tableId]);
    assert.equal(jobs.rows[0].n, 1);
  });

  it('a payment_id from another table -> 400', async () => {
    const otherTable = randomUUID();
    const otherToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T2',$3,'SEATED')`,
      [otherTable, locationId, otherToken],
    );
    const res = await post(otherToken, 'pay-rp-1');
    assert.equal(res.statusCode, 400);
  });
});
