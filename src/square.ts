// Minimal typed Square REST client (fetch-based, no SDK).
// Every call below was verified live against the Square sandbox on 2026-10-12:
// CreateOrder -> CreatePayment(source_id=EXTERNAL) -> auto-COMPLETED,
// and the split flow: 2x partial external payments (autocomplete=false) + PayOrder -> COMPLETED.
import { randomUUID } from 'node:crypto';
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

async function sq<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const t = token ?? requireSquareToken();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
      'Square-Version': API_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const total: number = order?.total_money?.amount ?? 0;
  const paid: number = (order?.tenders ?? []).reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sum: number, t: any) => sum + (t?.amount_money?.amount ?? 0),
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
}

export async function createPayment(input: CreatePaymentInput, token?: string): Promise<{ payment: SquarePayment }> {
  const {
    orderId, amountCents, currency, sourceId,
    tipCents = 0, autocomplete = false,
    idempotencyKey = randomUUID(), externalSource,
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
    app_fee_money: undefined,
    ...(sourceId === 'EXTERNAL'
      ? { external_details: { type: 'OTHER_GIFT_CARD', source: externalSource } }
      : {}),
  }, token);
}

export async function payOrder(
  orderId: string,
  paymentIds: string[],
  idempotencyKey = randomUUID(),
  token?: string,
): Promise<{ order: SquareOrder }> {
  const oid = pathSeg(orderId, 'order_id');
  paymentIds.forEach((p) => assertSquareId(p, 'payment_id'));
  return sq('POST', `/v2/orders/${oid}/pay`, { idempotency_key: idempotencyKey, payment_ids: paymentIds }, token);
}

export async function retrieveOrder(orderId: string, token?: string): Promise<{ order: SquareOrder }> {
  return sq('GET', `/v2/orders/${pathSeg(orderId, 'order_id')}`, undefined, token);
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
  const scopes = ['ORDERS_READ', 'ORDERS_WRITE', 'PAYMENTS_READ', 'PAYMENTS_WRITE', 'MERCHANT_PROFILE_READ'].join('+');
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
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) throw new SquareError(res.status, data.errors ?? []);
  return data;
}

export async function getMerchantProfile(token: string): Promise<{ merchant: SquareOrder }> {
  return sq('GET', '/v2/merchants/me', undefined, token);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listLocations(token: string): Promise<{ locations?: any[] }> {
  return sq('GET', '/v2/locations', undefined, token);
}
