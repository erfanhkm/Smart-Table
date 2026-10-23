// v0.7.5 — Claude cycle-2 chunk F2 fixes (billing + reconcile):
//   F2-12/F2-1 effectivePlan: paid period governs; DEACTIVATED terminal;
//     ACTIVE gets a 3-day staleness grace; no-evidence accounts keep plan.
//   F2-3  reconcile: ambiguous tenders after 24h -> MANUAL REVIEW, never
//     FAILED; FAILED only when the POS shows no unrecorded tenders at all.
//   F2-9  reconcile settle must not flip a re-seated table to PAID.
//   F2-15 reconcile settle promotes sibling AUTHORIZED rows on close.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PG_MEM = '1';
process.env.SQUARE_ACCESS_TOKEN = 'test-token';
process.env.SQUARE_LOCATION_ID = 'SQLOC1';
process.env.SQUARE_ENV = 'sandbox';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = 'x';
process.env.STAFF_API_TOKEN = 'test-token';

const { query } = await import('../src/db.ts');
const { migrate } = await import('../src/migrate.ts');
const { effectivePlan } = await import('../src/services/billing.ts');
const { reconcilePendingPayments } = await import('../src/services/reconcile.ts');

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe('v0.7.5 F2 hardening — effectivePlan matrix', () => {
  const base = {
    location_id: 'loc-f2x', plan: 'subscription', pending_plan: null, commission_bps: 200,
    subscription_price_cents: 9900, currency: 'CAD', square_customer_id: 'C1', square_card_id: 'K1',
    card_brand: null, card_last4: null, square_subscription_id: 'SUB1',
    subscription_status: 'ACTIVE', subscription_paid_through: day(30),
    fee_charge_failures: 0, fee_charge_next_attempt_at: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('paid period governs over a CANCELED status (F2-12)', () => {
    assert.equal(effectivePlan({ ...base, subscription_status: 'CANCELED' }), 'subscription');
    assert.equal(effectivePlan({ ...base, subscription_status: 'PAUSED' }), 'subscription');
    assert.equal(effectivePlan({ ...base, subscription_status: 'CANCELED', subscription_paid_through: day(-1) }), 'commission');
  });

  it('DEACTIVATED is terminal regardless of dates (E-8)', () => {
    assert.equal(effectivePlan({ ...base, subscription_status: 'DEACTIVATED' }), 'commission');
  });

  it('ACTIVE: grace for a few stale days, commission after (F2-1)', () => {
    assert.equal(effectivePlan({ ...base, subscription_paid_through: null }), 'subscription');
    assert.equal(effectivePlan({ ...base, subscription_paid_through: day(-2) }), 'subscription');
    assert.equal(effectivePlan({ ...base, subscription_paid_through: day(-10) }), 'commission');
  });

  it('no Square evidence either way: the chosen plan stands', () => {
    assert.equal(effectivePlan({ ...base, subscription_status: null, subscription_paid_through: null }), 'subscription');
  });
});

// ---- reconcile scenarios ----------------------------------------------------

const ORDERS: Record<string, { total: number; tenders: { id: string; amount: number }[] }> = {
  ORDA: { total: 5000, tenders: [{ id: 'TA1', amount: 5000 }, { id: 'TA2', amount: 5000 }] },
  ORDB: { total: 5000, tenders: [] },
  ORDC: { total: 5000, tenders: [{ id: 'TC1', amount: 5000 }] },
  ORDD: { total: 5000, tenders: [{ id: 'TD1', amount: 5000 }] },
};

describe('v0.7.5 F2 hardening — reconcile', () => {
  const origFetch = globalThis.fetch;
  const ids: Record<string, string> = {};

  async function seedCheck(ref: string, tableState: string, extraOpenCheck = false): Promise<{ checkId: string; tableId: string }> {
    const locId = randomUUID();
    const tableId = randomUUID();
    const checkId = randomUUID();
    await query(
      `INSERT INTO locations(id, merchant_id, name, pos_type, demo, square_location_id) VALUES ($1,$2,$3,'square',TRUE,$4)`,
      [locId, 'm-f2', `Loc ${ref}`, `SQ-${ref}`],
    );
    await query(`INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,'T1',$3,$4)`,
      [tableId, locId, `tok-${ref}`, tableState]);
    await query(
      `INSERT INTO checks(id, location_id, table_id, pos_type, external_check_ref, state)
       VALUES ($1,$2,$3,'square',$4,'OPEN')`,
      [checkId, locId, tableId, ref],
    );
    if (extraOpenCheck) {
      await query(
        `INSERT INTO checks(id, location_id, table_id, pos_type, external_check_ref, state)
         VALUES ($1,$2,$3,'square',$4,'OPEN')`,
        [randomUUID(), locId, tableId, `${ref}-NEW`],
      );
    }
    return { checkId, tableId };
  }

  async function seedPending(checkId: string, key: string, opts: { ref?: string; sibling?: boolean } = {}): Promise<string> {
    const pid = randomUUID();
    await query(
      `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, pos_tender_ref, created_at)
       VALUES ($1,$2,5000,0,'PENDING',$3,$4, now() - interval '25 hours')`,
      [pid, checkId, key, opts.ref ?? null],
    );
    if (opts.sibling) {
      await query(
        `INSERT INTO payments(id, check_id, amount_cents, tip_cents, status, idempotency_key, created_at)
         VALUES ($1,$2,1000,0,'AUTHORIZED',$3, now() - interval '2 hours')`,
        [randomUUID(), checkId, `${key}-sibling`],
      );
    }
    return pid;
  }

  before(async () => {
    await migrate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string) => {
      const m = /\/v2\/orders\/([^/?]+)/.exec(String(url));
      const o = m ? ORDERS[m[1]] : undefined;
      const body = o
        ? {
            order: {
              id: m![1], state: 'OPEN',
              total_money: { amount: o.total, currency: 'CAD' },
              tenders: o.tenders.map((t) => ({ id: t.id, type: 'CARD', amount_money: { amount: t.amount, currency: 'CAD' } })),
            },
          }
        : { errors: [{ code: 'NOT_FOUND', detail: 'no order' }] };
      return new Response(JSON.stringify(body), { status: o ? 200 : 404, headers: { 'content-type': 'application/json' } });
    };

    const a = await seedCheck('ORDA', 'PAYING');
    ids.pA = await seedPending(a.checkId, 'f2-amb');
    const b = await seedCheck('ORDB', 'PAYING');
    ids.pB = await seedPending(b.checkId, 'f2-none');
    const c = await seedCheck('ORDC', 'SEATED', true);
    ids.cCheck = c.checkId; ids.cTable = c.tableId;
    ids.pC = await seedPending(c.checkId, 'f2-reseat', { ref: 'TC1' });
    const d = await seedCheck('ORDD', 'PAYING');
    ids.dCheck = d.checkId; ids.dTable = d.tableId;
    ids.pD = await seedPending(d.checkId, 'f2-settle', { ref: 'TD1', sibling: true });
  });

  after(() => { globalThis.fetch = origFetch; });

  it('ambiguous tenders stay PENDING for manual review; no-tender rows fail; settles respect re-seated tables', async () => {
    const r = await reconcilePendingPayments();
    assert.equal(r.failed, 1);
    assert.equal(r.reconciled, 2);
    assert.equal(r.stillPending, 1);

    const pA = await query<{ status: string; last_reconcile_error: string | null }>(
      `SELECT status, last_reconcile_error FROM payments WHERE id = $1`, [ids.pA]);
    assert.equal(pA.rows[0].status, 'PENDING', 'F2-3: ambiguous evidence must not mark a paid payment FAILED');
    assert.match(pA.rows[0].last_reconcile_error ?? '', /MANUAL REVIEW/);

    const pB = await query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [ids.pB]);
    assert.equal(pB.rows[0].status, 'FAILED', 'no unrecorded tenders at all after 24h -> FAILED (positive evidence)');

    const pC = await query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [ids.pC]);
    assert.equal(pC.rows[0].status, 'COMPLETED');
    const tC = await query<{ state: string }>(`SELECT state FROM tables WHERE id = $1`, [ids.cTable]);
    assert.equal(tC.rows[0].state, 'SEATED', 'F2-9: a re-seated table must not be flipped to PAID by a late reconcile');
    const evC = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM events WHERE check_id = $1 AND type = 'paid'`, [ids.cCheck]);
    assert.equal(evC.rows[0].n, 0, 'no phantom paid event for the re-seated table');

    const pD = await query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [ids.pD]);
    assert.equal(pD.rows[0].status, 'COMPLETED');
    const tD = await query<{ state: string }>(`SELECT state FROM tables WHERE id = $1`, [ids.dTable]);
    assert.equal(tD.rows[0].state, 'PAID');
    const sib = await query<{ status: string }>(
      `SELECT status FROM payments WHERE idempotency_key = 'f2-settle-sibling'`);
    assert.equal(sib.rows[0].status, 'COMPLETED', 'F2-15: sibling AUTHORIZED rows are promoted when reconcile closes the check');
  });
});
