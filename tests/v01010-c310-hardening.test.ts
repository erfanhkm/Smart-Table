// v0.10.10 (C3-10) device / receipt hardening tests.
//
// Proves:
//  1. Migration 035 carries print_jobs.payment_id + the waiter-poll
//     partial index (M-2/M-5), and the claim path no longer consults any
//     legacy hash (KEY QUESTION: fallback retired).
//  2. Pairing: claim response is no-store (L-11); minting + the implicit
//     re-pair revocation are audited (L-8); re-pairing cancels the old
//     unit's jobs and releases their payments' print claims (M-3/M-2);
//     a failed pairing does not burn the code (L-5).
//  3. Ack: same-state re-ack is an idempotent 200 replay, conflicting
//     transitions still 409 (H-1); a 'failed' ack and job expiry release
//     the payment's print claim (M-2); explicit revoke does too.
//  4. Downgrading to Starter deletes outstanding claim codes (L-4).
//  5. /call dedupe only swallows a press when no waiter_ack follows the
//     last call (L-9).
//  6. Staff print: an idempotency key replayed with DIFFERENT lines is a
//     409, not a silent replay of the first job (L-6).
//  7. Receipt lines: newline stripped (L-1), the formatter sanitizes its
//     own output (L-2), partial payments print the share line instead of
//     the full check's items (L-3), and column math is display-width
//     based — CJK lines fit 32 columns and surrogate pairs never split
//     (L-3 width half).
//
// Run: PG_MEM=1 npx tsx --test tests/v01010-c310-hardening.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['c310', 'staff', 'token'].join('-');
process.env.SQUARE_ACCESS_TOKEN = ['c310', 'square', 'token'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');
const { hashToken } = await import('../src/routes/portal.js');
const { hashClaimCode } = await import('../src/routes/device.js');
const { setLocationTier } = await import('../src/services/billing.js');
const { buildReceiptLines, sanitizePrintLines, stripControlChars, displayWidth } = await import(
  '../src/services/receiptLines.js'
);

const STAFF = { authorization: 'Bearer ' + ['c310', 'staff', 'token'].join('-') };
const locId = randomUUID();
const loc2Id = randomUUID();
const tPair = randomUUID();
const tFail = randomUUID();
const tAck = randomUUID();
const tCall = randomUUID();
const tPrint = randomUUID();
const tDown = randomUUID();
let app: Awaited<ReturnType<typeof buildApp>>;

const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

async function seedTable(id: string, name: string, locationId = locId) {
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`, [
    id,
    locationId,
    name,
    `qr-${id.slice(0, 8)}`,
  ]);
}

async function seedDevice(tableId: string, label: string) {
  const plain = ['c310', label, 'token'].join('-');
  const id = randomUUID();
  await query(`INSERT INTO devices(id, location_id, table_id, token_hash) VALUES ($1,$2,$3,$4)`, [
    id,
    locId,
    tableId,
    hashToken(plain),
  ]);
  return { id, auth: { authorization: `Bearer ${plain}` } };
}

async function seedClaimedPaymentJob(deviceId: string, tableId: string, opts: { ageMs?: number } = {}) {
  const checkId = randomUUID();
  const paymentId = randomUUID();
  const jobId = randomUUID();
  await query(
    `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, receipt_printed_at)
     VALUES ($1,$2,1000,0,'COMPLETED',$3, now())`,
    [paymentId, checkId, `idem-${paymentId.slice(0, 8)}`],
  );
  await query(
    `INSERT INTO print_jobs(id, device_id, location_id, table_id, check_id, payment_id, lines, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'["receipt"]','pending', $7)`,
    [jobId, deviceId, locId, tableId, checkId, paymentId, new Date(Date.now() - (opts.ageMs ?? 0)).toISOString()],
  );
  return { paymentId, jobId };
}

async function paymentClaim(paymentId: string) {
  const r = await query<{ receipt_printed_at: string | null }>(
    `SELECT receipt_printed_at FROM payments WHERE id = $1`,
    [paymentId],
  );
  return r.rows[0]?.receipt_printed_at ?? null;
}

async function jobRow(jobId: string) {
  const r = await query<{ status: string; error: string | null }>(`SELECT status, error FROM print_jobs WHERE id = $1`, [
    jobId,
  ]);
  return r.rows[0];
}

const mint = (tableId: string) =>
  app.inject({ method: 'POST', url: '/api/portal/devices/claim-code', headers: STAFF, payload: { table_id: tableId } });

const claim = (code: string, ip: string) =>
  app.inject({ method: 'POST', url: '/api/device/claim', payload: { code }, remoteAddress: ip });

before(async () => {
  await migrate();
  app = await buildApp({ logger: false });
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ($1,'m-c310','square','SQLOCC310','SQLOCC310','C310 Bistro','CAD')`,
    [locId],
  );
  await query(
    `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
     VALUES ($1,'m-c310b','square','SQLOCC310B','SQLOCC310B','C310 Second','CAD')`,
    [loc2Id],
  );
  await seedTable(tPair, 'Pair Table');
  await seedTable(tFail, 'Fail Table');
  await seedTable(tAck, 'Ack Table');
  await seedTable(tCall, 'Call Table');
  await seedTable(tPrint, 'Print Table');
  await seedTable(tDown, 'Down Table', loc2Id);
});

describe('migration + fallback retirement (M-5, KEY QUESTION)', () => {
  it('migration 035 adds payment_id and the waiter-poll partial index', () => {
    const sql = readSrc('../migrations/035_c310_device_hardening.sql');
    assert.match(sql, /ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS payment_id/);
    assert.match(sql, /idx_events_table_waiter_poll/);
    assert.match(sql, /WHERE type IN \('call_waiter', ?'waiter_ack'\)/);
  });

  it('the claim path consults only the HMAC hash', () => {
    const src = readSrc('../src/routes/device.ts');
    assert.ok(!src.includes('hashToken(code)'), 'no legacy hash lookup for claim codes');
    assert.ok(src.includes('const codeHash = hashClaimCode(code)'), 'single HMAC lookup');
  });
});

describe('pairing: audits, re-pair job cancellation, no-burn failures', () => {
  let device1 = '';
  let device2 = '';
  let token2 = '';

  it('claim answers no-store and minting is audited (L-11/L-8)', async () => {
    const m = await mint(tPair);
    assert.equal(m.statusCode, 200, m.body);
    const code = (m.json() as { code: string }).code;
    const res = await claim(code, '198.51.100.10');
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['cache-control'] ?? ''), /no-store/);
    device1 = (res.json() as { device_id: string }).device_id;
    const audits = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'device.claim_code_minted' AND target = $1`,
      [tPair],
    );
    assert.ok(audits.rows[0].n >= 1, 'minting wrote an audit row');
  });

  it('re-pairing cancels the old unit jobs, releases claims, audits the revoke (M-3/M-2/L-8)', async () => {
    const { paymentId, jobId } = await seedClaimedPaymentJob(device1, tPair);
    const m = await mint(tPair);
    const code = (m.json() as { code: string }).code;
    const res = await claim(code, '198.51.100.11');
    assert.equal(res.statusCode, 200, res.body);
    device2 = (res.json() as { device_id: string }).device_id;
    token2 = (res.json() as { device_token: string }).device_token;
    assert.notEqual(device2, device1);
    const old = await query<{ revoked_at: string | null }>(`SELECT revoked_at FROM devices WHERE id = $1`, [device1]);
    assert.ok(old.rows[0].revoked_at, 'old device revoked');
    const job = await jobRow(jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'device replaced');
    assert.equal(await paymentClaim(paymentId), null, 'print claim released');
    const revokeAudits = await query<{ detail: string | null }>(
      `SELECT detail FROM audit_log WHERE action = 'device.revoked' AND target = $1`,
      [device1],
    );
    assert.equal(revokeAudits.rowCount, 1);
    assert.match(revokeAudits.rows[0].detail ?? '', /device replaced/);
    // Stash for the ack tests.
    (globalThis as Record<string, unknown>).__c310 = { device2, token2 };
  });

  it('a pairing that fails midway does not burn the code (L-5)', async () => {
    const m = await mint(tFail);
    const code = (m.json() as { code: string }).code;
    await query(`DELETE FROM tables WHERE id = $1`, [tFail]);
    const failed = await claim(code, '198.51.100.12');
    assert.equal(failed.statusCode, 400, failed.body);
    assert.match(failed.body, /table no longer exists/);
    const row = await query<{ used_at: string | null }>(
      `SELECT used_at FROM device_claim_codes WHERE table_id = $1`,
      [tFail],
    );
    assert.equal(row.rows[0].used_at, null, 'the failed pairing rolled the consumption back');
    await seedTable(tFail, 'Fail Table');
    const ok = await claim(code, '198.51.100.12');
    assert.equal(ok.statusCode, 200, ok.body);
  });
});

describe('ack idempotency + claim release (H-1, M-2)', () => {
  const dev2 = () => {
    const s = (globalThis as Record<string, unknown>).__c310 as { token2: string };
    return { authorization: `Bearer ${s.token2}` };
  };
  const ack = (jobId: string, status: string) =>
    app.inject({ method: 'POST', url: `/api/device/print-jobs/${jobId}/ack`, headers: dev2(), payload: { status } });

  it("a 'failed' ack releases the claim; same-state re-ack replays 200; conflict 409s", async () => {
    const s = (globalThis as Record<string, unknown>).__c310 as { device2: string };
    const { paymentId, jobId } = await seedClaimedPaymentJob(s.device2, tPair);
    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: dev2() });
    assert.equal(fetch1.statusCode, 200, fetch1.body);
    const failed = await ack(jobId, 'failed');
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal(await paymentClaim(paymentId), null, 'failed ack released the print claim');
    const replay = await ack(jobId, 'failed');
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((replay.json() as { replayed?: boolean }).replayed, true);
    const conflictRes = await ack(jobId, 'done');
    assert.equal(conflictRes.statusCode, 409, conflictRes.body);
    assert.equal((await jobRow(jobId)).status, 'failed', 'terminal state not rewritten');
  });

  it("a 'done' ack replays 200 too, and a done job keeps its claim", async () => {
    const s = (globalThis as Record<string, unknown>).__c310 as { device2: string };
    const { paymentId, jobId } = await seedClaimedPaymentJob(s.device2, tPair);
    const done = await ack(jobId, 'done');
    assert.equal(done.statusCode, 200, done.body);
    assert.ok(await paymentClaim(paymentId), 'a printed receipt keeps the one-print claim');
    const replay = await ack(jobId, 'done');
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((replay.json() as { replayed?: boolean }).replayed, true);
    const conflictRes = await ack(jobId, 'failed');
    assert.equal(conflictRes.statusCode, 409, conflictRes.body);
  });

  it('an expired job releases its claim when the device next fetches (M-2)', async () => {
    const s = (globalThis as Record<string, unknown>).__c310 as { device2: string };
    const { paymentId, jobId } = await seedClaimedPaymentJob(s.device2, tPair, { ageMs: 16 * 60_000 });
    const fetch1 = await app.inject({ method: 'GET', url: '/api/device/print-jobs', headers: dev2() });
    assert.equal(fetch1.statusCode, 200, fetch1.body);
    const ids = (fetch1.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    assert.ok(!ids.includes(jobId), 'expired job is not delivered');
    assert.equal((await jobRow(jobId)).status, 'failed');
    assert.equal(await paymentClaim(paymentId), null, 'expiry released the print claim');
  });

  it('explicit revoke cancels the queue and releases claims (M-2)', async () => {
    const dev = await seedDevice(tAck, 'acktable');
    const { paymentId, jobId } = await seedClaimedPaymentJob(dev.id, tAck);
    const res = await app.inject({ method: 'POST', url: `/api/portal/devices/${dev.id}/revoke`, headers: STAFF });
    assert.equal(res.statusCode, 200, res.body);
    const job = await jobRow(jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'device revoked');
    assert.equal(await paymentClaim(paymentId), null);
  });
});

describe('tier downgrade deletes outstanding claim codes (L-4)', () => {
  it('setLocationTier(starter) removes unused codes for the location', async () => {
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')`,
      [hashClaimCode('13572468'), loc2Id, tDown],
    );
    await setLocationTier(loc2Id, 'starter');
    const r = await query(`SELECT code_hash FROM device_claim_codes WHERE location_id = $1 AND used_at IS NULL`, [loc2Id]);
    assert.equal(r.rowCount, 0, 'outstanding codes deleted on downgrade');
  });
});

describe('/call dedupe respects waiter_ack (L-9)', () => {
  it('a press after an ack is a new call; a press after an unacked call dedupes', async () => {
    const dev = await seedDevice(tCall, 'calltable');
    const press = () => app.inject({ method: 'POST', url: '/api/device/call', headers: dev.auth });
    const callCount = async () => {
      const r = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM events WHERE table_id = $1 AND type = 'call_waiter'`,
        [tCall],
      );
      return r.rows[0].n;
    };
    const first = await press();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(await callCount(), 1);
    // A waiter_ack lands after the call (stamped ahead so event ordering
    // is deterministic in this test).
    await query(
      `INSERT INTO events(id, table_id, type, created_at) VALUES ($1,$2,'waiter_ack', now() + interval '2 minutes')`,
      [randomUUID(), tCall],
    );
    const second = await press();
    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual((second.json() as { deduped?: boolean }).deduped, true, 'post-ack press is NOT swallowed');
    assert.equal(await callCount(), 2);
    // Now the newest event is an unacknowledged call: a quick press dedupes.
    await query(
      `INSERT INTO events(id, table_id, type, created_at) VALUES ($1,$2,'call_waiter', now() + interval '3 minutes')`,
      [randomUUID(), tCall],
    );
    const third = await press();
    assert.equal(third.statusCode, 200, third.body);
    assert.equal((third.json() as { deduped?: boolean }).deduped, true);
    assert.equal(await callCount(), 3, 'the deduped press inserted nothing');
  });
});

describe('staff print idempotency compares content (L-6)', () => {
  it('same key + different lines is a 409; same key + same lines replays', async () => {
    await seedDevice(tPrint, 'printtable');
    const send = (lines: string[]) =>
      app.inject({
        method: 'POST',
        url: `/api/tables/${tPrint}/print-job`,
        headers: STAFF,
        payload: { lines, idempotency_key: 'c310-key-1' },
      });
    const first = await send(['Alpha receipt']);
    assert.equal(first.statusCode, 200, first.body);
    const firstId = (first.json() as { job_id: string }).job_id;
    const different = await send(['Beta receipt']);
    assert.equal(different.statusCode, 409, different.body);
    const same = await send(['Alpha receipt']);
    assert.equal(same.statusCode, 200, same.body);
    assert.equal((same.json() as { job_id: string }).job_id, firstId);
  });
});

describe('receipt lines (L-1/L-2/L-3)', () => {
  const base = {
    restaurantName: 'C310 Bistro',
    tableName: 'Pair Table',
    tipCents: 0,
    currency: 'CAD',
    paidAt: 'Nov 11, 2026',
  };

  it('newline becomes a space and other controls vanish (L-1)', () => {
    assert.equal(stripControlChars('A\nB\u0007C'), 'A BC');
    assert.deepEqual(sanitizePrintLines(['X\nFORGED TOTAL']), ['X FORGED TOTAL']);
  });

  it('a partial payment prints the share line, not the full check items (L-3)', () => {
    const lines = buildReceiptLines({
      ...base,
      items: [{ name: 'Soup', quantity: 1, amountCents: 1000 }],
      amountCents: 500,
    });
    assert.ok(lines.some((l) => l.includes('Your share of the check')), lines.join('|'));
    assert.ok(!lines.some((l) => l.includes('Soup')), 'full-check items must not print over a partial Paid line');
    assert.ok(lines.some((l) => l.includes('$5.00')));
  });

  it('a reconciling payment prints its items (L-3)', () => {
    const lines = buildReceiptLines({
      ...base,
      items: [{ name: 'Soup', quantity: 1, amountCents: 1000 }],
      amountCents: 1000,
    });
    assert.ok(lines.some((l) => l.includes('Soup')));
    assert.ok(!lines.some((l) => l.includes('Your share of the check')));
  });

  it("the formatter's own output carries no control bytes, currency included (L-2)", () => {
    const lines = buildReceiptLines({
      ...base,
      currency: 'CA\nD',
      items: [{ name: 'Soup\nFORGED', quantity: 1, amountCents: 100 }],
      amountCents: 100,
    });
    for (const l of lines) assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(l), `control byte in: ${JSON.stringify(l)}`);
    assert.ok(lines.some((l) => l.includes('CA D 1.00')), lines.join('|'));
  });

  it('CJK lines fit 32 display columns and surrogate pairs never split (L-3 width)', () => {
    const lines = buildReceiptLines({
      ...base,
      items: [{ name: '北京烤鸭'.repeat(10), quantity: 1, amountCents: 100 }],
      amountCents: 100,
    });
    for (const l of lines) assert.ok(displayWidth(l) <= 32, `too wide: ${l}`);
    const emoji = buildReceiptLines({
      ...base,
      restaurantName: '𐮷'.repeat(24),
      items: [],
      amountCents: 0,
    });
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const l of emoji) assert.ok(!lone.test(l), `lone surrogate in: ${JSON.stringify(l)}`);
  });
});
