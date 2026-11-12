// v0.4 billing: how restaurants pay Smart Table.
//
// Tiers (locations.tier, v0.9.0): starter ($49.99/mo or 1% — printed QR
// codes only) and base ($99/mo or 2% — with the STT-101 device). The
// tier supplies the default price/commission pair below; see
// TIER_DEFAULTS and setLocationTier.
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
import { query, withAdvisoryLock, withTx } from '../db.js';
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
  squareErrorCode,
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

// v0.9.0: service tiers (locations.tier, migration 031). The tier picks
// the DEFAULT price/commission pair for the location's billing account —
// each tier offers the same two plans: subscription OR commission.
//   starter — printed QR codes only (no device, no printing, no waiter
//             button): $49.99/mo or 1% commission.
//   base    — full product incl. the STT-101 device: $99/mo or 2%.
export type LocationTier = 'starter' | 'base';

export const TIER_DEFAULTS: Record<LocationTier, { subscription_price_cents: number; commission_bps: number }> = {
  starter: { subscription_price_cents: 4999, commission_bps: 100 },
  base: { subscription_price_cents: DEFAULT_SUBSCRIPTION_PRICE_CENTS, commission_bps: DEFAULT_COMMISSION_BPS },
};

export function isLocationTier(v: unknown): v is LocationTier {
  return v === 'starter' || v === 'base';
}

/** The location's tier; anything unexpected reads as 'base' (the full product). */
export async function getLocationTier(locationId: string): Promise<LocationTier> {
  const r = await query<{ tier: string | null }>(`SELECT tier FROM locations WHERE id = $1`, [locationId]);
  return isLocationTier(r.rows[0]?.tier) ? r.rows[0].tier : 'base';
}

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

function squareStatusOf(e: unknown): number | null {
  const status = (e as { status?: unknown })?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * C3-2-6: failures that are OUR platform's problem, not the restaurant's
 * card — a revoked platform token (401), a permissions error (403), a
 * missing platform customer (404), or a Square-side 5xx. Classifying a
 * 401/403/404 as a card refusal released the batch AND climbed the
 * location's decline backoff, so collection stayed delayed for days
 * after the platform issue was fixed. Platform-side failures are
 * "unknown outcome": the batch stays in 'charging' for the resolver /
 * manual review and the backoff counter is never touched.
 */
function isPlatformSideFailure(e: unknown): boolean {
  const status = squareStatusOf(e);
  if (status === null) return false; // network/timeout: unknown, handled as before
  return status === 401 || status === 403 || status === 404 || status >= 500;
}

/** Definitive refusal of the RESTAURANT's card (release + backoff apply). */
function isDefinitiveCardFailure(e: unknown): boolean {
  return isDefinitiveSquareFailure(e) && !isPlatformSideFailure(e);
}

/**
 * C3-2-3: subscription_paid_through is a DATE column (migration 011).
 * node-postgres returns DATE as a JS Date; pg-mem returns the string.
 * Comparing a Date against a 'YYYY-MM-DD' string with < / >= coerces
 * the string to NaN, so EVERY comparison silently came out false in
 * production while the whole suite (pg-mem strings) passed — the same
 * class as the F2-4 timestamp bug. Normalize every account row through
 * toYmd() at the read choke points (ensureBillingAccount /
 * updateAccount / syncAllSubscriptions) so BillingAccount values are
 * always plain 'YYYY-MM-DD' strings, as the type declares.
 */
export function toYmd(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    // pg builds DATE values from local calendar components — read them
    // back the same way (toISOString would shift the day across TZ).
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    return m ? m[1] : null;
  }
  return null;
}

function normalizeAccount<T extends BillingAccount>(row: T): T {
  if (row) row.subscription_paid_through = toYmd(row.subscription_paid_through);
  return row;
}

export async function ensureBillingAccount(locationId: string): Promise<BillingAccount> {
  // v0.9.0: a NEW account inherits its location tier's default price +
  // commission (starter $49.99/1%, base $99/2%). Existing rows keep the
  // values already stored — tier changes go through setLocationTier.
  const defaults = TIER_DEFAULTS[await getLocationTier(locationId)];
  await query(
    `INSERT INTO billing_accounts(location_id, commission_bps, subscription_price_cents) VALUES ($1, $2, $3) ON CONFLICT (location_id) DO NOTHING`,
    [locationId, defaults.commission_bps, defaults.subscription_price_cents],
  );
  const r = await query<BillingAccount>(`SELECT * FROM billing_accounts WHERE location_id = $1`, [locationId]);
  return normalizeAccount(r.rows[0]);
}

/**
 * v0.9.0: switch a location's service tier (starter <-> base). The tier
 * lives on locations (it gates device pairing + receipt printing) and its
 * default price/commission pair is applied to the billing account, so the
 * NEXT subscription creation / commission charge uses the tier's numbers.
 * A Square subscription that is already live keeps the plan variation it
 * was created with (Square prices a subscription at creation) — the new
 * price takes over when the subscription is next created, e.g. after a
 * plan switch away and back. Plan (commission/subscription) is untouched.
 * v0.10.1 (C3-2-4): re-selecting the current tier is a no-op, and a tier
 * change preserves a customized price/commission pair unless the caller
 * passes resetPricing — only accounts still ON their old tier's defaults
 * move to the new tier's defaults automatically.
 */
export async function setLocationTier(
  locationId: string,
  tier: LocationTier,
  opts: { resetPricing?: boolean } = {},
): Promise<BillingState> {
  return withBillingLock(locationId, async () => {
    const acct = await ensureBillingAccount(locationId);
    const currentTier = await getLocationTier(locationId);
    // C3-2-4(a): re-selecting the CURRENT tier is a no-op. The old code
    // re-applied the tier defaults on every call, so an owner simply
    // re-saving their settings silently wiped a founder-negotiated rate.
    if (currentTier === tier && !opts.resetPricing) return getBillingState(locationId);
    const oldDefaults = TIER_DEFAULTS[currentTier];
    const customized =
      acct.commission_bps !== oldDefaults.commission_bps ||
      acct.subscription_price_cents !== oldDefaults.subscription_price_cents;
    // A tier change moves an UN-customized account to the new tier's
    // defaults. A customized account keeps its negotiated pair unless
    // the caller explicitly asks for a reset — pricing overrides are
    // contracts, not settings noise.
    const applyDefaults = opts.resetPricing || !customized;
    if (customized && !opts.resetPricing) {
      console.log(
        `[billing] tier change ${currentTier} -> ${tier} for location ${locationId}: preserving customized pricing ` +
          `(${acct.commission_bps} bps / ${acct.subscription_price_cents} cents)`,
      );
    }
    const defaults = TIER_DEFAULTS[tier];
    // C3-2-4(d): tier + account move in ONE transaction — the old two
    // statements could split state (tier flipped, pricing stale) when
    // the second write failed.
    await withTx(async (client) => {
      await client.query(`UPDATE locations SET tier = $2 WHERE id = $1`, [locationId, tier]);
      // v0.10.10 (C3-10 L-4): downgrading to Starter deletes the
      // location's outstanding (unused) claim codes in the same
      // transaction. A live code on a Starter location is refused at
      // claim time — but the pre-check that produces that distinct 403
      // doubles as a code-existence oracle; with the codes gone, a
      // downgraded location's guesses get the generic error like any
      // other unknown code, and no code can outlive the downgrade.
      if (tier === 'starter') {
        await client.query(`DELETE FROM device_claim_codes WHERE location_id = $1 AND used_at IS NULL`, [locationId]);
      }
      if (applyDefaults) {
        await client.query(
          `UPDATE billing_accounts SET commission_bps = $2, subscription_price_cents = $3, updated_at = now() WHERE location_id = $1`,
          [locationId, defaults.commission_bps, defaults.subscription_price_cents],
        );
      }
    });
    return getBillingState(locationId);
  });
}

// E-low: updateAccount interpolates column NAMES into SQL. All callers
// are internal today, but the allow-list makes the interpolation safe by
// construction — an unexpected key is a programming error, not SQL.
const BILLING_ACCOUNT_COLUMNS = new Set([
  'plan', 'pending_plan', 'commission_bps', 'subscription_price_cents', 'currency', 'square_customer_id', 'square_card_id',
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
  return normalizeAccount(r.rows[0]);
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
  const paidThrough: string | null =
    toYmd(sub.charged_through_date) ?? toYmd(sub.canceled_date) ?? acct.subscription_paid_through;
  // C3-2-5: the fold-in is guarded on the subscription id we actually
  // synced. The old read-modify-write ran unlocked: if the owner
  // re-subscribed (new subscription id, pending_plan cleared) while the
  // scheduled sync was in flight, the sync wrote the OLD subscription's
  // status/paid-through over the new one and then flipped the plan to
  // commission — live subscription + commission plan simultaneously.
  // Now: the status write lands only if the row still points at THIS
  // subscription, and the pending flip is a compare-and-set on the plan
  // fields themselves. A lost race re-reads and returns current state.
  const folded = await query<BillingAccount>(
    `UPDATE billing_accounts SET subscription_status = $2, subscription_paid_through = $3, updated_at = now()
     WHERE location_id = $1 AND square_subscription_id = $4 RETURNING *`,
    [acct.location_id, sub.status ?? acct.subscription_status, paidThrough, acct.square_subscription_id],
  );
  if (folded.rows.length === 0) return ensureBillingAccount(acct.location_id);
  let current = normalizeAccount(folded.rows[0]);
  // Apply a scheduled switch to commission once the paid period has run out.
  if (
    acct.pending_plan === 'commission' &&
    (sub.status === 'CANCELED' || sub.status === 'DEACTIVATED') &&
    paidThrough &&
    paidThrough < today()
  ) {
    const flipped = await query<BillingAccount>(
      `UPDATE billing_accounts SET plan = 'commission', pending_plan = NULL, updated_at = now()
       WHERE location_id = $1 AND plan = 'subscription' AND pending_plan = 'commission'
         AND square_subscription_id = $2 RETURNING *`,
      [acct.location_id, acct.square_subscription_id],
    );
    if (flipped.rows.length > 0) current = normalizeAccount(flipped.rows[0]);
    else current = await ensureBillingAccount(acct.location_id);
  }
  return current;
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
  for (const rawAcct of r.rows) {
    const acct = normalizeAccount(rawAcct);
    try {
      // C3-2 Low: a sync that failed (Square unreachable) or found no
      // subscription returns the input row unchanged and used to be
      // counted as synced anyway — the count now only advances when
      // syncSubscription actually folded fresh state in (a new row
      // object comes back from its guarded UPDATE).
      const out = await syncSubscription(acct);
      if (out !== acct) synced += 1;
    } catch (e) {
      console.error(`[billing] scheduled subscription sync failed for location ${acct.location_id}:`, e);
    }
  }
  return { synced };
}

export interface BillingState {
  account: BillingAccount;
  /** v0.9.0: the location's service tier (locations.tier). */
  tier: LocationTier;
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
    tier: await getLocationTier(locationId),
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
  const newCardId = String(card.id);
  const oldCardId = acct.square_card_id;
  // C3-2-10: a live subscription must move to the new card BEFORE the
  // account row points at it. The old order recorded the new card
  // first; when the move then failed, the billing page showed the NEW
  // card's last four while renewals kept charging the old one — and the
  // next save disabled the (never-adopted) newer card instead of the
  // original, leaving it enabled and orphaned. Now: move first; on
  // failure the new card is disabled again (it was never adopted), the
  // account keeps the old card, and the owner gets a clear error
  // instead of a silently inconsistent state. F2-7's protection is
  // preserved: the old card stays enabled until the move has succeeded.
  if (acct.square_subscription_id) {
    try {
      await updatePlatformSubscriptionCard(acct.square_subscription_id, newCardId);
    } catch (e) {
      console.error(
        `[billing] could not move subscription ${acct.square_subscription_id} to the new card; keeping the old card active:`,
        e,
      );
      await disablePlatformCard(newCardId).catch(() => undefined);
      throw httpError(
        502,
        'could not move your subscription to the new card — your existing card is still active, please try again',
        'card_move_failed',
      );
    }
  }
  acct = await updateAccount(locationId, {
    square_card_id: newCardId,
    card_brand: card.card_brand ? String(card.card_brand) : null,
    card_last4: card.last_4 ? String(card.last_4) : null,
  });
  if (oldCardId && oldCardId !== newCardId) {
    // The subscription (if any) already points at the new card, so the
    // old one can be disabled safely.
    await disablePlatformCard(oldCardId).catch(() => undefined);
  }
  return acct;
}

async function ensurePlanVariation(priceCents: number, currency: string, tier: LocationTier): Promise<string> {
  // v0.9.0: the cache key carries the tier alongside the price it already
  // encoded, so a starter ($49.99) and base ($99) variation never share a
  // cache slot even if a future price change makes the amounts collide.
  // (The Square-side variation idempotency key in square.ts derives from
  // plan + price + currency, so a re-create at the same price returns the
  // original variation — no duplicate catalog objects.)
  const key = `sq_plan_variation_${tier}_${priceCents}_${currency}`;
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
    const variationId = await ensurePlanVariation(
      acct.subscription_price_cents,
      loc.currency,
      await getLocationTier(locationId),
    );
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
  // C3-2-9: the rate in each description is derived from the ROW's own
  // fee/charge — the old text used the account's CURRENT commission_bps,
  // so after a tier change every historical 2% fee read "1% fee",
  // contradicting its own amount and the audit trail. Amounts render in
  // the row's currency, not a hard-coded "$".
  const pctOf = (fee: number, charge: number): string => {
    if (!(charge > 0)) return '0%';
    const pct = Math.round((fee / charge) * 10000) / 100;
    return `${pct}%`;
  };
  const moneyOf = (cents: number, currency: string): string =>
    currency === 'CAD' || currency === 'USD' ? `$${(cents / 100).toFixed(2)}` : `${currency} ${(cents / 100).toFixed(2)}`;
  const out: HistoryEntry[] = ledger.rows.map((r) => ({
    date: new Date(r.created_at).toISOString(),
    kind: (r.method === 'reversal' ? 'fee_reversal' : 'commission_fee') as HistoryEntry['kind'],
    description:
      r.method === 'reversal'
        ? 'Commission given back — guest payment was refunded'
        : r.method === 'square_app_fee'
          ? `${pctOf(r.fee_cents, r.charge_cents)} fee on a ${moneyOf(r.charge_cents, r.currency)} guest payment (taken by Square)`
          : `${pctOf(r.fee_cents, r.charge_cents)} fee on a ${moneyOf(r.charge_cents, r.currency)} guest payment (accrued)`,
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
        // C3-2-9: an invoice Square reports no amount for is SKIPPED —
        // the old fallback displayed the current subscription price as
        // if it were the invoiced amount, fabricating history.
        if (money?.amount === undefined || money?.amount === null) continue;
        out.push({
          date: String(inv.created_at ?? ''),
          kind: 'subscription_invoice',
          description: 'Smart Table monthly subscription',
          amount_cents: Number(money.amount),
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
const MIN_FEE_CHARGE_CENTS = 100;

async function releaseFeeClaim(batchId: string): Promise<void> {
  await query(
    `UPDATE fee_ledger SET status = 'accrued', batch_id = NULL, claimed_at = NULL WHERE batch_id = $1 AND status = 'charging'`,
    [batchId],
  ).catch(() => undefined);
}

type AccruedChargeOutcome =
  | { kind: 'charged'; cents: number }
  | { kind: 'definitive' } // the restaurant's card refused: released, backoff applies
  | { kind: 'platform' } // OUR platform failed (401/403/404/5xx): stays 'charging', no backoff
  | { kind: 'unknown' } // timeout / network: stays 'charging' for the resolver
  | { kind: 'skipped' }; // nothing to charge, or below the minimum charge: released

/**
 * Claim one location's accrued fees in ONE currency under a fresh batch
 * and charge them (C3-2-6(c): the pre-fix claim swept every currency
 * into a single batch and charged the mixed sum in the first row's
 * currency, so a USD restaurant on a CAD platform account failed
 * permanently). The batch idempotency key (fees-<batchId>) is unchanged,
 * so retrying a batch can never double-charge.
 */
async function chargeAccruedBatch(acct: BillingAccount, currency: string): Promise<AccruedChargeOutcome> {
  const batchId = randomUUID();
  const claim = await query<{ fee_cents: number }>(
    `UPDATE fee_ledger SET status = 'charging', batch_id = $2, claimed_at = now()
     WHERE location_id = $1 AND status = 'accrued' AND currency = $3
     RETURNING fee_cents`,
    [acct.location_id, batchId, currency],
  );
  if (claim.rows.length === 0) return { kind: 'skipped' }; // another run claimed them first
  const total = claim.rows.reduce((s, r) => s + Number(r.fee_cents), 0);
  if (total <= 0) {
    // Net credit / zero balance: nothing to charge, release the claim.
    await releaseFeeClaim(batchId);
    return { kind: 'skipped' };
  }
  if (total < MIN_FEE_CHARGE_CENTS) {
    // C3-2-6(d): Square's minimum card charge is $1 — a tiny post-claim
    // net balance (a few cents left after reversals net in) can only
    // fail. Release it so it keeps accruing toward a chargeable amount.
    await releaseFeeClaim(batchId);
    console.log(
      `[billing] location ${acct.location_id}: accrued ${currency} balance of ${total} cents is below the minimum charge — left to keep accruing`,
    );
    return { kind: 'skipped' };
  }
  let payment;
  try {
    const loc = await platformLocation();
    payment = await createPlatformCardCharge({
      customerId: acct.square_customer_id!,
      cardId: acct.square_card_id!,
      locationId: loc.id,
      amountCents: total,
      currency,
      idempotencyKey: `fees-${batchId}`,
      note: 'Smart Table commission (accrued guest-payment fees)',
    });
  } catch (e) {
    if (isDefinitiveCardFailure(e)) {
      // The card definitively refused: release the rows so a later run
      // (after the restaurant updates its card) can collect them — with
      // F2-6 backoff, not on the very next run.
      await releaseFeeClaim(batchId);
      return { kind: 'definitive' };
    }
    if (isPlatformSideFailure(e)) {
      // C3-2-6(a): a revoked platform token / permission / missing
      // customer is not a card refusal. The batch stays 'charging' for
      // the resolver / manual review and the location's decline backoff
      // is NOT incremented — collection resumes as soon as the platform
      // issue is fixed instead of days later.
      console.error(
        `[billing] PLATFORM-SIDE fee charge failure for location ${acct.location_id} (batch ${batchId}) — batch left 'charging', no backoff:`,
        e,
      );
      return { kind: 'platform' };
    }
    // Unknown outcome (timeout / network): the rows STAY in 'charging'
    // under this batch — never re-charged blindly. Square has no
    // get-by-idempotency-key lookup (F2-5); resolveStuckFeeCharges
    // re-sends the identical request inside Square's key-retention
    // window and settles from the response.
    console.error(`[billing] accrued fee charge failed for location ${acct.location_id} (batch ${batchId}):`, e);
    return { kind: 'unknown' };
  }
  if (!payment?.id) {
    console.error(`[billing] fee charge for location ${acct.location_id} (batch ${batchId}) returned no payment — left 'charging' for the resolver`);
    return { kind: 'unknown' };
  }
  // F2-10: a returned payment object is not success by itself — with
  // autocomplete a settled charge reports COMPLETED; FAILED/CANCELED
  // must release the claim (with backoff), anything else stays
  // 'charging' for the resolver rather than marking money collected
  // that never moved.
  const pStatus = typeof payment.status === 'string' ? payment.status.toUpperCase() : '';
  if (pStatus === 'FAILED' || pStatus === 'CANCELED') {
    console.error(`[billing] fee charge payment ${payment.id} for location ${acct.location_id} ended ${pStatus} — releasing the batch`);
    await releaseFeeClaim(batchId);
    return { kind: 'definitive' };
  }
  if (pStatus && pStatus !== 'COMPLETED') {
    console.error(`[billing] fee charge payment ${payment.id} for location ${acct.location_id} has status ${pStatus} — left 'charging' for the resolver`);
    return { kind: 'unknown' };
  }
  await query(
    `UPDATE fee_ledger SET status = 'charged', platform_charge_ref = $2 WHERE batch_id = $1 AND status = 'charging'`,
    [batchId, String(payment.id)],
  );
  return { kind: 'charged', cents: total };
}

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

  let locationsCharged = 0;
  let totalCents = 0;
  for (const row of due) {
    // C3-2-6(b): the whole per-location flow runs inside its own
    // try/catch. The old loop let one location's DB error abort the
    // entire run — every later location went unprocessed that cycle.
    try {
      const acct = await ensureBillingAccount(row.location_id);
      if (!acct.square_card_id || !acct.square_customer_id) {
        // Fees are owed but there is nothing to charge. Surfacing this
        // to the owner + founder panel is F10-5; never skip in total
        // silence again — the log line is the floor.
        console.error(
          `[billing] location ${row.location_id} has ${row.total} cents of accrued fees due but no card on file — collection skipped`,
        );
        continue;
      }
      if (acct.fee_charge_next_attempt_at && new Date(acct.fee_charge_next_attempt_at).getTime() > Date.now()) {
        continue; // F2-6 backoff window
      }
      const currencies = await query<{ currency: string }>(
        `SELECT DISTINCT currency FROM fee_ledger WHERE location_id = $1 AND status = 'accrued'`,
        [row.location_id],
      );
      let chargedCents = 0;
      let sawDefinitive = false;
      for (const { currency } of currencies.rows) {
        const outcome = await chargeAccruedBatch(acct, currency);
        if (outcome.kind === 'charged') chargedCents += outcome.cents;
        else if (outcome.kind === 'definitive') sawDefinitive = true;
      }
      if (sawDefinitive) await noteFailure(acct);
      if (chargedCents > 0) {
        locationsCharged += 1;
        totalCents += chargedCents;
        if (!sawDefinitive && ((acct.fee_charge_failures ?? 0) > 0 || acct.fee_charge_next_attempt_at)) {
          await updateAccount(row.location_id, { fee_charge_failures: 0, fee_charge_next_attempt_at: null })
            .catch((e) => console.error('[billing] could not reset fee-charge backoff:', e));
        }
      }
    } catch (e) {
      console.error(`[billing] processAccruedFees failed for location ${row.location_id}:`, e);
    }
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
 *
 * C3-2-2: an ERROR on the resend path is never treated as a refusal
 * anymore. The old code released the batch on any "definitive" 4xx —
 * but IDEMPOTENCY_KEY_REUSED (what Square answers when the resend's
 * parameters differ from the original, e.g. the owner replaced the
 * card) PROVES the original request reached Square; releasing the batch
 * let the next collection charge the same fees again under a new batch
 * — a double-charge when the first charge had in fact gone through.
 * Every resend error (key-reuse, 401/403/404, 5xx, network) now routes
 * the batch to manual review: it stays 'charging', untouched, counted.
 * (A payment OBJECT reporting FAILED/CANCELED is different — that is
 * the original charge's own settled outcome, and still releases.)
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
    if (!acct.square_card_id || !acct.square_customer_id) {
      // The batch can never be re-sent without a card on file — surface
      // it as manual review instead of silently skipping it every run.
      manualReview += 1;
      console.error(
        `[billing] MANUAL REVIEW: fee batch ${b.batch_id} (location ${b.location_id}, ${b.total} cents) is stuck 'charging' and the location has no card on file to re-send with`,
      );
      continue;
    }
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
      // C3-2-2: NEVER release on a resend error (see the header comment).
      // IDEMPOTENCY_KEY_REUSED means the original request reached
      // Square with different parameters (typically a replaced card);
      // 401/403/404 are platform-side unknowns. All of them mean "the
      // original may have processed" — a human verifies in the Square
      // dashboard; the batch stays exactly where it is.
      manualReview += 1;
      const code = e instanceof SquareError ? squareErrorCode(e) : null;
      console.error(
        `[billing] MANUAL REVIEW: stuck-batch resend failed for batch ${b.batch_id} (location ${b.location_id}, ${b.total} cents)` +
          `${code ? ` — Square code ${code}` : ''}${code === 'IDEMPOTENCY_KEY_REUSED' ? ' (the original charge reached Square; releasing this batch would double-charge)' : ''}` +
          ` — batch left 'charging', NOT released:`,
        e,
      );
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
 *
 * C3-2-1 hardening (v0.10.1): the pre-fix sweep re-judged every settled
 * payment with TODAY's plan, over ALL history, with no card/cash filter:
 * (1) a location that ran subscription (or a free pilot) for months and
 * switched to commission got fees accrued on its whole history at the
 * next sweep; (2) staff-recorded external (cash) payments never carry a
 * fee by design, so on a non-Square location every cash payment accrued
 * 2%, and on Square every cash payment re-raised the "MISSING FEE ROW"
 * alarm on every run, burying real misses. Now:
 *  - the window is bounded to the last 48 hours;
 *  - each payment's STORED fee decision (migration 032, stamped by
 *    payCheck at charge time) governs: 'external' and 'subscription'
 *    rows are skipped silently, 'commission' rows are recorded at the
 *    STORED bps even if the plan has since changed;
 *  - legacy rows (no stored decision) fall back to the old heuristic —
 *    staff-recorded rows (recorded_by set) count as external, the rest
 *    are judged by the current plan — inside the bounded window only.
 */
export async function sweepMissingFees(): Promise<{ recorded: number; squareMissing: number }> {
  const r = await query<{
    id: string; amount_cents: number; tip_cents: number; currency: string | null;
    external_payment_ref: string | null; square_payment_id: string | null;
    pos_type: string; location_id: string | null;
    fee_decision: string | null; fee_bps: number | null; recorded_by: string | null;
  }>(
    // LEFT JOIN instead of a correlated NOT EXISTS: pg-mem cannot plan
    // correlated subqueries against the outer row (and the shape is
    // portable to real Postgres unchanged). Duplicate rows from multiple
    // fee entries are deduped by the f.id IS NULL filter itself — a
    // payment with ANY fee row joins only non-null rows.
    `SELECT p.id, p.amount_cents, p.tip_cents, p.currency, p.external_payment_ref,
            p.square_payment_id, p.fee_decision, p.fee_bps, p.recorded_by,
            c.pos_type, c.location_id
     FROM payments p JOIN checks c ON c.id = p.check_id
     LEFT JOIN fee_ledger f ON f.payment_row_id = p.id AND f.method IN ('square_app_fee','accrued')
     WHERE p.status IN ('AUTHORIZED','COMPLETED')
       AND p.created_at < now() - interval '10 minutes'
       AND p.created_at > now() - interval '48 hours'
       AND f.id IS NULL`,
  );
  let recorded = 0;
  let squareMissing = 0;
  for (const row of r.rows) {
    if (!row.location_id) continue;
    // The stored decision wins; the recorded_by heuristic only serves
    // legacy rows payCheck never stamped.
    const decision = row.fee_decision ?? (row.recorded_by ? 'external' : null);
    if (decision === 'external' || decision === 'subscription') continue;
    try {
      const acct = await ensureBillingAccount(row.location_id);
      // A stored 'commission' decision is honored at its stored rate
      // even if the location has since switched plans; only unstamped
      // legacy rows are judged by today's plan.
      let bps: number;
      if (decision === 'commission') {
        bps = row.fee_bps ?? acct.commission_bps;
      } else {
        if (effectivePlan(acct) !== 'commission') continue;
        bps = acct.commission_bps;
      }
      const fee = feeFor(row.amount_cents + row.tip_cents, bps);
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
