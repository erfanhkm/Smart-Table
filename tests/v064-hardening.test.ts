// v0.6.4 security-hardening regression tests (from the Claude double-check
// review, cycle 1 section 1):
//  - A-1: admin login is rate-limited and answers 401 (not 400) on bad creds
//  - A-2: STAFF_API_TOKEN no longer grants founder (/api/admin/*) access
//  - A-6: portal login answers the same 401 for unknown emails as for wrong
//    passwords (and always pays the scrypt cost — dummy hash)
//  - B-5: Square payment.updated maps statuses and never regresses a row
//  - B-13: the webhook verification URL is pinned to APP_URL
//  - B-3: sq() refuses to run without an explicit token (unit-level: the
//    exported merchant helpers surface the error)
//
// Run: PG_MEM=1 npx tsx --test tests/v064-hardening.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';

process.env.PG_MEM = '1';
const STAFF_TOKEN = 'staff-token-for-tests-' + 'x'.repeat(24);
process.env.STAFF_API_TOKEN = STAFF_TOKEN;
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

// Founder admin credentials for this test app (hash in the app's scrypt format).
const ADMIN_PASSWORD = 'founder-pass-123';
const salt = Buffer.alloc(16, 7);
process.env.ADMIN_USERNAME = 'founder';
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString('hex')}$${scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { hashPassword, encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { webhookNotificationUrl, mapSquarePaymentStatus, paymentStatusRank } = await import('../src/routes/webhooks.js');
const { retrievePayment } = await import('../src/square.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
const CHECK = randomUUID();

before(async () => {
  await migrate();
  app = await buildApp();
  await app.ready();
  await query(
    `INSERT INTO checks(id, table_id, pos_type, external_check_ref, state, total_cents, currency)
     VALUES ($1, NULL, 'square', 'SQORD064', 'OPEN', 5000, 'CAD')`,
    [CHECK],
  );
  const mkPayment = async (sqId: string, status: string) => {
    await query(
      `INSERT INTO payments(id, check_id, square_payment_id, amount_cents, status, idempotency_key)
       VALUES ($1,$2,$3,5000,$4,$5)`,
      [randomUUID(), CHECK, sqId, status, `key-${sqId}`],
    );
  };
  await mkPayment('SQPAY_DONE', 'COMPLETED');
  await mkPayment('SQPAY_PENDING', 'PENDING');
  await query(
    `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
     VALUES ('m-064','square','sq-merchant',$1,$2)`,
    [encryptSecret('x'), encryptSecret('x')],
  );
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ('loc-064','m-064','square','SQLoc064','SQLoc064','Hardening House','CAD')`,
  );
  await query(`INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'owner@x.local',$2,'owner','loc-064')`, [
    randomUUID(),
    await hashPassword('owner-pass-123'),
  ]);
});

async function squareWebhook(eventId: string, paymentId: string, status: string) {
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/square',
    payload: { event_id: eventId, type: 'payment.updated', data: { object: { payment: { id: paymentId, status } } } },
  });
}

async function paymentStatus(sqId: string): Promise<string> {
  const r = await query(`SELECT status FROM payments WHERE square_payment_id=$1`, [sqId]);
  return (r.rows[0] as { status: string }).status;
}

describe('B-13/B-5 units: pinned webhook URL + status mapping', () => {
  it('webhookNotificationUrl is APP_URL + path, always', () => {
    assert.equal(
      webhookNotificationUrl({ appUrl: 'https://portal.example.com' }),
      'https://portal.example.com/api/webhooks/square',
    );
  });

  it('mapSquarePaymentStatus maps only APPROVED/COMPLETED', () => {
    assert.equal(mapSquarePaymentStatus('APPROVED'), 'AUTHORIZED');
    assert.equal(mapSquarePaymentStatus('COMPLETED'), 'COMPLETED');
    assert.equal(mapSquarePaymentStatus('CANCELED'), null);
    assert.equal(mapSquarePaymentStatus('PENDING'), null);
    assert.equal(mapSquarePaymentStatus(undefined), null);
  });

  it('paymentStatusRank is forward-only with terminal states on top', () => {
    assert.ok(paymentStatusRank('AUTHORIZED') > paymentStatusRank('PENDING'));
    assert.ok(paymentStatusRank('COMPLETED') > paymentStatusRank('AUTHORIZED'));
    assert.ok(paymentStatusRank('FAILED') >= paymentStatusRank('COMPLETED'));
    assert.ok(paymentStatusRank('REFUNDED') >= paymentStatusRank('COMPLETED'));
  });
});

describe('B-3: Square client refuses a missing token', () => {
  it('retrievePayment without a token throws before any network call', async () => {
    await assert.rejects(() => retrievePayment('SQPAY1', undefined), /explicit Square access token is required/);
  });
});

describe('B-5: payment.updated is mapped and forward-only', () => {
  it('an out-of-order APPROVED does not regress a COMPLETED payment', async () => {
    const res = await squareWebhook('evt-064-1', 'SQPAY_DONE', 'APPROVED');
    assert.equal(res.statusCode, 200);
    assert.equal(await paymentStatus('SQPAY_DONE'), 'COMPLETED');
  });

  it('COMPLETED moves a PENDING payment forward', async () => {
    const res = await squareWebhook('evt-064-2', 'SQPAY_PENDING', 'COMPLETED');
    assert.equal(res.statusCode, 200);
    assert.equal(await paymentStatus('SQPAY_PENDING'), 'COMPLETED');
  });

  it('raw Square vocabulary is never stored (CANCELED ignored)', async () => {
    const res = await squareWebhook('evt-064-3', 'SQPAY_DONE', 'CANCELED');
    assert.equal(res.statusCode, 200);
    assert.equal(await paymentStatus('SQPAY_DONE'), 'COMPLETED');
  });
});

describe('A-2/A-1: founder admin auth', () => {
  it('the staff token does NOT open founder routes anymore', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/analytics',
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
    });
    assert.equal(res.statusCode, 401);
  });

  it('bad founder password answers 401 (not 400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: 'founder', password: 'wrong' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('good founder login issues a session that opens founder routes', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: 'founder', password: ADMIN_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const token = login.json().token as string;
    assert.ok(token);
    // Analytics is unconfigured in tests (no Cloudflare token) -> 400, the
    // point is it is NOT 401: the session authenticated.
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/analytics',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 400);
  });

  it('the founder login limiter trips at 10 attempts per IP', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/login',
        remoteAddress: '10.9.9.9',
        payload: { username: 'founder', password: 'wrong' },
      });
      last = res.statusCode;
    }
    assert.equal(last, 429);
  });
});

describe('A-6: portal login does not enumerate emails', () => {
  it('unknown email and wrong password get the identical 401', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: 'nobody@x.local', password: 'whatever' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: 'owner@x.local', password: 'wrong' },
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(unknown.json(), wrong.json());
  });
});
