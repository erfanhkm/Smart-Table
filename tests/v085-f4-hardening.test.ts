// v0.8.5 (Claude cycle-2 chunk F4): guest-surface hardening.
//
//  F4-1/F4-2 loyalty: a visit counts only against the caller's OWN payment
//    (payment_id), once per check (guard inside the UPDATE), once per
//    payment across ALL phone numbers, never for refunded / tiny / stale
//    payments. A bare phone lookup counts nothing and creates no row.
//  F4-5  check resolution is scoped to the token's table (same POS ref in
//    two locations resolves to the caller's own check).
//  F4-7  pay route sits behind the per-token write limiter + the table
//    gate now also accepts a PAID table (F4-11).
//  F4-8  receipt email/print REQUIRE payment_id (no latest-payment fallback).
//  F4-10 feedback requires an in-service table or a recent payment.
//  F4-12 bootstrap reports pos_unavailable when open checks exist but the
//    POS cannot be read.
//  F4-13 claims validate device UUID + item index + fingerprint against
//    the live bill.
//
// Run: PG_MEM=1 npx tsx --test tests/v085-f4-hardening.test.ts
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

// Stateful Square fixture: before the charge the order is unpaid; after a
// successful POST /v2/payments it carries the tender and zero net due.
let orderPaid = false;
function orderObj(id: string) {
  return {
    id,
    state: orderPaid ? 'COMPLETED' : 'OPEN',
    line_items: [
      { uid: 'li1', name: 'Burger', quantity: '1', base_price_money: { amount: 1200, currency: 'CAD' }, total_money: { amount: 1200, currency: 'CAD' } },
    ],
    total_money: { amount: 1200, currency: 'CAD' },
    net_amount_due_money: { amount: orderPaid ? 0 : 1200, currency: 'CAD' },
    tenders: orderPaid
      ? [{ id: 'sqpay-f4', payment_id: 'sqpay-f4', type: 'CARD', amount_money: { amount: 1200, currency: 'CAD' }, tip_money: { amount: 150, currency: 'CAD' } }]
      : [],
  };
}

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v2/payments') && method === 'POST') {
      orderPaid = true;
      return json({ payment: { id: 'sqpay-f4', status: 'COMPLETED', amount_money: { amount: 1200, currency: 'CAD' }, tip_money: { amount: 150, currency: 'CAD' } } });
    }
    const payOrder = /\/v2\/orders\/([\w-]+)\/pay-order$/.exec(url);
    if (payOrder && method === 'POST') return json({ order: orderObj(payOrder[1]) });
    const m = /\/v2\/orders\/([\w-]+)$/.exec(url);
    if (m && method === 'GET') {
      if (m[1] === 'ord-broken') return json({ errors: [{ code: 'INTERNAL', detail: 'boom' }] }, 500);
      return json({ order: orderObj(m[1]) });
    }
    return origFetch(input as string, init);
  }) as typeof fetch;
}

describe('v0.8.5 F4 guest hardening', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let locationId = '';
  let tableId = '';
  let tableToken = '';
  let checkId = '';
  let brokenTableToken = '';
  const devA = randomUUID();
  const devB = randomUUID();

  async function seedLocation(suffix: string): Promise<string> {
    const merchantId = randomUUID();
    const locId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,'square',$2,$2,$3,$4,'2099-06-01T00:00:00Z')`,
      [merchantId, `sqm-${suffix}`, encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, qr_ordering_enabled, loyalty_enabled, loyalty_visits_required, loyalty_reward_text)
       VALUES ($1,$2,'square',$3,$3,'Testaurant','CAD',false,true,true,5,'Free dessert')`,
      [locId, merchantId, `SQL-${suffix}`],
    );
    await query(
      `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,$2,'square',$3,$4,$5,'2099-06-01T00:00:00Z')`,
      [randomUUID(), merchantId, `sqm-${suffix}`, encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    return locId;
  }

  before(async () => {
    installFetch();
    await migrate();
    app = await buildApp({ logger: false });

    locationId = await seedLocation('f4');
    tableId = randomUUID();
    tableToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'FREE')`,
      [tableId, locationId, tableToken],
    );
    checkId = randomUUID();
    const merchantRow = await query(`SELECT merchant_id FROM locations WHERE id = $1`, [locationId]);
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'ord-f4','ord-f4','square',$4,'OPEN',1200,'CAD')`,
      [checkId, tableId, locationId, merchantRow.rows[0].merchant_id],
    );
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
       VALUES ($1,$2,1200,150,'COMPLETED',$3,'pay-f4-1','CAD')`,
      [randomUUID(), checkId, randomUUID()],
    );
    // A refunded payment: must never count a loyalty visit.
    const refundedPayId = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
       VALUES ($1,$2,1200,0,'COMPLETED',$3,'pay-f4-refunded','CAD')`,
      [refundedPayId, checkId, randomUUID()],
    );
    await query(
      `INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, status, idempotency_key)
       VALUES ($1,$2,$3,$4,1200,'CAD','COMPLETED',$5)`,
      [randomUUID(), refundedPayId, checkId, locationId, randomUUID()],
    );
    // Shadow location whose check carries the SAME POS ref (F4-5).
    const loc2 = await seedLocation('f4b');
    const table2 = randomUUID();
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T9',$3,'SEATED')`,
      [table2, loc2, `tok-${randomUUID().replace(/-/g, '')}`],
    );
    const m2 = await query(`SELECT merchant_id FROM locations WHERE id = $1`, [loc2]);
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'ord-f4','ord-f4','square',$4,'OPEN',1200,'CAD')`,
      [randomUUID(), table2, loc2, m2.rows[0].merchant_id],
    );
    // A table whose only open check cannot be read from the POS (F4-12).
    const brokenTable = randomUUID();
    brokenTableToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T2',$3,'SEATED')`,
      [brokenTable, locationId, brokenTableToken],
    );
    const m1 = await query(`SELECT merchant_id FROM locations WHERE id = $1`, [locationId]);
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'ord-broken','ord-broken','square',$4,'OPEN',1200,'CAD')`,
      [randomUUID(), brokenTable, locationId, m1.rows[0].merchant_id],
    );
  });

  after(async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    await app?.close();
  });

  function post(path: string, body: unknown) {
    return app.inject({ method: 'POST', url: path, payload: body as Record<string, unknown> });
  }

  it('loyalty lookup without payment_id counts nothing and creates no row', async () => {
    const res = await post(`/api/t/${tableToken}/loyalty`, { phone: '6045550101' });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json();
    assert.equal(data.counted, false);
    assert.equal(data.visits, 0);
    const rows = await query(`SELECT COUNT(*)::int AS n FROM loyalty_visits WHERE location_id = $1`, [locationId]);
    assert.equal(rows.rows[0].n, 0);
  });

  it('loyalty counts the caller\'s own payment, once', async () => {
    const first = await post(`/api/t/${tableToken}/loyalty`, { phone: '6045550101', payment_id: 'pay-f4-1' });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().counted, true);
    assert.equal(first.json().visits, 1);
    const again = await post(`/api/t/${tableToken}/loyalty`, { phone: '6045550101', payment_id: 'pay-f4-1' });
    assert.equal(again.json().counted, false);
    assert.equal(again.json().visits, 1);
  });

  it('the same payment cannot count for a second phone number', async () => {
    const res = await post(`/api/t/${tableToken}/loyalty`, { phone: '6045559999', payment_id: 'pay-f4-1' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().counted, false);
    assert.equal(res.json().visits, 0);
  });

  it('loyalty rejects an unknown payment_id and a refunded payment', async () => {
    const bogus = await post(`/api/t/${tableToken}/loyalty`, { phone: '6045550101', payment_id: 'pay-nope' });
    assert.equal(bogus.statusCode, 400);
    const refunded = await post(`/api/t/${tableToken}/loyalty`, { phone: '6045550101', payment_id: 'pay-f4-refunded' });
    assert.equal(refunded.statusCode, 400);
  });

  it('receipt email and print REQUIRE payment_id', async () => {
    const email = await post(`/api/t/${tableToken}/receipt-email`, { email: 'guest@example.com' });
    assert.equal(email.statusCode, 400);
    assert.match(email.body, /payment_id is required/);
    const print = await post(`/api/t/${tableToken}/receipt-print`, {});
    assert.equal(print.statusCode, 400);
    assert.match(print.body, /payment_id is required/);
  });

  it('feedback is gated to an in-service table, then allowed once seated', async () => {
    // A dedicated FREE table with no payments anywhere near it — the main
    // table's seeded payments would (correctly) satisfy the gate.
    const fbTable = randomUUID();
    const fbToken = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(
      `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T3',$3,'FREE')`,
      [fbTable, locationId, fbToken],
    );
    const blocked = await post(`/api/t/${fbToken}/feedback`, { rating: 5 });
    assert.equal(blocked.statusCode, 400, blocked.body);
    await query(`UPDATE tables SET state = 'SEATED' WHERE id = $1`, [fbTable]);
    const ok = await post(`/api/t/${fbToken}/feedback`, { rating: 5 });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('check detail resolves to the caller\'s own check when refs collide', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/checks/ord-f4?table_token=${tableToken}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().id, checkId);
  });

  it('bootstrap flags pos_unavailable when open checks cannot be read', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/t/${brokenTableToken}` });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json();
    assert.equal(data.check, null);
    assert.equal(data.pos_unavailable, true);
  });

  it('claims validate device id, item index and fingerprint against the live bill', async () => {
    const base = `/api/checks/ord-f4/claims?table_token=${tableToken}`;
    const badDevice = await post(base, { item_index: 0, fingerprint: 'Burger|1|1200', device_id: 'not-a-uuid' });
    assert.equal(badDevice.statusCode, 400, badDevice.body);
    const badIndex = await post(base, { item_index: 5, fingerprint: 'Burger|1|1200', device_id: devA });
    assert.equal(badIndex.statusCode, 400, badIndex.body);
    const badFp = await post(base, { item_index: 0, fingerprint: 'Fries|1|500', device_id: devA });
    assert.equal(badFp.statusCode, 400, badFp.body);
    const ok = await post(base, { item_index: 0, fingerprint: 'Burger|1|1200', device_id: devA });
    assert.equal(ok.statusCode, 200, ok.body);
    const clash = await post(base, { item_index: 0, fingerprint: 'Burger|1|1200', device_id: devB });
    assert.equal(clash.statusCode, 409, clash.body);
    // A different device cannot unclaim it; the owner can.
    await app.inject({ method: 'DELETE', url: base, payload: { item_index: 0, device_id: devB } });
    const stillHeld = await post(base, { item_index: 0, fingerprint: 'Burger|1|1200', device_id: devB });
    assert.equal(stillHeld.statusCode, 409, stillHeld.body);
    const un = await app.inject({ method: 'DELETE', url: base, payload: { item_index: 0, device_id: devA } });
    assert.equal(un.statusCode, 200, un.body);
    const nowFree = await post(base, { item_index: 0, fingerprint: 'Burger|1|1200', device_id: devB });
    assert.equal(nowFree.statusCode, 200, nowFree.body);
  });

  it('pay gate: FREE table blocks a new charge, a PAID-flipped table does not (F4-11)', async () => {
    const body = {
      mode: 'full', amount_cents: 1200, tip_cents: 150,
      card_nonce: 'cnon:card-nonce-ok', payment_method: 'card',
      idempotency_key: randomUUID(),
    };
    await query(`UPDATE tables SET state = 'FREE' WHERE id = $1`, [tableId]);
    const blocked = await post(`/api/checks/ord-f4/pay?table_token=${tableToken}`, body);
    assert.equal(blocked.statusCode, 400, blocked.body);
    assert.match(blocked.body, /not seated/);
    await query(`UPDATE tables SET state = 'PAID' WHERE id = $1`, [tableId]);
    const ok = await post(`/api/checks/ord-f4/pay?table_token=${tableToken}`, body);
    assert.equal(ok.statusCode, 200, ok.body);
    const rows = await query(`SELECT status FROM payments WHERE check_id = $1 AND external_payment_ref = 'sqpay-f4'`, [checkId]);
    assert.equal(rows.rows[0]?.status, 'COMPLETED');
  });
});
