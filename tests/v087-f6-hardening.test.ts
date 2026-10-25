// v0.8.7 (Claude cycle-2 chunk F6): staff/admin/tables/onboarding/oauth
// route hardening.
//
//  F6-1  admin login: a GLOBAL failure budget behind the per-IP limiter —
//        20 failures inside an hour lock all admin logins for 15 min.
//  F6-2  Google review URL: exact suffix allow-list (google.xy.com dies).
//  F6-3  free: an OPEN check blocks with 409; force:true frees and clears
//        the open checks' group-pay claims; audited.
//  F6-4  quick-tables: owner/manager only + the 200 cumulative cap.
//  F6-5  manual-token founder branch: POS validation + replace guard +
//        durable audit rows (parity with the portal branch).
//  F6-6  recorded_by is written inside payCheck (immutable on replay);
//        staff-token callers must name location_id (F6-12).
//  F6-13 ack-call only records when a call is actually open; QR PNG is
//        owner/manager only with a private cache header.
//  F6-14 verify-menu is owner/manager only.
//  F6-9  oauth/start is owner/manager only.
//
// Run: PG_MEM=1 npx tsx --test tests/v087-f6-hardening.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';

process.env.PG_MEM = '1';
const RAW = ['STAFF', 'API', 'TOKEN'].join('_');
process.env[RAW] = ['test', 'token'].join('-');
process.env.SQUARE_APP_ID = process.env.SQUARE_APP_ID || 'sq0idp-test-app';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const ADMIN_PASSWORD = 'founder-pass-123';
const salt = randomBytes(16);
process.env.ADMIN_USERNAME = 'founder';
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString('hex')}$${scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { hashToken } = await import('../src/routes/portal.js');
const { isValidGoogleReviewUrl } = await import('../src/routes/staff.js');

const STAFF = { authorization: `Bearer ${process.env[RAW]}` };
const LOC_A = 'loc-f6-a';
const LOC_Q = 'loc-f6-q';
const M_A = 'm-f6-a';
const TBL_A = randomUUID();
const TBL_FREE = randomUUID();
const TBL_ACK = randomUUID();
const CHECK_EXT = randomUUID();
const CHECK_FREE = randomUUID();

const TOKENS: Record<string, string> = {
  'owner@a.test': 'tok-f6-owner-a',
  'staff@a.test': 'tok-f6-staff-a',
  'owner@q.test': 'tok-f6-owner-q',
};

async function seedUser(email: string, locationId: string, role: string) {
  const id = randomUUID();
  await query(`INSERT INTO portal_users(id, email, password_hash, location_id, role) VALUES ($1,$2,'x',$3,$4)`, [
    id, email, locationId, role,
  ]);
  await query(`INSERT INTO portal_tokens(token_hash, user_id) VALUES ($1,$2)`, [hashToken(TOKENS[email]), id]);
  return id;
}

function orderJson(id: string, locationId: string, total = 10000) {
  return {
    order: {
      id, location_id: locationId, state: 'OPEN',
      total_money: { amount: total, currency: 'CAD' },
      line_items: [{ name: 'Dish', quantity: '1', total_money: { amount: total, currency: 'CAD' } }],
      tenders: [],
    },
  };
}

function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('clover.com')) {
      const auth = init?.headers?.Authorization ?? '';
      if (auth === 'Bearer GOODTOKEN123') return json({ elements: [] });
      return json({ message: 'unauthorized' }, 401);
    }
    if (/\/v2\/orders\/[^/]+\/pay/.test(url) && method === 'POST') return json({ order: { id: 'EXTF6', state: 'OPEN' } });
    if (/\/v2\/payments/.test(url) && method === 'POST') {
      return json({
        payment: {
          id: 'pay-' + randomUUID().slice(0, 8), status: 'APPROVED', order_id: 'EXTF6',
          amount_money: { amount: 10000, currency: 'CAD' }, total_money: { amount: 10000, currency: 'CAD' },
        },
      });
    }
    if (/\/v2\/orders\/[^/]+/.test(url) && method === 'GET') return json(orderJson('EXTF6', 'SQLocA'));
    return orig(input as string, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ($1,'square','sq-f6','','')`, [M_A]);
  await query(
    `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ($1,$2,'square','sq-f6',$3,'')`,
    [randomUUID(), M_A, encryptSecret('SQ-TOKEN')],
  );
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency) VALUES ($1,$2,'square','SQLocA','SQLocA','Alpha','CAD')`, [LOC_A, M_A]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency) VALUES ($1,$2,'square','SQLocQ','SQLocQ','Quota','CAD')`, [LOC_Q, M_A]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'A1','tokF6A','SEATED')`, [TBL_A, LOC_A]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'F1','tokF6F','SEATED')`, [TBL_FREE, LOC_A]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'K1','tokF6K','FREE')`, [TBL_ACK, LOC_A]);
  await query(
    `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
     VALUES ($1,$2,$3,'EXTF6','EXTF6','square',$4,'OPEN',10000,'CAD')`,
    [CHECK_EXT, TBL_A, LOC_A, M_A],
  );
  await query(
    `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
     VALUES ($1,$2,$3,'FREECHK','FREECHK','square',$4,'OPEN',500,'CAD')`,
    [CHECK_FREE, TBL_FREE, LOC_A, M_A],
  );
  await query(
    `INSERT INTO item_claims(id, check_id, item_index, item_fingerprint, device_id) VALUES ($1,$2,0,'Dish|1|500',$3)`,
    [randomUUID(), CHECK_FREE, randomUUID()],
  );
  // LOC_Q starts at 199 tables for the cumulative-cap test.
  for (let i = 1; i <= 199; i++) {
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')`, [
      randomUUID(), LOC_Q, `Table ${i}`, `qtok-${i}`,
    ]);
  }
  await seedUser('owner@a.test', LOC_A, 'owner');
  await seedUser('staff@a.test', LOC_A, 'staff');
  await seedUser('owner@q.test', LOC_Q, 'owner');
}

describe('v0.8.7 F6 route hardening', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const as = (email: string) => ({ authorization: `Bearer ${TOKENS[email]}` });

  before(async () => {
    installFetch();
    await seed();
    app = await buildApp();
  });

  it('F6-2: google review URL allow-list', () => {
    assert.equal(isValidGoogleReviewUrl('https://google.xy.com/maps/place'), false);
    assert.equal(isValidGoogleReviewUrl('https://google.abc.io/maps'), false);
    assert.equal(isValidGoogleReviewUrl('https://google.attacker.com/maps'), false);
    assert.equal(isValidGoogleReviewUrl('https://google.co.uk.evil.com/maps'), false);
    assert.equal(isValidGoogleReviewUrl('http://google.com/maps'), false);
    assert.equal(isValidGoogleReviewUrl('https://www.google.com/maps/place/X'), true);
    assert.equal(isValidGoogleReviewUrl('https://google.co.uk/maps'), true);
    assert.equal(isValidGoogleReviewUrl('https://maps.google.ca/maps'), true);
    assert.equal(isValidGoogleReviewUrl('https://google.com/maps'), true);
    assert.equal(isValidGoogleReviewUrl('https://g.page/foo'), true);
  });

  it('F6-4/F6-14: quick-tables + verify-menu role gates and the cumulative cap', async () => {
    // Staff role cannot bulk-create tables.
    let res = await app.inject({
      method: 'POST', url: '/api/portal/onboarding/quick-tables', headers: as('staff@a.test'),
      payload: { count: 3 },
    });
    assert.equal(res.statusCode, 403);
    // Owner at the 199-table location: room for exactly 1 more.
    res = await app.inject({
      method: 'POST', url: '/api/portal/onboarding/quick-tables', headers: as('owner@q.test'),
      payload: { count: 5 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).created.length, 1);
    const total = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tables WHERE location_id = $1`, [LOC_Q]);
    assert.equal(total.rows[0].n, 200);
    // At the cap, further creation is refused.
    res = await app.inject({
      method: 'POST', url: '/api/portal/onboarding/quick-tables', headers: as('owner@q.test'),
      payload: { count: 1 },
    });
    assert.equal(res.statusCode, 400);
    // verify-menu is owner/manager only.
    res = await app.inject({
      method: 'POST', url: '/api/portal/onboarding/verify-menu', headers: as('staff@a.test'), payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  it('F6-3: free blocked by an open check; force frees + clears claims + audits', async () => {
    let res = await app.inject({ method: 'POST', url: `/api/tables/${TBL_FREE}/free`, headers: as('owner@a.test'), payload: {} });
    assert.equal(res.statusCode, 409, res.body);
    res = await app.inject({
      method: 'POST', url: `/api/tables/${TBL_FREE}/free`, headers: as('owner@a.test'), payload: { force: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const claims = await query(`SELECT id FROM item_claims WHERE check_id = $1`, [CHECK_FREE]);
    assert.equal(claims.rowCount, 0);
    const tbl = await query<{ state: string }>(`SELECT state FROM tables WHERE id = $1`, [TBL_FREE]);
    assert.equal(tbl.rows[0].state, 'FREE');
    const audit = await query(`SELECT id FROM audit_log WHERE action = 'table_freed' AND target = $1`, [TBL_FREE]);
    assert.equal(audit.rowCount, 1);
  });

  it('F6-13: ack-call records only against an open call; QR PNG owner/manager only', async () => {
    let res = await app.inject({ method: 'POST', url: `/api/tables/${TBL_ACK}/ack-call`, headers: as('owner@a.test'), payload: {} });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).no_open_call, true);
    let acks = await query(`SELECT id FROM events WHERE table_id = $1 AND type = 'waiter_ack'`, [TBL_ACK]);
    assert.equal(acks.rowCount, 0);
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'call_waiter')`, [randomUUID(), TBL_ACK]);
    res = await app.inject({ method: 'POST', url: `/api/tables/${TBL_ACK}/ack-call`, headers: as('owner@a.test'), payload: {} });
    assert.equal(res.statusCode, 200);
    acks = await query(`SELECT id FROM events WHERE table_id = $1 AND type = 'waiter_ack'`, [TBL_ACK]);
    assert.equal(acks.rowCount, 1);
    // QR PNG: staff role refused; owner gets the PNG (the platform-wide
    // /api no-store hook covers its cache header).
    res = await app.inject({ method: 'GET', url: `/api/tables/${TBL_A}/qr`, headers: as('staff@a.test') });
    assert.equal(res.statusCode, 403);
    res = await app.inject({ method: 'GET', url: `/api/tables/${TBL_A}/qr`, headers: as('owner@a.test') });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['cache-control']), /no-store/);
  });

  it('F6-6/F6-12: staff-token external payment needs location_id; recorded_by immutable on replay', async () => {
    const body = {
      mode: 'full', tip_cents: 0,
      idempotency_key: '66666666-6666-4666-8666-666666666666',
    };
    // Staff token without a location: refused before any lookup.
    let res = await app.inject({
      method: 'POST', url: '/api/checks/EXTF6/record-external-payment', headers: STAFF, payload: body,
    });
    assert.equal(res.statusCode, 400, res.body);
    // With the location named: recorded, actor = staff-token.
    res = await app.inject({
      method: 'POST', url: '/api/checks/EXTF6/record-external-payment', headers: STAFF,
      payload: { ...body, location_id: LOC_A },
    });
    assert.equal(res.statusCode, 200, res.body);
    let paid = await query<{ recorded_by: string | null }>(
      `SELECT recorded_by FROM payments WHERE idempotency_key = '66666666-6666-4666-8666-666666666666'`,
    );
    assert.equal(paid.rows[0]?.recorded_by, 'staff-token');
    // Replay of the same key by the location's owner must NOT overwrite the actor.
    res = await app.inject({
      method: 'POST', url: '/api/checks/EXTF6/record-external-payment', headers: as('owner@a.test'), payload: body,
    });
    assert.equal(res.statusCode, 200, res.body);
    paid = await query<{ recorded_by: string | null }>(
      `SELECT recorded_by FROM payments WHERE idempotency_key = '66666666-6666-4666-8666-666666666666'`,
    );
    assert.equal(paid.rows[0]?.recorded_by, 'staff-token');
    const audit = await query(`SELECT id FROM audit_log WHERE action = 'external_payment_recorded' AND target = $1`, [CHECK_EXT]);
    assert.ok(audit.rowCount >= 1);
  });

  it('F6-5: manual-token founder branch validates + replace-guards + audits', async () => {
    const base = {
      pos_type: 'clover', external_merchant_ref: 'CLOVERM-F6', location_ref: 'CLOVERLOC1',
      location_name: 'Founder Clover', access_token: 'GOODTOKEN123',
    };
    // Bad token: rejected by the POS validation, nothing stored.
    let res = await app.inject({
      method: 'POST', url: '/api/oauth/manual-token', headers: STAFF,
      payload: { ...base, access_token: 'BADTOKEN999' },
    });
    assert.equal(res.statusCode, 400, res.body);
    // Good token: stored.
    res = await app.inject({ method: 'POST', url: '/api/oauth/manual-token', headers: STAFF, payload: base });
    assert.equal(res.statusCode, 200, res.body);
    // Second store without replace: conflict now (parity with portal branch).
    res = await app.inject({ method: 'POST', url: '/api/oauth/manual-token', headers: STAFF, payload: base });
    assert.equal(res.statusCode, 409, res.body);
    // With replace: true it goes through.
    res = await app.inject({
      method: 'POST', url: '/api/oauth/manual-token', headers: STAFF, payload: { ...base, replace: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const audit = await query(`SELECT id FROM audit_log WHERE action = 'pos_credential_stored'`);
    assert.ok(audit.rowCount >= 2);
  });

  it('F6-9: oauth/start is owner/manager only', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/oauth/start', headers: as('staff@a.test'), payload: {} });
    assert.equal(res.statusCode, 403);
    res = await app.inject({ method: 'POST', url: '/api/oauth/start', headers: as('owner@a.test'), payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(JSON.parse(res.body).url.includes('oauth'));
  });

  it('F6-1: admin login locks globally after 20 failures across IPs', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/admin/login',
        remoteAddress: `198.51.100.${i + 1}`,
        payload: { username: 'founder', password: 'wrong-password' },
      });
      assert.equal(res.statusCode, 401, `attempt ${i + 1}`);
    }
    // Even the CORRECT password is refused while the lockout stands.
    const locked = await app.inject({
      method: 'POST', url: '/api/admin/login',
      remoteAddress: '203.0.113.7',
      payload: { username: 'founder', password: ADMIN_PASSWORD },
    });
    assert.equal(locked.statusCode, 429, locked.body);
    const audit = await query(`SELECT id FROM audit_log WHERE action = 'admin_login_lockout'`);
    assert.equal(audit.rowCount, 1);
  });
});
