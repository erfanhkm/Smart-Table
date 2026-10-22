// v0.4 billing: how restaurants pay Smart Table.
//
// Plans (billing_accounts.plan):
//   commission   — 2% of each guest card payment. Square locations: the fee
//                  is taken in-flight as a Square application fee (see
//                  services/pos/square.ts). Other POS: the fee accrues in
//                  fee_ledger and processAccruedFees() charges it monthly
//                  to the card on file.
//   subscription — flat monthly price via a Square Subscription on OUR
//                  platform account against the restaurant's card on file.
//                  No per-payment fees while a paid period is running.
//
// Plan switching rules:
//   -> subscription: starts immediately (Square charges the first month at
//      once). Requires a card on file.
//   -> commission from an active subscription: the Square subscription is
//      canceled; the plan stays 'subscription' until the paid-through date
//      (pending_plan='commission'), then flips — a restaurant never pays
//      both for the same days.
//   Switching back to subscription while a canceled subscription is still
//   in its paid window is rejected (Square would double-charge the overlap).
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { badRequest } from '../http.js';
import { config } from '../config.js';
import {
  cancelPlatformSubscription,
  createPlatformCard,
  createPlatformCardCharge,
  createPlatformCustomer,
  createPlatformSubscription,
  createSubscriptionPlanVariation,
  disablePlatformCard,
  platformLocation,
  searchPlatformSubscriptions,
  retrievePlatformInvoice,
  retrievePlatformSubscription,
  updatePlatformCustomerEmail,
  SquareError,
} from '../square.js';

export type BillingPlan = 'commission' | 'subscription';

export interface BillingAccount {
  location_id: string;
  plan: BillingPlan;
  pending_plan: BillingPlan | null;
  commission_bps: number;
  subscription_price_cents: number;
  currency: string;
  square_customer_id: string | null;
  square_card_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  square_subscription_id: string | null;
  subscription_status: string | null;
  subscription_paid_through: string | null;
}

export const DEFAULT_COMMISSION_BPS = 200; // 2.00%
export const DEFAULT_SUBSCRIPTION_PRICE_CENTS = 9900; // $99.00/mo — Base plan price (Erfan, 2026-10-21); per-account adjustable

/** 2% of the charged amount (amount + tip), rounded to the nearest cent; never negative, never the whole charge. */
export function feeFor(chargeCents: number, bps: number): number {
  if (!Number.isSafeInteger(chargeCents) || chargeCents <= 0) return 0;
  const fee = Math.round((chargeCents * bps) / 10000);
  return Math.max(0, Math.min(fee, chargeCents - 1));
}

// Per-location in-process mutex for billing mutations (E-3): switchPlan and
// saveCard interleave Square API calls with DB reads/writes, so a double
// click or a client retry could otherwise create duplicate Square
// customers, cards or subscriptions. The service runs as a single instance;
// cross-instance safety comes from the deterministic Square idempotency
// keys, the atomic fee-ledger claim in processAccruedFees, and
// search-before-create for subscriptions.
const billingLocks = new Map<string, Promise<unknown>>();
export function withBillingLock<T>(locationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = billingLocks.get(locationId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  billingLocks.set(locationId, run.then(() => undefined, () => undefined));
  return run;
}

/** A Square 4xx (other than timeout/rate-limit) is a definitive refusal. */
function isDefinitiveSquareFailure(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function ensureBillingAccount(locationId: string): Promise<BillingAccount> {
  await query(
    `INSERT INTO billing_accounts(location_id, subscription_price_cents) VALUES ($1, $2) ON CONFLICT (location_id) DO NOTHING`,
    [locationId, DEFAULT_SUBSCRIPTION_PRICE_CENTS],
  );
  const r = await query<BillingAccount>(`SELECT * FROM billing_accounts WHERE location_id = $1`, [locationId]);
  return r.rows[0];
}

// E-low: updateAccount interpolates column NAMES into SQL. All callers
// are internal today, but the allow-list makes the interpolation safe by
// construction — an unexpected key is a programming error, not SQL.
const BILLING_ACCOUNT_COLUMNS = new Set([
  'plan', 'pending_plan', 'commission_bps', 'currency', 'square_customer_id', 'square_card_id',
  'card_brand', 'card_last4',
  'square_subscription_id', 'square_plan_variation_id', 'subscription_status',
  'subscription_paid_through',
]);

async function updateAccount(locationId: string, fields: Record<string, unknown>): Promise<BillingAccount> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return ensureBillingAccount(locationId);
  for (const k of keys) {
    if (!BILLING_ACCOUNT_COLUMNS.has(k)) throw new Error(`updateAccount: column not allowed: ${k}`);
  }
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const r = await query<BillingAccount>(
    `UPDATE billing_accounts SET ${sets}, updated_at = now() WHERE location_id = $1 RETURNING *`,
    [locationId, ...keys.map((k) => fields[k])],
  );
  return r.rows[0];
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** The plan that actually applies right now, from stored fields only (no network). */
export function effectivePlan(acct: BillingAccount): BillingPlan {
  if (acct.plan !== 'subscription') return acct.plan;
  // Pending switch back to commission takes effect once the paid period ends.
  if (
    acct.pending_plan === 'commission' &&
    acct.subscription_paid_through &&
    acct.subscription_paid_through < today()
  ) {
    return 'commission';
  }
  // E-8: a LAPSED subscription must not silently keep the location on the
  // subscription plan (commission would never be charged): the plan only
  // counts while Square reports the subscription ACTIVE and the paid
  // period covers today. (syncSubscription refreshes these fields from
  // Square whenever the billing state is viewed; between syncs a just-
  // lapsed sub can read as subscription until the next view — the stored
  // paid_through bound keeps that window honest.)
  const status = (acct.subscription_status ?? '').toUpperCase();
  const lapsed =
    (status !== '' && status !== 'ACTIVE') ||
    (acct.subscription_paid_through !== null && acct.subscription_paid_through < today());
  if (lapsed) {
    console.warn(
      `[billing] location ${acct.location_id}: subscription lapsed (status=${status || 'unknown'}, paid_through=${acct.subscription_paid_through}) — billing as commission`,
    );
    return 'commission';
  }
  return acct.plan;
}

/** Pull the live subscription state from Square and fold it into the account row. */
export async function syncSubscription(acct: BillingAccount): Promise<BillingAccount> {
  if (!acct.square_subscription_id) return acct;
  let sub;
  try {
    sub = await retrievePlatformSubscription(acct.square_subscription_id);
  } catch {
    return acct; // Square unreachable: serve stored state rather than failing the page
  }
  if (!sub) return acct;
  const paidThrough: string | null = sub.charged_through_date ?? sub.canceled_date ?? acct.subscription_paid_through;
  const fields: Record<string, unknown> = {
    subscription_status: sub.status ?? acct.subscription_status,
    subscription_paid_through: paidThrough,
  };
  // Apply a scheduled switch to commission once the paid period has run out.
  if (
    acct.pending_plan === 'commission' &&
    (sub.status === 'CANCELED' || sub.status === 'DEACTIVATED') &&
    paidThrough &&
    paidThrough < today()
  ) {
    fields.plan = 'commission';
    fields.pending_plan = null;
  }
  return updateAccount(acct.location_id, fields);
}

export interface BillingState {
  account: BillingAccount;
  effective_plan: BillingPlan;
  accrued_cents: number;
  collected_this_month_cents: number;
  has_card: boolean;
}

// E-low: getBillingState used to make a LIVE Square call (syncSubscription)
// on every portal view. Sync at most once a minute per location — the
// subscription state does not change faster than that in practice, and
// plan switches call syncSubscription directly.
const lastSyncAt = new Map<string, number>();

export async function getBillingState(locationId: string): Promise<BillingState> {
  let acct = await ensureBillingAccount(locationId);
  if (Date.now() - (lastSyncAt.get(locationId) ?? 0) > 60_000) {
    acct = await syncSubscription(acct);
    lastSyncAt.set(locationId, Date.now());
  }
  // CASE sums instead of FILTER aggregates (pg-mem silently ignores FILTER),
  // and the month boundary is computed in JS (pg-mem has no date_trunc).
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const agg = await query<{ accrued: string; collected: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'accrued' THEN fee_cents ELSE 0 END), 0) AS accrued,
       COALESCE(SUM(CASE WHEN status IN ('collected','charged') AND created_at >= $2 THEN fee_cents ELSE 0 END), 0) AS collected
     FROM fee_ledger WHERE location_id = $1`,
    [locationId, monthStart.toISOString()],
  );
  return {
    account: acct,
    effective_plan: effectivePlan(acct),
    accrued_cents: Number(agg.rows[0]?.accrued ?? 0),
    collected_this_month_cents: Number(agg.rows[0]?.collected ?? 0),
    has_card: !!acct.square_card_id,
  };
}

/** Record a commission fee for a completed guest card payment. */
export async function recordFee(input: {
  locationId: string;
  paymentRowId: string | null;
  posPaymentRef: string | null;
  chargeCents: number;
  feeCents: number;
  currency: string;
  method: 'square_app_fee' | 'accrued';
}): Promise<void> {
  if (input.feeCents <= 0) return;
  // ON CONFLICT DO NOTHING + the partial unique index from migration 017
  // (E-9): one original fee per payment per method, even if a completion
  // path runs twice (webhook + poll, reconcile + live path).
  await query(
    `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      input.locationId,
      input.paymentRowId,
      input.posPaymentRef,
      input.chargeCents,
      input.feeCents,
      input.currency,
      input.method,
      input.method === 'square_app_fee' ? 'collected' : 'accrued',
    ],
  );
}

/** Save (or replace) the restaurant's card on file on the platform Square account. */
export async function saveCard(
  locationId: string,
  input: { sourceId: string; verificationToken?: string; email?: string },
): Promise<BillingAccount> {
  return withBillingLock(locationId, () => saveCardLocked(locationId, input));
}

async function saveCardLocked(
  locationId: string,
  input: { sourceId: string; verificationToken?: string; email?: string },
): Promise<BillingAccount> {
  if (typeof input.sourceId !== 'string' || !/^cnon:/.test(input.sourceId)) {
    throw badRequest('invalid card token');
  }
  let acct = await ensureBillingAccount(locationId);
  if (!acct.square_customer_id) {
    const loc = await query<{ name: string | null }>(`SELECT name FROM locations WHERE id = $1`, [locationId]);
    const owner = await query<{ email: string }>(
      `SELECT email FROM portal_users WHERE location_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [locationId],
    ).catch(() => ({ rows: [] as { email: string }[] }));
    // Square Subscriptions require an email on the customer (invoices are
    // emailed); refuse early with a clear message instead of a Square 400.
    const email = input.email ?? owner.rows[0]?.email ?? '';
    if (!email) {
      throw badRequest('an email address is required for billing — sign in with your portal account to add a card');
    }
    const customer = await createPlatformCustomer(loc.rows[0]?.name ?? 'Restaurant', email, locationId);
    if (!customer?.id) throw new Error('Square customer creation failed');
    acct = await updateAccount(locationId, { square_customer_id: String(customer.id) });
  } else if (input.email) {
    // Customer exists (maybe created before it had an email): keep Square's
    // copy in sync so subscription creation cannot fail on a missing email.
    await updatePlatformCustomerEmail(acct.square_customer_id, input.email).catch(() => undefined);
  }
  const card = await createPlatformCard({
    customerId: acct.square_customer_id!,
    sourceId: input.sourceId,
    verificationToken: input.verificationToken,
  });
  if (!card?.id) throw new Error('Square card creation failed');
  const oldCardId = acct.square_card_id;
  acct = await updateAccount(locationId, {
    square_card_id: String(card.id),
    card_brand: card.card_brand ? String(card.card_brand) : null,
    card_last4: card.last_4 ? String(card.last_4) : null,
  });
  if (oldCardId && oldCardId !== card.id) {
    await disablePlatformCard(oldCardId).catch(() => undefined);
  }
  return acct;
}

async function ensurePlanVariation(priceCents: number, currency: string): Promise<string> {
  const key = `sq_plan_variation_${priceCents}_${currency}`;
  const existing = await query<{ value: string }>(`SELECT value FROM billing_settings WHERE key = $1`, [key]);
  if (existing.rows[0]?.value) return existing.rows[0].value;
  const variationId = await createSubscriptionPlanVariation(priceCents, currency);
  await query(
    `INSERT INTO billing_settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [key, variationId],
  );
  // A concurrent first call may have stored its own variation id first;
  // always use the stored one so every subscription references the same
  // plan variation (the loser's Square catalog object is a harmless orphan).
  const stored = await query<{ value: string }>(`SELECT value FROM billing_settings WHERE key = $1`, [key]);
  return stored.rows[0]?.value ?? variationId;
}

export async function switchPlan(locationId: string, target: BillingPlan): Promise<BillingState> {
  return withBillingLock(locationId, () => switchPlanLocked(locationId, target));
}

async function switchPlanLocked(locationId: string, target: BillingPlan): Promise<BillingState> {
  let acct = await ensureBillingAccount(locationId);
  acct = await syncSubscription(acct);
  const nowPlan = effectivePlan(acct);

  if (target === 'subscription') {
    if (nowPlan === 'subscription' && !acct.pending_plan) return getBillingState(locationId);
    // A canceled subscription still inside its paid window: re-subscribing
    // now would double-charge the overlap, so make the owner wait it out.
    if (
      acct.plan === 'subscription' &&
      acct.pending_plan === 'commission' &&
      acct.subscription_paid_through &&
      acct.subscription_paid_through >= today()
    ) {
      throw badRequest(
        `your current subscription is paid through ${acct.subscription_paid_through}; you can re-subscribe after that date`,
      );
    }
    if (!acct.square_card_id || !acct.square_customer_id) {
      throw badRequest('add a payment card first, then choose the subscription plan');
    }
    const loc = await platformLocation();
    const variationId = await ensurePlanVariation(acct.subscription_price_cents, loc.currency);
    // Search-before-create (E-3): if a previous attempt created the Square
    // subscription but its response or our DB write was lost, adopt the
    // existing live subscription instead of stacking a second one that
    // would double-charge the restaurant every month.
    const existingSubs = await searchPlatformSubscriptions(acct.square_customer_id).catch(() => []);
    const liveSub = existingSubs.find(
      (s) => (s?.status === 'ACTIVE' || s?.status === 'PAUSED') && s?.plan_variation_id === variationId,
    );
    if (liveSub?.id) {
      await updateAccount(locationId, {
        plan: 'subscription',
        pending_plan: null,
        currency: loc.currency,
        square_subscription_id: String(liveSub.id),
        subscription_status: liveSub.status ? String(liveSub.status) : 'ACTIVE',
        subscription_paid_through: liveSub.charged_through_date ?? null,
      });
      return getBillingState(locationId);
    }
    let sub;
    try {
      sub = await createPlatformSubscription({
        customerId: acct.square_customer_id,
        planVariationId: variationId,
        cardId: acct.square_card_id,
        locationId: loc.id,
      });
    } catch (e) {
      if (e instanceof SquareError) {
        // E-low: Square's raw error detail stays in the server log — the
        // client gets a generic message (provider internals are not UI).
        console.error('[billing] Square subscription creation failed:', e.errors ?? e);
        throw badRequest('could not start the subscription — please try again or contact support');
      }
      throw e;
    }
    if (!sub?.id) throw new Error('Square subscription creation failed');
    await updateAccount(locationId, {
      plan: 'subscription',
      pending_plan: null,
      currency: loc.currency,
      square_subscription_id: String(sub.id),
      subscription_status: sub.status ? String(sub.status) : 'ACTIVE',
      subscription_paid_through: sub.charged_through_date ?? null,
    });
    return getBillingState(locationId);
  }

  // target === 'commission'
  if (nowPlan === 'commission') {
    if (acct.pending_plan) await updateAccount(locationId, { pending_plan: null });
    return getBillingState(locationId);
  }
  if (acct.square_subscription_id && acct.subscription_status === 'ACTIVE') {
    const sub = await cancelPlatformSubscription(acct.square_subscription_id);
    await updateAccount(locationId, {
      pending_plan: 'commission',
      subscription_status: sub?.status ? String(sub.status) : 'CANCELED',
      subscription_paid_through: sub?.canceled_date ?? sub?.charged_through_date ?? acct.subscription_paid_through,
    });
  } else {
    await updateAccount(locationId, { plan: 'commission', pending_plan: null });
  }
  return getBillingState(locationId);
}

export interface HistoryEntry {
  date: string;
  kind: 'commission_fee' | 'subscription_invoice' | 'accrued_charge' | 'fee_reversal';
  description: string;
  amount_cents: number;
  currency: string;
  status: string;
}

export async function billingHistory(locationId: string): Promise<HistoryEntry[]> {
  const acct = await ensureBillingAccount(locationId);
  const ledger = await query<{
    created_at: string; charge_cents: number; fee_cents: number; currency: string; method: string; status: string;
  }>(
    `SELECT created_at, charge_cents, fee_cents, currency, method, status FROM fee_ledger
     WHERE location_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [locationId],
  );
  const pct = `${acct.commission_bps / 100}%`;
  const out: HistoryEntry[] = ledger.rows.map((r) => ({
    date: new Date(r.created_at).toISOString(),
    kind: (r.method === 'reversal' ? 'fee_reversal' : 'commission_fee') as HistoryEntry['kind'],
    description:
      r.method === 'reversal'
        ? 'Commission given back — guest payment was refunded'
        : r.method === 'square_app_fee'
          ? `${pct} fee on a $${(r.charge_cents / 100).toFixed(2)} guest payment (taken by Square)`
          : `${pct} fee on a $${(r.charge_cents / 100).toFixed(2)} guest payment (accrued)`,
    amount_cents: r.fee_cents,
    currency: r.currency,
    status: r.status,
  }));
  if (acct.square_subscription_id) {
    try {
      const sub = await retrievePlatformSubscription(acct.square_subscription_id);
      const invoiceIds: string[] = Array.isArray(sub?.invoice_ids) ? sub.invoice_ids.slice(-12).reverse() : [];
      for (const invId of invoiceIds) {
        const inv = await retrievePlatformInvoice(String(invId)).catch(() => null);
        if (!inv) continue;
        const money = inv.payment_requests?.[0]?.total_completed_amount_money ??
          inv.payment_requests?.[0]?.computed_amount_money;
        out.push({
          date: String(inv.created_at ?? ''),
          kind: 'subscription_invoice',
          description: 'Smart Table monthly subscription',
          amount_cents: Number(money?.amount ?? acct.subscription_price_cents),
          currency: String(money?.currency ?? acct.currency),
          status: String(inv.status ?? ''),
        });
      }
    } catch { /* history is best-effort */ }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 50);
}

/** SDK config for tokenizing the restaurant's OWN card (platform account). */
export async function platformCardConfig(): Promise<{ provider: string; publishableKey: string; extra: { locationId: string; environment: string } }> {
  if (!config.squareAppId) throw new Error('SQUARE_APP_ID is not configured');
  const loc = await platformLocation();
  return {
    provider: 'square',
    publishableKey: config.squareAppId,
    extra: { locationId: loc.id, environment: config.squareEnv },
  };
}

/**
 * Monthly collection of accrued commission: charge each location's card on
 * file once its accrued balance is at least $50, or its oldest accrued fee
 * is at least 25 days old. Safe to call repeatedly (rows flip to 'charged'
 * only after a successful charge).
 */
export async function processAccruedFees(): Promise<{ locationsCharged: number; totalCents: number }> {
  // Due-selection computed in JS (portable across Postgres/pg-mem, which
  // cannot plan the compound HAVING this used to use): a location is due
  // when its net accrued balance is positive AND (≥ $50 or oldest fee ≥ 25
  // days old). Reversal rows (negative) net into the balance.
  const accrued = await query<{ location_id: string; fee_cents: number; created_at: string }>(
    `SELECT location_id, fee_cents, created_at FROM fee_ledger WHERE status = 'accrued'`,
  );
  const byLocation = new Map<string, { total: number; oldest: string }>();
  for (const r of accrued.rows) {
    const cur = byLocation.get(r.location_id) ?? { total: 0, oldest: r.created_at };
    cur.total += r.fee_cents;
    if (r.created_at < cur.oldest) cur.oldest = r.created_at;
    byLocation.set(r.location_id, cur);
  }
  const cutoff = new Date(Date.now() - 25 * 86400000).toISOString();
  const due = [...byLocation.entries()]
    .filter(([, v]) => v.total > 0 && (v.total >= 5000 || v.oldest <= cutoff))
    .map(([location_id, v]) => ({ location_id, total: v.total, oldest: v.oldest }));
  let locationsCharged = 0;
  let totalCents = 0;
  for (const row of due) {
    const acct = await ensureBillingAccount(row.location_id);
    if (!acct.square_card_id || !acct.square_customer_id) continue;
    // Atomic claim (E-2): flip this location's accrued rows to 'charging'
    // under a fresh batch id in ONE statement. Overlapping runs claim
    // disjoint row sets, rows accrued after the due-snapshot are not swept
    // into a charge whose total was computed earlier, and the Square
    // idempotency key is derived from the batch so retrying the same batch
    // can never double-charge.
    const batchId = randomUUID();
    const claim = await query<{ fee_cents: number; currency: string }>(
      `UPDATE fee_ledger SET status = 'charging', batch_id = $2
       WHERE location_id = $1 AND status = 'accrued'
       RETURNING fee_cents, currency`,
      [row.location_id, batchId],
    );
    if (claim.rows.length === 0) continue; // another run claimed them first
    const total = claim.rows.reduce((s, r) => s + Number(r.fee_cents), 0);
    if (total <= 0) {
      // Net credit / zero balance: nothing to charge, release the claim.
      await query(
        `UPDATE fee_ledger SET status = 'accrued', batch_id = NULL WHERE batch_id = $1 AND status = 'charging'`,
        [batchId],
      );
      continue;
    }
    try {
      const loc = await platformLocation();
      const payment = await createPlatformCardCharge({
        customerId: acct.square_customer_id,
        cardId: acct.square_card_id,
        locationId: loc.id,
        amountCents: total,
        currency: claim.rows[0]?.currency ?? loc.currency,
        idempotencyKey: `fees-${batchId}`,
        note: 'Smart Table commission (accrued guest-payment fees)',
      });
      if (!payment?.id) throw new Error('Square accrued-fee charge returned no payment');
      await query(
        `UPDATE fee_ledger SET status = 'charged', platform_charge_ref = $2 WHERE batch_id = $1 AND status = 'charging'`,
        [batchId, String(payment.id)],
      );
      locationsCharged += 1;
      totalCents += total;
    } catch (e) {
      if (isDefinitiveSquareFailure(e)) {
        // The card definitively refused: release the rows so a later run
        // (after the restaurant updates its card) can collect them.
        await query(
          `UPDATE fee_ledger SET status = 'accrued', batch_id = NULL WHERE batch_id = $1 AND status = 'charging'`,
          [batchId],
        ).catch(() => undefined);
      }
      // Unknown outcome (timeout / 5xx / network): the rows STAY in
      // 'charging' under this batch — never re-charged blindly. The charge
      // can be resolved by looking the Square payment up by its
      // idempotency key (`fees-<batchId>`).
      console.error(`[billing] accrued fee charge failed for location ${row.location_id} (batch ${batchId}):`, e);
    }
  }
  return { locationsCharged, totalCents };
}
