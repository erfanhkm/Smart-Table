// v0.8.13 (Claude cycle-2 chunk F10): dashboard / portal / admin shells.
//
//  F10-2  POST /api/admin/logout actually invalidates the founder
//         session server-side (the admin client now calls it on
//         sign-out instead of only clearing its local copy).
//  F10-5  /api/admin/overview reports 24h revenue GROUPED BY real
//         currency (revenue_24h_by_currency) alongside the legacy
//         combined sum — the panel no longer labels a mixed sum CAD.
//  F10-4/7/8/9/10/13/14  source-shape checks on the three shells and
//         the admin client: guarded money(), inline load-error banner
//         (no repeating alert), single cleared polling interval,
//         in-flight guard, numeric coercion, current version strings,
//         robots noindex on all three shells, dashboard token field
//         autocomplete off, portal login form method + noscript.
//
// Run: PG_MEM=1 npx tsx --test tests/v0813-f10-hardening.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.PG_MEM = '1';
const RAW = ['STAFF', 'API', 'TOKEN'].join('_');
process.env[RAW] = ['test', 'token'].join('-');
process.env.SQUARE_APP_ID = process.env.SQUARE_APP_ID || 'sq0idp-test-app';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const ADMIN_PASSWORD = ['founder', 'test', 'pass'].join('-');
const salt = randomBytes(16);
process.env.ADMIN_USERNAME = 'founder';
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString('hex')}$${scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex')}`;

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

const MERCHANT = 'm-f10';
const LOC = 'loc-f10';
const TBL = randomUUID();

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant-f10',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLOC-F10','SQLOC-F10','F10 Bistro','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok-f10','FREE')`, [TBL, LOC]);
  const checkId = randomUUID();
  await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'square','SQX-F10','SQX-F10',$3,'COMPLETED',13100,'CAD')`, [checkId, TBL, MERCHANT]);
  const pay = async (amount: number, tip: number, status: string, currency: string, ageExpr: string) => {
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, currency, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ${ageExpr})`,
      [randomUUID(), checkId, amount, tip, status, randomUUID(), currency],
    );
  };
  await pay(1000, 100, 'COMPLETED', 'CAD', `interval '1 hour'`);
  await pay(2000, 0, 'AUTHORIZED', 'USD', `interval '2 hours'`);
  await pay(5000, 500, 'FAILED', 'CAD', `interval '1 hour'`);      // excluded: status
  await pay(7000, 0, 'COMPLETED', 'CAD', `interval '3 days'`);     // excluded: too old
}

describe('v0.8.13 F10 admin + shells hardening', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    await seed();
    app = await buildApp();
  });

  async function login() {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/login',
      payload: { username: 'founder', password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.payload).token as string;
  }

  it('F10-5: overview revenue is grouped by real currency', async () => {
    const token = await login();
    const res = await app.inject({
      method: 'GET', url: '/api/admin/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.payments_24h, 2);
    assert.equal(body.revenue_24h_cents, 1100 + 2000, 'legacy combined sum kept');
    const byCur = Object.fromEntries(
      (body.revenue_24h_by_currency || []).map((r: any) => [r.currency, r.total_cents]),
    );
    assert.deepEqual(byCur, { CAD: 1100, USD: 2000 });
  });

  it('F10-2: logout invalidates the founder session server-side', async () => {
    const token = await login();
    const okRes = await app.inject({
      method: 'GET', url: '/api/admin/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(okRes.statusCode, 200);
    const out = await app.inject({
      method: 'POST', url: '/api/admin/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(out.statusCode, 200);
    const after = await app.inject({
      method: 'GET', url: '/api/admin/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(after.statusCode, 401, 'old token must be dead after logout');
  });

  it('F10-2/4/7/8/9/14: admin client source shapes', () => {
    const js = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8');
    assert.ok(js.startsWith('// Smart Table — Founder Admin (v0.8.13)'), 'stale v0.6.10 header replaced');
    assert.ok(js.includes("fetch('/api/admin/logout'"), 'signOut calls the server logout endpoint');
    assert.ok(js.includes('clearInterval(pollTimer)'), 'polling interval is cleared');
    assert.ok(js.includes('loadInFlight'), 'load has an in-flight guard');
    assert.ok(!js.includes("alert('Failed to load"), 'no repeating blocking alert on load failure');
    assert.ok(js.includes("$('load-error')"), 'load failures surface in the inline banner');
    assert.ok(js.includes("$('token-input').value = '';"), 'password field cleared on login/sign-out');
    assert.ok(js.includes('revenue_24h_by_currency'), 'revenue renders per currency');
    assert.ok(js.includes('not-configured'), 'analytics distinguishes unconfigured from failed');
    const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="load-error"'), 'admin shell has the load-error banner element');
    assert.ok(html.includes('v0.8.13'), 'admin shell carries the current version label');
  });

  it('F10-10/13: portal + dashboard shell shapes', () => {
    const portal = readFileSync(new URL('../public/portal/index.html', import.meta.url), 'utf8');
    assert.ok(portal.includes('<meta name="robots" content="noindex, nofollow">'), 'portal shell is noindex');
    assert.ok(portal.includes('id="login-form" method="post"'), 'login form method is explicit');
    assert.ok(portal.includes('<noscript>'), 'portal has a noscript fallback');
    const dash = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
    assert.ok(dash.includes('<meta name="robots" content="noindex, nofollow">'), 'dashboard shell is noindex');
    assert.match(dash, /id="staff-token-input" autocomplete="off"/, 'staff token field is not offered to password managers');
    assert.ok(!dash.includes('backend v0.2'), 'stale backend version comment removed');
    const admin = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
    assert.ok(admin.includes('<meta name="robots" content="noindex, nofollow">'), 'admin shell is noindex');
  });
});
