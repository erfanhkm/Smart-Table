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
export const DEFAULT_SUBSCRIPTION_PRICE_CENTS = 4900; // $49.00 — placeholder price, change per account

/** 2% of the charged amount (amount + tip), rounded to the nearest cent; never negative, never the whole charge. */
export function feeFor(chargeCents: number, bps: number): number {
  if (!Number.isSafeInteger(chargeCents) || chargeCents <= 0) return 0;
  const fee = Math.round((chargeCents * bps) / 10000);
  return Math.max(0, Math.min(fee, chargeCents - 1));
}

export async function ensureBillingAccount(locationId: string): Promise<BillingAccount> {
  await query(
    `INSERT INTO billing_accounts(location_id) VALUES ($1) ON CONFLICT (location_id) DO NOTHING`,
    [locationId],
  );
  const r = await query<BillingAccount>(`SELECT * FROM billing_accounts WHERE location_id = $1`, [locationId]);
  return r.rows[0];
}

async function updateAccount(locationId: string, fields: Record<string, unknown>): Promise<BillingAccount> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return ensureBillingAccount(locationId);
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
  if (
    acct.plan === 'subscription' &&
    acct.pending_plan === 'commission' &&
    acct.subscription_paid_through &&
    acct.subscription_paid_through < today()
  ) {
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

export async function getBillingState(locationId: string): Promise<BillingState> {
  let acct = await ensureBillingAccount(locationId);
  acct = await syncSubscription(acct);
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
  await query(
    `INSERT INTO fee_ledger(id, location_id, payment_row_id, pos_payment_ref, charge_cents, fee_cents, currency, method, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
    const customer = await createPlatformCustomer(loc.rows[0]?.name ?? 'Restaurant', email);
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
  return variationId;
}

export async function switchPlan(locationId: string, target: BillingPlan): Promise<BillingState> {
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
        const detail = String(e.errors?.[0]?.detail ?? 'Square rejected the subscription');
        throw badRequest(`could not start the subscription: ${detail.slice(0, 200)}`);
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
  kind: 'commission_fee' | 'subscription_invoice' | 'accrued_charge';
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
  const out: HistoryEntry[] = ledger.rows.map((r) => ({
    date: new Date(r.created_at).toISOString(),
    kind: 'commission_fee' as const,
    description:
      r.method === 'square_app_fee'
        ? `2% fee on a $${(r.charge_cents / 100).toFixed(2)} guest payment (taken by Square)`
        : `2% fee on a $${(r.charge_cents / 100).toFixed(2)} guest payment (accrued)`,
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
  const due = await query<{ location_id: string; total: string; oldest: string }>(
    `SELECT location_id, SUM(fee_cents) AS total, MIN(created_at) AS oldest
     FROM fee_ledger WHERE status = 'accrued'
     GROUP BY location_id
     HAVING SUM(fee_cents) >= 5000 OR MIN(created_at) <= now() - interval '25 days'`,
  );
  let locationsCharged = 0;
  let totalCents = 0;
  for (const row of due.rows) {
    try {
      const acct = await ensureBillingAccount(row.location_id);
      if (!acct.square_card_id || !acct.square_customer_id) continue;
      const total = Number(row.total);
      const loc = await platformLocation();
      const rows = await query<{ id: string; currency: string }>(
        `SELECT id, currency FROM fee_ledger WHERE location_id = $1 AND status = 'accrued' ORDER BY created_at ASC`,
        [row.location_id],
      );
      const payment = await createPlatformCardCharge({
        customerId: acct.square_customer_id,
        cardId: acct.square_card_id,
        locationId: loc.id,
        amountCents: total,
        currency: rows.rows[0]?.currency ?? loc.currency,
        idempotencyKey: randomUUID(),
        note: 'Smart Table commission (accrued guest-payment fees)',
      });
      if (!payment?.id) continue;
      await query(
        `UPDATE fee_ledger SET status = 'charged', platform_charge_ref = $2 WHERE location_id = $1 AND status = 'accrued'`,
        [row.location_id, String(payment.id)],
      );
      locationsCharged += 1;
      totalCents += total;
    } catch (e) {
      console.error(`[billing] accrued fee charge failed for location ${row.location_id}:`, e);
    }
  }
  return { locationsCharged, totalCents };
}
