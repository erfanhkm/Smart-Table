// v0.8.14 (F11) device-API hardening tests.
//
// Proves:
//  1. Claim failures are indistinguishable: unknown / used / expired all
//     return the same generic 400 (F11-1), and codes are stored as keyed
//     HMAC hashes — with the legacy SHA-256 fallback still able to claim
//     a pre-change row (F11-1 storage migration path).
//  2. Claim consumption is atomic: two concurrent claims of one code
//     yield exactly one device (F11-2); minting purges long-expired code
//     rows (F11 Low).
//  3. State carries the CURRENT table_token (F11-7), last_seen writes are
//     throttled (F11-6), heartbeat rssi is clamped (F11 Low).
//  4. Print jobs: control characters stripped at creation (F11-3),
//     idempotency-key replay, server-side expiry, mark-sent covers only
//     the returned rows, the per-device queue cap, ack cannot rewrite a
//     terminal state, and revoking a device cancels its queue (F11-3/4).
//  5. Pairing + revocation write audit rows (F11-5 cheap part).
//  6. The claim endpoint has its own hard attempt budget (F11-1) — this
//     describe runs LAST and counts every claim made above it.
//
// Run: PG_MEM=1 npx tsx --test tests/v0814-f11-hardening.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'test-square-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');
const { hashToken } = await import('../src/routes/portal.js');
const { hashClaimCode } = await import('../src/routes/device.js');

const STAFF = { authorization: 'Bearer test-token' };
const locId = randomUUID();
const table1Id = randomUUID();
const table2Id = randomUUID();
let app: Awaited<ReturnType<typeof buildApp>>;
let deviceBToken = ''; // table2's device (print-job tests)
let deviceBId = '';
let table1Token = ''; // table1 race winner (state tests)

const claim = (code: string) => app.inject({ method: 'POST', url: '/api/device/claim', payload: { code } });

async function mint(table: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/portal/devices/claim-code',
    headers: STAFF,
    payload: { table_id: table },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { code: string }).code;
}

async function staffPrint(table: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/tables/${table}/print-job`, headers: STAFF, payload });
}

before(async () => {
  await migrate();
  app = await buildApp({ logger: false });
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ($1,'m-f11','square','SQLOCF11','SQLOCF11','F11 Test Bistro','CAD')`,
    [locId],
  );
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'Table 1','qrtok1','SEATED')`, [
    table1Id,
    locId,
  ]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'Table 2','qrtok2','FREE')`, [
    table2Id,
    locId,
  ]);
});

describe('claim errors are generic (F11-1)', () => {
  let genericBody = '';

  it('unknown code -> generic 400', async () => {
    const res = await claim('99999999'); // claim #1
    assert.equal(res.statusCode, 400);
    genericBody = res.body;
    assert.match(genericBody, /invalid claim code/);
  });

  it('used code -> the identical generic 400', async () => {
    const code = await mint(table1Id);
    const ok = await claim(code); // claim #2
    assert.equal(ok.statusCode, 200, ok.body);
    const again = await claim(code); // claim #3
    assert.equal(again.statusCode, 400);
    assert.equal(again.body, genericBody);
  });

  it('expired code -> the identical generic 400', async () => {
    const code = '11111111';
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at)
       VALUES ($1,$2,$3, now() - interval '1 minute')`,
      [hashClaimCode(code), locId, table2Id],
    );
    const res = await claim(code); // claim #4
    assert.equal(res.statusCode, 400);
    assert.equal(res.body, genericBody);
  });
});

describe('claim-code storage is keyed HMAC (F11-1)', () => {
  it('minted codes are stored as HMAC, not plain SHA-256', async () => {
    const code = await mint(table2Id);
    const r = await query<{ code_hash: string }>(
      `SELECT code_hash FROM device_claim_codes WHERE table_id = $1 AND used_at IS NULL`,
      [table2Id],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].code_hash, hashClaimCode(code));
    assert.notEqual(r.rows[0].code_hash, hashToken(code));
  });

  it('a legacy SHA-256-stored code can still claim (deploy bridge)', async () => {
    const code = '22222222';
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '10 minutes')`,
      [hashToken(code), locId, table2Id],
    );
    const res = await claim(code); // claim #5
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { device_token: string; device_id: string };
    deviceBToken = body.device_token;
    deviceBId = body.device_id;
  });
});

describe('claim consumption is atomic (F11-2)', () => {
  it('two concurrent claims of one code produce exactly one device', async () => {
    const code = await mint(table1Id);
    const [a, b] = await Promise.all([claim(code), claim(code)]); // claims #6, #7
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [200, 400]);
    const winner = a.statusCode === 200 ? a : b;
    table1Token = (winner.json() as { device_token: string }).device_token;
    const active = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [table1Id],
    );
    assert.equal(active.rows[0].n, 1);
  });

  it('minting purges long-expired code rows', async () => {
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at, used_at)
       VALUES ($1,$2,$3, now() - interval '2 days', now() - interval '2 days')`,
      [hashClaimCode('33333333'), locId, table2Id],
    );
    await mint(table1Id);
    const r = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM device_claim_codes WHERE code_hash = $1`,
      [hashClaimCode('33333333')],
    );
    assert.equal(r.rows[0].n, 0);
  });
});

describe('state freshness + token (F11-6/F11-7, Low)', () => {
  const dev = () => ({ authorization: `Bearer ${table1Token}` });

  it('state carries the current table_token — and follows a QR rotation', async () => {
    const s1 = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal(s1.statusCode, 200, s1.body);
    assert.equal((s1.json() as { table_token: string }).table_token, 'qrtok1');
    await query(`UPDATE tables SET qr_token = 'qrtok1-rotated' WHERE id = $1`, [table1Id]);
    const s2 = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal((s2.json() as { table_token: string }).table_token, 'qrtok1-rotated');
  });

  it('last_seen_at writes are throttled to ~30s', async () => {
    const devRow = await query<{ id: string }>(
      `SELECT id FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [table1Id],
    );
    const id = devRow.rows[0].id;
    await query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [id]);
    const v1 = (await query<{ last_seen_at: string }>(`SELECT last_seen_at FROM devices WHERE id = $1`, [id])).rows[0]
      .last_seen_at;
    await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    const v2 = (await query<{ last_seen_at: string }>(`SELECT last_seen_at FROM devices WHERE id = $1`, [id])).rows[0]
      .last_seen_at;
    assert.equal(String(v2), String(v1), 'a fresh last_seen must not be rewritten by a poll');
    await query(`UPDATE devices SET last_seen_at = $2 WHERE id = $1`, [id, new Date('2020-01-01T00:00:00Z')]);
    await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    const v3 = (await query<{ last_seen_at: string }>(`SELECT last_seen_at FROM devices WHERE id = $1`, [id])).rows[0]
      .last_seen_at;
    // pg-mem renders timestamps at second precision, so compare parsed
    // times: a 2020 value must have been replaced by a fresh one.
    assert.ok(new Date(v3).getTime() > Date.now() - 60_000, 'a stale last_seen must be refreshed');
  });

  it('heartbeat rssi is clamped to the physical dBm range', async () => {
    const devRow = await query<{ id: string }>(
      `SELECT id FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [table1Id],
    );
    const id = devRow.rows[0].id;
    const hb1 = await app.inject({
      method: 'POST',
      url: '/api/device/heartbeat',
      headers: dev(),
      payload: { rssi: -999 },
    });
    assert.equal(hb1.statusCode, 200, hb1.body);
    assert.equal((await query<{ rssi: number }>(`SELECT rssi FROM devices WHERE id = $1`, [id])).rows[0].rssi, -100);
    await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: dev(), payload: { rssi: 42 } });
    assert.equal((await query<{ rssi: number }>(`SELECT rssi FROM devices WHERE id = $1`, [id])).rows[0].rssi, 0);
  });
});

describe('print jobs (F11-3/F11-4)', () => {
  const devB = () => ({ authorization: `Bearer ${deviceBToken}` });
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const TAB = String.fromCharCode(9);

  it('control characters are stripped at creation', async () => {
    const create = await staffPrint(table2Id, {
      lines: ['TOTAL $5.00', `ESC${ESC}@ reset`, `BEL${BEL} ring`, `tab${TAB}here`],
    });
    assert.equal(create.statusCode, 200, create.body);
    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: devB() });
    const jobs = (fetch1.json() as { jobs: { lines: string[] }[] }).jobs;
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].lines, ['TOTAL $5.00', 'ESC@ reset', 'BEL ring', 'tabhere']);
  });

  it('ack is terminal: re-acking a done job conflicts, unknown ids 404', async () => {
    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: devB() });
    const jobId = (fetch1.json() as { jobs: { id: string }[] }).jobs[0].id;
    const ack = await app.inject({
      method: 'POST',
      url: `/api/device/print-jobs/${jobId}/ack`,
      headers: devB(),
      payload: { status: 'done' },
    });
    assert.equal(ack.statusCode, 200, ack.body);
    const reAck = await app.inject({
      method: 'POST',
      url: `/api/device/print-jobs/${jobId}/ack`,
      headers: devB(),
      payload: { status: 'failed' },
    });
    assert.equal(reAck.statusCode, 409);
    const row = await query<{ status: string }>(`SELECT status FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(row.rows[0].status, 'done', 'the terminal state must not be rewritten');
    const missing = await app.inject({
      method: 'POST',
      url: `/api/device/print-jobs/${randomUUID()}/ack`,
      headers: devB(),
      payload: { status: 'done' },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('an idempotency key replays the original job', async () => {
    const first = await staffPrint(table2Id, { lines: ['receipt'], idempotency_key: 'test-key-1' });
    assert.equal(first.statusCode, 200, first.body);
    const firstId = (first.json() as { job_id: string }).job_id;
    const second = await staffPrint(table2Id, { lines: ['receipt'], idempotency_key: 'test-key-1' });
    assert.equal(second.statusCode, 200, second.body);
    const secondBody = second.json() as { job_id: string; replayed?: boolean };
    assert.equal(secondBody.job_id, firstId);
    assert.equal(secondBody.replayed, true);
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM print_jobs WHERE device_id = $1 AND idempotency_key = 'test-key-1'`,
      [deviceBId],
    );
    assert.equal(rows.rows[0].n, 1);
    // Clear the queue for the next tests.
    const ack = await app.inject({
      method: 'POST',
      url: `/api/device/print-jobs/${firstId}/ack`,
      headers: devB(),
      payload: { status: 'done' },
    });
    assert.equal(ack.statusCode, 200, ack.body);
  });

  it('uncollected jobs expire server-side after the TTL', async () => {
    const create = await staffPrint(table2Id, { lines: ['stale receipt'] });
    assert.equal(create.statusCode, 200, create.body);
    const jobId = (create.json() as { job_id: string }).job_id;
    await query(`UPDATE print_jobs SET created_at = now() - interval '20 minutes' WHERE id = $1`, [jobId]);
    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: devB() });
    const ids = (fetch1.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    assert.ok(!ids.includes(jobId), 'an expired job must not be delivered');
    const row = await query<{ status: string }>(`SELECT status FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(row.rows[0].status, 'failed');
    const st = await app.inject({ method: 'GET', url: '/api/device/state', headers: devB() });
    assert.ok(!(st.json() as { print_jobs: string[] }).print_jobs.includes(jobId));
  });

  it('fetch marks sent ONLY the rows it returned', async () => {
    const base = Date.now();
    for (let i = 0; i < 21; i++) {
      await query(
        `INSERT INTO print_jobs(id, device_id, location_id, table_id, lines, created_at)
         VALUES ($1,$2,$3,$4,'["x"]',$5)`,
        [randomUUID(), deviceBId, locId, table2Id, new Date(base + i * 1000)],
      );
    }
    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: devB() });
    const jobs = (fetch1.json() as { jobs: { id: string }[] }).jobs;
    assert.equal(jobs.length, 20);
    const sent = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM print_jobs WHERE device_id = $1 AND status = 'sent'`,
      [deviceBId],
    );
    assert.equal(sent.rows[0].n, 20);
    const pending = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM print_jobs WHERE device_id = $1 AND status = 'pending'`,
      [deviceBId],
    );
    assert.equal(pending.rows[0].n, 1, 'the row beyond the fetch LIMIT stays pending');
  });

  it('the per-device queue cap refuses new jobs while full', async () => {
    const res = await staffPrint(table2Id, { lines: ['one too many'] });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /queue is full/);
  });

  it('revoking the device cancels its queued jobs and kills the token', async () => {
    const rv = await app.inject({
      method: 'POST',
      url: `/api/portal/devices/${deviceBId}/revoke`,
      headers: STAFF,
      payload: {},
    });
    assert.equal(rv.statusCode, 200, rv.body);
    const active = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM print_jobs WHERE device_id = $1 AND status IN ('pending','sent')`,
      [deviceBId],
    );
    assert.equal(active.rows[0].n, 0);
    const failed = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM print_jobs WHERE device_id = $1 AND status = 'failed' AND error = 'device revoked'`,
      [deviceBId],
    );
    assert.equal(failed.rows[0].n, 21);
    const s = await app.inject({ method: 'GET', url: '/api/device/state', headers: devB() });
    assert.equal(s.statusCode, 401);
  });
});

describe('audit trail (F11-5 cheap part)', () => {
  it('pairing and revocation wrote audit rows', async () => {
    const paired = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'device.paired' AND location_id = $1`,
      [locId],
    );
    assert.ok(paired.rows[0].n >= 3, 'every successful claim is audited');
    const revoked = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'device.revoked' AND target = $1`,
      [deviceBId],
    );
    assert.equal(revoked.rows[0].n, 1);
  });
});

describe('claim attempt budget (F11-1) — runs last by design', () => {
  it('the endpoint hard-caps attempts per IP inside the code lifetime', async () => {
    // 7 claims were made by the describes above; the budget is 15 per
    // 10 minutes per IP, so attempt #15 still reaches the handler (400)
    // and #16 is the first 429.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await claim(String(50000000 + i));
      statuses.push(res.statusCode);
    }
    assert.equal(statuses[7], 400, 'attempt #15 is still a normal failure');
    assert.equal(statuses[8], 429, 'attempt #16 hits the budget');
    assert.equal(statuses[11], 429);
  });
});
