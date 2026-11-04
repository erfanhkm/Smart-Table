// v0.10.3 — Claude cycle-3 chunk C3-4 hardening tests (pg-mem + mocked POS).
//
// Proves:
//  C3-4-1  POST /order sits behind the per-token write limiter (source
//          shape) — it previously had no route limiter at all.
//  C3-4-2  loyalty: payment_id is REQUIRED (no membership-oracle lookup);
//          a payment claimed by a DIFFERENT phone reveals zeroed progress;
//          Persian digits normalize to ASCII; a PENDING refund blocks;
//          simultaneous first submissions for one phone count once.
//  C3-4-3  claims: rejected on a non-open check; a stale claim (bill item
//          changed under its index) is replaced, not blocking; per-device
//          cap of 20 claims per check; claims limiter keys on token+IP,
//          not the unvalidated body device_id (source shape).
//  C3-4-4  bill detail cache is single-flight: 10 concurrent polls at a
//          cache miss produce exactly ONE POS read.
//  C3-4-5  a failed post-order read-back answers check:null +
//          pending_detail (never a zero-remaining "paid" bill); the stored
//          total self-heals on the next poll; a same-key replay with the
//          SAME cart duplicates, with a DIFFERENT cart is a 400.
//  C3-4-6  a FREE table's OPEN check is payable (the check is the
//          authority); 10 recent FAILED attempts cap new charges at 429;
//          card-config refuses a non-open check.
//
// Run: PG_MEM=1 npx tsx --test tests/v0103-c34-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-token';
process.env.SQUARE_ACCESS_TOKEN = 'test-square-token';
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';
process.env.SQUARE_APP_ID = 'sq0idp-test';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.RECEIPT_FROM_EMAIL = 'receipts@smarttablepay.com';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---- Square fixture ---------------------------------------------------------
const paidOrders = new Set<string>();
let readBackFails = false;
let resendFails = false;
let sfGetCount = 0;

function sqOrder(id: string, items: { name: string; qty: number; amount: number }[], paid = false) {
  const total = items.reduce((s, i) => s + i.amount * i.qty, 0);
  return {
    id, location_id: 'SQL-C34', state: paid ? 'COMPLETED' : 'OPEN',
    line_items: items.map((i) => ({
      name: i.name, quantity: String(i.qty),
      total_money: { amount: i.amount * i.qty, currency: 'CAD' },
    })),
    total_money: { amount: total, currency: 'CAD' },
    net_amount_due_money: { amount: paid ? 0 : total, currency: 'CAD' },
    tenders: paid
      ? [{ id: `T-${id}`, payment_id: `sqpay-${id}`, type: 'CARD', amount_money: { amount: total, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' } }]
      : [],
  };
}

const BURGER = [{ name: 'Burger', qty: 1, amount: 1200 }];
const DISHES = Array.from({ length: 25 }, (_, i) => ({ name: `Dish ${i}`, qty: 1, amount: 100 + i }));

function orderFor(id: string) {
  switch (id) {
    case 'ORD-NEW': return sqOrder(id, BURGER);
    case 'ord-claims': return sqOrder(id, DISHES);
    case 'ord-free': return sqOrder(id, BURGER, paidOrders.has(id));
    case 'ord-sf': return sqOrder(id, BURGER);
    case 'ord-rcpt': return sqOrder(id, BURGER);
    default: return sqOrder(id, BURGER);
  }
}

const CATALOG = {
  objects: [
    { id: 'ITEM1', type: 'ITEM', item_data: { name: 'Burger', variations: [{ id: 'VAR1', type: 'ITEM_VARIATION', item_variation_data: { name: 'Regular', price_money: { amount: 1200, currency: 'CAD' } } }] } },
    { id: 'ITEM2', type: 'ITEM', item_data: { name: 'Fries', variations: [{ id: 'VAR2', type: 'ITEM_VARIATION', item_variation_data: { name: 'Regular', price_money: { amount: 500, currency: 'CAD' } } }] } },
  ],
};

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('https://api.resend.com')) {
      if (resendFails) return json({ error: 'provider boom' }, 500);
      return json({ id: 'em-c34' });
    }
    const u = new URL(url);
    if (u.pathname === '/v2/catalog/search' && method === 'POST') return json(CATALOG);
    if (u.pathname === '/v2/orders' && method === 'POST') return json({ order: { id: 'ORD-NEW' } });
    if (u.pathname === '/v2/payments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { order_id?: string; amount_money?: { amount: number } };
      if (body.order_id) paidOrders.add(body.order_id);
      return json({ payment: { id: `sqpay-${body.order_id ?? 'x'}`, status: 'COMPLETED', amount_money: body.amount_money ?? { amount: 0, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' } } });
    }
    const payOrder = /\/v2\/orders\/([\w-]+)\/pay$/.exec(u.pathname);
    if (payOrder && method === 'POST') return json({ order: orderFor(payOrder[1]) });
    const getOrder = /\/v2\/orders\/([\w-]+)$/.exec(u.pathname);
    if (getOrder && method === 'GET') {
      const id = getOrder[1];
      if (id === 'ORD-NEW' && readBackFails) return json({ errors: [{ code: 'INTERNAL', detail: 'read-back boom' }] }, 500);
      if (id === 'ord-sf') {
        sfGetCount++;
        await new Promise((r) => setTimeout(r, 60));
      }
      return json({ order: orderFor(id) });
    }
    return json({ errors: [{ code: 'NOT_FOUND', detail: `unexpected: ${method} ${url}` }] }, 404);
  }) as typeof fetch;
}

// ---- tests ------------------------------------------------------------------
describe('v0.10.3 C3-4 hardening', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let merchantId = '';
  let locationId = '';
  const tok: Record<string, string> = {};
  const checkDb: Record<string, string> = {};

  async function seedTable(name: string, state: string): Promise<string> {
    const id = randomUUID();
    const token = `tok-${randomUUID().replace(/-/g, '')}`;
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,$5)`, [id, locationId, name, token, state]);
    tok[name] = token;
    return id;
  }
  async function seedCheck(tableId: string, ref: string, state: string, total = 1200): Promise<string> {
    const id = randomUUID();
    await query(
      `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
       VALUES ($1,$2,$3,$4,$4,'square',$5,$6,$7,'CAD')`,
      [id, tableId, locationId, ref, merchantId, state, total],
    );
    checkDb[ref] = id;
    return id;
  }
  async function seedPayment(checkId: string, ref: string, status = 'COMPLETED', amount = 1200): Promise<string> {
    const id = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref, currency)
       VALUES ($1,$2,$3,0,$4,$5,$6,'CAD')`,
      [id, checkId, amount, status, randomUUID(), ref],
    );
    return id;
  }
  function post(path: string, body: unknown) {
    return app.inject({ method: 'POST', url: path, payload: body as Record<string, unknown> });
  }
  const fp = (i: number) => `Dish ${i}|1|${100 + i}`;

  before(async () => {
    installFetch();
    await migrate();
    app = await buildApp({ logger: false });

    merchantId = randomUUID();
    locationId = randomUUID();
    await query(
      `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,'square',$2,$2,$3,$4,'2099-06-01T00:00:00Z')`,
      [merchantId, 'sqm-c34', encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, qr_ordering_enabled, loyalty_enabled, loyalty_visits_required, loyalty_reward_text)
       VALUES ($1,$2,'square','SQL-C34','SQL-C34','C34 House','CAD',false,true,true,5,'Free dessert')`,
      [locationId, merchantId],
    );
    await query(
      `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,$2,'square','sqm-c34',$3,$4,'2099-06-01T00:00:00Z')`,
      [randomUUID(), merchantId, encryptSecret('sq-token'), encryptSecret('sq-refresh')],
    );

    await seedTable('ORD', 'SEATED');
    const claimTable = await seedTable('CLAIM', 'SEATED');
    await seedCheck(claimTable, 'ord-claims', 'OPEN', 3250);
    await seedCheck(claimTable, 'ord-closed', 'COMPLETED', 1200);
    const freeTable = await seedTable('FREE', 'FREE');
    await seedCheck(freeTable, 'ord-free', 'OPEN');
    const capTable = await seedTable('CAP', 'SEATED');
    const capCheck = await seedCheck(capTable, 'ord-cap', 'OPEN');
    for (let i = 0; i < 10; i++) await seedPayment(capCheck, `fail-${i}`, 'FAILED');
    const sfTable = await seedTable('SF', 'SEATED');
    await seedCheck(sfTable, 'ord-sf', 'OPEN');
    const loyTable = await seedTable('LOY', 'SEATED');
    const loyCheck = await seedCheck(loyTable, 'ord-loy', 'OPEN');
    await seedPayment(loyCheck, 'pay-loy-a');
    await seedPayment(loyCheck, 'pay-loy-b');
    const pendingRefundPay = await seedPayment(loyCheck, 'pay-loy-pending-refund');
    await query(
      `INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, status, idempotency_key)
       VALUES ($1,$2,$3,$4,1200,'CAD','PENDING',$5)`,
      [randomUUID(), pendingRefundPay, loyCheck, locationId, randomUUID()],
    );
    const rcptTable = await seedTable('RCPT', 'SEATED');
    const rcptCheck = await seedCheck(rcptTable, 'ord-rcpt', 'OPEN');
    await seedPayment(rcptCheck, 'pay-rcpt-1');
  });

  after(async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    await app?.close();
  });

  it('C3-4-5: failed read-back answers pending_detail, the poll self-heals, cart changes under a kept key are rejected', async () => {
    const key = randomUUID();
    readBackFails = true;
    const placed = await post(`/api/t/${tok.ORD}/order`, { items: [{ menu_item_id: 'VAR1', quantity: 1 }], idempotency_key: key });
    readBackFails = false;
    assert.equal(placed.statusCode, 200, placed.body);
    const placedBody = placed.json();
    assert.equal(placedBody.ok, true);
    assert.equal(placedBody.check, null, 'a zero-remaining bill must never reach the client');
    assert.equal(placedBody.pending_detail, true);
    const stored = await query(`SELECT total_cents FROM checks WHERE external_check_ref = 'ORD-NEW'`);
    assert.equal(Number(stored.rows[0].total_cents), 0, 'linked with the minimal detail');

    const poll = await app.inject({ method: 'GET', url: `/api/t/${tok.ORD}` });
    assert.equal(poll.statusCode, 200, poll.body);
    assert.equal(poll.json().check.total_cents, 1200, 'the poll shows the real bill');
    await new Promise((r) => setTimeout(r, 100));
    const healed = await query(`SELECT total_cents FROM checks WHERE external_check_ref = 'ORD-NEW'`);
    assert.equal(Number(healed.rows[0].total_cents), 1200, 'stored total self-healed from the live detail');

    const replay = await post(`/api/t/${tok.ORD}/order`, { items: [{ menu_item_id: 'VAR1', quantity: 1 }], idempotency_key: key });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().duplicate, true);
    assert.equal(replay.json().check.total_cents, 1200);

    const changed = await post(`/api/t/${tok.ORD}/order`, { items: [{ menu_item_id: 'VAR2', quantity: 1 }], idempotency_key: key });
    assert.equal(changed.statusCode, 400, changed.body);
    assert.match(changed.body, /different cart/);
  });

  it('C3-4-3: claims gate on open checks, replace stale claims, and cap per device', async () => {
    const devA = randomUUID();
    const devB = randomUUID();
    const claim = (ref: string, device: string, idx: number, fingerprint: string) =>
      post(`/api/checks/${ref}/claims?table_token=${tok.CLAIM}`, { item_index: idx, fingerprint, device_id: device });

    const closed = await claim('ord-closed', devA, 0, fp(0));
    assert.equal(closed.statusCode, 400, closed.body);
    assert.match(closed.body, /not open/);

    // A stale claim from a previous bill shape sits on index 0.
    await query(
      `INSERT INTO item_claims(id, check_id, item_index, item_fingerprint, device_id) VALUES ($1,$2,0,'Old Dish|1|1',$3)`,
      [randomUUID(), checkDb['ord-claims'], randomUUID()],
    );
    const fresh = await claim('ord-claims', devA, 0, fp(0));
    assert.equal(fresh.statusCode, 200, fresh.body);
    const rival = await claim('ord-claims', devB, 0, fp(0));
    assert.equal(rival.statusCode, 409, rival.body);

    // Per-device cap: devB claims 20 more items, the 21st is refused.
    for (let i = 1; i <= 20; i++) {
      const r = await claim('ord-claims', devB, i, fp(i));
      assert.equal(r.statusCode, 200, `claim ${i}: ${r.body}`);
    }
    const over = await claim('ord-claims', devB, 21, fp(21));
    assert.equal(over.statusCode, 409, over.body);
    assert.match(over.body, /maximum number of items/);
  });

  it('C3-4-4: ten concurrent bill polls share one POS read (single-flight)', async () => {
    const res = await Promise.all(
      Array.from({ length: 10 }, () => app.inject({ method: 'GET', url: `/api/t/${tok.SF}` })),
    );
    for (const r of res) assert.equal(r.statusCode, 200, r.body);
    assert.equal(sfGetCount, 1, `expected exactly one POS read, got ${sfGetCount}`);
  });

  it('C3-4-6: a FREE table with an OPEN check can still pay it', async () => {
    const res = await post(`/api/checks/ord-free/pay?table_token=${tok.FREE}`, {
      card_nonce: 'cnon:test', idempotency_key: randomUUID(), mode: 'full',
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = await query(`SELECT status FROM payments WHERE check_id = $1 AND status IN ('COMPLETED','AUTHORIZED')`, [checkDb['ord-free']]);
    assert.ok(rows.rowCount > 0, 'the payment settled despite the FREE table');
  });

  it('C3-4-6: ten recent FAILED attempts cap new charges; card-config refuses a closed check', async () => {
    const capped = await post(`/api/checks/ord-cap/pay?table_token=${tok.CAP}`, {
      card_nonce: 'cnon:test', idempotency_key: randomUUID(), mode: 'full',
    });
    assert.equal(capped.statusCode, 429, capped.body);
    assert.match(capped.body, /failed payment attempts/);

    const cfg = await app.inject({ method: 'GET', url: `/api/checks/ord-closed/card-config?table_token=${tok.CLAIM}` });
    assert.equal(cfg.statusCode, 400, cfg.body);
    assert.match(cfg.body, /not open/);
  });

  it('C3-4-2: loyalty gating — oracle closed, foreign claim zeroed, digits normalized, pending refund blocks, double-submit counts once', async () => {
    const loy = (body: unknown) => post(`/api/t/${tok.LOY}/loyalty`, body);

    const noPay = await loy({ phone: '6045550101' });
    assert.equal(noPay.statusCode, 400, noPay.body);
    assert.match(noPay.body, /payment_id is required/);

    // Phone A counts its own payment.
    const aFirst = await loy({ phone: '6045550101', payment_id: 'pay-loy-a' });
    assert.equal(aFirst.statusCode, 200, aFirst.body);
    assert.equal(aFirst.json().counted, true);
    assert.equal(aFirst.json().visits, 1);

    // Phone B has its OWN progress (1 visit via its own payment)…
    const bFirst = await loy({ phone: '6045559999', payment_id: 'pay-loy-b' });
    assert.equal(bFirst.json().counted, true);
    assert.equal(bFirst.json().visits, 1);
    // …but presenting A's already-claimed payment reveals NOTHING about B.
    const bForeign = await loy({ phone: '6045559999', payment_id: 'pay-loy-a' });
    assert.equal(bForeign.statusCode, 200, bForeign.body);
    assert.equal(bForeign.json().counted, false);
    assert.equal(bForeign.json().visits, 0, 'foreign claim must zero the progress answer');
    assert.equal(bForeign.json().total_rewards, 0);

    // Persian digits for A's number resolve to A's own hash (progress 1).
    const faDigits = '6045550101'.split('').map((d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]).join('');
    const aFa = await loy({ phone: faDigits, payment_id: 'pay-loy-a' });
    assert.equal(aFa.statusCode, 200, aFa.body);
    assert.equal(aFa.json().visits, 1, 'Persian-digit input must reach the same loyalty row');

    // A payment under a PENDING refund counts nothing.
    const pending = await loy({ phone: '6045557777', payment_id: 'pay-loy-pending-refund' });
    assert.equal(pending.statusCode, 400, pending.body);

    // Simultaneous first submissions for one phone + one payment: both
    // succeed, the visit counts exactly once (insert race closed).
    await seedPayment(checkDb['ord-loy'], 'pay-loy-c');
    const [r1, r2] = await Promise.all([
      loy({ phone: '6045553333', payment_id: 'pay-loy-c' }),
      loy({ phone: '6045553333', payment_id: 'pay-loy-c' }),
    ]);
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(r2.statusCode, 200, r2.body);
    const rows = await query(`SELECT visit_count FROM loyalty_visits WHERE location_id = $1`, [locationId]);
    const counts = rows.rows.map((r: { visit_count: number }) => Number(r.visit_count)).sort();
    assert.deepEqual(counts, [1, 1, 1], 'three phones, one counted visit each');
  });

  it('C3-4 Low: a thrown receipt-email send releases the one-send slot', async () => {
    resendFails = true;
    const res = await post(`/api/t/${tok.RCPT}/receipt-email`, { email: 'guest@example.com', payment_id: 'pay-rcpt-1' });
    resendFails = false;
    // The route throws a 502; the global handler masks every 5xx as a
    // generic 500 on the wire (house rule) — what matters is the slot.
    assert.equal(res.statusCode, 500, res.body);
    const rows = await query(
      `SELECT receipt_emailed_at FROM payments WHERE external_payment_ref = 'pay-rcpt-1'`,
    );
    assert.equal(rows.rows[0].receipt_emailed_at, null, 'the slot must be released after a thrown send');
    // And the guest can immediately retry — successfully this time.
    const retry = await post(`/api/t/${tok.RCPT}/receipt-email`, { email: 'guest@example.com', payment_id: 'pay-rcpt-1' });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().sent, true);
  });

  it('C3-4-1/3 source shapes: order route is limited; claims limiter ignores the body device_id', () => {
    const src = readFileSync(new URL('../src/routes/customer.ts', import.meta.url), 'utf8');
    assert.ok(src.includes("app.post('/api/t/:token/order', { preHandler: tokenWriteLimiter }"), 'order route carries the per-token limiter');
    const claimsBlock = src.slice(src.indexOf("name: 'guest-claims'"), src.indexOf("name: 'guest-menu'"));
    assert.ok(!claimsBlock.includes('device_id'), 'claims limiter must not key on the unvalidated device_id');
    assert.ok(claimsBlock.includes('req.ip'), 'claims limiter keys on token + IP');
    assert.ok(src.includes('cart_hash'), 'order reservations store the cart hash');
  });
});
