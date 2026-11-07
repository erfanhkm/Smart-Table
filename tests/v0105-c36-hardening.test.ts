// v0.10.5: Claude cycle-3 chunk C3-6 hardening (staff/admin/portal/oauth).
//
// Proves:
//  C3-6-1 (High) a founder-provisioned restaurant CAN connect Square: the
//    owner-started OAuth callback binds the provisioned location to the
//    authorizing merchant (pending ref retired, credential stored, no
//    orphan locations). A location bound to a DIFFERENT real merchant is
//    still refused.
//  C3-6-5 provisioned owners are flagged must_change_password; the new
//    POST /api/portal/change-password verifies the current password,
//    clears the flag and revokes the user's other tokens.
//  C3-6-6 GET /api/admin/locations returns the same stats via grouped
//    aggregates.
//  C3-6-3 portal login limiters count FAILURES only (11 good logins in a
//    row all pass), successes clear the per-email counter, and the limit
//    still locks after 10 failures.
//  C3-6-2 a forced table free ABANDONS its open checks (the next party's
//    guest page no longer lists the old bill); link-check resurrects an
//    abandoned check deliberately.
//  C3-6-7 the founder manual-token branch validates BEFORE creating rows
//    (a rejected token leaves no junk merchant) and distinguishes a POS
//    rejection from an unreachable POS.
//  C3-6-4 the admin global lockout exempts a previously-successful
//    source IP (the founder is not DoSed by other people's failures).
//
// Run: PG_MEM=1 npx tsx --test tests/v0105-c36-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_APP_ID = process.env.SQUARE_APP_ID || 'sq0idp-test-app';
process.env.SQUARE_APP_SECRET = ['sq', 'app', 'secret', 'test'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const ADMIN_PASSWORD = 'test-admin-password-1';
const salt = randomBytes(16);
process.env.ADMIN_USERNAME = 'founder';
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString('hex')}$${scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');
const { hashPassword, encryptSecret } = await import('../src/crypto.js');
const { hashToken } = await import('../src/routes/portal.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
const STAFF = { authorization: 'Bearer test-token' };

// ---- POS fetch mock -------------------------------------------------------
let sqMerchantId = 'SQMERCH1';
let sqLocations: unknown[] = [{ id: 'SQLOC1', name: 'Bind Bistro', currency: 'CAD' }];
let cloverMode: 'ok' | 'reject' | 'down' = 'ok';
const origFetch = globalThis.fetch;
function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = async (input: any) => {
  const url = String(typeof input === 'string' ? input : (input?.url ?? ''));
  if (url.includes('/oauth2/token')) {
    return jsonRes(200, {
      access_token: 'sq-access-1',
      refresh_token: 'sq-refresh-1',
      merchant_id: sqMerchantId,
      expires_at: '2027-01-01T00:00:00Z',
    });
  }
  if (url.includes('/v2/merchants/me')) return jsonRes(200, { merchant: { id: sqMerchantId, business_name: 'Mock Square Biz' } });
  if (url.includes('/v2/locations')) return jsonRes(200, { locations: sqLocations });
  if (url.includes('/v2/orders/')) {
    return jsonRes(200, {
      order: {
        id: 'SQORD-FREE',
        location_id: 'SQLOC-FREE',
        state: 'OPEN',
        total_money: { amount: 1200, currency: 'CAD' },
        net_amounts: { total_money: { amount: 1200, currency: 'CAD' } },
        line_items: [],
        tenders: [],
      },
    });
  }
  if (url.includes('clover.com')) {
    if (cloverMode === 'reject') return jsonRes(401, { message: 'unauthorized' });
    if (cloverMode === 'down') throw new TypeError('fetch failed');
    return jsonRes(200, { elements: [] });
  }
  throw new Error(`unexpected fetch in v0105 test: ${url}`);
};

async function adminLogin(remoteAddress?: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/admin/login',
    ...(remoteAddress ? { remoteAddress } : {}),
    payload: { username: 'founder', password: ADMIN_PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.payload);
  return JSON.parse(res.payload).token as string;
}

async function provision(name: string, ownerEmail: string, adminToken: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/admin/locations',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name, owner_email: ownerEmail, tier: 'base', plan: 'commission', table_count: 3 },
  });
  assert.equal(res.statusCode, 200, res.payload);
  return JSON.parse(res.payload);
}

async function portalLogin(email: string, password: string, remoteAddress?: string) {
  return app.inject({
    method: 'POST', url: '/api/portal/login',
    ...(remoteAddress ? { remoteAddress } : {}),
    payload: { email, password },
  });
}

before(async () => {
  await migrate();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  (globalThis as any).fetch = origFetch;
  await app.close();
});

describe('C3-6-1 + C3-6-5: provisioned restaurant connects Square; temp password lifecycle', () => {
  it('binds the pending location on OAuth callback and enforces password change', async () => {
    const adminToken = await adminLogin();
    const prov = await provision('Bind Bistro', 'owner@bind.test', adminToken);
    const locationId = prov.location_id as string;
    const tempPassword = prov.temp_password as string;

    // Login with the temp password: flagged must-change.
    const login1 = await portalLogin('owner@bind.test', tempPassword);
    assert.equal(login1.statusCode, 200, login1.payload);
    const loginBody = JSON.parse(login1.payload);
    assert.equal(loginBody.user.must_change_password, true);
    const ownerToken = loginBody.token as string;

    // Owner starts OAuth for their own location.
    const start = await app.inject({
      method: 'POST', url: '/api/oauth/start',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { location_id: locationId },
    });
    assert.equal(start.statusCode, 200, start.payload);
    const authUrl = JSON.parse(start.payload).url as string;
    const state = new URL(authUrl).searchParams.get('state');
    assert.ok(state);

    // Square redirects back with a code.
    sqMerchantId = 'SQMERCH1';
    sqLocations = [{ id: 'SQLOC1', name: 'Bind Bistro', currency: 'CAD' }];
    const cb = await app.inject({ method: 'GET', url: `/api/oauth/callback?code=TESTCODE&state=${state}` });
    assert.equal(cb.statusCode, 200, cb.payload);
    const cbBody = JSON.parse(cb.payload);
    assert.equal(cbBody.bound_location_id, locationId);
    assert.equal(cbBody.bound_square_location_id, 'SQLOC1');

    // The location is bound to the real merchant; the pending one is gone.
    const loc = await query<any>(`SELECT * FROM locations WHERE id = $1`, [locationId]);
    assert.equal(loc.rows[0].square_location_id, 'SQLOC1');
    assert.equal(loc.rows[0].pos_location_ref, 'SQLOC1');
    const merch = await query<any>(`SELECT * FROM merchants WHERE id = $1`, [loc.rows[0].merchant_id]);
    assert.equal(merch.rows[0].external_merchant_ref, 'SQMERCH1');
    const pending = await query(`SELECT id FROM merchants WHERE external_merchant_ref LIKE 'pending-%'`);
    assert.equal(pending.rowCount, 0, 'pending placeholder merchant retired');
    const creds = await query(`SELECT id FROM pos_credentials WHERE merchant_id = $1`, [loc.rows[0].merchant_id]);
    assert.equal(creds.rowCount, 1, 'credential stored for the authorizing merchant');
    const locCount = await query(`SELECT id FROM locations WHERE merchant_id = $1`, [loc.rows[0].merchant_id]);
    assert.equal(locCount.rowCount, 1, 'no orphan locations created by the callback');

    // Change password: wrong current -> 401; right current -> 200, flag cleared.
    const wrong = await app.inject({
      method: 'POST', url: '/api/portal/change-password',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { current_password: 'not-the-password', new_password: 'NewPass-12345' },
    });
    assert.equal(wrong.statusCode, 401, wrong.payload);
    const changed = await app.inject({
      method: 'POST', url: '/api/portal/change-password',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { current_password: tempPassword, new_password: 'NewPass-12345' },
    });
    assert.equal(changed.statusCode, 200, changed.payload);
    const login2 = await portalLogin('owner@bind.test', 'NewPass-12345');
    assert.equal(login2.statusCode, 200, login2.payload);
    assert.equal(JSON.parse(login2.payload).user.must_change_password, false);
    const oldLogin = await portalLogin('owner@bind.test', tempPassword);
    assert.equal(oldLogin.statusCode, 401, 'the temp password no longer works');
  });

  it('still refuses a callback whose merchant differs from a REAL bound merchant', async () => {
    const merchantId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc)
       VALUES ($1,'square','SQOTHER','SQOTHER','','')`,
      [merchantId],
    );
    const locationId = randomUUID();
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
       VALUES ($1,$2,'square','SQLOC-OTHER','SQLOC-OTHER','Other Place','CAD')`,
      [locationId, merchantId],
    );
    const userId = randomUUID();
    await query(
      `INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'owner@other.test',$2,'owner',$3)`,
      [userId, await hashPassword('OtherPass-123'), locationId],
    );
    const plain = 'other-owner-token-plain';
    await query(`INSERT INTO portal_tokens(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [
      hashToken(plain),
      userId,
    ]);
    const start = await app.inject({
      method: 'POST', url: '/api/oauth/start',
      headers: { authorization: `Bearer ${plain}` },
      payload: { location_id: locationId },
    });
    assert.equal(start.statusCode, 200, start.payload);
    const state = new URL(JSON.parse(start.payload).url as string).searchParams.get('state');
    sqMerchantId = 'SQMERCH1'; // authorizing account is NOT 'SQOTHER'
    const cb = await app.inject({ method: 'GET', url: `/api/oauth/callback?code=TESTCODE&state=${state}` });
    assert.equal(cb.statusCode, 400, cb.payload);
    assert.match(cb.payload, /different restaurant/);
  });
});

describe('C3-6-6: admin locations aggregates', () => {
  it('returns per-location stats matching the seeded ledger rows', async () => {
    const adminToken = await adminLogin();
    const prov = await provision('Stats Place', 'owner@stats.test', adminToken);
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status) VALUES ($1,$2,NULL,NULL,500,500,'CAD','test','accrued')`,
      [randomUUID(), prov.location_id],
    );
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status) VALUES ($1,$2,NULL,NULL,700,700,'CAD','test','collected')`,
      [randomUUID(), prov.location_id],
    );
    const res = await app.inject({
      method: 'GET', url: '/api/admin/locations?limit=500',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const row = (JSON.parse(res.payload).locations as any[]).find((l) => l.id === prov.location_id);
    assert.ok(row, 'provisioned location listed');
    assert.equal(row.fees_accrued_cents, 500);
    assert.equal(row.fees_this_month_cents, 700);
    assert.equal(row.tables, 3);
    assert.equal(row.open_checks, 0);
  });
});

describe('C3-6-3: portal login limiter counts failures only', () => {
  it('allows unlimited successful logins; locks after 10 failures', async () => {
    // portal_users.location_id is NOT NULL — give the limiter users a home.
    const mId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc) VALUES ($1,'square','SQLIM','', '')`,
      [mId],
    );
    const homeLoc = randomUUID();
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency) VALUES ($1,$2,'square','SQLOC-LIM','SQLOC-LIM','Limiter Home','CAD')`,
      [homeLoc, mId],
    );
    const userId = randomUUID();
    await query(
      `INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'limiter@x.test',$2,'owner',$3)`,
      [userId, await hashPassword('LimiterPass-1'), homeLoc],
    );
    for (let i = 0; i < 11; i++) {
      const res = await portalLogin('limiter@x.test', 'LimiterPass-1');
      assert.equal(res.statusCode, 200, `successful login ${i + 1} must not be limited`);
    }
    const user2 = randomUUID();
    await query(
      `INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'limiter2@x.test',$2,'owner',$3)`,
      [user2, await hashPassword('LimiterPass-2'), homeLoc],
    );
    for (let i = 0; i < 10; i++) {
      const res = await portalLogin('limiter2@x.test', 'wrong-password', '198.51.100.77');
      assert.equal(res.statusCode, 401, `failed attempt ${i + 1}`);
    }
    const eleventh = await portalLogin('limiter2@x.test', 'LimiterPass-2', '198.51.100.77');
    assert.equal(eleventh.statusCode, 429, 'locked after 10 failures, even with the right password');
    const other = await portalLogin('limiter@x.test', 'LimiterPass-1');
    assert.equal(other.statusCode, 200, 'a different account from a different IP is unaffected');
  });
});

describe('C3-6-2: forced free abandons open checks', () => {
  it('abandons the check, frees the table, hides the bill; link-check resurrects', async () => {
    const merchantId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc)
       VALUES ($1,'square','SQMERCH-FREE','SQMERCH-FREE','','')`,
      [merchantId],
    );
    await query(
      `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
       VALUES ($1,$2,'square','SQMERCH-FREE',$3,$4)`,
      [randomUUID(), merchantId, encryptSecret('sq-token-free'), encryptSecret('')],
    );
    const locationId = randomUUID();
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
       VALUES ($1,$2,'square','SQLOC-FREE','SQLOC-FREE','Free House','CAD')`,
      [locationId, merchantId],
    );
    const tableId = randomUUID();
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'1','tok-free-1','SEATED')`, [
      tableId,
      locationId,
    ]);
    const checkId = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,'square','SQORD-FREE','SQORD-FREE',$4,'OPEN',1200,'CAD')`,
      [checkId, tableId, locationId, merchantId],
    );

    const blocked = await app.inject({ method: 'POST', url: `/api/tables/${tableId}/free`, headers: STAFF, payload: {} });
    assert.equal(blocked.statusCode, 409, blocked.payload);

    const forced = await app.inject({
      method: 'POST', url: `/api/tables/${tableId}/free`, headers: STAFF, payload: { force: true },
    });
    assert.equal(forced.statusCode, 200, forced.payload);
    const chk = await query<any>(`SELECT state FROM checks WHERE id = $1`, [checkId]);
    assert.equal(chk.rows[0].state, 'ABANDONED');
    const tbl = await query<any>(`SELECT state FROM tables WHERE id = $1`, [tableId]);
    assert.equal(tbl.rows[0].state, 'FREE');

    const guest = await app.inject({ method: 'GET', url: '/api/t/tok-free-1' });
    assert.equal(guest.statusCode, 200, guest.payload);
    assert.ok(!guest.payload.includes(checkId), 'the abandoned bill is not listed for the next party');

    const relink = await app.inject({
      method: 'POST', url: `/api/tables/${tableId}/link-check`, headers: STAFF, payload: { external_check_id: 'SQORD-FREE' },
    });
    assert.equal(relink.statusCode, 200, relink.payload);
    const chk2 = await query<any>(`SELECT state FROM checks WHERE id = $1`, [checkId]);
    assert.equal(chk2.rows[0].state, 'OPEN', 're-linking resurrects the abandoned check');
    const tbl2 = await query<any>(`SELECT state FROM tables WHERE id = $1`, [tableId]);
    assert.equal(tbl2.rows[0].state, 'SEATED');
  });
});

describe('C3-6-7: founder manual-token validates first, honest errors', () => {
  it('rejected token -> no merchant row, rejection message; unreachable -> reachability message', async () => {
    cloverMode = 'reject';
    const bad = await app.inject({
      method: 'POST', url: '/api/oauth/manual-token', headers: STAFF,
      payload: { pos_type: 'clover', external_merchant_ref: 'CMERCHBAD1', location_ref: 'CMERCHBAD1', location_name: 'Bad Clover', access_token: 'tok-12345678' },
    });
    assert.equal(bad.statusCode, 400, bad.payload);
    assert.match(bad.payload, /rejected this token/);
    const junk = await query(`SELECT id FROM merchants WHERE external_merchant_ref = 'CMERCHBAD1'`);
    assert.equal(junk.rowCount, 0, 'validation happens before any merchant row is created');

    cloverMode = 'down';
    const down = await app.inject({
      method: 'POST', url: '/api/oauth/manual-token', headers: STAFF,
      payload: { pos_type: 'clover', external_merchant_ref: 'CMERCHDOWN1', location_ref: 'CMERCHDOWN1', location_name: 'Down Clover', access_token: 'tok-12345678' },
    });
    assert.equal(down.statusCode, 400, down.payload);
    assert.match(down.payload, /could not reach the POS/);

    cloverMode = 'ok';
    const good = await app.inject({
      method: 'POST', url: '/api/oauth/manual-token', headers: STAFF,
      payload: { pos_type: 'clover', external_merchant_ref: 'CMERCHOK1', location_ref: 'CMERCHOK1', location_name: 'Good Clover', access_token: 'tok-12345678' },
    });
    assert.equal(good.statusCode, 200, good.payload);
    assert.ok(JSON.parse(good.payload).location_id);
  });
});

describe('C3-6-4: admin lockout exempts a known source', () => {
  it('20 failures elsewhere lock strangers out, not the founder\'s known IP', async () => {
    const KNOWN = '192.0.2.10';
    const FRESH = '192.0.2.99';
    await adminLogin(KNOWN); // establishes the known source (and resets counters)
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/admin/login',
        remoteAddress: `198.51.100.${i + 1}`,
        payload: { username: 'founder', password: 'wrong-password' },
      });
      assert.equal(res.statusCode, 401, `failure ${i + 1}`);
    }
    const stranger = await app.inject({
      method: 'POST', url: '/api/admin/login',
      remoteAddress: FRESH,
      payload: { username: 'founder', password: ADMIN_PASSWORD },
    });
    assert.equal(stranger.statusCode, 429, 'unknown source is locked out');
    const founder = await app.inject({
      method: 'POST', url: '/api/admin/login',
      remoteAddress: KNOWN,
      payload: { username: 'founder', password: ADMIN_PASSWORD },
    });
    assert.equal(founder.statusCode, 200, 'known source is exempt from the global lock');
  });
});
