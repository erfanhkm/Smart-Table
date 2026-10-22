// v0.6.5 regression tests — Claude review cycle 1, section 2, batch 1:
// tenant scoping + credential safety.
//
// Proves:
//  C-1  record-external-payment: a portal user cannot record a cash payment
//       on another restaurant's check (404); staff role is refused (403).
//  C-2  staff/tables/dashboard routes pin portal users to their location;
//       table lists no longer carry qr_token.
//  C-3  guest pay + card-config require the table's QR token; paying by a
//       bare POS ref is dead.
//  C-4  link-check never re-points a check to another table (409); the same
//       external ref can exist at two locations (location-keyed identity).
//  C-5  onboarding "POS connected" needs a credential row or the explicit
//       demo flag — never just an app-level env token.
//  C-10 role gates: refunds / billing writes / table free need owner|manager.
//  C-11 google_review_url validation parses the URL (no google.attacker.com).
//  E-1  manual-token: portal users bind tokens only to their OWN location's
//       merchant, owner-only, replace needs replace:true, token validated.
//
// Run: PG_MEM=1 npx tsx --test tests/v065-tenant-scoping.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
process.env.SQUARE_APP_ID = process.env.SQUARE_APP_ID || 'sq0idp-test-app';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const { hashToken } = await import('../src/routes/portal.js');
const { isValidGoogleReviewUrl } = await import('../src/routes/staff.js');

const STAFF = { authorization: 'Bearer test-staff-token' };

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
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('clover.com')) {
      const auth = init?.headers?.Authorization ?? '';
      if (auth === 'Bearer good-token') return json({ elements: [] });
      return json({ message: 'unauthorized' }, 401);
    }
    if (/\/v2\/orders\/SHARED1/.test(url) && method === 'GET') return json(orderJson('SHARED1', 'SQLocA'));
    if (/\/v2\/orders\/ORD_A2/.test(url) && method === 'GET') return json(orderJson('ORD_A2', 'SQLocA', 5000));
    if (/\/v2\/orders\/[^/]+\/pay/.test(url) && method === 'POST') {
      return json({ order: { id: 'SHARED1', state: 'OPEN' } });
    }
    if (/\/v2\/payments/.test(url) && method === 'POST') {
      return json({
        payment: {
          id: 'pay-' + randomUUID().slice(0, 8), status: 'APPROVED', order_id: 'SHARED1',
          amount_money: { amount: 10000, currency: 'CAD' }, total_money: { amount: 10000, currency: 'CAD' },
        },
      });
    }
    if (/\/v2\/orders\/[^/]+/.test(url) && method === 'GET') return json(orderJson('SHARED1', 'SQLocA'));
    return json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

const M_A = 'm-a'; const M_B = 'm-b'; const M_C = 'm-c';
const LOC_A = 'loc-a'; const LOC_B = 'loc-b'; const LOC_C = 'loc-c';
const LOC_D = 'loc-d'; const LOC_E = 'loc-e';
const TBL_A = randomUUID(); const TBL_A2 = randomUUID(); const TBL_B = randomUUID();
const CHECK_A = randomUUID();

const TOKENS: Record<string, string> = {
  'owner@a.test': 'tok-owner-a',
  'owner@b.test': 'tok-owner-b',
  'staff@a.test': 'tok-staff-a',
  'owner@c.test': 'tok-owner-c',
  'staff@c.test': 'tok-staff-c',
};

async function seedUser(email: string, locationId: string, role: string) {
  const id = randomUUID();
  await query(
    `INSERT INTO portal_users(id, email, password_hash, location_id, role) VALUES ($1,$2,'x',$3,$4)`,
    [id, email, locationId, role],
  );
  await query(`INSERT INTO portal_tokens(token_hash, user_id) VALUES ($1,$2)`, [hashToken(TOKENS[email]), id]);
}

async function seed() {
  await migrate();
  for (const [m, ref] of [[M_A, 'sq-a'], [M_B, 'sq-b']] as const) {
    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ($1,'square',$2,'','')`, [m, ref]);
    await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ($1,$2,'square',$3,$4,'')`,
      [randomUUID(), m, ref, encryptSecret('SQ-TOKEN')]);
  }
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ($1,'clover','CLOVERM1','','')`, [M_C]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency) VALUES ($1,$2,'square','SQLocA','SQLocA','Alpha','CAD')`, [LOC_A, M_A]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency) VALUES ($1,$2,'square','SQLocB','SQLocB','Beta','CAD')`, [LOC_B, M_B]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency) VALUES ($1,$2,'clover','CLOVERM1','CLOVERM1','Clover House','CAD')`, [LOC_C, M_C]);
  // Demo-flag pair for C-5: D is demo (no creds), E is not (no creds).
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ('m-d','square','sq-d','','')`);
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ('m-e','square','sq-e','','')`);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo) VALUES ($1,'m-d','square','SQLocD','SQLocD','Demo Place','CAD',true)`, [LOC_D]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo) VALUES ($1,'m-e','square','SQLocE','SQLocE','Plain Place','CAD',false)`, [LOC_E]);

  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'A1','tokA','SEATED')`, [TBL_A, LOC_A]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'A2','tokA2','FREE')`, [TBL_A2, LOC_A]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'B1','tokB','SEATED')`, [TBL_B, LOC_B]);
  await query(`INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,$3,'SHARED1','SHARED1','square',$4,'OPEN',10000,'CAD')`, [CHECK_A, TBL_A, LOC_A, M_A]);

  await seedUser('owner@a.test', LOC_A, 'owner');
  await seedUser('owner@b.test', LOC_B, 'owner');
  await seedUser('staff@a.test', LOC_A, 'staff');
  await seedUser('owner@c.test', LOC_C, 'owner');
  await seedUser('staff@c.test', LOC_C, 'staff');
}

describe('v0.6.5 tenant scoping + credential safety', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const as = (email: string) => ({ authorization: `Bearer ${TOKENS[email]}` });

  before(async () => {
    installFetch();
    await seed();
    app = await buildApp();
  });

  it('C-2: portal users are pinned to their location on list/dashboard routes', async () => {
    for (const url of [
      `/api/tables?location_id=${LOC_A}`,
      `/api/dashboard/overview?location_id=${LOC_A}`,
      `/api/dashboard/metrics?location_id=${LOC_A}`,
      `/api/pos-open-checks?location_id=${LOC_A}`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: as('owner@b.test') });
      assert.equal(res.statusCode, 404, `${url} must 404 for another tenant`);
    }
    // Own location works, and the table list carries no qr_token (C-2).
    const own = await app.inject({ method: 'GET', url: `/api/tables?location_id=${LOC_A}`, headers: as('owner@a.test') });
    assert.equal(own.statusCode, 200);
    const tables = JSON.parse(own.body).tables;
    assert.ok(tables.length >= 2);
    assert.equal(tables[0].qr_token, undefined);
    // Row-scoped routes: B cannot read A's QR or free A's table.
    const qr = await app.inject({ method: 'GET', url: `/api/tables/${TBL_A}/qr`, headers: as('owner@b.test') });
    assert.equal(qr.statusCode, 404);
    const free = await app.inject({ method: 'POST', url: `/api/tables/${TBL_A}/free`, headers: as('owner@b.test') });
    assert.equal(free.statusCode, 404);
    // Creating a table in another tenant's location is refused.
    const create = await app.inject({
      method: 'POST', url: '/api/tables', headers: as('owner@b.test'),
      payload: { location_id: LOC_A, name: 'evil' },
    });
    assert.equal(create.statusCode, 404);
  });

  it('C-1/C-10: record-external-payment is scoped + role-gated + audited', async () => {
    const body = {
      mode: 'full', tip_cents: 0,
      idempotency_key: '11111111-1111-4111-8111-111111111111',
    };
    // Another tenant: the check does not exist for them.
    let res = await app.inject({
      method: 'POST', url: '/api/checks/SHARED1/record-external-payment',
      headers: as('owner@b.test'), payload: body,
    });
    assert.equal(res.statusCode, 404);
    // Right location, wrong role.
    res = await app.inject({
      method: 'POST', url: '/api/checks/SHARED1/record-external-payment',
      headers: as('staff@a.test'), payload: { ...body, idempotency_key: '22222222-2222-4222-8222-222222222222' },
    });
    assert.equal(res.statusCode, 403);
    // The owner records the cash payment: works, and recorded_by is set.
    res = await app.inject({
      method: 'POST', url: '/api/checks/SHARED1/record-external-payment',
      headers: as('owner@a.test'), payload: { ...body, idempotency_key: '33333333-3333-4333-8333-333333333333' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const paid = await query<{ recorded_by: string | null }>(
      `SELECT recorded_by FROM payments WHERE idempotency_key = '33333333-3333-4333-8333-333333333333'`,
    );
    assert.ok(paid.rows[0]?.recorded_by, 'actor must be recorded (B-11)');
  });

  it('C-3: guest pay + card-config require the table token', async () => {
    const payBody = {
      mode: 'full', tip_cents: 0, card_nonce: 'cnon:card-nonce-ok',
      idempotency_key: '44444444-4444-4444-8444-444444444444',
    };
    let res = await app.inject({ method: 'POST', url: '/api/checks/SHARED1/pay', payload: payBody });
    assert.equal(res.statusCode, 400, 'no table_token -> 400');
    res = await app.inject({ method: 'POST', url: '/api/checks/SHARED1/pay?table_token=wrong', payload: payBody });
    assert.equal(res.statusCode, 404, 'wrong table_token -> 404');
    res = await app.inject({ method: 'GET', url: '/api/checks/SHARED1/card-config' });
    assert.equal(res.statusCode, 400, 'card-config without token -> 400');
    res = await app.inject({ method: 'GET', url: '/api/checks/SHARED1/card-config?table_token=tokA' });
    assert.equal(res.statusCode, 200, 'card-config with the table token works');
  });

  it('C-4: link-check cannot re-point a check; refs are unique per location', async () => {
    // SHARED1 is linked to TBL_A. Linking it to A2 (same location) -> 409.
    let res = await app.inject({
      method: 'POST', url: `/api/tables/${TBL_A2}/link-check`, headers: STAFF,
      payload: { external_check_id: 'SHARED1' },
    });
    assert.equal(res.statusCode, 409, res.body);
    const still = await query(`SELECT table_id FROM checks WHERE id = $1`, [CHECK_A]);
    assert.equal(still.rows[0].table_id, TBL_A, 'check must stay on its original table');
    // A fresh order links fine and lands with location_id set.
    res = await app.inject({
      method: 'POST', url: `/api/tables/${TBL_A2}/link-check`, headers: STAFF,
      payload: { external_check_id: 'ORD_A2' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const linked = await query<{ location_id: string }>(
      `SELECT location_id FROM checks WHERE external_check_ref = 'ORD_A2'`,
    );
    assert.equal(linked.rows[0].location_id, LOC_A);
    // The same external ref at ANOTHER location is a different check now.
    await query(
      `INSERT INTO checks(id, table_id, location_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'SHARED1','square',$4,'OPEN',100,'CAD')`,
      [randomUUID(), TBL_B, LOC_B, M_B],
    );
    const both = await query(`SELECT COUNT(*)::int AS n FROM checks WHERE external_check_ref = 'SHARED1'`);
    assert.equal(both.rows[0].n, 2);
  });

  it('C-5: onboarding connected = credential row or explicit demo flag', async () => {
    const stateFor = async (loc: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/portal/onboarding?location_id=${loc}`, headers: STAFF });
      assert.equal(res.statusCode, 200, res.body);
      return JSON.parse(res.body).steps.pos_connected.done;
    };
    assert.equal(await stateFor(LOC_D), true, 'demo-flagged location counts as connected');
    assert.equal(await stateFor(LOC_E), false, 'no creds + no demo flag = not connected (env token must not count)');
    assert.equal(await stateFor(LOC_A), true, 'credential row = connected');
  });

  it('C-10: refunds and billing writes require owner/manager', async () => {
    const refund = await app.inject({
      method: 'POST', url: `/api/portal/payments/${randomUUID()}/refund`,
      headers: as('staff@a.test'), payload: { amount_cents: 100, idempotency_key: '55555555-5555-4555-8555-555555555555' },
    });
    assert.equal(refund.statusCode, 403);
    const card = await app.inject({
      method: 'POST', url: '/api/portal/billing/card',
      headers: as('staff@a.test'), payload: { source_id: 'cnon:card-nonce-ok' },
    });
    assert.equal(card.statusCode, 403);
    const free = await app.inject({
      method: 'POST', url: `/api/tables/${TBL_A}/free`, headers: as('staff@a.test'),
    });
    assert.equal(free.statusCode, 403);
  });

  it('E-1: manual-token binds only to the caller\'s own merchant, owner-only, replace-gated, validated', async () => {
    const url = '/api/oauth/manual-token';
    // Staff role at the location: refused (owner only).
    let res = await app.inject({
      method: 'POST', url, headers: as('staff@c.test'),
      payload: { pos_type: 'clover', access_token: 'good-token' },
    });
    assert.equal(res.statusCode, 403);
    // Owner, but pointing at someone else's merchant ref: refused before any POS call.
    res = await app.inject({
      method: 'POST', url, headers: as('owner@c.test'),
      payload: { pos_type: 'clover', access_token: 'good-token', external_merchant_ref: 'SOMEONE-ELSE' },
    });
    assert.equal(res.statusCode, 400);
    // Owner + own refs + a token the POS rejects: refused, nothing stored.
    res = await app.inject({
      method: 'POST', url, headers: as('owner@c.test'),
      payload: { pos_type: 'clover', access_token: 'bad-token' },
    });
    assert.equal(res.statusCode, 400);
    let cred = await query(`SELECT 1 FROM pos_credentials WHERE merchant_id = $1 AND pos_type = 'clover'`, [M_C]);
    assert.equal(cred.rowCount, 0);
    // Owner + own refs + a valid token: stored against THEIR merchant.
    res = await app.inject({
      method: 'POST', url, headers: as('owner@c.test'),
      payload: { pos_type: 'clover', access_token: 'good-token' },
    });
    assert.equal(res.statusCode, 200, res.body);
    cred = await query(`SELECT 1 FROM pos_credentials WHERE merchant_id = $1 AND pos_type = 'clover'`, [M_C]);
    assert.equal(cred.rowCount, 1);
    // Overwriting requires explicit replace: true.
    res = await app.inject({
      method: 'POST', url, headers: as('owner@c.test'),
      payload: { pos_type: 'clover', access_token: 'good-token' },
    });
    assert.equal(res.statusCode, 409);
    res = await app.inject({
      method: 'POST', url, headers: as('owner@c.test'),
      payload: { pos_type: 'clover', access_token: 'good-token', replace: true },
    });
    assert.equal(res.statusCode, 200);
  });

  it('C-11: google_review_url is parsed, not regex-matched', () => {
    assert.equal(isValidGoogleReviewUrl('https://google.attacker.com/maps'), false);
    assert.equal(isValidGoogleReviewUrl('https://www.google.com/maps/place/Some+Place'), true);
    assert.equal(isValidGoogleReviewUrl('https://google.ca/maps'), true);
    assert.equal(isValidGoogleReviewUrl('https://g.page/r/Cxyz'), true);
    assert.equal(isValidGoogleReviewUrl('http://google.com/maps'), false);
    assert.equal(isValidGoogleReviewUrl('https://maps.google.com/maps'), true);
    assert.equal(isValidGoogleReviewUrl('https://google.attacker.com/maps'), false);
    assert.equal(isValidGoogleReviewUrl('not a url'), false);
  });
});
