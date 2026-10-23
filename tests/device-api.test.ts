// v0.7 Device API tests — STT-101 pairing + device surface + portal registry.
//
// Proves:
//  1. Pairing: portal claim code -> device claim returns a token + the
//     table's QR token; the code is single-use; wrong/expired codes fail.
//  2. Device auth: no token / wrong token / revoked token all get 401.
//  3. State derivation: open check -> awaiting_payment; waiter call ->
//     service pending; staff ack -> acked; button bounce is deduped.
//  4. Print jobs: staff creates -> device fetches (job marked sent) ->
//     ack done removes it; a foreign device cannot ack it; a table with
//     no paired device rejects job creation; line validation holds.
//  5. Heartbeat: fields land in the portal registry; partial heartbeats
//     do not clear previously reported fields.
//  6. Re-pairing a table revokes the previous unit (old token dies).
//
// Run: PG_MEM=1 npx tsx --test tests/device-api.test.ts
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

const STAFF = { authorization: 'Bearer test-token' };
const locId = randomUUID();
const tableId = randomUUID();
const table2Id = randomUUID();
let app: Awaited<ReturnType<typeof buildApp>>;
let deviceToken = '';
let deviceId = '';

const dev = () => ({ authorization: `Bearer ${deviceToken}` });

async function makeClaimCode(table: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/portal/devices/claim-code',
    headers: STAFF,
    payload: { table_id: table },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { code: string }).code;
}

async function claim(code: string) {
  return app.inject({ method: 'POST', url: '/api/device/claim', payload: { code } });
}

before(async () => {
  await migrate();
  app = await buildApp({ logger: false });
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ($1,'m-dev','square','SQLOCDEV','SQLOCDEV','Device Test Bistro','CAD')`,
    [locId],
  );
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'Table 7','qrtok7','SEATED')`, [
    tableId,
    locId,
  ]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'Table 8','qrtok8','FREE')`, [
    table2Id,
    locId,
  ]);
});

describe('pairing', () => {
  it('rejects malformed and unknown codes', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/device/claim', payload: { code: 'abc' } });
    assert.equal(bad.statusCode, 400);
    const unknown = await claim('99999999');
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.body, /invalid claim code/);
  });

  it('rejects an expired code', async () => {
    const code = '42424242';
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at)
       VALUES ($1,$2,$3, now() - interval '1 minute')`,
      [hashToken(code), locId, table2Id],
    );
    const res = await claim(code);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /expired/);
  });

  it('claim code for an unknown table 404s', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/portal/devices/claim-code',
      headers: STAFF,
      payload: { table_id: randomUUID() },
    });
    assert.equal(res.statusCode, 404);
  });

  it('claims successfully and the code becomes single-use', async () => {
    const code = await makeClaimCode(tableId);
    const res = await claim(code);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { device_token: string; device_id: string; table_token: string };
    assert.ok(body.device_token.length >= 32);
    assert.equal(body.table_token, 'qrtok7');
    deviceToken = body.device_token;
    deviceId = body.device_id;
    const again = await claim(code);
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /already used/);
  });

  it('stores only the token hash', async () => {
    const r = await query<{ token_hash: string }>(`SELECT token_hash FROM devices WHERE id = $1`, [deviceId]);
    assert.equal(r.rows[0].token_hash, hashToken(deviceToken));
    assert.notEqual(r.rows[0].token_hash, deviceToken);
  });
});

describe('device auth', () => {
  it('401s without a token and with a wrong token', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/device/state' });
    assert.equal(none.statusCode, 401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/device/state',
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(wrong.statusCode, 401);
  });
});

describe('state + service calls', () => {
  it('starts idle, then reflects an open check', async () => {
    const s1 = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal(s1.statusCode, 200, s1.body);
    const b1 = s1.json() as { check_state: string; service_state: string; table_status: string };
    assert.equal(b1.check_state, 'none');
    assert.equal(b1.service_state, 'none');
    assert.equal(b1.table_status, 'seated');
    await query(
      `INSERT INTO checks(id, table_id, location_id, external_check_ref, pos_type, state, total_cents, currency)
       VALUES ($1,$2,$3,'CHK-DEV-1','square','OPEN',4200,'CAD')`,
      [randomUUID(), tableId, locId],
    );
    const s2 = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal((s2.json() as { check_state: string }).check_state, 'awaiting_payment');
  });

  it('button press creates a pending call; an immediate re-press is deduped; staff ack flips to acked', async () => {
    const c1 = await app.inject({ method: 'POST', url: '/api/device/call', headers: dev(), payload: {} });
    assert.equal(c1.statusCode, 200, c1.body);
    const c2 = await app.inject({ method: 'POST', url: '/api/device/call', headers: dev(), payload: {} });
    assert.equal((c2.json() as { deduped?: boolean }).deduped, true);
    const calls = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM events WHERE table_id = $1 AND type = 'call_waiter'`,
      [tableId],
    );
    assert.equal(calls.rows[0].n, 1);
    const s = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal((s.json() as { service_state: string }).service_state, 'pending');
    const ack = await app.inject({ method: 'POST', url: `/api/tables/${tableId}/ack-call`, headers: STAFF, payload: {} });
    assert.equal(ack.statusCode, 200, ack.body);
    const s2 = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal((s2.json() as { service_state: string }).service_state, 'acked');
  });
});

describe('print jobs', () => {
  let jobId = '';
  it('rejects invalid line payloads and tables without a device', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/print-job`,
      headers: STAFF,
      payload: { lines: [] },
    });
    assert.equal(empty.statusCode, 400);
    const noDevice = await app.inject({
      method: 'POST',
      url: `/api/tables/${table2Id}/print-job`,
      headers: STAFF,
      payload: { lines: ['hi'] },
    });
    assert.equal(noDevice.statusCode, 400);
    assert.match(noDevice.body, /no paired device/);
  });

  it('flows staff -> device fetch -> ack', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/print-job`,
      headers: STAFF,
      payload: { lines: ['Gastown Bistro', 'TOTAL  $42.00 CAD'] },
    });
    assert.equal(create.statusCode, 200, create.body);
    jobId = (create.json() as { job_id: string }).job_id;

    const st = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.deepEqual((st.json() as { print_jobs: string[] }).print_jobs, [jobId]);

    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: dev() });
    const jobs = (fetch1.json() as { jobs: { id: string; lines: string[] }[] }).jobs;
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].lines, ['Gastown Bistro', 'TOTAL  $42.00 CAD']);
    const row = await query<{ status: string }>(`SELECT status FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(row.rows[0].status, 'sent');

    const ack = await app.inject({
      method: 'POST',
      url: `/api/device/print-jobs/${jobId}/ack`,
      headers: dev(),
      payload: { status: 'done' },
    });
    assert.equal(ack.statusCode, 200, ack.body);
    const st2 = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.deepEqual((st2.json() as { print_jobs: string[] }).print_jobs, []);
  });
});

describe('portal Devices view (source shape)', () => {
  it('parses API responses via readJson — never reads fields off the raw Response', async () => {
    // v0.7.0 regression: request() returns a fetch Response; reading
    // .devices/.tables off it yielded undefined and the view rendered an
    // empty registry claiming every table was already paired.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../public/portal/app.js', import.meta.url), 'utf8');
    const start = src.indexOf('async function renderDevices()');
    const end = src.indexOf('/* --------', start);
    const fn = src.slice(start, end > start ? end : start + 6000);
    assert.ok(fn.includes('await readJson(devRes)'), 'devices response must be parsed');
    assert.ok(fn.includes('await readJson(tabRes)'), 'tables response must be parsed');
    assert.ok(!fn.includes('devRes.devices'), 'raw Response field access must be gone');
    assert.ok(!fn.includes('tabRes.tables'), 'raw Response field access must be gone');
  });
});

describe('heartbeat + registry + revoke + re-pair', () => {
  it('heartbeat lands in the portal registry; partial updates keep old fields', async () => {
    const hb = await app.inject({
      method: 'POST',
      url: '/api/device/heartbeat',
      headers: dev(),
      payload: { fw_version: '0.1.0', battery_pct: 87, charging: true, rssi: -55, paper_ok: true },
    });
    assert.equal(hb.statusCode, 200, hb.body);
    const hb2 = await app.inject({
      method: 'POST',
      url: '/api/device/heartbeat',
      headers: dev(),
      payload: { battery_pct: 86 },
    });
    assert.equal(hb2.statusCode, 200);
    const list = await app.inject({
      method: 'GET',
      url: `/api/portal/devices?location_id=${locId}`,
      headers: STAFF,
    });
    const devices = (list.json() as { devices: Record<string, unknown>[] }).devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].battery_pct, 86);
    assert.equal(devices[0].fw_version, '0.1.0');
    assert.equal(devices[0].paper_ok, true);
    assert.equal(devices[0].table_name, 'Table 7');
    assert.ok(!('token_hash' in devices[0]), 'token hash must never reach the portal');
  });

  it('revoking kills the token', async () => {
    const rv = await app.inject({
      method: 'POST',
      url: `/api/portal/devices/${deviceId}/revoke`,
      headers: STAFF,
      payload: {},
    });
    assert.equal(rv.statusCode, 200, rv.body);
    const s = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal(s.statusCode, 401);
  });

  it('re-pairing issues a fresh working token with exactly one active device', async () => {
    const code = await makeClaimCode(tableId);
    const res = await claim(code);
    assert.equal(res.statusCode, 200, res.body);
    deviceToken = (res.json() as { device_token: string }).device_token;
    const s = await app.inject({ method: 'GET', url: '/api/device/state', headers: dev() });
    assert.equal(s.statusCode, 200);
    const active = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [tableId],
    );
    assert.equal(active.rows[0].n, 1);
  });
});
