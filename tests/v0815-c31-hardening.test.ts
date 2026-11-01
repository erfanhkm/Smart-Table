// v0.8.15 — Claude cycle-3 C3-1 hardening tests (pg-mem + mocked POS fetch).
//
// Proves:
//  C3-1-1  orderRemaining caps by tender coverage: an authorized $40 on a
//          $100 order (net_amount_due still stale at $100) leaves only
//          $60 chargeable — an over-amount is refused and a "full" payment
//          charges exactly the true remaining and closes.
//  C3-1-4  IDEMPOTENCY_KEY_REUSED from Square is outcome-UNKNOWN in
//          payCheck: 409 payment_needs_reconciliation, row stays PENDING.
//  C3-1-6  the tender-blind ledger cap counts PENDING rows whose
//          charge_started_at marker is set: a stranded attempt blocks a
//          different guest from being charged the same money on Helcim.
//  C3-1-7  orderTenderRemaining fails closed when total_money is absent.
//  C3-1-8  sq() returns a 200 response that carries warnings alongside
//          the created object; a 200 with errors and NO object throws.
//  C3-1-9  a POS refund accepted as PENDING keeps our row PENDING with
//          pos_status stored and fees NOT reversed; REJECTED fails the
//          row; COMPLETED completes and reverses.
//  C3-1-12 subscription + plan-variation creation use deterministic
//          idempotency keys (stable across retries, <= 45 chars).
//  Low     the OAuth authorize URL URL-encodes the client id.
//
// Run: PG_MEM=1 npx tsx --test tests/v0815-c31-hardening.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN=<redacted>
process.env.SQUARE_ACCESS_TOKEN=<redacted>
process.env.SQUARE_APP_ID = 'sq0idp-test+id';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { payCheck } = await import('../src/services/payments.js');
const { refundPayment } = await import('../src/services/refunds.js');
const {
  orderRemaining, orderTenderRemaining, createPayment, createPlatformSubscription,
  createSubscriptionPlanVariation, squareAuthorizeUrl, SquareError,
} = await import('../src/square.js');

// ---- fetch mock -------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let keyReusedMode = false;
let warnMode = false;
let refundStatusMode: 'PENDING' | 'COMPLETED' | 'REJECTED' = 'COMPLETED';
const paymentBodies: { amount_money?: { amount?: number }; order_id?: string }[] = [];
const subKeys: string[] = [];
const catalogKeys: string[] = [];
let helcimPurchases = 0;
let paySeq = 0;

// C31A: $100 order, guest A already authorized $40 + $6 tip (tender 4600).
const c31aTenders: { amount: number; tip: number }[] = [{ amount: 4600, tip: 600 }];
function c31aOrder() {
  return {
    id: 'SQORD-C31A', location_id: 'SQLoc1', state: 'OPEN',
    total_money: { amount: 10000, currency: 'CAD' },
    // Stale on purpose: Square does not move net_amount_due for
    // authorize-only payments (v0.8.10) — this is the C3-1-1 trap.
    net_amount_due_money: { amount: 10000, currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: 10000, currency: 'CAD' } }],
    tenders: c31aTenders.map((t, i) => ({
      id: `T${i}`, payment_id: `SQPAY-T${i}`, type: 'CARD',
      amount_money: { amount: t.amount, currency: 'CAD' },
      tip_money: { amount: t.tip, currency: 'CAD' },
    })),
  };
}
function plainOrder(id: string, total: number) {
  return {
    id, location_id: 'SQLoc1', state: 'OPEN',
    total_money: { amount: total, currency: 'CAD' },
    net_amount_due_money: { amount: total, currency: 'CAD' },
    line_items: [{ name: 'Item', quantity: '1', total_money: { amount: total, currency: 'CAD' } }],
    tenders: [],
  };
}

const origFetch = globalThis.fetch;
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    if (u.hostname.includes('helcim')) {
      if (url.includes('/invoices/888')) {
        return json({ invoice: { invoiceId: 888, invoiceNumber: 'INV-888', amount: 50.0, currency: 'CAD', status: 'DUE' } });
      }
      if (url.includes('/payment/purchase')) {
        helcimPurchases += 1;
        return json({ responseCode: '0', transactionId: 'HTXN-C31' });
      }
      return json({ error: 'unexpected helcim call' }, 500);
    }
    // Square platform (billing) calls
    if (u.pathname === '/v2/subscriptions' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      subKeys.push(String(body.idempotency_key));
      return json({ subscription: { id: 'SUB-C31', status: 'ACTIVE' } });
    }
    if (u.pathname === '/v2/catalog/object' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      catalogKeys.push(String(body.idempotency_key));
      const isPlan = body.object?.type === 'SUBSCRIPTION_PLAN';
      return json({ catalog_object: { id: isPlan ? 'PLAN-C31' : 'VAR-C31' } });
    }
    // Square merchant calls
    if (u.pathname === '/v2/orders/SQORD-C31A' && method === 'GET') return json({ order: c31aOrder() });
    if (u.pathname === '/v2/orders/SQORD-C32' && method === 'GET') return json({ order: plainOrder('SQORD-C32', 5000) });
    if (u.pathname === '/v2/orders/SQORD-C31R' && method === 'GET') return json({ order: plainOrder('SQORD-C31R', 5000) });
    if (/\/v2\/orders\/[^/]+\/pay$/.test(u.pathname) && method === 'POST') {
      return json({ order: { ...c31aOrder(), state: 'COMPLETED' } });
    }
    if (u.pathname === '/v2/payments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { amount_money?: { amount?: number }; tip_money?: { amount?: number }; order_id?: string };
      paymentBodies.push(body);
      if (warnMode) {
        return json({ payment: { id: 'SQPAY-WARN', status: 'APPROVED' }, errors: [{ category: 'RATE_LIMIT_ERROR', code: 'RATE_LIMITED', detail: 'warning only' }] });
      }
      if (keyReusedMode) {
        return json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'IDEMPOTENCY_KEY_REUSED', detail: 'key reused with different parameters' }] }, 400);
      }
      paySeq += 1;
      const pid = `SQPAY-C31-${paySeq}`;
      if (body.order_id === 'SQORD-C31A') {
        c31aTenders.push({ amount: (body.amount_money?.amount ?? 0) + (body.tip_money?.amount ?? 0), tip: body.tip_money?.amount ?? 0 });
      }
      return json({ payment: { id: pid, status: 'APPROVED' } });
    }
    const payGetM = /\/v2\/payments\/(SQPAY-R\d)$/.exec(u.pathname);
    if (payGetM && method === 'GET') {
      return json({ payment: { id: payGetM[1], source_type: 'CARD', status: 'COMPLETED', amount_money: { amount: 5000, currency: 'CAD' }, tip_money: { amount: 0, currency: 'CAD' } } });
    }
    if (u.pathname === '/v2/refunds' && method === 'POST') {
      return json({ refund: { id: `SQREF-${refundStatusMode}`, status: refundStatusMode } });
    }
    return json({ errors: [{ code: 'NOT_FOUND', detail: `unexpected: ${method} ${url}` }] }, 404);
  }) as typeof fetch;
}

// ---- seed -------------------------------------------------------------------
const MERCHANT = 'm-c31';
const checkIds: Record<string, string> = {};
async function seedCheck(key: string, loc: string, pos: string, ref: string, total: number) {
  const tId = randomUUID();
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'SEATED')`,
    [tId, loc, `T-${key}`, randomUUID().replace(/-/g, '')]);
  const cId = randomUUID();
  checkIds[key] = cId;
  await query(
    `INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,'CAD')`,
    [cId, tId, loc, pos, ref, pos === 'square' ? ref : null, MERCHANT, total],
  );
}

describe('v0.8.15 C3-1 hardening', () => {
  before(async () => {
    installFetch();
    await migrate();
    await query(`INSERT INTO merchants(id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc)
      VALUES ($1,'square','sq-merchant',$2,$3)`, [MERCHANT, encryptSecret('x'), encryptSecret('x')]);
    for (const [loc, pos, ref] of [['loc-sq-c31', 'square', 'SQLoc1'], ['loc-hc-c31', 'helcim', 'HCLOC2']] as const) {
      await query(`INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
        VALUES ($1,$2,$3,$4,$5,$6,'CAD')`, [loc, MERCHANT, pos, ref, ref, `Loc ${pos}`]);
      await query(`INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, card_public_token, card_private_token_enc)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), MERCHANT, pos, pos === 'square' ? 'sq-merchant' : ref, encryptSecret('TOK'), encryptSecret('x'), null, encryptSecret('HC-PRIV')]);
    }
    await seedCheck('A', 'loc-sq-c31', 'square', 'SQORD-C31A', 10000);
    await seedCheck('B', 'loc-sq-c31', 'square', 'SQORD-C32', 5000);
    await seedCheck('R', 'loc-sq-c31', 'square', 'SQORD-C31R', 5000);
    await seedCheck('HC', 'loc-hc-c31', 'helcim', '888', 5000);
  });
  after(() => { (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch; });

  it('C3-1-1 unit: orderRemaining takes the smaller of net due and tender coverage', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(orderRemaining(c31aOrder() as any), 6000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(orderTenderRemaining(c31aOrder() as any), 6000);
  });

  it('C3-1-7 unit: orderTenderRemaining throws when total_money is absent', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => orderTenderRemaining({ tenders: [] } as any), /no total_money/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.throws(() => orderTenderRemaining(null as any), /no total_money/);
  });

  it('C3-1-1: an over-amount above the tender-based remaining is refused pre-charge', async () => {
    const before = paymentBodies.length;
    await assert.rejects(
      () => payCheck({
        checkRef: 'SQORD-C31A', checkId: checkIds.A, mode: 'custom', amountCents: 8000,
        idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
      }),
      /amount_cents must be between 1 and 6000/,
    );
    assert.equal(paymentBodies.length, before, 'no charge call may happen');
  });

  it('C3-1-1: a "full" payment charges only the true remaining and closes the check', async () => {
    const res = await payCheck({
      checkRef: 'SQORD-C31A', checkId: checkIds.A, mode: 'full', tipCents: 600,
      idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
    });
    const charge = paymentBodies[paymentBodies.length - 1];
    assert.equal(charge.amount_money?.amount, 6000, 'the second guest is capped at the true $60 remaining, not the stale $100');
    assert.equal(res.remainingCents, 0);
    assert.equal(res.checkState, 'COMPLETED');
  });

  it('C3-1-4: IDEMPOTENCY_KEY_REUSED is a 409 reconciliation state, never a decline', async () => {
    keyReusedMode = true;
    const key = randomUUID();
    let err: Error & { statusCode?: number; errorCode?: string };
    try {
      await payCheck({
        checkRef: 'SQORD-C32', checkId: checkIds.B, mode: 'full',
        idempotencyKey: key, source: { kind: 'card', nonce: 'cnon:card-nonce-ok' },
      });
      assert.fail('must throw');
    } catch (e) { err = e as typeof err; }
    keyReusedMode = false;
    assert.equal(err!.statusCode, 409);
    assert.equal(err!.errorCode, 'payment_needs_reconciliation');
    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE idempotency_key = $1`, [key]);
    assert.equal(row.rows[0].status, 'PENDING', 'the row must stay reconcilable, not FAILED');
  });

  it('C3-1-6: a stranded charge_started PENDING row caps a tender-blind check for other guests', async () => {
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, charge_started_at)
       VALUES ($1,$2,5000,0,'full','PENDING',$3, now())`,
      [randomUUID(), checkIds.HC, randomUUID()],
    );
    await assert.rejects(
      () => payCheck({
        checkRef: '888', checkId: checkIds.HC, mode: 'full',
        idempotencyKey: randomUUID(), source: { kind: 'card', nonce: 'helcim-token-123' },
      }),
      /check is already fully paid/,
    );
    assert.equal(helcimPurchases, 0, 'no second charge may happen against the stranded money');
  });

  it('C3-1-8: a 200 with warnings alongside the payment object returns the payment', async () => {
    warnMode = true;
    const { payment } = await createPayment(
      { orderId: 'SQORD-C32', amountCents: 100, currency: 'CAD', sourceId: 'cnon:card-nonce-ok', idempotencyKey: 'warn-key-1' },
      'TOK',
    );
    assert.equal(payment.id, 'SQPAY-WARN');
    warnMode = false;
  });

  it('C3-1-8: a 200 with errors and NO object still throws', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: 'BAD_REQUEST', detail: 'no object' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await assert.rejects(
      () => createPayment({ orderId: 'SQORD-C32', amountCents: 100, currency: 'CAD', sourceId: 'cnon:card-nonce-ok', idempotencyKey: 'warn-key-2' }, 'TOK'),
      (e: unknown) => e instanceof SquareError,
    );
    installFetch();
  });

  async function seedRefundablePayment(ref: string): Promise<string> {
    const rowId = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, split_mode, status, idempotency_key, square_payment_id, external_payment_ref, currency)
       VALUES ($1,$2,5000,0,'full','COMPLETED',$3,$4,$4,'CAD')`,
      [rowId, checkIds.R, randomUUID(), ref],
    );
    await query(
      `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status)
       VALUES ($1,'loc-sq-c31',$2,$3,5000,100,'CAD','square_app_fee','collected')`,
      [randomUUID(), rowId, ref],
    );
    return rowId;
  }
  async function reversalCount(rowId: string): Promise<number> {
    const r = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM fee_ledger WHERE payment_row_id = $1 AND method = 'reversal'`, [rowId]);
    return r.rows[0]?.n ?? 0;
  }

  it('C3-1-9: a PENDING POS refund keeps the row PENDING, stores pos_status, reverses nothing', async () => {
    const rowId = await seedRefundablePayment('SQPAY-R1');
    refundStatusMode = 'PENDING';
    const res = await refundPayment({ paymentRowId: rowId, idempotencyKey: 'refund-pending-1', expectedLocationId: 'loc-sq-c31' });
    assert.equal(res.pos_refund_ref, 'SQREF-PENDING');
    const rows = await query<{ status: string; pos_status: string }>(`SELECT status, pos_status FROM refunds WHERE payment_row_id = $1`, [rowId]);
    assert.equal(rows.rows[0].status, 'PENDING');
    assert.equal(rows.rows[0].pos_status, 'PENDING');
    assert.equal(await reversalCount(rowId), 0, 'fees reverse only once the refund completes');
  });

  it('C3-1-9: a COMPLETED POS refund completes the row and reverses the fee', async () => {
    const rowId = await seedRefundablePayment('SQPAY-R2');
    refundStatusMode = 'COMPLETED';
    await refundPayment({ paymentRowId: rowId, idempotencyKey: 'refund-complete-1', expectedLocationId: 'loc-sq-c31' });
    const rows = await query<{ status: string; pos_status: string }>(`SELECT status, pos_status FROM refunds WHERE payment_row_id = $1`, [rowId]);
    assert.equal(rows.rows[0].status, 'COMPLETED');
    assert.equal(rows.rows[0].pos_status, 'COMPLETED');
    assert.equal(await reversalCount(rowId), 1);
  });

  it('C3-1-9: a REJECTED POS refund fails the row with pos_status stored', async () => {
    const rowId = await seedRefundablePayment('SQPAY-R3');
    refundStatusMode = 'REJECTED';
    await assert.rejects(
      () => refundPayment({ paymentRowId: rowId, idempotencyKey: 'refund-rejected-1', expectedLocationId: 'loc-sq-c31' }),
      /POS rejected the refund/,
    );
    const rows = await query<{ status: string; pos_status: string }>(`SELECT status, pos_status FROM refunds WHERE payment_row_id = $1`, [rowId]);
    assert.equal(rows.rows[0].status, 'FAILED');
    assert.equal(rows.rows[0].pos_status, 'REJECTED');
    assert.equal(await reversalCount(rowId), 0);
    refundStatusMode = 'COMPLETED';
  });

  it('C3-1-12: subscription and plan-variation keys are deterministic and within the Square limit', async () => {
    await createPlatformSubscription({ customerId: 'CUST-C31', planVariationId: 'VAR-C31', cardId: 'CARD-C31', locationId: 'LOC-C31' });
    await createPlatformSubscription({ customerId: 'CUST-C31', planVariationId: 'VAR-C31', cardId: 'CARD-C31', locationId: 'LOC-C31' });
    assert.equal(subKeys.length, 2);
    assert.equal(subKeys[0], subKeys[1]);
    assert.ok(subKeys[0].length <= 45, `subscription key too long: ${subKeys[0].length}`);
    const v1 = await createSubscriptionPlanVariation(9900, 'CAD');
    const v2 = await createSubscriptionPlanVariation(9900, 'CAD');
    assert.equal(v1, v2);
    assert.equal(catalogKeys.length, 4);
    assert.equal(catalogKeys[0], catalogKeys[2], 'plan key must be deterministic');
    assert.equal(catalogKeys[1], catalogKeys[3], 'variation key must be deterministic');
    for (const k of catalogKeys) assert.ok(k.length <= 45, `catalog key too long: ${k.length}`);
  });

  it('Low: the OAuth authorize URL URL-encodes the client id', () => {
    const url = squareAuthorizeUrl('state-1');
    assert.ok(url.includes('client_id=sq0idp-test%2Bid'), url);
  });
});
