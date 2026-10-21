// Root redirect test (pg-mem): GET / on the portal subdomain must redirect
// to /portal instead of 404ing (owner hit the bare root URL, 2026-10-21).
//
// Run: PG_MEM=1 npx tsx --test tests/root-redirect.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { buildApp } = await import('../src/index.js');

describe('root redirect', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  before(async () => {
    await migrate();
    app = await buildApp();
  });

  it('GET / -> 302 to /portal', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/portal');
  });
});
