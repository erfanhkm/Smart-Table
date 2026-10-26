// Minimal typed Square REST client (fetch-based, no SDK).
// Every call below was verified live against the Square sandbox on 2026-10-12:
// CreateOrder -> CreatePayment(source_id=EXTERNAL) -> auto-COMPLETED,
// and the split flow: 2x partial external payments (autocomplete=false) + PayOrder -> COMPLETED.
import { randomUUID, createHash } from 'node:crypto';
import { config, requireSquareToken } from './config.js';
import { badRequest } from './http.js';

const BASE =
  config.squareEnv === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
const API_VERSION = '2024-12-18';

export class SquareError extends Error {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errors: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(status: number, errors: any[]) {
    super(`Square API ${status}: ${JSON.stringify(errors).slice(0, 300)}`);
    this.status = status;
    this.errors = errors;
  }
}

/** First Square error code (e.g. CARD_DECLINED) if it looks like a plain enum, else null. Safe to show to clients. */
export function squareErrorCode(e: SquareError): string | null {
  const code = e.errors?.[0]?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

// ---- ID safety -------------------------------------------------------------
// Every Square ID that is interpolated into a URL path (or sent as an identifier)
// must pass assertSquareId() first -> 400 before any network call, and is then
// encodeURIComponent()'d. This closes `..%2F..%2Fv2%2Flocations` style traversal.
const SQUARE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SQUARE_ID_MAX = 255;

export function assertSquareId(id: unknown, label = 'id'): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > SQUARE_ID_MAX || !SQUARE_ID_RE.test(id)) {
    throw badRequest(`invalid ${label}`);
  }
  return id;
}

const pathSeg = (id: unknown, label: string): string => encodeURIComponent(assertSquareId(id, label));

// Hard ceiling on every Square call: a hung connection must fail fast and be
// treated as "outcome unknown" by callers, never sit inside a DB transaction
// or hang a guest's payment request (v0.6.4).
const SQ_TIMEOUT_MS = 10_000;

async function sq<T>(method: string, path: string, body: unknown, token: string | undefined): Promise<T> {
  // v0.6.4: NO silent fallback to the platform token. A merchant-scoped call
  // that forgets its token must fail loudly here — with the fallback it would
  // silently run against Smart Table's own Square account instead.
  if (!token) {
    throw new Error(
      'sq: an explicit Square access token is required (merchant calls pass the merchant token; platform calls pass requireSquareToken())',
    );
  }
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': API_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(SQ_TIMEOUT_MS),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) throw new SquareError(res.status, data.errors ?? []);
  return data as T;
}

export interface Money {
  amount: number;
  currency: string;
}
export interface LineItemInput {
  name: string;
  quantity: string;
  amountCents: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SquareOrder = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SquarePayment = any;

/** Remaining unpaid amount on an order, from its tenders. */
export function orderRemaining(order: SquareOrder): number {
  // Square's own amount-due figure is authoritative when present: a
  // tender's amount_money INCLUDES its tip, so total - sum(tenders)
  // double-counts every tip (a fully paid $24.00 bill with a $2.10 tip
  // read as -$2.10 remaining, proven live 2026-10-24; split payments
  // with tips likewise under-reported the balance still owed).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const due = (order as any)?.net_amount_due_money?.amount;
  if (typeof due === 'number') return due;
  return orderTenderRemaining(order);
}

/**
 * Bill coverage from the order's tenders alone: total − Σ(amount − tip)
 * (a tender's amount_money INCLUDES its tip; the tip is not bill
 * coverage). Unlike orderRemaining this ignores net_amount_due_money,
 * which does NOT fall for an authorized (autocomplete:false) payment —
 * Square settles those only at PayOrder (v0.8.10, proven live
 * 2026-10-25). The Square adapter's post-charge close-out decision
 * uses this: the question there is whether the tenders ON the order
 * cover the bill, and the just-landed payment's tender is already on it.
 */
export function orderTenderRemaining(order: SquareOrder): number {
  const total: number = order?.total_money?.amount ?? 0;
  const paid: number = (order?.tenders ?? []).reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sum: number, t: any) => sum + ((t?.amount_money?.amount ?? 0) - (t?.tip_money?.amount ?? 0)),
    0,
  );
  return total - paid;
}

export async function createOrder(
  locationId: string,
  items: LineItemInput[],
  currency: string,
  idempotencyKey = randomUUID(),
  token?: string,
): Promise<{ order: SquareOrder }> {
  assertSquareId(locationId, 'location_id');
  return sq('POST', '/v2/orders', {
    idempotency_key: idempotencyKey,
    order: {
      location_id: locationId,
      line_items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        base_price_money: { amount: i.amountCents, currency },
      })),
    },
  }, token);
}

/** Create an order from catalog variations (QR ordering). */
export async function createCatalogOrder(
  locationId: string,
  items: { catalogObjectId: string; quantity: number }[],
  currency: string,
  tableLabel: string,
  idempotencyKey: string = randomUUID(),
  token?: string,
): Promise<{ order: SquareOrder }> {
  assertSquareId(locationId, 'location_id');
  return sq('POST', '/v2/orders', {
    idempotency_key: idempotencyKey,
    order: {
      location_id: locationId,
      // Table label visible to staff in the Square POS / dashboard.
      // L4 fix: Square caps reference_id at 40 chars — truncate the label.
      reference_id: `SmartTable:${tableLabel}`.slice(0, 40),
      line_items: items.map((i) => ({
        catalog_object_id: i.catalogObjectId,
        quantity: String(i.quantity),
      })),
    },
  }, token);
}

/** Search the Square catalog for sellable ITEM variations (QR ordering menu). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchCatalogItems(token?: string): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await sq('POST', '/v2/catalog/search', {
      object_types: ['ITEM'],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    }, token);
    out.push(...(data?.objects ?? []));
    cursor = data?.cursor || undefined;
  } while (cursor && out.length < 1000);
  return out;
}

export interface CreatePaymentInput {
  orderId: string;
  amountCents: number;
  currency: string;
  /** Card nonce from Square Web Payments SDK, or 'EXTERNAL' for outside payments (cash / other rails; staff-only callers). */
  sourceId: string;
  tipCents?: number;
  autocomplete?: boolean;
  idempotencyKey?: string;
  externalSource?: string;
  /** v0.4 billing: Smart Table's commission, taken by Square as an application fee at charge time. */
  appFeeCents?: number;
}

export async function createPayment(input: CreatePaymentInput, token?: string): Promise<{ payment: SquarePayment }> {
  const {
    orderId, amountCents, currency, sourceId,
    tipCents = 0, autocomplete = false,
    idempotencyKey = randomUUID(), externalSource, appFeeCents,
  } = input;
  assertSquareId(orderId, 'order_id');
  if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 255) {
    throw badRequest('invalid source_id');
  }
  // Defence in depth: an EXTERNAL (no money moves through Square) payment must be an explicit,
  // named choice of the caller — never a default.
  if (sourceId === 'EXTERNAL' && !externalSource) {
    throw new Error('createPayment: EXTERNAL source requires externalSource');
  }
  return sq('POST', '/v2/payments', {
    idempotency_key: idempotencyKey,
    source_id: sourceId,
    order_id: orderId,
    amount_money: { amount: amountCents, currency },
    tip_money: tipCents > 0 ? { amount: tipCents, currency } : undefined,
    autocomplete,
    app_fee_money:
      appFeeCents !== undefined && appFeeCents > 0 ? { amount: appFeeCents, currency } : undefined,
    ...(sourceId === 'EXTERNAL'
      ? { external_details: { type: 'OTHER_GIFT_CARD', source: externalSource } }
      : {}),
  }, token);
}

export async function payOrder(
  orderId: string,
  paymentIds: string[],
  // Square accepts any string (<=255 chars) as an idempotency key; the
  // explicit string type lets callers derive one (e.g. `<payment key>:payorder`,
  // F1-8) instead of minting a random key per attempt.
  idempotencyKey: string = randomUUID(),
  token?: string,
): Promise<{ order: SquareOrder }> {
  const oid = pathSeg(orderId, 'order_id');
  paymentIds.forEach((p) => assertSquareId(p, 'payment_id'));
  return sq('POST', `/v2/orders/${oid}/pay`, { idempotency_key: idempotencyKey, payment_ids: paymentIds }, token);
}

export async function retrieveOrder(orderId: string, token?: string): Promise<{ order: SquareOrder }> {
  return sq('GET', `/v2/orders/${pathSeg(orderId, 'order_id')}`, undefined, token);
}

export async function retrievePayment(paymentId: string, token?: string): Promise<{ payment: SquarePayment }> {
  return sq('GET', `/v2/payments/${pathSeg(paymentId, 'payment_id')}`, undefined, token);
}

/** Cancel (void) an APPROVED payment that has not been captured yet.
 *  Releases the guest's authorization hold; all-or-nothing per payment. */
export async function cancelPayment(paymentId: string, token?: string): Promise<{ payment: SquarePayment }> {
  return sq('POST', `/v2/payments/${pathSeg(paymentId, 'payment_id')}/cancel`, {}, token);
}

export interface CreateRefundInput {
  paymentId: string;
  amountCents: number;
  currency: string;
  idempotencyKey?: string;
  reason?: string;
}

/** Refund (part of) a completed card payment. Square also returns the
 *  proportional share of any application fee with the refund. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createRefund(input: CreateRefundInput, token?: string): Promise<{ refund: any }> {
  assertSquareId(input.paymentId, 'payment_id');
  return sq('POST', '/v2/refunds', {
    idempotency_key: input.idempotencyKey ?? randomUUID(),
    payment_id: input.paymentId,
    amount_money: { amount: input.amountCents, currency: input.currency },
    reason: input.reason ? input.reason.slice(0, 192) : undefined,
  }, token);
}

export async function searchOpenOrders(locationId: string, token?: string): Promise<{ orders?: SquareOrder[] }> {
  assertSquareId(locationId, 'location_id');
  return sq(
    'POST',
    '/v2/orders/search',
    { location_ids: [locationId], query: { filter: { state_filter: { states: ['OPEN'] } } } },
    token,
  );
}

// ---- OAuth helpers (per-merchant onboarding; used by src/routes/oauth.ts) ----

export function squareAuthorizeUrl(state: string): string {
  const clientId = config.squareAppId;
  if (!clientId) throw new Error('SQUARE_APP_ID is not set');
  // PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS (D-4): required by Square for
  // app_fee_money (our commission). Sellers who connected before this scope
  // was added must reconnect to grant it; until they do, the adapter's
  // fee-only retry drops the in-flight fee and it accrues instead.
  const scopes = ['ORDERS_READ', 'ORDERS_WRITE', 'PAYMENTS_READ', 'PAYMENTS_WRITE', 'PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS', 'MERCHANT_PROFILE_READ'].join('+');
  const redirect = encodeURIComponent(`${config.appUrl}/api/oauth/callback`);
  return `${BASE}/oauth2/authorize?client_id=${clientId}&scope=${scopes}&session=false&state=${encodeURIComponent(state)}&redirect_uri=${redirect}`;
}

export async function exchangeOAuthCode(code: string): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}> {
  if (!config.squareAppId || !config.squareAppSecret) throw new Error('SQUARE_APP_ID/SECRET not set');
  const res = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': API_VERSION },
    body: JSON.stringify({
      client_id: config.squareAppId,
      client_secret: config.squareAppSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${config.appUrl}/api/oauth/callback`,
    }),
    signal: AbortSignal.timeout(SQ_TIMEOUT_MS),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) throw new SquareError(res.status, data.errors ?? []);
  return data;
}

/**
 * D-7: exchange a Square OAuth refresh token for a fresh access token.
 * Square access tokens expire ~30 days after issue; without this, every
 * connected Square restaurant would start failing payments on schedule.
 * Square does not rotate the refresh token on refresh (the response may
 * still carry one — callers persist whatever comes back).
 */
export async function refreshSquareAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
}> {
  if (!config.squareAppId || !config.squareAppSecret) throw new Error('SQUARE_APP_ID/SECRET not set');
  const res = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': API_VERSION },
    body: JSON.stringify({
      client_id: config.squareAppId,
      client_secret: config.squareAppSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(SQ_TIMEOUT_MS),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.errors || !data?.access_token) {
    throw new SquareError(res.status, data?.errors ?? [{ code: 'REFRESH_FAILED', detail: 'Square token refresh failed' }]);
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token ?? refreshToken),
    expiresAt: data.expires_at ? String(data.expires_at) : null,
  };
}

export async function getMerchantProfile(token: string): Promise<{ merchant: SquareOrder }> {
  return sq('GET', '/v2/merchants/me', undefined, token);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listLocations(token: string): Promise<{ locations?: any[] }> {
  return sq('GET', '/v2/locations', undefined, token);
}

// ---- Platform billing (v0.4) ----------------------------------------------
// These calls act on OUR OWN Square account (the platform), never on a
// merchant's: restaurants are OUR customers here. They therefore always use
// the app-level token (requireSquareToken) and deliberately accept no
// per-merchant token parameter.
// API shapes verified live against the sandbox on 2026-10-21: plan +
// plan-variation via Catalog (STATIC phase pricing for Square-Version
// 2024-12-18), customer via company_name, card on file via cnon: nonce,
// subscription ACTIVE on create, cancel -> CANCELED with canceled_date.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function platformLocation(): Promise<{ id: string; currency: string; name: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('GET', '/v2/locations', undefined, requireSquareToken());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc = (data?.locations ?? []).find((l: any) => l?.status === 'ACTIVE') ?? data?.locations?.[0];
  if (!loc?.id) throw new Error('platform Square account has no location');
  return { id: String(loc.id), currency: String(loc.currency ?? 'CAD'), name: String(loc.name ?? '') };
}

/** Create the subscription plan + its monthly variation; returns the variation id (what subscriptions reference). */
export async function createSubscriptionPlanVariation(
  priceCents: number,
  currency: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plan: any = await sq('POST', '/v2/catalog/object', {
    idempotency_key: randomUUID(),
    object: {
      type: 'SUBSCRIPTION_PLAN',
      id: '#smart-table-plan',
      subscription_plan_data: { name: 'Smart Table' },
    },
  }, requireSquareToken());
  const planId = plan?.catalog_object?.id ?? plan?.object?.id;
  if (!planId) throw new Error('subscription plan creation returned no id');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const variation: any = await sq('POST', '/v2/catalog/object', {
    idempotency_key: randomUUID(),
    object: {
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: '#smart-table-plan-monthly',
      subscription_plan_variation_data: {
        name: 'Monthly',
        subscription_plan_id: planId,
        phases: [
          {
            cadence: 'MONTHLY',
            ordinal: 0,
            pricing: { type: 'STATIC', price_money: { amount: priceCents, currency } },
          },
        ],
      },
    },
  }, requireSquareToken());
  const variationId = variation?.catalog_object?.id ?? variation?.object?.id;
  if (!variationId) throw new Error('subscription plan variation creation returned no id');
  return String(variationId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createPlatformCustomer(companyName: string, email: string, referenceId?: string): Promise<any> {
  // Deterministic idempotency key per location (E-3): if the create
  // succeeded at Square but the response/DB write was lost, the retry
  // returns the SAME customer instead of creating a duplicate. The
  // location id is also stored as reference_id so the customer can be
  // found again by search.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', '/v2/customers', {
    idempotency_key: referenceId ? `st-cust-${referenceId}` : randomUUID(),
    reference_id: referenceId || undefined,
    company_name: companyName || 'Restaurant',
    email_address: email || undefined,
  }, requireSquareToken());
  return data?.customer;
}

/** All subscriptions belonging to a platform customer (search-before-create, E-3). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchPlatformSubscriptions(customerId: string): Promise<any[]> {
  assertSquareId(customerId, 'customer_id');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', '/v2/subscriptions/search', {
    query: { filter: { customer_ids: [customerId] } },
  }, requireSquareToken());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Array.isArray(data?.subscriptions) ? data.subscriptions : [];
}

/** Add/replace the email on a platform customer (Square Subscriptions refuse customers without one). */
export async function updatePlatformCustomerEmail(customerId: string, email: string): Promise<void> {
  await sq('PUT', `/v2/customers/${pathSeg(customerId, 'customer_id')}`, { email_address: email }, requireSquareToken());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createPlatformCard(input: {
  customerId: string;
  sourceId: string;
  verificationToken?: string;
  cardholderName?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  assertSquareId(input.customerId, 'customer_id');
  // Deterministic per (customer, card token): replaying the same save
  // returns the same card instead of stacking duplicates (E-3); a
  // different card token yields a different key, so replacement still works.
  const cardKey = `st-card-${createHash('sha256').update(`${input.customerId}:${input.sourceId}`).digest('hex').slice(0, 32)}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', '/v2/cards', {
    idempotency_key: cardKey,
    source_id: input.sourceId,
    verification_token: input.verificationToken || undefined,
    card: { customer_id: input.customerId, cardholder_name: input.cardholderName || undefined },
  }, requireSquareToken());
  return data?.card;
}

export async function disablePlatformCard(cardId: string): Promise<void> {
  await sq('POST', `/v2/cards/${pathSeg(cardId, 'card_id')}/disable`, {}, requireSquareToken());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createPlatformSubscription(input: {
  customerId: string;
  planVariationId: string;
  cardId: string;
  locationId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', '/v2/subscriptions', {
    idempotency_key: randomUUID(),
    customer_id: input.customerId,
    location_id: input.locationId,
    plan_variation_id: input.planVariationId,
    card_id: input.cardId,
    timezone: 'America/Vancouver',
  }, requireSquareToken());
  return data?.subscription;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function retrievePlatformSubscription(subscriptionId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('GET', `/v2/subscriptions/${pathSeg(subscriptionId, 'subscription_id')}`, undefined, requireSquareToken());
  return data?.subscription;
}

/**
 * Point a subscription at a different card on file (F2-7): when a
 * restaurant replaces its card, the subscription must be moved to the new
 * card BEFORE the old one is disabled, or the next renewal charges a dead
 * card and the subscription lapses. (Docs-based shape: UpdateSubscription
 * accepts card_id on the subscription object; sandbox-verified with the
 * billing test mock's call ordering.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updatePlatformSubscriptionCard(subscriptionId: string, cardId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', `/v2/subscriptions/${pathSeg(subscriptionId, 'subscription_id')}`, {
    subscription: { card_id: cardId },
  }, requireSquareToken());
  return data?.subscription;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cancelPlatformSubscription(subscriptionId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', `/v2/subscriptions/${pathSeg(subscriptionId, 'subscription_id')}/cancel`, {}, requireSquareToken());
  return data?.subscription;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function retrievePlatformInvoice(invoiceId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('GET', `/v2/invoices/${pathSeg(invoiceId, 'invoice_id')}`, undefined, requireSquareToken());
  return data?.invoice;
}

/** Charge a stored card on the platform account (accrued commission collection). */
export async function createPlatformCardCharge(input: {
  customerId: string;
  cardId: string;
  locationId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  note?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await sq('POST', '/v2/payments', {
    idempotency_key: input.idempotencyKey,
    source_id: input.cardId,
    customer_id: input.customerId,
    location_id: input.locationId,
    amount_money: { amount: input.amountCents, currency: input.currency },
    note: input.note?.slice(0, 500),
    autocomplete: true,
  }, requireSquareToken());
  return data?.payment;
}
