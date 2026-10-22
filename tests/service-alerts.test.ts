// Idea 1 — Service Recovery alert tests (pg-mem, no POS calls involved).
//
// Proves:
//  1. A 1-3 star guest rating raises an open low_rating alert, listed by the
//     staff API with the table name, rating and comment.
//  2. A 4-5 star rating raises nothing.
//  3. Dedupe: a second low rating while an alert is open adds no duplicate.
//  4. Resolve: another location's portal user gets 404; staff token resolves;
//     the open list empties.
//  5. Waiter spam: 2 calls = no alert; the 3rd call within 10 minutes raises
//     a waiter_repeat alert.
//
// Run: PG_MEM=1 npx tsx --test tests/service-alerts.test.ts
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

const MERCHANT = 'm-sa';
const LOC = 'loc-sa';
const OTHER_LOC = 'loc-sa-other';
const TABLE = randomUUID();
const OTHER_TOKEN = 'portal-token-other-sa';

async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Alert House','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc2','SQLoc2','Other House','CAD')`, [OTHER_LOC, MERCHANT]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok1','SEATED')`, [TABLE, LOC]);
  const otherUser = randomUUID();
  await query(`INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'other@x.local','x','owner',$2)`, [otherUser, OTHER_LOC]);
  await query(`INSERT INTO portal_tokens(token_hash, user_id) VALUES ($1,$2)`, [hashToken(OTHER_TOKEN), otherUser]);
}

describe('idea 1: service recovery alerts', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const staff = { authorization: 'Bearer test-staff-token' };
  before(async () => {
    await seed();
    app = await buildApp();
  });

  const openAlerts = async () => {
    const res = await app.inject({ method: 'GET', url: `/api/service-alerts?location_id=${LOC}`, headers: staff });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body).alerts;
  };

  it('low rating raises an alert; high rating does not; dedupe holds', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/t/tok1/feedback', payload: { rating: 5 } });
    assert.equal(res.statusCode, 200);
    assert.equal((await openAlerts()).length, 0);

    res = await app.inject({ method: 'POST', url: '/api/t/tok1/feedback', payload: { rating: 2, comment: 'Slow service' } });
    assert.equal(res.statusCode, 200);
    let alerts = await openAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'low_rating');
    assert.equal(alerts[0].rating, 2);
    assert.equal(alerts[0].comment, 'Slow service');
    assert.equal(alerts[0].table_name, 'T1');

    res = await app.inject({ method: 'POST', url: '/api/t/tok1/feedback', payload: { rating: 1 } });
    assert.equal(res.statusCode, 200);
    alerts = await openAlerts();
    assert.equal(alerts.length, 1, 'second low rating must not duplicate the open alert');
  });

  it('resolve is location-scoped and empties the open list', async () => {
    const alerts = await openAlerts();
    const id = alerts[0].id;
    let res = await app.inject({ method: 'POST', url: `/api/service-alerts/${id}/resolve`, headers: { authorization: `Bearer ${OTHER_TOKEN}` } });
    assert.equal(res.statusCode, 404);
    res = await app.inject({ method: 'POST', url: `/api/service-alerts/${id}/resolve`, headers: staff });
    assert.equal(res.statusCode, 200);
    assert.equal((await openAlerts()).length, 0);
  });

  it('third waiter call within 10 minutes raises a waiter_repeat alert', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: `/api/t/tok1/call-waiter` });
      assert.equal(res.statusCode, 200);
    }
    assert.equal((await openAlerts()).length, 0);
    const res = await app.inject({ method: 'POST', url: `/api/t/tok1/call-waiter` });
    assert.equal(res.statusCode, 200);
    const alerts = await openAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'waiter_repeat');
    assert.equal(alerts[0].table_name, 'T1');
  });
});
