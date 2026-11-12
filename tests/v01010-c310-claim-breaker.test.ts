// v0.10.10 (C3-10 M-4): the claim endpoint's GLOBAL attempt ceiling.
// The per-IP budget (15 / 10 min) alone lets a distributed guesser rotate
// source IPs; a second limiter with a constant key caps ALL claim
// attempts at 300 per 10 minutes. This file lives apart from the other
// C3-10 tests because tripping the ceiling takes 301 attempts and the
// limiter state is per-process.
//
// Run: PG_MEM=1 npx tsx --test tests/v01010-c310-claim-breaker.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['c310', 'staff', 'token'].join('-');
process.env.SQUARE_ACCESS_TOKEN = ['c310', 'square', 'token'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { buildApp } = await import('../src/index.js');

let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  await migrate();
  app = await buildApp({ logger: false });
});

describe('global claim ceiling (M-4)', () => {
  it('300 attempts across many IPs pass the limiter; the 301st is a 429', async () => {
    // 20 source IPs x 15 attempts each = 300. Each IP stays within its
    // own per-IP budget of 15, so every response here is the handler's
    // generic 400 for an unknown code — proof the per-IP limiter and the
    // handler both ran.
    for (let ip = 1; ip <= 20; ip++) {
      for (let n = 0; n < 15; n++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/device/claim',
          payload: { code: '00000000' },
          remoteAddress: `198.51.100.${ip}`,
        });
        assert.equal(res.statusCode, 400, `ip ${ip} attempt ${n + 1}: ${res.body}`);
      }
    }
    // Attempt 301, from a FRESH IP whose own budget is untouched: only
    // the global ceiling can refuse it.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/device/claim',
      payload: { code: '00000000' },
      remoteAddress: '203.0.113.99',
    });
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.match(blocked.body, /too many requests/);
  });
});
