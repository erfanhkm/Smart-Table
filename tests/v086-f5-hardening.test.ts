// v0.8.6 — Claude cycle-2 chunk F5 (core platform) regression tests.
// Covers: F5-20 empty-secret round trip, F5-7 tag pinning, F5-21 NFC
// passwords, F5-5 IPv6 /64 rate-limit buckets + Retry-After, F5-8 config
// gates, F5-10 static-HTML CSP fallback, F5-13 308 host redirect,
// F5-14 uniform 404, F5-16 /api no-store + guest body cap.
process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { encryptSecret, decryptSecret, hashPassword, verifyPassword } = await import('../src/crypto.js');
const { assertSafeConfig } = await import('../src/config.js');
const { rateLimit, normalizeIp } = await import('../src/rate-limit.js');
const { buildApp } = await import('../src/index.js');
const { migrate } = await import('../src/migrate.js');
const Fastify = (await import('fastify')).default;

describe('F5-20/F5-7 crypto', () => {
  it('round-trips an empty secret (empty refresh token)', () => {
    assert.equal(decryptSecret(encryptSecret('')), '');
  });
  it('round-trips a normal secret', () => {
    assert.equal(decryptSecret(encryptSecret('tok-123')), 'tok-123');
  });
  it('rejects a truncated auth tag', () => {
    const [iv, ct] = encryptSecret('x').split('.');
    const shortTag = Buffer.alloc(8).toString('base64');
    assert.throws(() => decryptSecret(`${iv}.${ct}.${shortTag}`), /malformed/);
  });
  it('rejects a two-segment value', () => {
    assert.throws(() => decryptSecret('abc.def'), /malformed/);
  });
});

describe('F5-21 password Unicode normalization', () => {
  it('verifies composed input against a decomposed-typed password', async () => {
    const decomposed = 'cafe\u0301-secret'; // e + combining acute
    const composed = 'caf\u00e9-secret'; // é
    const stored = await hashPassword(decomposed);
    assert.equal(await verifyPassword(composed, stored), true);
    assert.equal(await verifyPassword('wrong', stored), false);
  });
});

describe('F5-5 rate limiter IPv6 grouping', () => {
  it('normalizeIp buckets by /64', () => {
    assert.equal(normalizeIp('2001:db8:aaaa:bbbb::1'), '2001:db8:aaaa:bbbb::/64');
    assert.equal(normalizeIp('2001:0db8:aaaa:bbbb:0000:0000:0000:0099'), '2001:0db8:aaaa:bbbb::/64');
    assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
    assert.equal(normalizeIp('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  });
  it('shares one bucket across a /64 and sends Retry-After', async () => {
    const app = Fastify();
    app.addHook('onRequest', rateLimit({ name: 'v086-test', windowMs: 60_000, max: 3 }));
    app.get('/x', async () => ({ ok: true }));
    const hosts = ['2001:db8:aaaa:bbbb::1', '2001:db8:aaaa:bbbb::2', '2001:db8:aaaa:bbbb::3'];
    for (const h of hosts) {
      const r = await app.inject({ method: 'GET', url: '/x', remoteAddress: h });
      assert.equal(r.statusCode, 200);
    }
    const blocked = await app.inject({ method: 'GET', url: '/x', remoteAddress: '2001:db8:aaaa:bbbb::99' });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    const other = await app.inject({ method: 'GET', url: '/x', remoteAddress: '2001:db8:aaaa:cccc::1' });
    assert.equal(other.statusCode, 200);
    await app.close();
  });
});

describe('F5-8 assertSafeConfig gates', () => {
  const good = {
    isProd: true,
    nodeEnv: 'production',
    usePgMem: false,
    squareWebhookKey: 'whsec_x',
    staffApiToken: 'tk'.repeat(20),
    encryptionKeyHex: '0123456789abcdef'.repeat(4),
    adminPasswordHash: '',
    appUrl: 'https://portal.smarttablepay.com',
    squareEnv: 'sandbox',
    squareEnvSet: true,
    squareAccessToken: 'sq-token',
    squareLocationId: 'L123',
    cloverEnv: 'sandbox',
    resendApiKey: 're_x',
    helcimApiToken: '',
    shopifyAdminToken: '',
    port: 3000,
    trustProxy: 1,
    isRender: true,
  } as const;
  const warn = () => undefined;
  it('accepts the full production config', () => {
    assert.doesNotThrow(() => assertSafeConfig(good as never, warn));
  });
  it('refuses an unset SQUARE_ENV in production', () => {
    assert.throws(() => assertSafeConfig({ ...good, squareEnvSet: false } as never, warn), /SQUARE_ENV/);
  });
  it('refuses missing Square billing credentials', () => {
    assert.throws(() => assertSafeConfig({ ...good, squareAccessToken: '' } as never, warn), /SQUARE_ACCESS_TOKEN/);
  });
  it('refuses degenerate secrets', () => {
    assert.throws(() => assertSafeConfig({ ...good, staffApiToken: 'a'.repeat(40) } as never, warn), /STAFF_API_TOKEN/);
    assert.throws(() => assertSafeConfig({ ...good, encryptionKeyHex: 'ab'.repeat(32) } as never, warn), /ENCRYPTION_KEY/);
  });
  it('only warns when RESEND_API_KEY is missing', () => {
    const warnings: string[] = [];
    assert.doesNotThrow(() => assertSafeConfig({ ...good, resendApiKey: '' } as never, (m) => warnings.push(m)));
    assert.ok(warnings.some((w) => w.includes('RESEND_API_KEY')));
  });
});

describe('F5 index-level hardening', () => {
  it('uniform 404, static CSP, redirect and body rules', async () => {
    await migrate();
    const app = await buildApp({ logger: false });

    const nf = await app.inject({ method: 'GET', url: '/no-such-route' });
    assert.equal(nf.statusCode, 404);
    assert.deepEqual(nf.json(), { error: 'not found' });

    const statik = await app.inject({ method: 'GET', url: '/t/index.html' });
    assert.equal(statik.statusCode, 200);
    assert.ok(String(statik.headers['content-security-policy'] ?? '').includes("default-src 'self'"));

    const get = await app.inject({ method: 'GET', url: '/portal', headers: { host: 'smart-table-vc0t.onrender.com' } });
    assert.equal(get.statusCode, 301);
    const post = await app.inject({
      method: 'POST',
      url: '/api/webhooks/square',
      headers: { host: 'smart-table-vc0t.onrender.com', 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(post.statusCode, 308);
    assert.ok(String(post.headers.location).startsWith('https://portal.smarttablepay.com/'));

    const api = await app.inject({ method: 'GET', url: '/api/t/deadbeefcafe/bootstrap' });
    assert.equal(api.headers['cache-control'], 'no-store');

    const big = await app.inject({
      method: 'POST',
      url: '/api/t/deadbeefcafe/order',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(70_000) }),
    });
    assert.equal(big.statusCode, 413);
    await app.close();
  });
});
