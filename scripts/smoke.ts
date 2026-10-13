// End-to-end smoke test: boots the real API with an in-memory DB, drives the
// HTTP endpoints, and verifies the full payment flow against the Square sandbox.
// Requires: SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID in the environment.
process.env.PG_MEM = '1';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'ab'.repeat(32); // dev-only

import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/index.js';
import { migrate } from '../src/migrate.js';
import { query } from '../src/db.js';
import { config } from '../src/config.js';
import { createOrder } from '../src/square.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok - ${msg}`);
}

const locationId = config.squareLocationId;
if (!config.squareAccessToken || !locationId) {
  console.error('SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID must be set');
  process.exit(1);
}

const app = await buildApp({ logger: false });
await migrate();

await query(
  `INSERT INTO merchants(id, square_merchant_id, access_token_enc, refresh_token_enc)
   VALUES ('m1','smoke','x','x') ON CONFLICT DO NOTHING`,
);
await query(
  `INSERT INTO locations(id, merchant_id, square_location_id, name, currency)
   VALUES ('l1','m1',$1,'Smoke Test Diner','USD') ON CONFLICT DO NOTHING`,
  [locationId],
);
const t1Token = randomUUID().replace(/-/g, '');
const t2Token = randomUUID().replace(/-/g, '');
await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ('t1','l1','T1',$1,'FREE') ON CONFLICT DO NOTHING`, [t1Token]);
await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ('t2','l1','T2',$1,'FREE') ON CONFLICT DO NOTHING`, [t2Token]);

await app.listen({ port: 0 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
const J = { 'Content-Type': 'application/json' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(path: string, body: unknown): Promise<{ status: number; j: any }> {
  const r = await fetch(base + path, { method: 'POST', headers: J, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(path: string): Promise<{ status: number; j: any }> {
  const r = await fetch(base + path);
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

try {
  console.log('1. create Square order in sandbox');
  const { order } = await createOrder(locationId, [{ name: 'Smoke Burger', quantity: '2', amountCents: 1200 }], 'USD');
  assert(order.state === 'OPEN', `order ${order.id} is OPEN`);

  console.log('2. staff links check to T1');
  let r = await post('/api/tables/t1/link-check', { square_order_id: order.id, total_cents: 2400, currency: 'USD' });
  assert(r.status === 200 && r.j.ok === true, 'link-check ok');

  console.log('3. guest scans QR, sees the $24 bill');
  r = await get(`/api/t/${t1Token}`);
  assert(r.j.table?.name === 'T1', 'table resolved from QR token');
  assert(r.j.check?.remaining_cents === 2400, `remaining is 2400 (got ${r.j.check?.remaining_cents})`);

  console.log('4. guest pays $10 (custom split)');
  r = await post(`/api/checks/${order.id}/pay`, { mode: 'custom', amount_cents: 1000 });
  assert(r.status === 200, `pay accepted (status ${r.status})`);
  assert(r.j.remainingCents === 1400 && r.j.checkState === 'OPEN', 'remaining 1400, still OPEN');

  console.log('5. guest pays remaining $14 -> bill closes');
  r = await post(`/api/checks/${order.id}/pay`, { mode: 'custom', amount_cents: 1400 });
  assert(r.j.remainingCents === 0 && r.j.checkState === 'COMPLETED', 'check COMPLETED');

  console.log('6. dashboard shows T1 as PAID');
  r = await get('/api/dashboard/overview');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(r.j.tables.find((t: any) => t.id === 't1')?.state === 'PAID', 'T1 is PAID');

  console.log('7. overpayment is rejected');
  const { order: o2 } = await createOrder(locationId, [{ name: 'Smoke Fries', quantity: '1', amountCents: 500 }], 'USD');
  r = await post('/api/tables/t2/link-check', { square_order_id: o2.id, total_cents: 500, currency: 'USD' });
  assert(r.status === 200, 'T2 linked');
  r = await post(`/api/checks/${o2.id}/pay`, { mode: 'custom', amount_cents: 99999 });
  assert(r.status === 400, `overpay rejected with 400 (got ${r.status})`);

  console.log('8. webhook delivery is idempotent');
  const hook = {
    event_id: 'evt-smoke-1',
    type: 'order.updated',
    data: { object: { order: { id: order.id, state: 'COMPLETED' } } },
  };
  r = await post('/api/webhooks/square', hook);
  assert(r.j.ok === true && !r.j.deduped, 'first delivery processed');
  r = await post('/api/webhooks/square', hook);
  assert(r.j.deduped === true, 'second delivery deduped');

  console.log('9. waiter call -> ack -> metrics');
  r = await post('/api/tables/t1/call-waiter', {});
  assert(r.j.ok === true, 'call-waiter ok');
  r = await get('/api/dashboard/overview');
  assert(r.j.waiter_calls.length === 1, '1 open waiter call');
  await post('/api/tables/t1/ack-call', {});
  r = await get('/api/dashboard/overview');
  assert(r.j.waiter_calls.length === 0, 'call acknowledged');
  r = await get('/api/dashboard/metrics');
  assert(r.j.settled_checks === 1 && r.j.avg_settlement_secs != null, `metrics computed (settlement ${r.j.avg_settlement_secs}s)`);

  console.log('\nSMOKE PASS');
} finally {
  await app.close();
}
process.exit(0);
