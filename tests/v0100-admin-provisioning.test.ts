// v0.10.0: founder-admin "New Restaurant" provisioning —
// POST /api/admin/locations creates merchant + location + billing
// account + owner portal login + tables in one transaction, for a
// restaurant that connects its POS later.
//
// Proves:
//  (a) 401 without (and with a bogus) founder session.
//  (b) starter + commission happy path: every row exists with the
//      tier pair (100 bps), the POS-pending refs are in place, tables
//      are numbered with unique QR tokens, and the returned temp
//      password logs the owner in via the real /api/portal/login.
//  (c) base + subscription: billing resolves the Base price (9900).
//  (d) duplicate owner email -> 409 and NO partial rows survive.
//  (e) invalid table_count / tier -> 400, nothing created.
//  (f) a card payment on a not-yet-connected location fails cleanly
//      with 409 pos_not_connected (never reaches an adapter / env token).
//
// Run: PG_MEM=1 npx tsx --test tests/v0100-admin-provisioning.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['test', 'token'].join('-');
process.env.SQUARE_APP_ID = process.env.SQUARE_APP_ID || 'sq0idp-test-app';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const ADMIN_PASSWORD = ['founder', 'pass', 'v0100'].join('-');
const salt = randomBytes(16);
process.env.ADMIN_USERNAME = 'founder';
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString('hex')}$${scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');
const { getBillingState } = await import('../src/services/billing.js');
const { payCheck } = await import('../src/services/payments.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
let adminToken = '';

async function adminLogin() {
  const res = await app.inject({
    method: 'POST', url: '/api/admin/login',
    payload: { username: 'founder', password: ADMIN_PASSWORD },
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.payload).token as string;
}

async function createRestaurant(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/admin/locations',
    headers: { authorization: `Bearer ${adminToken}` },
    payload,
  });
}

before(async () => {
  await migrate();
  app = await buildApp();
  adminToken = await adminLogin();
});

describe('v0.10.0 founder-admin provisioning', () => {
  it('(a) requires founder auth', async () => {
    const noAuth = await app.inject({
      method: 'POST', url: '/api/admin/locations',
      payload: { name: 'Nope', owner_email: 'nope@example.com' },
    });
    assert.equal(noAuth.statusCode, 401);
    const bogus = await app.inject({
      method: 'POST', url: '/api/admin/locations',
      headers: { authorization: 'Bearer not-a-real-session' },
      payload: { name: 'Nope', owner_email: 'nope@example.com' },
    });
    assert.equal(bogus.statusCode, 401);
    const rows = await query(`SELECT id FROM locations WHERE name = 'Nope'`);
    assert.equal(rows.rows.length, 0);
  });

  it('(b) starter + commission happy path, temp password logs in', async () => {
    const res = await createRestaurant({
      name: 'Provisioned Starter',
      owner_email: 'Owner@Starter.example',
      tier: 'starter',
      plan: 'commission',
      table_count: 4,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);
    assert.ok(body.location_id && body.merchant_id);
    assert.equal(body.owner_email, 'owner@starter.example', 'email is lowercased');
    assert.equal(body.tier, 'starter');
    assert.equal(body.plan, 'commission');
    assert.equal(body.tables_created, 4);
    assert.equal(typeof body.temp_password, 'string');
    assert.ok(body.temp_password.length >= 14, 'temp password is 14+ chars');

    const loc = await query<any>(`SELECT * FROM locations WHERE id = $1`, [body.location_id]);
    assert.equal(loc.rows.length, 1);
    assert.equal(loc.rows[0].name, 'Provisioned Starter');
    assert.equal(loc.rows[0].currency, 'CAD');
    assert.equal(loc.rows[0].demo, false);
    assert.equal(loc.rows[0].tier, 'starter');
    assert.equal(loc.rows[0].merchant_id, body.merchant_id);
    assert.equal(loc.rows[0].pos_type, 'square');
    assert.equal(loc.rows[0].pos_location_ref, `pending-${body.location_id}`);
    assert.equal(loc.rows[0].square_location_id, `pending-${body.location_id}`);

    const mer = await query<any>(`SELECT * FROM merchants WHERE id = $1`, [body.merchant_id]);
    assert.equal(mer.rows.length, 1);
    assert.equal(mer.rows[0].pos_type, 'square');
    assert.equal(mer.rows[0].square_merchant_id, null);
    assert.equal(mer.rows[0].external_merchant_ref, `pending-${body.merchant_id}`);
    assert.equal(mer.rows[0].access_token_enc, '');

    const creds = await query(`SELECT id FROM pos_credentials WHERE merchant_id = $1`, [body.merchant_id]);
    assert.equal(creds.rows.length, 0, 'no POS credential row — nothing can fall back to a token');

    const acct = await query<any>(`SELECT * FROM billing_accounts WHERE location_id = $1`, [body.location_id]);
    assert.equal(acct.rows.length, 1);
    assert.equal(acct.rows[0].plan, 'commission');
    assert.equal(acct.rows[0].commission_bps, 100, 'starter commission is 1%');
    assert.equal(acct.rows[0].subscription_price_cents, 4999, 'starter price is $49.99');

    const owner = await query<any>(`SELECT * FROM portal_users WHERE email = 'owner@starter.example'`);
    assert.equal(owner.rows.length, 1);
    assert.equal(owner.rows[0].role, 'owner');
    assert.equal(owner.rows[0].location_id, body.location_id);
    assert.notEqual(owner.rows[0].password_hash, body.temp_password, 'only the hash is stored');

    const tbls = await query<any>(`SELECT name, qr_token FROM tables WHERE location_id = $1 ORDER BY name`, [body.location_id]);
    assert.equal(tbls.rows.length, 4);
    assert.deepEqual(tbls.rows.map((t: any) => t.name), ['1', '2', '3', '4']);
    assert.equal(new Set(tbls.rows.map((t: any) => t.qr_token)).size, 4, 'QR tokens are unique');

    // The temp password works on the REAL portal login route.
    const login = await app.inject({
      method: 'POST', url: '/api/portal/login',
      payload: { email: 'owner@starter.example', password: body.temp_password },
    });
    assert.equal(login.statusCode, 200, login.payload);
    assert.ok(JSON.parse(login.payload).token, 'portal login issues a token');
  });

  it('(c) base + subscription resolves the Base price; default table_count is 10', async () => {
    const res = await createRestaurant({
      name: 'Provisioned Base',
      owner_email: 'owner@base.example',
      tier: 'base',
      plan: 'subscription',
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);
    assert.equal(body.tables_created, 10);
    const state = await getBillingState(body.location_id);
    assert.equal(state.tier, 'base');
    assert.equal(state.account.plan, 'subscription');
    assert.equal(state.account.subscription_price_cents, 9900, 'base price is $99.00');
    assert.equal(state.account.commission_bps, 200, 'base commission is 2%');
    const tbls = await query(`SELECT id FROM tables WHERE location_id = $1`, [body.location_id]);
    assert.equal(tbls.rows.length, 10);
  });

  it('(d) duplicate owner email -> 409 and nothing partial survives', async () => {
    const before = await query(`SELECT COUNT(*)::int AS n FROM locations`);
    const res = await createRestaurant({
      name: 'Dupe Should Not Exist',
      owner_email: 'owner@starter.example', // created in (b)
      tier: 'base',
      plan: 'commission',
      table_count: 3,
    });
    assert.equal(res.statusCode, 409, res.payload);
    assert.match(JSON.parse(res.payload).error, /already in use/i);
    const after = await query(`SELECT COUNT(*)::int AS n FROM locations`);
    assert.equal(after.rows[0].n, before.rows[0].n, 'no location row was left behind');
    const ghost = await query(`SELECT id FROM locations WHERE name = 'Dupe Should Not Exist'`);
    assert.equal(ghost.rows.length, 0);
  });

  it('(e) invalid input -> 400 and nothing is created', async () => {
    for (const bad of [
      { name: 'Bad Tables Zero', owner_email: 'zero@example.com', table_count: 0 },
      { name: 'Bad Tables Many', owner_email: 'many@example.com', table_count: 101 },
      { name: 'Bad Tables Frac', owner_email: 'frac@example.com', table_count: 2.5 },
      { name: 'Bad Tier', owner_email: 'tier@example.com', tier: 'gold' },
      { name: 'Bad Plan', owner_email: 'plan@example.com', plan: 'free' },
      { name: '', owner_email: 'noname@example.com' },
      { name: 'Bad Email', owner_email: 'not-an-email' },
    ]) {
      const res = await createRestaurant(bad);
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} -> ${res.payload}`);
    }
    const users = await query(
      `SELECT id FROM portal_users WHERE email IN ('zero@example.com','many@example.com','frac@example.com','tier@example.com','plan@example.com','noname@example.com')`,
    );
    assert.equal(users.rows.length, 0);
  });

  it('(f) card payment before POS connection fails cleanly (pos_not_connected)', async () => {
    const res = await createRestaurant({
      name: 'Not Connected Yet',
      owner_email: 'owner@pending.example',
      tier: 'base',
      plan: 'commission',
      table_count: 1,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);
    const tbl = await query<any>(`SELECT id FROM tables WHERE location_id = $1`, [body.location_id]);
    const checkId = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,'square','PENDING-ORDER','PENDING-ORDER',$3,'OPEN',1200,'CAD')`,
      [checkId, tbl.rows[0].id, body.merchant_id],
    );
    await assert.rejects(
      payCheck({
        checkId,
        checkRef: 'PENDING-ORDER',
        mode: 'full',
        idempotencyKey: randomUUID(),
        source: { kind: 'card', nonce: ['cnon', 'testnonce'].join(':') },
      }),
      (e: any) => {
        assert.equal(e.statusCode, 409);
        assert.equal(e.errorCode, 'pos_not_connected');
        return true;
      },
    );
    const pays = await query(`SELECT id FROM payments WHERE check_id = $1`, [checkId]);
    assert.equal(pays.rows.length, 0, 'no payment row was reserved for the refused attempt');
  });
});
