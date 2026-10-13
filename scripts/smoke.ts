// End-to-end smoke test: boots the real API with an in-memory DB, drives the
// HTTP endpoints, and verifies the full payment flow against the Square sandbox.
// Requires: SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID in the environment.
// Optional:  SMOKE_CARD=1  also tries the guest card path with Square's sandbox test nonce
//            (the card path is NOT yet proven in the sandbox, so it is informational, not a gate).
//
// The env must be set BEFORE src/config.ts is evaluated. Static `import` statements are hoisted above
// any code in this file, so the app modules are loaded with dynamic import() after the env is ready.
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'ab'.repeat(32); // dev-only
const STAFF = `smoke-${randomUUID()}-${randomUUID()}`;
process.env.STAFF_API_TOKEN = STAFF;
delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY; // exercise the non-production "unverified webhook" path

const { buildApp } = await import('../src/index.js');
const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { createOrder } = await import('../src/square.js');

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
// A second location that is NOT the Square sandbox location the orders are created in.
await query(
  `INSERT INTO locations(id, merchant_id, square_location_id, name, currency)
   VALUES ('l2','m1','OTHERLOCATION','Other Diner','USD') ON CONFLICT DO NOTHING`,
);
const t1Token = randomUUID().replace(/-/g, '');
const t2Token = randomUUID().replace(/-/g, '');
const t3Token = randomUUID().replace(/-/g, '');
await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ('t1','l1','T1',$1,'FREE') ON CONFLICT DO NOTHING`, [t1Token]);
await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ('t2','l1','T2',$1,'FREE') ON CONFLICT DO NOTHING`, [t2Token]);
await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ('t3','l2','T3',$1,'FREE') ON CONFLICT DO NOTHING`, [t3Token]);

await app.listen({ port: 0 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

type Res = { status: number; j: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function headers(auth: string | false): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) h.Authorization = `Bearer ${auth}`;
  return h;
}
/** Staff by default; pass `false` for an anonymous (guest) call or a string for a specific token. */
async function post(path: string, body: unknown, auth: string | false = STAFF): Promise<Res> {
  const r = await fetch(base + path, { method: 'POST', headers: headers(auth), body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function get(path: string, auth: string | false = STAFF): Promise<Res> {
  const r = await fetch(base + path, { headers: headers(auth) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

try {
  console.log('0. security gates (no Square needed)');
  let r = await get('/api/dashboard/overview?location_id=l1', false);
  assert(r.status === 401, 'dashboard overview without token -> 401');
  r = await get('/api/dashboard/overview?location_id=l1', 'wrong-token');
  assert(r.status === 401 && r.j.error === 'unauthorized', 'dashboard overview with wrong token -> 401 JSON');
  for (const [m, p] of [
    ['POST', '/api/tables'], ['POST', '/api/tables/t1/link-check'], ['POST', '/api/tables/t1/free'],
    ['POST', '/api/tables/t1/ack-call'], ['POST', '/api/checks/ORDER1/record-external-payment'],
  ] as const) {
    const rr = await fetch(base + p, { method: m, headers: headers(false), body: '{}' });
    assert(rr.status === 401, `${m} ${p} without token -> 401`);
  }
  for (const p of ['/api/locations', '/api/square-open-orders?location_id=l1', '/api/dashboard/metrics?location_id=l1', '/api/tables?location_id=l1']) {
    const rr = await fetch(base + p);
    assert(rr.status === 401, `GET ${p} without token -> 401`);
  }
  r = await get('/api/dashboard/overview');
  assert(r.status === 400, 'overview without location_id -> 400 (no unfiltered fallback)');
  r = await get('/healthz', false);
  assert(r.status === 200, 'healthz is public');
  r = await get(`/api/t/${t1Token}`, false);
  assert(r.status === 200 && r.j.table?.name === 'T1', 'guest QR resolve is public');

  const k0 = randomUUID();
  r = await post('/api/checks/ORDER1/pay', { mode: 'full', idempotency_key: k0 }, false);
  assert(r.status === 400 && /card_nonce/.test(r.j.error), 'guest pay without card_nonce -> 400');
  r = await post('/api/checks/ORDER1/pay', { mode: 'full', card_nonce: 'EXTERNAL', idempotency_key: k0 }, false);
  assert(r.status === 400, 'guest pay with card_nonce=EXTERNAL -> 400');
  r = await post('/api/checks/ORDER1/pay', { mode: 'full', card_nonce: 'cnon:card-nonce-ok' }, false);
  assert(r.status === 400 && /idempotency_key/.test(r.j.error), 'guest pay without idempotency_key -> 400');
  r = await post('/api/checks/bad.id/pay', { mode: 'full', card_nonce: 'cnon:x', idempotency_key: k0 }, false);
  assert(r.status === 400 && /invalid orderId/.test(r.j.error), 'malformed order id rejected before any Square call');
  r = await get('/api/checks/..%2F..%2Fv2%2Flocations', false);
  assert(r.status === 400 || r.status === 404, `path-traversal order id rejected (status ${r.status})`);
  r = await post('/api/tables/t1/link-check', { square_order_id: '../v2/locations' });
  assert(r.status === 400, 'link-check with malformed order id -> 400');

  console.log('1. create Square order in sandbox');
  const { order } = await createOrder(locationId, [{ name: 'Smoke Burger', quantity: '2', amountCents: 1200 }], 'USD');
  assert(order.state === 'OPEN', `order ${order.id} is OPEN`);

  console.log('2. staff links check to T1 (and a wrong-location link is refused)');
  r = await post('/api/tables/t3/link-check', { square_order_id: order.id });
  assert(r.status === 403, `linking to a table of another Square location -> 403 (got ${r.status})`);
  r = await post('/api/tables/t1/link-check', { square_order_id: order.id, total_cents: 1, currency: 'XXX' });
  assert(r.status === 200 && r.j.ok === true, 'link-check ok (client total/currency are ignored)');
  const chk = await query(`SELECT merchant_id, total_cents, currency FROM checks WHERE square_order_id = $1`, [order.id]);
  assert(chk.rows[0]?.merchant_id === 'm1', 'merchant stored on the check');
  assert(chk.rows[0]?.total_cents === 2400 && chk.rows[0]?.currency === 'USD', 'total/currency taken from Square');

  console.log('3. guest scans QR, sees the $24 bill');
  r = await get(`/api/t/${t1Token}`, false);
  assert(r.j.table?.name === 'T1', 'table resolved from QR token');
  assert(r.j.check?.remaining_cents === 2400, `remaining is 2400 (got ${r.j.check?.remaining_cents})`);

  console.log('4. staff records $10 cash (custom split), idempotently');
  const k1 = randomUUID();
  const ext = `/api/checks/${order.id}/record-external-payment`;
  r = await post(ext, { mode: 'custom', amount_cents: 1000, idempotency_key: k1 });
  assert(r.status === 200, `external payment accepted (status ${r.status})`);
  assert(r.j.remainingCents === 1400 && r.j.checkState === 'OPEN' && r.j.replayed === false, 'remaining 1400, still OPEN');
  const firstPaymentId: string = r.j.paymentId;
  r = await post(ext, { mode: 'custom', amount_cents: 1000, idempotency_key: k1 });
  assert(r.status === 200 && r.j.replayed === true && r.j.paymentId === firstPaymentId, 'same idempotency_key -> stored result, same payment');
  r = await get(`/api/t/${t1Token}`, false);
  assert(r.j.check?.remaining_cents === 1400, 'replay did not charge again (remaining still 1400)');
  r = await post(ext, { mode: 'custom', amount_cents: 500, idempotency_key: k1 });
  assert(r.status === 409, `same key with a different amount -> 409 (got ${r.status})`);

  console.log('5. staff records the remaining $14 -> bill closes');
  r = await post(ext, { mode: 'custom', amount_cents: 1400, idempotency_key: randomUUID() });
  assert(r.j.remainingCents === 0 && r.j.checkState === 'COMPLETED', 'check COMPLETED');

  console.log('6. dashboard shows T1 as PAID');
  r = await get('/api/dashboard/overview?location_id=l1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(r.j.tables.find((t: any) => t.id === 't1')?.state === 'PAID', 'T1 is PAID');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(!r.j.tables.some((t: any) => t.id === 't3'), 'overview of l1 does not list the tables of l2');

  console.log('7. overpayment and bad tips are rejected');
  const { order: o2 } = await createOrder(locationId, [{ name: 'Smoke Fries', quantity: '1', amountCents: 500 }], 'USD');
  r = await post('/api/tables/t2/link-check', { square_order_id: o2.id });
  assert(r.status === 200, 'T2 linked');
  const ext2 = `/api/checks/${o2.id}/record-external-payment`;
  r = await post(ext2, { mode: 'custom', amount_cents: 99999, idempotency_key: randomUUID() });
  assert(r.status === 400, `overpay rejected with 400 (got ${r.status})`);
  r = await post(ext2, { mode: 'custom', amount_cents: 100, tip_cents: 101, idempotency_key: randomUUID() });
  assert(r.status === 400, 'tip greater than the amount -> 400');
  r = await post(ext2, { mode: 'custom', amount_cents: 100, tip_cents: -5, idempotency_key: randomUUID() });
  assert(r.status === 400, 'negative tip -> 400');
  r = await post(ext2, { mode: 'custom', amount_cents: 100, tip_cents: 1.5, idempotency_key: randomUUID() });
  assert(r.status === 400, 'fractional tip -> 400');
  r = await post(ext2, { mode: 'custom', amount_cents: 100, idempotency_key: 'not-a-uuid' });
  assert(r.status === 400, 'non-UUID idempotency_key -> 400');

  if (process.env.SMOKE_CARD === '1') {
    console.log('7b. (optional, informational) guest card path with the sandbox test nonce');
    r = await post(`/api/checks/${o2.id}/pay`, { mode: 'full', card_nonce: 'cnon:card-nonce-ok', idempotency_key: randomUUID() }, false);
    console.log(`  info - card path status ${r.status} ${JSON.stringify(r.j)}`);
  }

  console.log('8. webhook delivery is idempotent');
  const hook = {
    event_id: 'evt-smoke-1',
    type: 'order.updated',
    data: { object: { order: { id: order.id, state: 'COMPLETED' } } },
  };
  r = await post('/api/webhooks/square', hook, false);
  assert(r.j.ok === true && !r.j.deduped, 'first delivery processed');
  r = await post('/api/webhooks/square', hook, false);
  assert(r.j.deduped === true, 'second delivery deduped');

  console.log('9. waiter call -> ack -> metrics');
  r = await post('/api/tables/t1/call-waiter', {}, false);
  assert(r.j.ok === true, 'call-waiter ok (public)');
  r = await get('/api/dashboard/overview?location_id=l1');
  assert(r.j.waiter_calls.length === 1, '1 open waiter call');
  r = await get('/api/dashboard/overview?location_id=l2');
  assert(r.j.waiter_calls.length === 0, 'l2 does not see l1 waiter calls');
  await post('/api/tables/t1/ack-call', {});
  r = await get('/api/dashboard/overview?location_id=l1');
  assert(r.j.waiter_calls.length === 0, 'call acknowledged');
  r = await get('/api/dashboard/metrics?location_id=l1');
  assert(r.j.settled_checks === 1 && r.j.avg_settlement_secs != null, `metrics computed (settlement ${r.j.avg_settlement_secs}s)`);

  console.log('\nSMOKE PASS');
} finally {
  await app.close();
}
process.exit(0);
