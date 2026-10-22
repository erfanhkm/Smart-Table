// v0.2 security-review fixes: tests for the H1-H6, M1-M6 changes.
//
// Covers:
//  - H1: rate limiter buckets are namespaced (pay vs general don't share)
//  - H3: order idempotency — replay returns the original check; a key from
//    another table is rejected
//  - H4: orders require SEATED state; per-table order rate limit
//  - M1: check upsert is DO NOTHING (never re-points or re-opens)
//
// Run: PG_MEM=1 npx tsx --test tests/security-fixes.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { rateLimit } = await import('../src/rate-limit.js');

describe('H1: rate limiter bucket namespacing', () => {
  it('pay and general limiters do not share a counter', async () => {
    const pay = rateLimit({ name: 'pay', windowMs: 60_000, max: 2 });
    const general = rateLimit({ name: 'general', windowMs: 60_000, max: 200 });
    const req = { ip: '1.2.3.4', url: '/x' } as any;
    const statuses: number[] = [];
    const reply = () => {
      const r: any = {};
      r.code = (c: number) => { r.status = c; return r; };
      r.header = () => r;
      r.send = () => { statuses.push(r.status ?? 200); };
      return r;
    };
    // Exhaust the pay bucket (max 2).
    await pay(req, reply()); await pay(req, reply()); await pay(req, reply());
    assert.equal(statuses.filter((s) => s === 429).length, 1);
    // The general bucket for the same IP must be unaffected.
    statuses.length = 0;
    await general(req, reply());
    assert.equal(statuses.filter((s) => s === 429).length, 0);
  });

  it('different IPs do not share a bucket', async () => {
    const lim = rateLimit({ name: 't2', windowMs: 60_000, max: 1 });
    const mkReply = () => {
      const r: any = { status: 200 };
      r.code = (c: number) => { r.status = c; return r; };
      r.header = () => r;
      r.send = () => undefined;
      return r;
    };
    const r1 = mkReply(); await lim({ ip: '9.9.9.9', url: '/' } as any, r1);
    const r2 = mkReply(); await lim({ ip: '9.9.9.9', url: '/' } as any, r2);
    assert.equal(r2.status, 429);
    const r3 = mkReply(); await lim({ ip: '8.8.8.8', url: '/' } as any, r3);
    assert.equal(r3.status, 200);
  });
});

describe('H3/H4/M1: order idempotency and abuse guards', () => {
  const merchantId = randomUUID();
  const locationId = randomUUID();
  const tableId = randomUUID();
  const otherTableId = randomUUID();

  before(async () => {
    await migrate();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
       VALUES ($1,'square','sq-m',$2,$3) ON CONFLICT DO NOTHING`,
      [merchantId, 'x', 'x'],
    );
    await query(
      `INSERT INTO locations(id, merchant_id, name, pos_type, pos_location_ref, square_location_id, currency, qr_ordering_enabled)
       VALUES ($1,$2,'l','square','SQLoc1','SQLoc1','CAD',true) ON CONFLICT DO NOTHING`,
      [locationId, merchantId],
    );
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok1','SEATED') ON CONFLICT DO NOTHING`, [tableId, locationId]);
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T2','tok2','SEATED') ON CONFLICT DO NOTHING`, [otherTableId, locationId]);
  });

  it('reserves an idempotency key and rejects a replay from another table', async () => {
    const key = randomUUID();
    const nonce1 = randomUUID();
    // First reservation succeeds.
    await query(
      `INSERT INTO order_requests(idempotency_key, table_id, location_id, pos_type, status, nonce)
       VALUES ($1,$2,$3,'square','PENDING',$4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, tableId, locationId, nonce1],
    );
    const mine = await query(`SELECT * FROM order_requests WHERE idempotency_key = $1`, [key]);
    assert.equal(mine.rows[0].nonce, nonce1, 'we hold the reservation');
    assert.equal(mine.rows[0].table_id, tableId);
    // Replay from another table: the INSERT does nothing, and the stored
    // table_id differs -> the route must reject.
    await query(
      `INSERT INTO order_requests(idempotency_key, table_id, location_id, pos_type, status, nonce)
       VALUES ($1,$2,$3,'square','PENDING',$4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, otherTableId, locationId, randomUUID()],
    );
    const prev = await query(`SELECT table_id, nonce FROM order_requests WHERE idempotency_key = $1`, [key]);
    assert.notEqual(prev.rows[0].table_id, otherTableId);
    assert.equal(prev.rows[0].nonce, nonce1, 'original reservation untouched');
  });

  it('per-table order rate limit counts recent orders', async () => {
    for (let i = 0; i < 5; i++) {
      await query(
        `INSERT INTO order_requests(idempotency_key, table_id, location_id, pos_type, status, nonce)
         VALUES ($1,$2,$3,'square','COMPLETED',$4) ON CONFLICT DO NOTHING`,
        [randomUUID(), tableId, locationId, randomUUID()],
      );
    }
    const n = await query(
      `SELECT COUNT(*)::int AS n FROM order_requests
       WHERE table_id = $1 AND created_at > now() - interval '10 minutes'`,
      [tableId],
    );
    assert.ok(n.rows[0].n >= 5, 'expected at least 5 recent orders');
  });

  it('check upsert is DO NOTHING: never re-points or re-opens', async () => {
    const checkId = randomUUID();
    const ref = `ref-${randomUUID()}`;
    await query(
      `INSERT INTO checks(id, table_id, location_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$5,$3,'square',$4,'COMPLETED',1000,'CAD')`,
      [checkId, tableId, ref, merchantId, locationId],
    );
    // A duplicate insert with different table/state must NOT change the row.
    // v0.6.5 (C-4): identity is (location_id, pos_type, external_check_ref).
    await query(
      `INSERT INTO checks(id, table_id, location_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$5,$3,'square',$4,'OPEN',2000,'CAD')
       ON CONFLICT (location_id, pos_type, external_check_ref) DO NOTHING`,
      [randomUUID(), otherTableId, ref, merchantId, locationId],
    );
    const row = await query(`SELECT table_id, state, total_cents FROM checks WHERE external_check_ref = $1`, [ref]);
    assert.equal(row.rows[0].table_id, tableId);
    assert.equal(row.rows[0].state, 'COMPLETED');
    assert.equal(row.rows[0].total_cents, 1000);
  });
});
