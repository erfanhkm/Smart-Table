// Portal CSP regression test (pg-mem): the Billing "Add card" form loads the
// Square Web Payments SDK (script + iframe + tokenization calls) from
// squarecdn/squareup hosts. The portal page's CSP must allowlist them —
// with script-src 'self' only, the SDK was blocked and the form silently
// never rendered (owner report, 2026-10-21).
//
// Run: PG_MEM=1 npx tsx --test tests/portal-csp.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { buildApp } = await import('../src/index.js');

describe('portal CSP allows the Square card form', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    await migrate();
    app = await buildApp();
  });

  it('GET /portal CSP allowlists squarecdn in script-src, frame-src, connect-src', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal' });
    assert.equal(res.statusCode, 200);
    const csp = String(res.headers['content-security-policy'] || '');
    assert.ok(csp.includes("script-src 'self' https://*.squarecdn.com"), `script-src must allow squarecdn: ${csp}`);
    assert.ok(csp.includes('frame-src https://*.squarecdn.com'), `frame-src must allow squarecdn: ${csp}`);
    assert.ok(csp.includes('connect-src'), 'connect-src present');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'portal stays unframable');
  });
});
