// v0.10.4 — Claude cycle-3 chunk C3-5 hardening tests (pg-mem).
//
// Proves:
//  C3-5-1  splitStatements keeps semicolons inside string literals and
//          dollar-quoted bodies intact; migrate() applies a file whose
//          INSERT carries a ';' inside a string; a failing migration file
//          is never recorded as applied (bookkeeping insert shares the
//          file's transaction) and a corrected file applies cleanly.
//  C3-5-2  background timers are cleared on app close + the SIGTERM drain
//          deadline is 25s (source shape — the drain itself is a main-only
//          path and not exercised in-process).
//  C3-5-3  rate limiters own private bucket maps: a 10k-key flood against
//          one limiter cannot reset another limiter's counters; eviction
//          is LRU (a bucket hit mid-flood survives, idle ones evict).
//  C3-5-4  oversized bodies are refused 413 on /api/device/claim and
//          /api/demo-access-requests (route-level bodyLimit), while a
//          normal claim still reaches the route (400 invalid code).
//  C3-5-5b verifyPasswordForm: NFC hashes verify as 'nfc'; a PRE-F5-21
//          hash over the raw (NFD-typed) password verifies as 'raw';
//          a portal login on a legacy hash upgrades the stored hash to
//          the NFC form in place.
//  C3-5-6  Postgres 40P01 / 40001 map to retryable 409s alongside 55P03.
//  C3-5-7  DEMO_ACCESS_NOTIFY_EMAIL has no source default anymore;
//          sendDemoAccessEmail('') skips cleanly; assertSafeConfig warns
//          (never throws) on missing SQUARE_APP_ID/SECRET and on a missing
//          ADMIN_USERNAME while a password hash is set.
//
// Run: PG_MEM=1 npx tsx --test tests/v0104-c35-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'c35-test-staff-token-0123456789abcdef';
process.env.SQUARE_ACCESS_TOKEN = 'sq-test-token';
process.env.SQUARE_APP_ID = 'sq0idp-test';
process.env.RESEND_API_KEY = 're_test_key';
process.env.RECEIPT_FROM_EMAIL = 'receipts@smarttablepay.com';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const scryptAsync = promisify(scryptCb);

const { migrate, splitStatements } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { hashPassword, verifyPassword, verifyPasswordForm, encryptSecret } = await import('../src/crypto.js');
const { rateLimit } = await import('../src/rate-limit.js');
const { assertSafeConfig, config } = await import('../src/config.js');
const { sendDemoAccessEmail } = await import('../src/services/email.js');
const { buildApp } = await import('../src/index.js');

// ---------------------------------------------------------------- C3-5-1 --
describe('C3-5-1 migration runner', () => {
  it('splitStatements keeps semicolons inside strings and dollar bodies', () => {
    const sql = [
      `INSERT INTO t(a) VALUES ('x;y');`,
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE 'a;b'; END; $$ LANGUAGE plpgsql;`,
      `UPDATE t SET a = 'it''s; fine' WHERE id = 1;`,
      `SELECT 1;`,
    ].join('\n');
    const stmts = splitStatements(sql);
    assert.equal(stmts.length, 4);
    assert.ok(stmts[0].includes(`'x;y'`), 'string semicolon preserved in statement 1');
    assert.ok(stmts[1].includes(`'a;b'`), 'dollar body semicolon preserved in statement 2');
    assert.ok(stmts[2].includes(`'it''s; fine'`), 'escaped quote handled in statement 3');
    assert.equal(stmts[3], 'SELECT 1');
  });

  it('migrate applies a file with a semicolon inside a string literal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'c35-mig-ok-'));
    writeFileSync(
      path.join(dir, '001_probe.sql'),
      `CREATE TABLE c35_split_probe (v TEXT);\nINSERT INTO c35_split_probe(v) VALUES ('a;b');\n`,
    );
    await migrate(dir);
    const rows = await query(`SELECT v FROM c35_split_probe`);
    assert.equal(rows.rows[0].v, 'a;b');
    const recorded = await query(`SELECT 1 FROM schema_migrations WHERE name = '001_probe.sql'`);
    assert.equal(recorded.rowCount, 1);
  });

  it('a failing migration file is never recorded and a corrected file applies cleanly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'c35-mig-bad-'));
    const file = path.join(dir, '001_bad.sql');
    writeFileSync(
      file,
      `CREATE TABLE c35_rollback_probe (v TEXT);\nINSERT INTO c35_rollback_probe VALUES ('x');\nTHIS IS NOT SQL;\n`,
    );
    await assert.rejects(() => migrate(dir));
    // The bookkeeping insert lives in the SAME transaction as the file's
    // statements, so a failed file is never marked applied — the next boot
    // retries it instead of crash-looping on a half-recorded state.
    // (DDL rollback itself is real-Postgres transactional semantics;
    // pg-mem is known to leak DDL out of a rolled-back transaction, so the
    // table's survival is not asserted here.)
    const recorded = await query(`SELECT 1 FROM schema_migrations WHERE name = '001_bad.sql'`);
    assert.equal(recorded.rowCount, 0);
    // Correct the file: it must now apply cleanly and be recorded.
    writeFileSync(
      file,
      `CREATE TABLE IF NOT EXISTS c35_rollback_probe (v TEXT);\nINSERT INTO c35_rollback_probe VALUES ('fixed');\n`,
    );
    await migrate(dir);
    const recorded2 = await query(`SELECT 1 FROM schema_migrations WHERE name = '001_bad.sql'`);
    assert.equal(recorded2.rowCount, 1);
  });
});

// ---------------------------------------------------------------- C3-5-3 --
function fakeReply() {
  const r: {
    headers: Record<string, unknown>;
    statusCode: number;
    body: unknown;
    header(k: string, v: unknown): unknown;
    code(c: number): unknown;
    send(b: unknown): unknown;
  } = {
    headers: {},
    statusCode: 200,
    body: undefined,
    header(k, v) {
      r.headers[k] = v;
      return r;
    },
    code(c) {
      r.statusCode = c;
      return r;
    },
    send(b) {
      r.body = b;
      return r;
    },
  };
  return r;
}

describe('C3-5-3 rate limiter isolation + LRU', () => {
  it('a flood against one limiter never resets another limiter\u2019s counter', async () => {
    const login = rateLimit({ name: 'c35-login', windowMs: 60_000, max: 2, key: () => 'victim' });
    const flood = rateLimit({
      name: 'c35-flood',
      windowMs: 60_000,
      max: 1_000_000,
      key: (req) => (req as unknown as { k: string }).k,
    });
    const req = { ip: '203.0.113.9', url: '/x' };
    await login(req, fakeReply() as never);
    await login(req, fakeReply() as never);
    for (let i = 0; i < 10_001; i++) {
      await flood({ ...req, k: `junk-${i}` }, fakeReply() as never);
    }
    const third = fakeReply();
    await login(req, third as never);
    assert.equal(third.statusCode, 429, 'login counter survived the flood (3rd hit is over the limit of 2)');
  });

  it('eviction is LRU: a bucket hit mid-flood survives', async () => {
    const limiter = rateLimit({
      name: 'c35-lru',
      windowMs: 60_000,
      max: 100_000,
      key: (req) => (req as unknown as { k: string }).k,
    });
    const hit = async (k: string) => {
      const r = fakeReply();
      await limiter({ ip: '203.0.113.9', url: '/x', k } as never, r as never);
      return r;
    };
    await hit('busy');
    await hit('busy');
    for (let i = 0; i < 5_000; i++) await hit(`flood-a-${i}`);
    await hit('busy'); // refresh recency mid-flood
    for (let i = 0; i < 5_001; i++) await hit(`flood-b-${i}`);
    const r = await hit('busy');
    assert.equal(
      r.headers['X-RateLimit-Remaining'],
      100_000 - 4,
      'busy bucket kept its count (4 hits) instead of being evicted and reset',
    );
  });
});

// ------------------------------------------------------- C3-5-5b (crypto) --
const NFC_PW = 'café-ouvert-9';
const NFD_PW = NFC_PW.normalize('NFD');

async function legacyRawHash(password: string): Promise<string> {
  const { randomBytes } = await import('node:crypto');
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

describe('C3-5-5b password verification forms', () => {
  it('a current (NFC) hash verifies as nfc', async () => {
    const stored = await hashPassword(NFC_PW);
    assert.equal(await verifyPasswordForm(NFC_PW, stored), 'nfc');
    assert.equal(await verifyPassword(NFC_PW, stored), true);
  });

  it('a pre-F5-21 raw hash verifies via the raw fallback', async () => {
    const stored = await legacyRawHash(NFD_PW);
    // NFC verification alone cannot match this hash (different bytes)…
    assert.equal(await verifyPasswordForm(NFD_PW, stored), 'raw');
    assert.equal(await verifyPassword(NFD_PW, stored), true);
    // …and a wrong password still fails on both paths.
    assert.equal(await verifyPasswordForm('wrong-password', stored), null);
    assert.equal(await verifyPasswordForm(NFC_PW, 'not-a-hash'), null);
  });
});

// ------------------------------------------------------- app-level checks --
describe('C3-5 app-level (body caps, error mapping, login upgrade)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const EMAIL = 'legacy@x.local';

  before(async () => {
    await migrate();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
       VALUES ('m-c35','square','sq-merchant',$1,$2)`,
      [encryptSecret('x'), encryptSecret('x')],
    );
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
       VALUES ('loc-c35','m-c35','square','SQLocC35','SQLocC35','C35 House','CAD')`,
    );
    await query(
      `INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,$2,$3,'owner','loc-c35')`,
      [randomUUID(), EMAIL, await legacyRawHash(NFD_PW)],
    );
    app = await buildApp({ logger: false });
    // Routes that throw raw Postgres errors, to exercise the error handler.
    const thrower = (code: string) => () => {
      const e = new Error(`pg ${code}`) as Error & { code: string };
      e.code = code;
      throw e;
    };
    app.get('/__c35/55p03', thrower('55P03'));
    app.get('/__c35/40p01', thrower('40P01'));
    app.get('/__c35/40001', thrower('40001'));
  });

  after(async () => {
    await app.close();
  });

  it('C3-5-4: an oversized claim body is refused 413 before the route runs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/device/claim',
      payload: { code: '12345678', pad: 'x'.repeat(70_000) },
    });
    assert.equal(res.statusCode, 413);
  });

  it('C3-5-4: an oversized demo-access body is refused 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/demo-access-requests',
      payload: { full_name: 'x'.repeat(70_000) },
    });
    assert.equal(res.statusCode, 413);
  });

  it('C3-5-4: a normal claim still reaches the route (400 invalid code)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/device/claim', payload: { code: '99999999' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /invalid claim code/);
  });

  it('C3-5-6: 55P03 / 40P01 / 40001 all map to retryable 409s', async () => {
    const cases: [string, string][] = [
      ['55p03', 'lock_timeout'],
      ['40p01', 'deadlock_detected'],
      ['40001', 'serialization_failure'],
    ];
    for (const [path, code] of cases) {
      const res = await app.inject({ method: 'GET', url: `/__c35/${path}` });
      assert.equal(res.statusCode, 409, `${path} maps to 409`);
      assert.equal((res.json() as { code: string }).code, code);
    }
  });

  it('C3-5-5b: portal login on a legacy hash succeeds and upgrades it to NFC', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: EMAIL, password: NFD_PW },
    });
    assert.equal(res.statusCode, 200, 'NFD-typed password logs in against its pre-F5-21 hash');
    const after1 = await query<{ password_hash: string }>(
      `SELECT password_hash FROM portal_users WHERE email = $1`,
      [EMAIL],
    );
    assert.equal(
      await verifyPasswordForm(NFD_PW, after1.rows[0].password_hash),
      'nfc',
      'stored hash was rehashed to the NFC form on login',
    );
    // The NFC-typed form now logs in through the fast path too.
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: EMAIL, password: NFC_PW },
    });
    assert.equal(res2.statusCode, 200);
  });
});

// ---------------------------------------------------------------- C3-5-7 --
describe('C3-5-7 config hygiene', () => {
  const good = {
    isProd: true,
    nodeEnv: 'production',
    usePgMem: false,
    squareWebhookKey: 'whsec_x',
    staffApiToken: 'tk'.repeat(20),
    encryptionKeyHex: '0123456789abcdef'.repeat(4),
    adminPasswordHash: `scrypt$${'b'.repeat(32)}$${'c'.repeat(128)}`,
    adminUsername: 'erfan',
    appUrl: 'https://portal.smarttablepay.com',
    squareEnv: 'sandbox',
    squareEnvSet: true,
    squareAccessToken: 'sq-access-token',
    squareLocationId: 'L123456',
    squareAppId: 'sq0idp-x',
    squareAppSecret: 'sq-secret',
    cloverEnv: 'sandbox',
    resendApiKey: 're_test_key',
    helcimApiToken: '',
    shopifyAdminToken: '',
    port: 3000,
    trustProxy: 1,
    isRender: true,
  } as const;

  it('DEMO_ACCESS_NOTIFY_EMAIL carries no hard-coded source default', () => {
    assert.equal(config.demoAccessNotifyEmail, '');
  });

  it('sendDemoAccessEmail skips cleanly when the notify address is unset', async () => {
    const out = await sendDemoAccessEmail('', {
      fullName: 'A',
      restaurantName: 'B',
      email: 'a@b.c',
      phone: '1',
      city: 'X',
      submittedAt: new Date().toISOString(),
    });
    assert.equal(out.sent, false);
    assert.ok(out.skipped && out.skipped.length > 0);
  });

  it('a complete production config produces no Square/admin warnings', () => {
    const warnings: string[] = [];
    assertSafeConfig(good as never, (m) => warnings.push(m));
    assert.ok(!warnings.some((w) => w.includes('SQUARE_APP')), JSON.stringify(warnings));
    assert.ok(!warnings.some((w) => w.includes('ADMIN_USERNAME')), JSON.stringify(warnings));
  });

  it('missing SQUARE_APP_SECRET warns but never refuses the boot (D-7)', () => {
    const warnings: string[] = [];
    assert.doesNotThrow(() =>
      assertSafeConfig({ ...good, squareAppSecret: '' } as never, (m) => warnings.push(m)),
    );
    assert.ok(warnings.some((w) => w.includes('SQUARE_APP_SECRET')));
  });

  it('a missing ADMIN_USERNAME with a hash set warns but never refuses the boot', () => {
    const warnings: string[] = [];
    assert.doesNotThrow(() =>
      assertSafeConfig({ ...good, adminUsername: '' } as never, (m) => warnings.push(m)),
    );
    assert.ok(warnings.some((w) => w.includes('ADMIN_USERNAME')));
  });
});

// ---------------------------------------------------------------- C3-5-2 --
describe('C3-5-2 shutdown hygiene (source shape)', () => {
  it('timers are cleared on close and the drain deadline is 25s', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(src.includes("addHook('onClose'"), 'background timers cleared via onClose');
    assert.ok(src.includes('clearInterval'), 'intervals cleared on close');
    assert.ok(src.includes('25_000'), 'SIGTERM hard-exit deadline is 25s');
    assert.ok(!src.includes('10_000).unref();\n      app'), 'old 10s drain deadline is gone');
  });
});
