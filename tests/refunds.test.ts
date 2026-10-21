// v0.4.1 refund tests (pg-mem + mocked Square fetch).
//
// Proves:
//  1. A full card refund goes through the Square adapter, lands in the
//     refunds table, and reverses the collected 2% commission fee.
//  2. Partial refunds accumulate; going past the remainder is a 400.
//  3. Idempotency: replaying the same key never calls Square twice.
//  4. Cash (EXTERNAL) payments are refused with the "at the till" message.
//  5. Routes: list payments with refundable amounts; refund needs auth.
//
// Run: PG_MEM=1 npx tsx --test tests/refunds.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = ['test', 'token', '123'].join('-');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { payCheck } = await import('../src/services/payments.js');
const { refundPayment, listCheckPayments } = await import('../src/services/refunds.js');
const { buildApp } = await import('../src/index.js');

// ---- Square fetch mock -----------------------------------------------------
const calls: { url: string; method: string }[] = [];
const paySourceType = new Map<string, string>();
const payStatus = new Map<string, string>();
const payAmounts = new Map<string, { amount: number; tip: number }>();
const orderTotals: Record<string, number> = { SQORDR1: 10000, SQORDR2: 6000, SQORDR3: 4000 };
const orderPaid: Record<string, number> = { SQORDR1: 0, SQORDR2: 0, SQORDR3: 0 };
let paySeq = 0;
let refundSeq = 0;
let refundCalls = 0;
let cancelCalls = 0;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function orderObj(id: string) {
  return {
    id, location_id: 'SQLoc1', state: orderPaid[id] >= orderTotals[id] ? 'COMPLETED' : 'OPEN',
    total_money: { amount: orderTotals[id], currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: orderTotals[id], currency: 'CAD' } }],
    tenders: orderPaid[id] > 0 ? [{ id: 'T1', amount_money: { amount: orderPaid[id], currency: 'CAD' } }] : [],
  };
}
function installFetch() {
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const orderM = /\/v2\/orders\/(SQORDR\d+)/.exec(url);
    const payM = /\/v2\/payments\/([A-Za-z0-9]+)$/.exec(url);
    const cancelM = /\/v2\/payments\/([A-Za-z0-9]+)\/cancel$/.exec(url);
    if (url.includes('/v2/refunds')) {
      refundCalls += 1;
      refundSeq += 1;
      return json({ refund: { id: `SQREF${refundSeq}`, status: 'COMPLETED' } });
    }
    if (cancelM) {
      cancelCalls += 1;
      payStatus.set(cancelM[1], 'CANCELED');
      return json({ payment: { id: cancelM[1], status: 'CANCELED' } });
    }
    if (payM && method === 'GET') {
      const id = payM[1];
      if (id === 'SQSTANDALONE') {
        // Standalone APPROVED payment (no order attached) for the void path.
        return json({
          payment: {
            id, source_type: 'CARD', status: payStatus.get(id) ?? 'APPROVED',
            amount_money: { amount: 4000, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' },
          },
        });
      }
      const amt = payAmounts.get(id) ?? { amount: 0, tip: 0 };
      return json({
        payment: {
          id, source_type: paySourceType.get(id) ?? 'CARD', status: payStatus.get(id) ?? 'COMPLETED',
          order_id: 'SQORDR-X',
          amount_money: { amount: amt.amount, currency: 'CAD' }, tip_money: { amount: amt.tip, currency: 'CAD' },
        },
      });
    }
    if (url.includes('/v2/payments')) {
      const body = JSON.parse((init?.body as string) ?? '{}');
      paySeq += 1;
      const pid = `SQPAY${paySeq}`;
      paySourceType.set(pid, body.source_id === 'EXTERNAL' ? 'EXTERNAL' : 'CARD');
      payAmounts.set(pid, { amount: body.amount_money?.amount ?? 0, tip: body.tip_money?.amount ?? 0 });
      const oid = body.order_id as string;
      orderPaid[oid] += (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0);
      return json({ payment: { id: pid } });
    }
    if (orderM && url.includes('/pay')) return json({ order: orderObj(orderM[1]) });
    if (orderM) return json({ order: orderObj(orderM[1]) });
    return json({ errors: [{ code: 'NOT_FOUND', detail: 'unexpected in test' }] }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ---- seed ------------------------------------------------------------------
const MERCHANT = 'm-ref';
const LOC = 'loc-ref';
const checkIds: Record<string, string> = {};
async function seedCheck(orderId: string, total: number) {
  const tId = randomUUID();
  checkIds[orderId] = randomUUID();
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
    [tId, LOC, `T-${orderId}`, randomUUID().replace(/-/g, '')]);
  await query(`INSERT INTO checks(id, table_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
    VALUES ($1,$2,'square',$3,$3,$4,'OPEN',$5,'CAD')`,
    [checkIds[orderId], tId, orderId, MERCHANT, total]);
}
async function seed() {
  await migrate();
  await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
  await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
    VALUES ($1,$2,'square','SQLoc1','SQLoc1','Refund House','CAD')`, [LOC, MERCHANT]);
  await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
    VALUES ($1,$2,'square','sq-merchant',$3,$4)`, [randomUUID(), MERCHANT, encryptSecret('SQ-TOKEN'), encryptSecret('x')]);
  await seedCheck('SQORDR1', 10000);
  await seedCheck('SQORDR2', 6000);
  await seedCheck('SQORDR3', 4000);
}

async function paymentRowId(checkId: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM payments WHERE check_id = $1 AND status IN ('AUTHORIZED','COMPLETED') ORDER BY created_at DESC LIMIT 1`,
    [checkId],
  );
  return r.rows[0].id;
}

describe('v0.4.1 refunds', () => {
  before(async () => {
    installFetch();
    await seed();
    // Guest pays SQORDR1 in full by card: $100 + $10 tip (fee 220 collected).
    await payCheck({
      checkRef: 'SQORDR1', mode: 'full', tipCents: 1000, idempotencyKey: randomUUID(),
      source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    // SQORDR2 is paid in cash (EXTERNAL tender).
    await payCheck({
      checkRef: 'SQORDR2', mode: 'full', tipCents: 0, idempotencyKey: randomUUID(),
      source: { kind: 'external', label: 'CASH' },
    });
    // SQORDR3 is paid by card ($40, no tip); its Square payment is then
    // flipped to APPROVED (authorized, not yet settled) for the void tests.
    await payCheck({
      checkRef: 'SQORDR3', mode: 'full', tipCents: 0, idempotencyKey: randomUUID(),
      source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    const p3 = await query<{ external_payment_ref: string }>(
      `SELECT external_payment_ref FROM payments WHERE check_id = $1`, [checkIds.SQORDR3],
    );
    payStatus.set(p3.rows[0].external_payment_ref, 'APPROVED');
  });

  it('partial refund + idempotent replay of the same key', async () => {
    const rowId = await paymentRowId(checkIds.SQORDR1);
    const key = randomUUID();
    const before = refundCalls;
    const res = await refundPayment({ paymentRowId: rowId, amountCents: 3000, idempotencyKey: key });
    assert.equal(res.replayed, false);
    assert.equal(res.amount_cents, 3000);
    assert.equal(res.refunded_cents, 3000);
    assert.equal(res.refundable_cents, 8000);
    assert.equal(refundCalls, before + 1);
    // Replay with the same key: stored result, Square NOT called again.
    const replay = await refundPayment({ paymentRowId: rowId, amountCents: 3000, idempotencyKey: key });
    assert.equal(replay.replayed, true);
    assert.equal(replay.refund_id, res.refund_id);
    assert.equal(refundCalls, before + 1);
    // Proportional fee reversal for 3000/11000 of the 220-cent fee: -60.
    const rev = await query<{ total: string }>(
      `SELECT COALESCE(SUM(fee_cents), 0) AS total FROM fee_ledger WHERE payment_row_id = $1 AND method = 'reversal'`, [rowId],
    );
    assert.equal(Number(rev.rows[0].total), -60);
  });

  it('refunds accumulate to the full amount, the fee fully reverses, over-refunding is a 400', async () => {
    const rowId = await paymentRowId(checkIds.SQORDR1);
    const res = await refundPayment({ paymentRowId: rowId, idempotencyKey: randomUUID() }); // defaults to the 8000 remainder
    assert.equal(res.amount_cents, 8000);
    assert.equal(res.refunded_cents, 11000);
    assert.equal(res.refundable_cents, 0);
    const rows = await query(`SELECT * FROM refunds WHERE payment_row_id = $1 AND status = 'COMPLETED'`, [rowId]);
    assert.equal(rows.rows.length, 2);
    // Net commission kept on THIS payment is back to 0.
    const net = await query<{ total: string }>(
      `SELECT COALESCE(SUM(fee_cents), 0) AS total FROM fee_ledger WHERE payment_row_id = $1`, [rowId],
    );
    assert.equal(Number(net.rows[0].total), 0);
    await assert.rejects(
      () => refundPayment({ paymentRowId: rowId, amountCents: 100, idempotencyKey: randomUUID() }),
      /exceeds the refundable remainder/,
    );
    const list = await listCheckPayments(checkIds.SQORDR1);
    assert.equal(list[0].refunded_cents, 11000);
    assert.equal(list[0].refundable_cents, 0);
  });

  it('cash (EXTERNAL) payments are refused with the till message', async () => {
    const rowId = await paymentRowId(checkIds.SQORDR2);
    await assert.rejects(
      () => refundPayment({ paymentRowId: rowId, amountCents: 1000, idempotencyKey: randomUUID() }),
      /cash is refunded at the till/,
    );
    const rows = await query(`SELECT * FROM refunds WHERE payment_row_id = $1 AND status = 'COMPLETED'`, [rowId]);
    assert.equal(rows.rows.length, 0);
  });

  it('APPROVED order payment (still settling): refunds refuse with a try-again message', async () => {
    const rowId = await paymentRowId(checkIds.SQORDR3);
    await assert.rejects(
      () => refundPayment({ paymentRowId: rowId, amountCents: 1000, idempotencyKey: randomUUID() }),
      /still settling/,
    );
    await assert.rejects(
      () => refundPayment({ paymentRowId: rowId, idempotencyKey: randomUUID() }),
      /still settling/,
    );
    const rows = await query(`SELECT * FROM refunds WHERE payment_row_id = $1 AND status = 'COMPLETED'`, [rowId]);
    assert.equal(rows.rows.length, 0);
  });

  it('standalone APPROVED payment (adapter level): partial refused, full amount voids via cancel', async () => {
    const { squareAdapter } = await import('../src/services/pos/square.js');
    await assert.rejects(
      () => squareAdapter.refundPayment!({ paymentId: 'SQSTANDALONE', amountCents: 1000, currency: 'CAD', idempotencyKey: randomUUID(), token: 'SQ-TOKEN' }),
      /not settled yet/,
    );
    const before = cancelCalls;
    const res = await squareAdapter.refundPayment!({ paymentId: 'SQSTANDALONE', amountCents: 4000, currency: 'CAD', idempotencyKey: randomUUID(), token: 'SQ-TOKEN' });
    assert.equal(res.status, 'CANCELED');
    assert.equal(cancelCalls, before + 1);
  });

  it('routes: payments list shows refundable amounts; refund requires auth', async () => {
    const app = await buildApp({ logger: false });
    try {
      const list = await app.inject({ url: `/api/portal/checks/SQORDR1/payments`, headers: { authorization: 'Bearer test-token-123' } });
      assert.equal(list.statusCode, 200);
      const payments = JSON.parse(list.body).payments;
      assert.equal(payments.length, 1);
      assert.equal(payments[0].refunded_cents, 11000);
      assert.equal(payments[0].refundable_cents, 0);

      const noAuth = await app.inject({ method: 'POST', url: `/api/portal/payments/${payments[0].id}/refund`, payload: { idempotency_key: randomUUID() } });
      assert.equal(noAuth.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});
