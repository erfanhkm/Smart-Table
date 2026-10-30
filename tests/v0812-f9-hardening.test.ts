// v0.8.12 (F9): demo-location hardening.
//
// Proves:
//  F9-1  receipt EMAIL on a demo location answers like an accepted send
//        but never calls Resend and never claims the one-send slot;
//        on a real location it sends and claims as before.
//  F9-1  receipt PRINT on a demo location answers printed:true but
//        queues NO print job and claims nothing; real location queues.
//  F9-2  payCheck refuses payment attempts on a demo location when
//        SQUARE_ENV=production (no Square call, no reservation row),
//        and charges normally in sandbox.
//  F9-3  portal mutations on a demo location are 403: QR rotation,
//        Google review URL change, billing plan, billing card, refund,
//        cash-payment recording. Other settings + reads stay open.
//  F9-4  demo-access dedupe: a second pending submission with the same
//        email returns ok but inserts no row and sends no second email.
//
// Run: PG_MEM=1 npx tsx --test tests/v0812-f9-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
const TEST_TOKEN = ['test', 'token'].join('-');
process.env.STAFF_API_TOKEN = TEST_TOKEN;
process.env.SQUARE_ACCESS_TOKEN = ['sq', 'token'].join('-');
process.env.RESEND_API_KEY = ['resend', 'test', 'key'].join('-');
process.env.RECEIPT_FROM_EMAIL = 'receipts@smarttablepay.com';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { payCheck } = await import('../src/services/payments.js');
const { config } = await import('../src/config.js');

const STAFF = { authorization: `Bearer ${TEST_TOKEN}` };

// ---- fetch mock: Resend + Square -------------------------------------------
let resendCalls = 0;
let squareChargeCalls = 0;
const orderTotals: Record<string, number> = { 'ORD-DEMO': 1200, 'ORD-REAL': 1200 };
const orderPaid: Record<string, number> = { 'ORD-DEMO': 0, 'ORD-REAL': 0 };
let paySeq = 0;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function orderObj(id: string) {
  const paid = orderPaid[id] ?? 0;
  return {
    id, location_id: 'SQLOC-F9', state: paid >= (orderTotals[id] ?? 0) ? 'COMPLETED' : 'OPEN',
    total_money: { amount: orderTotals[id] ?? 0, currency: 'CAD' },
    line_items: [{ uid: 'li1', name: 'Burger', quantity: '1', base_price_money: { amount: 1200, currency: 'CAD' }, total_money: { amount: 1200, currency: 'CAD' } }],
    tenders: paid > 0 ? [{ id: 'T1', payment_id: 'SQPAYX', type: 'CARD', amount_money: { amount: paid, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' } }] : [],
  };
}
const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('https://api.resend.com/')) {
      resendCalls += 1;
      return json({ id: `email-${resendCalls}` });
    }
    if (url.endsWith('/v2/payments') && method === 'POST') {
      squareChargeCalls += 1;
      paySeq += 1;
      const body = JSON.parse(String(init?.body ?? '{}'));
      const oid = String(body.order_id ?? '');
      if (oid in orderPaid) orderPaid[oid] += (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0);
      return json({ payment: { id: `SQPAY${paySeq}`, status: 'APPROVED' } });
    }
    const payM = /\/v2\/orders\/([\w-]+)\/pay$/.exec(url);
    if (payM && method === 'POST') return json({ order: orderObj(payM[1]) });
    const getM = /\/v2\/orders\/([\w-]+)$/.exec(url);
    if (getM && method === 'GET') return json({ order: orderObj(getM[1]) });
    return origFetch(input as string, init);
  }) as typeof fetch;
}

// ---- seed --------------------------------------------------------------------
const MERCHANT = randomUUID();
const LOC_DEMO = randomUUID();
const LOC_REAL = randomUUID();
const TBL_DEMO = randomUUID();
const TBL_REAL = randomUUID();
const TOK_DEMO = `tokdemo${randomUUID().replace(/-/g, '')}`;
const TOK_REAL = `tokreal${randomUUID().replace(/-/g, '')}`;
const CHK_DEMO = randomUUID();
const CHK_REAL = randomUUID();
const PAY_DEMO = randomUUID();
const PAY_REAL = randomUUID();

async function seedLocation(locId: string, demo: boolean, sqRef: string) {
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, qr_ordering_enabled, loyalty_enabled, loyalty_visits_required, loyalty_reward_text)
     VALUES ($1,$2,'square',$3,$3,$4,'CAD',$5,true,true,5,'Free dessert')`,
    [locId, MERCHANT, sqRef, demo ? 'Demo Bistro' : 'Real Bistro', demo],
  );
}
async function seedTableCheck(locId: string, tblId: string, token: string, chkId: string, orderRef: string, payId: string, payRef: string) {
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,'SEATED')`, [tblId, locId, token]);
  await query(
    `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
     VALUES ($1,$2,$3,$4,$4,'square',$5,'OPEN',1200,'CAD')`,
    [chkId, tblId, locId, orderRef, MERCHANT],
  );
  await query(
    `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
     VALUES ($1,$2,1200,150,'COMPLETED',$3,$4,'CAD')`,
    [payId, chkId, randomUUID(), payRef],
  );
  await query(`INSERT INTO devices(id, location_id, table_id, token_hash) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), locId, tblId, `hash-${tblId}`]);
}

describe('v0.8.12 F9 demo-location hardening', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    installFetch();
    await migrate();
    app = await buildApp({ logger: false });
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,'square','sqm-f9','sqm-f9',$2,$3,'2099-06-01T00:00:00Z')`,
      [MERCHANT, encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    await query(
      `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,$2,'square','sqm-f9',$3,$4,'2099-06-01T00:00:00Z')`,
      [randomUUID(), MERCHANT, encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    await seedLocation(LOC_DEMO, true, 'SQLOC-F9D');
    await seedLocation(LOC_REAL, false, 'SQLOC-F9R');
    await seedTableCheck(LOC_DEMO, TBL_DEMO, TOK_DEMO, CHK_DEMO, 'ORD-DEMO', PAY_DEMO, 'pay-demo-1');
    await seedTableCheck(LOC_REAL, TBL_REAL, TOK_REAL, CHK_REAL, 'ORD-REAL', PAY_REAL, 'pay-real-1');
  });
  after(async () => {
    if (app) await app.close();
    globalThis.fetch = origFetch;
  });

  it('F9-1: receipt email on the demo location is accepted but never sent or claimed', async () => {
    const beforeResend = resendCalls;
    const res = await app.inject({
      method: 'POST', url: `/api/t/${TOK_DEMO}/receipt-email`,
      payload: { email: 'stranger@arbitrary.example', payment_id: 'pay-demo-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).sent, true);
    assert.equal(resendCalls, beforeResend, 'Resend must not be called for a demo location');
    const row = await query(`SELECT receipt_emailed_at FROM payments WHERE id = $1`, [PAY_DEMO]);
    assert.equal(row.rows[0].receipt_emailed_at, null, 'the one-send slot must not be claimed');
  });

  it('F9-1: receipt email on a real location sends and claims the slot', async () => {
    const beforeResend = resendCalls;
    const res = await app.inject({
      method: 'POST', url: `/api/t/${TOK_REAL}/receipt-email`,
      payload: { email: 'guest@real.example', payment_id: 'pay-real-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).sent, true);
    assert.equal(resendCalls, beforeResend + 1);
    const row = await query(`SELECT receipt_emailed_at FROM payments WHERE id = $1`, [PAY_REAL]);
    assert.notEqual(row.rows[0].receipt_emailed_at, null);
  });

  it('F9-1: receipt print on the demo location answers printed but queues no job', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/t/${TOK_DEMO}/receipt-print`,
      payload: { payment_id: 'pay-demo-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.printed, true);
    const jobs = await query(`SELECT COUNT(*)::int AS n FROM print_jobs WHERE table_id = $1`, [TBL_DEMO]);
    assert.equal(jobs.rows[0].n, 0, 'no print job may be created for a demo location');
    const row = await query(`SELECT receipt_printed_at FROM payments WHERE id = $1`, [PAY_DEMO]);
    assert.equal(row.rows[0].receipt_printed_at, null);
  });

  it('F9-1: receipt print on a real location queues exactly one job', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/t/${TOK_REAL}/receipt-print`,
      payload: { payment_id: 'pay-real-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).printed, true);
    const jobs = await query(`SELECT COUNT(*)::int AS n FROM print_jobs WHERE table_id = $1`, [TBL_REAL]);
    assert.equal(jobs.rows[0].n, 1);
  });

  it('F9-2: demo payments are refused in production mode before any Square call', async () => {
    const chargesBefore = squareChargeCalls;
    const key = randomUUID();
    (config as { squareEnv: string }).squareEnv = 'production';
    try {
      await assert.rejects(
        () => payCheck({
          checkRef: 'ORD-DEMO', checkId: CHK_DEMO, mode: 'full', tipCents: 0, idempotencyKey: key,
          source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
        }),
        /demo location: payments are disabled/,
      );
    } finally {
      (config as { squareEnv: string }).squareEnv = 'sandbox';
    }
    assert.equal(squareChargeCalls, chargesBefore, 'no charge may reach Square');
    const rows = await query(`SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key]);
    assert.equal(rows.rows[0].n, 0, 'the refusal happens before the reservation insert');
  });

  it('F9-2: the same demo payment succeeds in sandbox mode', async () => {
    const res = await payCheck({
      checkRef: 'ORD-DEMO', checkId: CHK_DEMO, mode: 'full', tipCents: 0, idempotencyKey: randomUUID(),
      source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    assert.ok(res.paymentId);
  });

  it('F9-3: QR rotation is refused on the demo location, allowed on a real one', async () => {
    const denied = await app.inject({ method: 'POST', url: `/api/tables/${TBL_DEMO}/rotate-qr`, headers: STAFF, payload: {} });
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body, /demo locations/i);
    const allowed = await app.inject({ method: 'POST', url: `/api/tables/${TBL_REAL}/rotate-qr`, headers: STAFF, payload: {} });
    assert.equal(allowed.statusCode, 200);
    assert.ok(JSON.parse(allowed.body).qr_token);
  });

  it('F9-3: review-URL changes are refused on demo; other settings still save', async () => {
    const denied = await app.inject({
      method: 'PATCH', url: `/api/locations/${LOC_DEMO}`, headers: STAFF,
      payload: { google_review_url: 'https://g.page/evil-link' },
    });
    assert.equal(denied.statusCode, 403);
    const other = await app.inject({
      method: 'PATCH', url: `/api/locations/${LOC_DEMO}`, headers: STAFF,
      payload: { loyalty_enabled: false },
    });
    assert.equal(other.statusCode, 200);
    const real = await app.inject({
      method: 'PATCH', url: `/api/locations/${LOC_REAL}`, headers: STAFF,
      payload: { google_review_url: 'https://g.page/real-link' },
    });
    assert.equal(real.statusCode, 200);
  });

  it('F9-3: billing plan and card writes are refused on demo; billing read works', async () => {
    const plan = await app.inject({
      method: 'POST', url: '/api/portal/billing/plan', headers: STAFF,
      payload: { location_id: LOC_DEMO, plan: 'subscription' },
    });
    assert.equal(plan.statusCode, 403);
    const card = await app.inject({
      method: 'POST', url: '/api/portal/billing/card', headers: STAFF,
      payload: { location_id: LOC_DEMO, source_id: 'cnon:card-nonce-ok' },
    });
    assert.equal(card.statusCode, 403);
    const read = await app.inject({ url: `/api/portal/billing?location_id=${LOC_DEMO}`, headers: STAFF });
    assert.equal(read.statusCode, 200);
  });

  it('F9-3: refunds and cash recording are refused on the demo location', async () => {
    const refund = await app.inject({
      method: 'POST', url: `/api/portal/payments/${PAY_DEMO}/refund`, headers: STAFF,
      payload: { idempotency_key: randomUUID() },
    });
    assert.equal(refund.statusCode, 403);
    const cash = await app.inject({
      method: 'POST', url: '/api/checks/ORD-DEMO/record-external-payment', headers: STAFF,
      payload: { location_id: LOC_DEMO, mode: 'full', tip_cents: 0, idempotency_key: randomUUID() },
    });
    assert.equal(cash.statusCode, 403);
  });

  it('F9-3: ordinary demo reads keep working', async () => {
    const tables = await app.inject({ url: `/api/tables?location_id=${LOC_DEMO}`, headers: STAFF });
    assert.equal(tables.statusCode, 200);
    assert.equal(JSON.parse(tables.body).tables.length, 1);
  });

  it('F9-4: a duplicate pending demo-access submission stores and emails only once', async () => {
    const beforeResend = resendCalls;
    const body = {
      full_name: 'Dana Dup', restaurant_name: 'Dup Cafe', email: 'dana@dupcafe.ca',
      phone: '604-555-0100', city: 'Surrey',
    };
    const first = await app.inject({ method: 'POST', url: '/api/demo-access-requests', payload: body, remoteAddress: '127.0.5.1' });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({ method: 'POST', url: '/api/demo-access-requests', payload: { ...body, full_name: 'Dana Again' }, remoteAddress: '127.0.5.2' });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(JSON.parse(second.body), { ok: true });
    const rows = await query(`SELECT COUNT(*)::int AS n FROM demo_access_requests WHERE email = 'dana@dupcafe.ca'`);
    assert.equal(rows.rows[0].n, 1, 'the duplicate must not insert a second row');
    assert.equal(resendCalls, beforeResend + 1, 'exactly one notification email');
  });
});
