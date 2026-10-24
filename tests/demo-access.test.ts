// v0.8.4: POST /api/demo-access-requests (owner-demo gate).
//
//  1. A complete submission -> 200 { ok: true }, one pending row with
//     every field, and one Resend notification carrying the details.
//  2. Missing / invalid required fields -> 400, no row.
//  3. Honeypot filled -> 200 but nothing stored, nothing emailed.
//  4. CORS preflight answers only for the marketing-site origins.
//
// Run: PG_MEM=1 npx tsx --test tests/demo-access.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.RECEIPT_FROM_EMAIL = 'receipts@smarttablepay.com';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');

const resendCalls: { to?: string; subject?: string; reply_to?: string }[] = [];
const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    if (url.startsWith('https://api.resend.com/')) {
      resendCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ id: 'email-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(input as string, init);
  }) as typeof fetch;
}

const validBody = {
  full_name: 'Sara Ahmadi',
  restaurant_name: 'Cafe Luna',
  email: 'sara@cafeluna.ca',
  phone: '604-555-0134',
  city: 'Burnaby',
  pos_system: 'Square',
  locations_count: 2,
  tables_count: '18',
  website: 'https://cafeluna.ca',
  message: 'Interested for our patio season.',
};

describe('v0.8.4 demo access requests', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    installFetch();
    await migrate();
    app = await buildApp({ logger: false });
  });
  after(async () => {
    await app.close();
    globalThis.fetch = origFetch;
  });

  const post = (payload: unknown, headers: Record<string, string> = {}, ip = '127.0.0.10') =>
    app.inject({ method: 'POST', url: '/api/demo-access-requests', payload, headers, remoteAddress: ip });

  it('stores a complete request as pending and emails the details', async () => {
    const res = await post(validBody, { origin: 'https://smarttablepay.com' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(res.headers['access-control-allow-origin'], 'https://smarttablepay.com');

    const rows = await query(`SELECT * FROM demo_access_requests WHERE email = 'sara@cafeluna.ca'`);
    assert.equal(rows.rowCount, 1);
    const r = rows.rows[0] as Record<string, unknown>;
    assert.equal(r.status, 'pending');
    assert.equal(r.full_name, 'Sara Ahmadi');
    assert.equal(r.restaurant_name, 'Cafe Luna');
    assert.equal(r.locations_count, 2);
    assert.equal(r.tables_count, 18);

    assert.equal(resendCalls.length, 1);
    assert.equal(resendCalls[0].reply_to, 'sara@cafeluna.ca');
    assert.match(String(resendCalls[0].subject), /Cafe Luna/);
  });

  it('rejects missing or invalid fields with 400 and stores nothing', async () => {
    const before = (await query(`SELECT COUNT(*)::int AS n FROM demo_access_requests`)).rows[0] as { n: number };
    let i = 0;
    for (const bad of [
      { ...validBody, email: 'not-an-email' },
      { ...validBody, full_name: '' },
      { ...validBody, restaurant_name: undefined },
      { ...validBody, phone: undefined },
      { ...validBody, city: undefined },
      { ...validBody, locations_count: -3 },
    ]) {
      const res = await post(bad, {}, `127.0.1.${++i}`);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
    }
    const after = (await query(`SELECT COUNT(*)::int AS n FROM demo_access_requests`)).rows[0] as { n: number };
    assert.equal(after.n, before.n);
  });

  it('honeypot submissions look successful but store and send nothing', async () => {
    const emailsBefore = resendCalls.length;
    const res = await post({ ...validBody, email: 'bot@spam.example', company_fax: '1-800-spam' }, {}, '127.0.0.99');
    assert.equal(res.statusCode, 200);
    const rows = await query(`SELECT * FROM demo_access_requests WHERE email = 'bot@spam.example'`);
    assert.equal(rows.rowCount, 0);
    assert.equal(resendCalls.length, emailsBefore);
  });

  it('answers CORS preflight only for the site origins', async () => {
    const okRes = await app.inject({
      method: 'OPTIONS', url: '/api/demo-access-requests',
      headers: { origin: 'https://smarttablepay.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(okRes.statusCode, 204);
    assert.equal(okRes.headers['access-control-allow-origin'], 'https://smarttablepay.com');

    const badRes = await app.inject({
      method: 'OPTIONS', url: '/api/demo-access-requests',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(badRes.headers['access-control-allow-origin'], undefined);
  });
});
