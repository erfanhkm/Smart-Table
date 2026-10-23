// v0.6.10 backlog tests — Claude cycle-1 G/H/I backlog batch 1.
//
// Proves:
//  1. G-3: portal_users.role defaults to 'staff' (least privilege) and the
//     CHECK rejects unknown roles; explicit 'owner' inserts still work.
//  2. G-2: payments/refunds/checks CHECK constraints reject out-of-domain
//     statuses and negative amounts.
//  3. E-9: uq_payments_check_ref (one POS ref per check) holds;
//     uq_refunds_one_pending was vetted and REJECTED (distinct partial
//     refunds on one payment are legitimate) — the test documents that.
//  4. uq_alert_open: a second OPEN alert for the same (table, kind) is
//     structurally impossible; raiseServiceAlert stays idempotent.
//  5. G-4: assertSafeConfig refuses prod boots with a malformed/missing
//     ENCRYPTION_KEY, a malformed ADMIN_PASSWORD_HASH, a non-https
//     APP_URL, a bad SQUARE_ENV, a NaN port, and a Render deploy running
//     in development mode; a well-formed prod config passes.
//  6. G-1: getTables returns correct per-location rows (scoped queries).
//  7. I-1: GET /api/portal/open-checks-detail aggregates open checks for
//     the caller's location in one request and stays location-scoped.
//  8. H-5/H-6/H-3 (guest page): attempt store uses localStorage with a
//     TTL, the Helcim listener checks ev.origin, and the bill poll backs
//     off adaptively instead of a fixed 5s interval.
//
// Run: PG_MEM=1 npx tsx --test tests/v0610-backlog.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

process.env.PG_MEM = '1';
process.env.STAFF_API_TOKEN = 'test-staff-token-0123456789abcdef';
process.env.SQUARE_ACCESS_TOKEN = 'sq-test-token-610';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const { migrate } = await import('../src/migrate.js');
const { query } = await import('../src/db.js');
const { assertSafeConfig } = await import('../src/config.js');
const { getTables } = await import('../src/services/floor.js');
const { raiseServiceAlert } = await import('../src/services/alerts.js');
const { buildApp } = await import('../src/index.js');

// Minimal Square-shaped fetch mock for the aggregate endpoint: the demo
// adapter resolves orders through the Square API client.
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes('/v2/orders/')) {
    const id = u.split('/v2/orders/')[1];
    return new Response(
      JSON.stringify({
        order: {
          id,
          location_id: 'SQLoc610',
          state: 'OPEN',
          total_money: { amount: 4200, currency: 'CAD' },
          total_tax_money: { amount: 0, currency: 'CAD' },
          total_discount_money: { amount: 0, currency: 'CAD' },
          total_tip_money: { amount: 0, currency: 'CAD' },
          total_service_charge_money: { amount: 0, currency: 'CAD' },
          line_items: [{ uid: 'li1', name: 'Soup', quantity: '1', total_money: { amount: 4200, currency: 'CAD' } }],
          tenders: [],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const LOC = 'loc-610';
const LOC2 = 'loc-610-b';
const TBL = 'tbl-610';
const TBL2 = 'tbl-610-b';
const CHK = 'chk-610';

before(async () => {
  await migrate();
  await query(`INSERT INTO merchants(id, square_merchant_id, access_token_enc, refresh_token_enc, pos_type, external_merchant_ref) VALUES ('m-610','SQM610','x','x','square','SQM610')`);
  for (const [loc, name] of [[LOC, 'A'], [LOC2, 'B']] as const) {
    await query(
      `INSERT INTO locations(id, merchant_id, square_location_id, name, currency, pos_type, pos_location_ref, demo) VALUES ($1,'m-610',$2,$3,'CAD','square',$2,true)`,
      [loc, loc === LOC ? 'SQLoc610' : 'SQLoc610B', name],
    );
  }
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok-610','SEATED')`, [TBL, LOC]);
  await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1','tok-610-b','SEATED')`, [TBL2, LOC2]);
  await query(
    `INSERT INTO checks(id, table_id, location_id, pos_type, external_check_ref, square_order_id, merchant_id, state, total_cents, currency) VALUES ($1,$2,$3,'square','ORD610','ORD610','m-610','OPEN',4200,'CAD')`,
    [CHK, TBL, LOC],
  );
});

describe('G-3 role default + CHECK', () => {
  it('defaults a role-less insert to staff and rejects unknown roles', async () => {
    const id = randomUUID();
    await query(`INSERT INTO portal_users(id, email, password_hash, location_id) VALUES ($1,'a610@x.local','x',$2)`, [id, LOC]);
    const r = await query(`SELECT role FROM portal_users WHERE id = $1`, [id]);
    assert.equal(r.rows[0].role, 'staff');
    await assert.rejects(
      query(`INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'b610@x.local','x','superadmin',$2)`, [randomUUID(), LOC]),
    );
    await query(`INSERT INTO portal_users(id, email, password_hash, role, location_id) VALUES ($1,'own610@x.local','x','owner',$2)`, [randomUUID(), LOC]);
  });
});

describe('G-2 money-table CHECK constraints', () => {
  it('rejects bad payment status / negative amounts, bad refund status, bad check state', async () => {
    const pay = async (status: string, amount = 100) =>
      query(
        `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key) VALUES ($1,$2,$3,0,$4,$5)`,
        [randomUUID(), CHK, amount, status, randomUUID()],
      );
    await pay('COMPLETED');
    await assert.rejects(pay('APPROVED'));
    await assert.rejects(pay('COMPLETED', -5));
    await assert.rejects(
      query(`INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, status, idempotency_key) VALUES ($1,'p-x',$2,$3,100,'CAD','MAYBE',$4)`, [randomUUID(), CHK, LOC, randomUUID()]),
    );
    await assert.rejects(
      query(`INSERT INTO checks(id, table_id, state, total_cents, currency) VALUES ($1,$2,'CLOSED',100,'CAD')`, [randomUUID(), TBL]),
    );
  });
});

describe('E-9 unique indexes', () => {
  it('uq_payments_check_ref: same POS ref twice on one check fails', async () => {
    const ins = () =>
      query(
        `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, external_payment_ref) VALUES ($1,$2,100,0,'COMPLETED',$3,'POSREF610')`,
        [randomUUID(), CHK, randomUUID()],
      );
    await ins();
    await assert.rejects(ins());
  });

  it('uq_refunds_one_pending REJECTED: distinct PENDING partial refunds on one payment coexist', async () => {
    // Vetting outcome (see migration 020 note): the index would block
    // legitimate separate partial refunds while one outcome is unknown.
    const payId = 'pay-610-pending';
    const ins = (status: string) =>
      query(
        `INSERT INTO refunds(id, payment_row_id, check_id, location_id, amount_cents, currency, status, idempotency_key) VALUES ($1,$2,$3,$4,100,'CAD',$5,$6)`,
        [randomUUID(), payId, CHK, LOC, status, randomUUID()],
      );
    await ins('PENDING');
    await ins('PENDING');
    await ins('FAILED');
  });
});

describe('uq_alert_open + raiseServiceAlert', () => {
  it('second raise is a no-op and a raw duplicate insert is rejected by the index', async () => {
    assert.equal(await raiseServiceAlert({ locationId: LOC, tableId: TBL, kind: 'low_rating', rating: 2 }), true);
    assert.equal(await raiseServiceAlert({ locationId: LOC, tableId: TBL, kind: 'low_rating', rating: 1 }), false);
    await assert.rejects(
      query(
        `INSERT INTO service_alerts(id, location_id, table_id, kind, status) VALUES ($1,$2,$3,'low_rating','open')`,
        [randomUUID(), LOC, TBL],
      ),
    );
  });
});

describe('G-4 assertSafeConfig', () => {
  const good = {
    isProd: true,
    nodeEnv: 'production',
    usePgMem: false,
    squareWebhookKey: 'whsec_x',
    staffApiToken: 's'.repeat(40),
    encryptionKeyHex: 'a'.repeat(64),
    adminPasswordHash: `scrypt$${'b'.repeat(32)}$${'c'.repeat(128)}`,
    appUrl: 'https://portal.smarttablepay.com',
    squareEnv: 'sandbox',
    helcimApiToken: '',
    shopifyAdminToken: '',
    port: 3000,
    trustProxy: 1,
    isRender: true,
  } as const;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  it('accepts a well-formed production config', () => {
    assert.doesNotThrow(() => assertSafeConfig(good as never, warn));
  });
  it('refuses missing/malformed ENCRYPTION_KEY', () => {
    assert.throws(() => assertSafeConfig({ ...good, encryptionKeyHex: 'short' } as never, warn), /ENCRYPTION_KEY/);
    assert.throws(() => assertSafeConfig({ ...good, encryptionKeyHex: '' } as never, warn), /ENCRYPTION_KEY/);
  });
  it('refuses a malformed ADMIN_PASSWORD_HASH but tolerates a missing one (warning only)', () => {
    assert.throws(() => assertSafeConfig({ ...good, adminPasswordHash: 'plaintext' } as never, warn), /ADMIN_PASSWORD_HASH/);
    assert.doesNotThrow(() => assertSafeConfig({ ...good, adminPasswordHash: '' } as never, warn));
  });
  it('refuses non-https / localhost APP_URL and a bad SQUARE_ENV', () => {
    assert.throws(() => assertSafeConfig({ ...good, appUrl: 'http://portal.smarttablepay.com' } as never, warn), /APP_URL/);
    assert.throws(() => assertSafeConfig({ ...good, appUrl: 'https://localhost:3000' } as never, warn), /APP_URL/);
    assert.throws(() => assertSafeConfig({ ...good, squareEnv: 'prod' } as never, warn), /SQUARE_ENV/);
  });
  it('refuses NaN port / proxy hops and a Render deploy in development mode', () => {
    assert.throws(() => assertSafeConfig({ ...good, port: Number.NaN } as never, warn), /PORT/);
    assert.throws(() => assertSafeConfig({ ...good, trustProxy: Number.NaN } as never, warn), /TRUST_PROXY_HOPS/);
    assert.throws(
      () => assertSafeConfig({ ...good, isProd: false, nodeEnv: 'development' } as never, warn),
      /RENDER/,
    );
  });
});

describe('G-1 getTables scoping (behavioral)', () => {
  it('returns only the caller location tables with their own paid sums', async () => {
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key) VALUES ($1,$2,1500,0,'COMPLETED',$3)`,
      [randomUUID(), CHK, randomUUID()],
    );
    const a = await getTables(LOC);
    assert.equal(a.length, 1);
    assert.equal(a[0].id, TBL);
    assert.equal(a[0].open_order_id, 'ORD610');
    // 1500 just inserted + 100 (G-2 valid payment) + 100 (E-9 first insert),
    // all COMPLETED on this check in earlier suites of this file.
    assert.equal(a[0].paid_cents, 1700);
    const b = await getTables(LOC2);
    assert.equal(b.length, 1);
    assert.equal(b[0].open_order_id, null);
    assert.equal(b[0].paid_cents, 0);
  });
});

describe('I-1 aggregate open-checks-detail endpoint', () => {
  it('returns the location open checks in one scoped response', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/portal/open-checks-detail?location_id=${LOC}`,
      headers: { authorization: `Bearer ${process.env.STAFF_API_TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { orders: Array<Record<string, unknown>> };
    assert.equal(body.orders.length, 1);
    assert.equal(body.orders[0].table_id, TBL);
    assert.equal(body.orders[0].error, false);
    assert.equal(body.orders[0].total, 4200);
    const other = await app.inject({
      method: 'GET',
      url: `/api/portal/open-checks-detail?location_id=${LOC2}`,
      headers: { authorization: `Bearer ${process.env.STAFF_API_TOKEN}` },
    });
    assert.equal(JSON.parse(other.body).orders.length, 0);
    await app.close();
  });
});

describe('guest page H-5/H-6/H-3 (source assertions)', () => {
  it('attempt store persists to localStorage with a TTL; Helcim checks origin; poll backs off', async () => {
    const src = await readFile(new URL('../public/t/app.js', import.meta.url), 'utf8');
    assert.ok(src.includes('localStorage.setItem(attemptStoreKey(a.orderId)'), 'attempts must persist in localStorage');
    assert.ok(src.includes('ATTEMPT_TTL_MS'), 'attempt entries must expire');
    assert.ok(src.includes('ev.origin !== expectedOrigin'), 'Helcim listener must verify the message origin');
    assert.ok(src.includes('POLL_MAX_MS'), 'poll backoff cap must exist');
    assert.ok(!src.includes('setInterval(() => { if (!document.hidden && !paying) fetchBill(); }, 5000)'), 'fixed 5s poll must be gone');
  });
});
