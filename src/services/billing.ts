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
import { query, withAdvisoryLock } from '../db.js';
import { badRequest, conflict, httpError } from '../http.js';
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
  updatePlatformSubscriptionCard,
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
  /** F2-6: accrued-fee charge backoff state (migration 023). */
  fee_charge_failures: number;
  fee_charge_next_attempt_at: string | null;
}

export const DEFAULT_COMMISSION_BPS = 200; // 2.00%
export const DEFAULT_SUBSCRIPTION_PRICE_CENTS = 9900; // $99.00/mo — Base plan price (Erfan, 2026-10-21); per-account adjustable

/** 2% of the charged amount (amount + tip), rounded to the nearest cent; never negative, never the whole charge. */
export function feeFor(chargeCents: number, bps: number): number {
  if (!Number.isSafeInteger(chargeCents) || chargeCents <= 0) return 0;
  const fee = Math.round((chargeCents * bps) / 10000);
  return Math.max(0, Math.min(fee, chargeCents - 1));
}

// Per-location mutex for billing mutations (E-3): switchPlan and saveCard
// interleave Square API calls with DB reads/writes, so a double click or a
// client retry could otherwise create duplicate Square customers, cards or
// subscriptions.
// F2-11: the lock is now a Postgres advisory lock (session-level, held on
// one connection for the whole operation), not an in-process promise
// chain — a rolling deploy briefly runs two instances, and an in-process
// map can't exclude the other one. On pg-mem (tests) the advisory lock is
// unsupported and the operation runs anyway (runIfUnsupported), matching
// the old single-instance behavior. Contention answers a clean 409
// instead of queueing behind a possibly-slow Square call chain.
export async function withBillingLock<T>(locationId: string, fn: () => Promise<T>): Promise<T> {
  const r = await withAdvisoryLock(`billing:${locationId}`, fn, { runIfUnsupported: true });
  if (r === null) {
    throw conflict('another billing change is in progress for this location — wait a moment and retry', 'billing_busy');
  }
  return r;
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
  'fee_charge_failures', 'fee_charge_next_attempt_at',
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
// F2-1/F2-12: the lapse warning used to fire on EVERY guest payment for a
// lapsed location — once per location per day is plenty.
const lapseWarnedOn = new Map<string, string>();
function warnLapsed(acct: BillingAccount, status: string): void {
  const day = today();
  if (lapseWarnedOn.get(acct.location_id) === day) return;
  lapseWarnedOn.set(acct.location_id, day);
  console.warn(
    `[billing] location ${acct.location_id}: subscription lapsed (status=${status || 'unknown'}, paid_through=${acct.subscription_paid_through}) — billing as commission`,
  );
}

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
  // Coverage is decided by the PAID PERIOD first (F2-12): a subscription
  // that Square canceled (or the owner canceled for a pending switch)
  // still covers every day it was paid for — reading a non-ACTIVE status
  // as an instant lapse charged commission on top of already-paid days.
  // DEACTIVATED is the exception: it is Square's terminal state (the
  // subscription is over, full stop), so it lapses regardless of dates
  // (E-8's original case).
  const status = (acct.subscription_status ?? '').toUpperCase();
  const paidThrough = acct.subscription_paid_through;
  if (status !== 'DEACTIVATED' && paidThrough !== null && paidThrough >= today()) return 'subscription';
  // E-8 (kept): a LAPSED subscription must not silently stay on the
  // subscription plan forever (commission would never be charged).
  // F2-1: but a stored paid_through can be a few days stale when Square
  // has already renewed — syncSubscription now runs on the billing timer
  // (syncAllSubscriptions), and an ACTIVE subscription gets a 3-day grace
  // past the stored date before we bill commission on top of it. A truly
  // lapsed sub (renewal failed) flips within those 3 days; a renewed one
  // is corrected by the next sync.
  if (status === 'ACTIVE') {
    if (paidThrough === null) return 'subscription'; // just created; Square hasn't reported a period yet
    const staleDays = Math.floor((Date.parse(today()) - Date.parse(paidThrough)) / 86400000);
    if (staleDays <= 3) return 'subscription';
  }
  // No Square evidence either way (no status, no period — a plan flag set
  // before any sync): respect the owner's chosen plan; the scheduled sync
  // fills the fields in and the rules above take over from there.
  if (status === '' && paidThrough === null) return 'subscription';
  warnLapsed(acct, status);
  return 'commission';
}

/** Pull the live subscription state from Square and fold it into the account row. */
export async function syncSubscription(acct: BillingAccount): Promise<BillingAccount> {
  if (!acct.square_subscription_id) return acct;
  let sub;
  try {
    sub = await retrievePlatformSubscription(acct.square_subscription_id);
  } catch (e) {
    // F2-14: never silent — a sync that keeps failing leaves the stored
    // state stale, which is exactly how F2-1 double-charges happen.
    console.error(`[billing] subscription sync failed for location ${acct.location_id} (sub ${acct.square_subscription_id}):`, e);
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

/**
 * F2-1: keep every stored subscription fresh on a schedule — before this,
 * syncSubscription ran only when an owner opened the billing page or
 * switched plans, so a Square renewal nobody looked at left the stored
 * paid_through stale and effectivePlan flipped the location to commission
 * ON TOP of its live subscription. Called from the billing timer.
 */
export async function syncAllSubscriptions(): Promise<{ synced: number }> {
  const r = await query<BillingAccount>(
    `SELECT * FROM billing_accounts WHERE square_subscription_id IS NOT NULL`,
  );
  let synced = 0;
  for (const acct of r.rows) {
    try {
      await syncSubscription(acct);
      synced += 1;
    } catch (e) {
      console.error(`[billing] scheduled subscription sync failed for location ${acct.location_id}:`, e);
    }
  }
  return { synced };
}

export interface BillingState {
  account: BillingAccount;
  effective_plan: BillingPlan;
  accrued_cents: number;
  /** F2-14: fees claimed by an in-flight collection batch — previously
   * invisible in BOTH the accrued and collected figures while stuck. */
  processing_cents: number;
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
  const agg = await query<{ accrued: string; collected: string; processing: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'accrued' THEN fee_cents ELSE 0 END), 0) AS accrued,
       COALESCE(SUM(CASE WHEN status = 'charging' THEN fee_cents ELSE 0 END), 0) AS processing,
       COALESCE(SUM(CASE WHEN status IN ('collected','charged') AND created_at >= $2 THEN fee_cents ELSE 0 END), 0) AS collected
     FROM fee_ledger WHERE location_id = $1`,
    [locationId, monthStart.toISOString()],
  );
  return {
    account: acct,
    effective_plan: effectivePlan(acct),
    accrued_cents: Number(agg.rows[0]?.accrued ?? 0),
    processing_cents: Number(agg.rows[0]?.processing ?? 0),
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
  // Length-bounded like the guest-side token patterns (F1-17/F2 Low).
  if (typeof input.sourceId !== 'string' || !/^cnon:[A-Za-z0-9_-]{1,200}$/.test(input.sourceId)) {
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
    // F2-7: an active subscription still points at the OLD card — move it
    // to the new card FIRST. If that update fails, keep the old card
    // enabled (disabling it would guarantee a failed renewal and a
    // lapsed subscription); the subscription keeps charging the old card
    // until a later save succeeds.
    let safeToDisable = !acct.square_subscription_id;
    if (acct.square_subscription_id) {
      try {
        await updatePlatformSubscriptionCard(acct.square_subscription_id, String(card.id));
        safeToDisable = true;
      } catch (e) {
        console.error(
          `[billing] could not move subscription ${acct.square_subscription_id} to the new card; keeping the old card enabled:`,
          e,
        );
      }
    }
    if (safeToDisable) {
      await disablePlatformCard(oldCardId).catch(() => undefined);
    }
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
    // F2-8: a FAILED search must abort the switch, not silently read as
    // "no existing subscription" — Square being flaky is exactly when a
    // previous create may have succeeded unseen. And the match no longer
    // requires the same plan_variation_id: after a price change the stored
    // variation differs, and the old check created a second live
    // subscription next to the first. Any live subscription for this
    // customer is THE subscription.
    let existingSubs;
    try {
      existingSubs = await searchPlatformSubscriptions(acct.square_customer_id);
    } catch (e) {
      console.error(`[billing] subscription search failed for location ${locationId}; aborting plan switch:`, e);
      throw httpError(503, 'could not verify existing subscriptions with Square — please try again', 'billing_sync_failed');
    }
    const liveSub = existingSubs.find((s) => s?.status === 'ACTIVE' || s?.status === 'PAUSED');
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
  // F2-8: cancel ANY non-terminal subscription — the old code canceled
  // only ACTIVE, so a PAUSED subscription survived the switch and could
  // resume charging a restaurant that had moved to commission.
  const subStatus = (acct.subscription_status ?? '').toUpperCase();
  if (acct.square_subscription_id && subStatus !== 'CANCELED' && subStatus !== 'DEACTIVATED') {
    const sub = await cancelPlatformSubscription(acct.square_subscription_id);
    await updateAccount(locationId, {
      pending_plan: 'commission',
      // F2-12: never fabricate 'CANCELED' when Square returned no status —
      // a fabricated terminal status read as an instant lapse in
      // effectivePlan and charged commission inside the paid window.
      subscription_status: sub?.status ? String(sub.status) : acct.subscription_status,
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
  // F2-4: node-postgres returns TIMESTAMPTZ as a JS Date; pg-mem returns a
  // string. Comparing a Date against an ISO string with <= coerces the
  // Date to its toString() ("Fri Oct 23 2026 …") and the 25-day branch
  // silently never fired in production. Normalize everything to epoch ms.
  const tsOf = (v: unknown): number => new Date(v as string).getTime();
  const byLocation = new Map<string, { total: number; oldest: number }>();
  for (const r of accrued.rows) {
    const ts = tsOf(r.created_at);
    const cur = byLocation.get(r.location_id) ?? { total: 0, oldest: ts };
    cur.total += r.fee_cents;
    if (ts < cur.oldest) cur.oldest = ts;
    byLocation.set(r.location_id, cur);
  }
  const cutoff = Date.now() - 25 * 86400000;
  const due = [...byLocation.entries()]
    .filter(([, v]) => v.total > 0 && (v.total >= 5000 || v.oldest <= cutoff))
    .map(([location_id, v]) => ({ location_id, total: v.total, oldest: v.oldest }));
  // F2-6: a definitively declined card used to be retried on EVERY run
  // (every 6h, plus 60s after each deploy). Failures now back off
  // exponentially per location (6h, 12h, 24h, capped 48h); a success
  // resets the counter.
  const noteFailure = async (acct: BillingAccount): Promise<void> => {
    const failures = (acct.fee_charge_failures ?? 0) + 1;
    const backoffMs = Math.min(6 * 3600000 * 2 ** (failures - 1), 48 * 3600000);
    await updateAccount(acct.location_id, {
      fee_charge_failures: failures,
      fee_charge_next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
    }).catch((e) => console.error('[billing] could not record fee-charge backoff:', e));
  };
  const releaseClaim = async (batchId: string): Promise<void> => {
    await query(
      `UPDATE fee_ledger SET status = 'accrued', batch_id = NULL, claimed_at = NULL WHERE batch_id = $1 AND status = 'charging'`,
      [batchId],
    ).catch(() => undefined);
  };

  let locationsCharged = 0;
  let totalCents = 0;
  for (const row of due) {
    const acct = await ensureBillingAccount(row.location_id);
    if (!acct.square_card_id || !acct.square_customer_id) continue;
    if (acct.fee_charge_next_attempt_at && new Date(acct.fee_charge_next_attempt_at).getTime() > Date.now()) {
      continue; // F2-6 backoff window
    }
    // Atomic claim (E-2): flip this location's accrued rows to 'charging'
    // under a fresh batch id in ONE statement. Overlapping runs claim
    // disjoint row sets, rows accrued after the due-snapshot are not swept
    // into a charge whose total was computed earlier, and the Square
    // idempotency key is derived from the batch so retrying the same batch
    // can never double-charge.
    const batchId = randomUUID();
    const claim = await query<{ fee_cents: number; currency: string }>(
      `UPDATE fee_ledger SET status = 'charging', batch_id = $2, claimed_at = now()
       WHERE location_id = $1 AND status = 'accrued'
       RETURNING fee_cents, currency`,
      [row.location_id, batchId],
    );
    if (claim.rows.length === 0) continue; // another run claimed them first
    const total = claim.rows.reduce((s, r) => s + Number(r.fee_cents), 0);
    if (total <= 0) {
      // Net credit / zero balance: nothing to charge, release the claim.
      await releaseClaim(batchId);
      continue;
    }
    let payment;
    try {
      const loc = await platformLocation();
      payment = await createPlatformCardCharge({
        customerId: acct.square_customer_id,
        cardId: acct.square_card_id,
        locationId: loc.id,
        amountCents: total,
        currency: claim.rows[0]?.currency ?? loc.currency,
        idempotencyKey: `fees-${batchId}`,
        note: 'Smart Table commission (accrued guest-payment fees)',
      });
    } catch (e) {
      if (isDefinitiveSquareFailure(e)) {
        // The card definitively refused: release the rows so a later run
        // (after the restaurant updates its card) can collect them — with
        // F2-6 backoff, not on the very next run.
        await releaseClaim(batchId);
        await noteFailure(acct);
      }
      // Unknown outcome (timeout / 5xx / network): the rows STAY in
      // 'charging' under this batch — never re-charged blindly. Square
      // has no get-by-idempotency-key lookup (F2-5); resolveStuckFeeCharges
      // re-sends the identical request inside Square's key-retention
      // window and settles from the response.
      console.error(`[billing] accrued fee charge failed for location ${row.location_id} (batch ${batchId}):`, e);
      continue;
    }
    if (!payment?.id) {
      console.error(`[billing] fee charge for location ${row.location_id} (batch ${batchId}) returned no payment — left 'charging' for the resolver`);
      continue;
    }
    // F2-10: a returned payment object is not success by itself — with
    // autocomplete a settled charge reports COMPLETED; FAILED/CANCELED
    // must release the claim (with backoff), anything else stays
    // 'charging' for the resolver rather than marking money collected
    // that never moved.
    const pStatus = typeof payment.status === 'string' ? payment.status.toUpperCase() : '';
    if (pStatus === 'FAILED' || pStatus === 'CANCELED') {
      console.error(`[billing] fee charge payment ${payment.id} for location ${row.location_id} ended ${pStatus} — releasing the batch`);
      await releaseClaim(batchId);
      await noteFailure(acct);
      continue;
    }
    if (pStatus && pStatus !== 'COMPLETED') {
      console.error(`[billing] fee charge payment ${payment.id} for location ${row.location_id} has status ${pStatus} — left 'charging' for the resolver`);
      continue;
    }
    await query(
      `UPDATE fee_ledger SET status = 'charged', platform_charge_ref = $2 WHERE batch_id = $1 AND status = 'charging'`,
      [batchId, String(payment.id)],
    );
    if ((acct.fee_charge_failures ?? 0) > 0 || acct.fee_charge_next_attempt_at) {
      await updateAccount(row.location_id, { fee_charge_failures: 0, fee_charge_next_attempt_at: null })
        .catch((e) => console.error('[billing] could not reset fee-charge backoff:', e));
    }
    locationsCharged += 1;
    totalCents += total;
  }
  return { locationsCharged, totalCents };
}

/**
 * F2-5: batches stuck in 'charging' (the charge's outcome was unknown —
 * timeout, 5xx, process death) used to sit there forever: the fees were
 * never collected and never visible as collected either. Square offers NO
 * lookup by idempotency key, but re-sending the IDENTICAL request (same
 * key `fees-<batchId>`, same total, same card) inside Square's retention
 * window (24h) is safe: Square returns the original payment instead of
 * charging twice. This resolver does exactly that for batches claimed
 * 15 minutes to 24 hours ago; older batches are flagged for a human and
 * left untouched (past the window a re-send could double-charge).
 */
export async function resolveStuckFeeCharges(): Promise<{ resolved: number; manualReview: number }> {
  const batches = await query<{ batch_id: string; location_id: string; total: string; currency: string; claimed_at: string }>(
    `SELECT batch_id, location_id, SUM(fee_cents) AS total, MIN(currency) AS currency, MIN(claimed_at) AS claimed_at
     FROM fee_ledger WHERE status = 'charging' AND batch_id IS NOT NULL AND claimed_at IS NOT NULL
     GROUP BY batch_id, location_id`,
  );
  let resolved = 0;
  let manualReview = 0;
  for (const b of batches.rows) {
    const ageMs = Date.now() - new Date(b.claimed_at).getTime();
    if (ageMs < 15 * 60000) continue; // the original attempt may still be settling
    if (ageMs > 24 * 3600000) {
      manualReview += 1;
      console.error(
        `[billing] MANUAL REVIEW: fee batch ${b.batch_id} (location ${b.location_id}, ${b.total} cents) has been 'charging' for over 24h — past Square's idempotency window; verify in the Square dashboard before touching it`,
      );
      continue;
    }
    const acct = await ensureBillingAccount(b.location_id);
    if (!acct.square_card_id || !acct.square_customer_id) continue;
    try {
      const loc = await platformLocation();
      const payment = await createPlatformCardCharge({
        customerId: acct.square_customer_id,
        cardId: acct.square_card_id,
        locationId: loc.id,
        amountCents: Number(b.total),
        currency: b.currency ?? loc.currency,
        idempotencyKey: `fees-${b.batch_id}`,
        note: 'Smart Table commission (accrued guest-payment fees)',
      });
      const pStatus = typeof payment?.status === 'string' ? payment.status.toUpperCase() : '';
      if (payment?.id && (pStatus === '' || pStatus === 'COMPLETED')) {
        await query(
          `UPDATE fee_ledger SET status = 'charged', platform_charge_ref = $2 WHERE batch_id = $1 AND status = 'charging'`,
          [b.batch_id, String(payment.id)],
        );
        resolved += 1;
      } else if (pStatus === 'FAILED' || pStatus === 'CANCELED') {
        await query(
          `UPDATE fee_ledger SET status = 'accrued', batch_id = NULL, claimed_at = NULL WHERE batch_id = $1 AND status = 'charging'`,
          [b.batch_id],
        );
        resolved += 1;
      }
      // Any other status: leave the batch for the next resolver run.
    } catch (e) {
      if (isDefinitiveSquareFailure(e)) {
        await query(
          `UPDATE fee_ledger SET status = 'accrued', batch_id = NULL, claimed_at = NULL WHERE batch_id = $1 AND status = 'charging'`,
          [b.batch_id],
        ).catch(() => undefined);
        resolved += 1;
      } else {
        console.error(`[billing] stuck-batch resolver could not resolve batch ${b.batch_id}:`, e);
      }
    }
  }
  return { resolved, manualReview };
}

/**
 * F1-6 sweep: a successful charge whose recordFee write failed (DB blip)
 * used to lose the platform's commission silently — the payment completed
 * and nothing ever looked for the missing ledger row again. This sweep
 * finds settled payments on commission-plan locations with NO fee row and
 * records the fee through the same idempotent recordFee.
 *
 * Square locations are the exception: Square takes the application fee
 * in-flight, atomically with the charge, so a missing row there is a
 * bookkeeping gap, NOT money owed — recording it as 'accrued' would bill
 * the restaurant twice. Square misses are counted and logged loudly for
 * manual review instead.
 */
export async function sweepMissingFees(): Promise<{ recorded: number; squareMissing: number }> {
  const r = await query<{
    id: string; amount_cents: number; tip_cents: number; currency: string | null;
    external_payment_ref: string | null; square_payment_id: string | null;
    pos_type: string; location_id: string | null;
  }>(
    // LEFT JOIN instead of a correlated NOT EXISTS: pg-mem cannot plan
    // correlated subqueries against the outer row (and the shape is
    // portable to real Postgres unchanged). Duplicate rows from multiple
    // fee entries are deduped by the f.id IS NULL filter itself — a
    // payment with ANY fee row joins only non-null rows.
    `SELECT p.id, p.amount_cents, p.tip_cents, p.currency, p.external_payment_ref,
            p.square_payment_id, c.pos_type, c.location_id
     FROM payments p JOIN checks c ON c.id = p.check_id
     LEFT JOIN fee_ledger f ON f.payment_row_id = p.id AND f.method IN ('square_app_fee','accrued')
     WHERE p.status IN ('AUTHORIZED','COMPLETED')
       AND p.created_at < now() - interval '10 minutes'
       AND f.id IS NULL`,
  );
  let recorded = 0;
  let squareMissing = 0;
  for (const row of r.rows) {
    if (!row.location_id) continue;
    try {
      const acct = await ensureBillingAccount(row.location_id);
      if (effectivePlan(acct) !== 'commission') continue;
      const fee = feeFor(row.amount_cents + row.tip_cents, acct.commission_bps);
      if (fee <= 0) continue;
      if (row.pos_type === 'square') {
        squareMissing += 1;
        console.error(
          `[billing] MISSING FEE ROW for Square payment ${row.id} (location ${row.location_id}): ` +
            'the in-flight application fee is not in the ledger — review manually, do NOT accrue.',
        );
        continue;
      }
      await recordFee({
        locationId: row.location_id,
        paymentRowId: row.id,
        posPaymentRef: row.external_payment_ref ?? row.square_payment_id,
        chargeCents: row.amount_cents + row.tip_cents,
        feeCents: fee,
        currency: row.currency ?? 'CAD',
        method: 'accrued',
      });
      recorded += 1;
    } catch (e) {
      console.error(`[billing] sweepMissingFees failed for payment ${row.id}:`, e);
    }
  }
  return { recorded, squareMissing };
}
