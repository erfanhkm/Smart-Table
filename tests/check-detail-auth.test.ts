// v0.4.2 check-detail auth tests (pg-mem + mocked Square fetch).
//
// GET /api/checks/:ref has two legitimate callers:
//  1. Guests, who must present the table's QR token (?table_token=...) —
//     the anti-enumeration review fix. No token -> 400, wrong token -> 404.
//  2. The restaurant portal (Live Orders / Check Detail), which presents a
//     staff or per-user portal bearer token. Portal users are scoped to
//     their own location: another location's check reads as 404.
// Before v0.4.2 only path 1 existed, so every open check in the portal
// rendered "Unavailable — retry".
//
// Run: PG_MEM=1 npx tsx --test tests/check-detail-auth.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { hashToken } = await import('../src/routes/portal.js');
const { buildApp } = await import('../src/index.js');

// ---- Square fetch mock: only order retrieval is exercised ------------------
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown) => {
    const url = String(input);
    if (/\/v2\/orders\/SQORDR1/.test(url)) {
      return new Response(JSON.stringify({
        order: {
          id: 'SQORDR1', location_id: 'SQLoc1', state: 'OPEN',
          total_money: { amount: 10000, currency: 'CAD' },
          line_items: [{ name: 'Item', quantity: '1', total_money: { amount: 10000, currency: 'CAD' } }],
          tenders: [],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ---- seed ------------------------------------------------------------------
const MERCHANT = 'm-cd';
const LOC = 'loc-cd';
const OTHER_LOC = 'loc-cd-other';
const TABLE = randomUUID();
const OWN_TOKEN = 'portal-token-own-location';
const OTHER_TOKEN = 'portal-token-other-location';

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Check House','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc2','SQLoc2','Other House','CAD')`, [OTHER_LOC, MERCHANT]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'square','sq-merchant',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok1','SEATED')`, [TABLE, LOC]);
  await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'square','SQORDR1','SQORDR1',$3,'OPEN',10000,'CAD')`, [randomUUID(), TABLE, MERCHANT]);
  const ownUser = randomUUID();
  const otherUser = randomUUID();
  await query(`INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'own@x.local','x','owner',$2)`, [ownUser, LOC]);
  await query(`INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'other@x.local','x','owner',$2)`, [otherUser, OTHER_LOC]);
  await query(`INSERT INTO portal_tokens(token_hash, user_id) VALUES ($1,$2)`, [hashToken(OWN_TOKEN), ownUser]);
  await query(`INSERT INTO portal_tokens(token_hash, user_id) VALUES ($1,$2)`, [hashToken(OTHER_TOKEN), otherUser]);
}

describe('v0.4.2 GET /api/checks/:ref auth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    installFetch();
    await seed();
    app = await buildApp();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('guest without table_token -> 400', async () => {
    const res = await get('/api/checks/SQORDR1');
    assert.equal(res.statusCode, 400);
  });

  it('guest with wrong table_token -> 404', async () => {
    const res = await get('/api/checks/SQORDR1?table_token=wrong');
    assert.equal(res.statusCode, 404);
  });

  it('guest with the table QR token -> 200 with the bill', async () => {
    const res = await get('/api/checks/SQORDR1?table_token=tok1');
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).total_cents, 10000);
  });

  it('staff API token -> 200', async () => {
    const res = await get('/api/checks/SQORDR1', { authorization: 'Bearer test-staff-token' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).total_cents, 10000);
  });

  it('portal token of the owning location -> 200', async () => {
    const res = await get('/api/checks/SQORDR1', { authorization: `Bearer ${OWN_TOKEN}` });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).total_cents, 10000);
  });

  it('portal token of another location -> 404 (no cross-location leak)', async () => {
    const res = await get('/api/checks/SQORDR1', { authorization: `Bearer ${OTHER_TOKEN}` });
    assert.equal(res.statusCode, 404);
  });

  it('bogus bearer token -> 400 (treated as a guest without a table token)', async () => {
    const res = await get('/api/checks/SQORDR1', { authorization: 'Bearer not-a-real-token' });
    assert.equal(res.statusCode, 400);
  });
});
