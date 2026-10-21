// Idea 2 — Group Pay claim tests (pg-mem + mocked Square fetch).
//
// Proves:
//  1. A guest claims an item with the table's QR token; the claim shows up in
//     GET /api/t/:token as check.item_claims.
//  2. A second device claiming the same item gets 409 (never double-paid).
//  3. Only the holding device can release a claim; afterwards another device
//     can take the item.
//  4. Guards: no table_token -> 400; wrong token -> 404.
//
// Run: PG_MEM=1 npx tsx --test tests/group-pay.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown) => {
    const url = String(input);
    if (/\/v2\/orders\/SQORDR1/.test(url)) {
      return new Response(JSON.stringify({
        order: {
          id: 'SQORDR1', location_id: 'SQLoc1', state: 'OPEN',
          total_money: { amount: 10000, currency: 'CAD' },
          line_items: [
            { name: 'Truffle Arancini', quantity: '1', total_money: { amount: 6000, currency: 'CAD' } },
            { name: 'Negroni', quantity: '2', total_money: { amount: 4000, currency: 'CAD' } },
          ],
          tenders: [],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

const MERCHANT = 'm-gp';
const LOC = 'loc-gp';
const TABLE = randomUUID();
const FP0 = 'Truffle Arancini|1|6000';
const FP1 = 'Negroni|2|4000';

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Group House','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'square','sq-merchant',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok1','SEATED')`, [TABLE, LOC]);
  await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'square','SQORDR1','SQORDR1',$3,'OPEN',10000,'CAD')`, [randomUUID(), TABLE, MERCHANT]);
}

describe('idea 2: group pay item claims', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    installFetch();
    await seed();
    app = await buildApp();
  });

  const claim = (device: string, idx: number, fp: string, token = 'tok1') =>
    app.inject({ method: 'POST', url: `/api/checks/SQORDR1/claims?table_token=${token}`, payload: { item_index: idx, fingerprint: fp, device_id: device } });
  const unclaim = (device: string, idx: number, token = 'tok1') =>
    app.inject({ method: 'DELETE', url: `/api/checks/SQORDR1/claims?table_token=${token}`, payload: { item_index: idx, device_id: device } });
  const billClaims = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/t/tok1' });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body).check.item_claims;
  };

  it('claim, conflict, release, re-claim', async () => {
    let res = await claim('device-A', 0, FP0);
    assert.equal(res.statusCode, 200);
    let claims = await billClaims();
    assert.equal(claims.length, 1);
    assert.equal(claims[0].item_index, 0);
    assert.equal(claims[0].device_id, 'device-A');

    res = await claim('device-B', 0, FP0);
    assert.equal(res.statusCode, 409, 'second device must not claim the same item');
    res = await claim('device-B', 1, FP1);
    assert.equal(res.statusCode, 200);
    claims = await billClaims();
    assert.equal(claims.length, 2);

    // Same device re-claiming its own item is a no-op success.
    res = await claim('device-A', 0, FP0);
    assert.equal(res.statusCode, 200);

    // Another device cannot release A's claim.
    res = await unclaim('device-B', 0);
    assert.equal(res.statusCode, 200);
    claims = await billClaims();
    assert.equal(claims.filter((c: { item_index: number }) => c.item_index === 0).length, 1);

    // The owner releases; B can now take it.
    res = await unclaim('device-A', 0);
    assert.equal(res.statusCode, 200);
    res = await claim('device-B', 0, FP0);
    assert.equal(res.statusCode, 200);
    claims = await billClaims();
    assert.equal(claims.filter((c: { item_index: number }) => c.item_index === 0)[0].device_id, 'device-B');
  });

  it('guards: missing token -> 400, wrong token -> 404', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/checks/SQORDR1/claims', payload: { item_index: 0, fingerprint: FP0, device_id: 'device-A' } });
    assert.equal(res.statusCode, 400);
    res = await claim('device-A', 0, FP0, 'wrong-token');
    assert.equal(res.statusCode, 404);
  });
});
