// Clover (Fiserv) adapter: implements PosAdapter against Clover's REST API.
//
// Docs: docs.clover.com (Global Developer Platform).
// Sandbox: https://apisandbox.dev.clover.com  |  Prod NA: https://api.clover.com
//
// Field mapping (Clover -> normalized):
//   order.id                      -> id
//   lineItems[].name              -> items[].name
//   lineItems[].unitQty           -> items[].quantity   (VERIFY IN SANDBOX:
//                                    unitQty semantics — see note below)
//   lineItems[].price             -> items[].amountCents (VERIFY: unit vs line total)
//   payments[].id / .tender.label -> tenders[].id / .type
//   payments[].amount             -> tenders[].amountCents
//   order.total                   -> totalCents
//   total - sum(payments)         -> remainingCents
//   state "Open"                  -> OPEN; anything else defensive-mapped
//
// SANDBOX VERIFICATION POINTS (confirm with scripts/verify-clover.ts):
//   [V1] order.state enum values beyond "Open".
//   [V2] whether ?filter=state=... works on GET orders (else client-side filter).
//   [V3] lineItems unitQty/price semantics (unit price vs line total).
//   [V4] exact POST body for recording a payment on an order.
//   [V5] merchant currency field location.
import { config } from '../../config.js';
import { badRequest } from '../../http.js';
import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison for secrets (M5 fix). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
import {
  CardCredentials,
  CardPaymentConfig,
  ChargeCardArgs,
  CreateCheckArgs,
  PosAdapter,
  PosCheckDetail,
  PosCheckState,
  PosCredentials,
  PosEvent,
  PosMenuItem,
  PosOpenCheckSummary,
  PosPaymentResult,
} from './types.js';

const REST_BASE =
  config.cloverEnv === 'production' ? 'https://api.clover.com' : 'https://apisandbox.dev.clover.com';
const OAUTH_AUTHORIZE_BASE =
  config.cloverEnv === 'production' ? 'https://www.clover.com' : 'https://sandbox.dev.clover.com';

// ---- ID safety (same discipline as src/square.ts) ----
const CLOVER_ID_RE = /^[A-Za-z0-9_-]+$/;
const CLOVER_ID_MAX = 255;

function assertCloverId(id: unknown, label = 'id'): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > CLOVER_ID_MAX || !CLOVER_ID_RE.test(id)) {
    throw badRequest(`invalid ${label}`);
  }
  return id;
}

const pathSeg = (id: unknown, label: string): string => encodeURIComponent(assertCloverId(id, label));

const ECOM_BASE =
  config.cloverEnv === 'production' ? 'https://scl.clover.com' : 'https://scl-sandbox.dev.clover.com';
const TOKEN_BASE =
  config.cloverEnv === 'production' ? 'https://token.clover.com' : 'https://token-sandbox.dev.clover.com';

/** Call the Clover Ecommerce API (charges, refunds). Uses the per-merchant Ecommerce private token. */
async function ecom<T>(method: string, path: string, body: unknown, privateToken: string): Promise<T> {
  const res = await fetch(ECOM_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${privateToken}`,
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1', // Ecommerce API wants the client IP; best effort server-side
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: AnyObj = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloverError(res.status, data);
  return data as T;
}

export class CloverError extends Error {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(status: number, detail: any) {
    super(`Clover API ${status}: ${JSON.stringify(detail).slice(0, 300)}`);
    this.status = status;
    this.detail = detail;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

// Resolve a Clover tender id for a payment method label at runtime.
// Clover requires the tender UUID (e.g. from GET /tenders), not a label.
// Strategy: exact label match (enabled) -> contains match (enabled) ->
// "Cash" tender -> first enabled tender. [V4] verified in sandbox 2026-10-15.
async function resolveTenderId(mId: string, method: string, token?: string): Promise<string> {
  const data: AnyObj = await cl('GET', `/v3/merchants/${mId}/tenders`, undefined, token);
  const els: AnyObj[] = data?.elements ?? (Array.isArray(data) ? data : []);
  const norm = (s: unknown) => String(s ?? '').toLowerCase();
  const want = norm(method).replace(/^test_/, '');
  const enabled = els.filter((t) => t?.enabled !== false && t?.id);
  const pick =
    enabled.find((t) => norm(t.label) === want) ??
    enabled.find((t) => norm(t.label).includes(want) || want.includes(norm(t.label))) ??
    enabled.find((t) => norm(t.label) === 'cash') ??
    enabled[0];
  if (!pick?.id) throw badRequest('no usable tender found for merchant');
  return String(pick.id);
}

async function cl<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const t = token ?? config.cloverAppSecret; // app-level fallback only for demo; merchants use OAuth tokens
  if (!t) throw new Error('Clover token is not set (pass an OAuth token or set CLOVER_APP_SECRET)');
  const res = await fetch(REST_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: AnyObj = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloverError(res.status, data);
  return data as T;
}

function mapState(s: unknown): PosCheckState {
  const v = String(s ?? '').toLowerCase();
  if (v === 'open') return 'OPEN';
  // [V1] confirm other Clover order states in sandbox; be conservative:
  // anything not openly "open" but not deleted is treated as closed.
  if (v === 'deleted' || v === 'cancelled' || v === 'canceled') return 'CANCELLED';
  return 'CLOSED';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTenders(order: AnyObj): { id: string; type: string; amountCents: number }[] {
  const payments: AnyObj[] = order?.payments?.elements ?? order?.payments ?? [];
  return payments.map((p: AnyObj) => ({
    id: String(p?.id ?? ''),
    type: String(p?.tender?.label ?? p?.tender?.id ?? 'tender'),
    amountCents: p?.amount ?? 0,
  }));
}

function mapDetail(order: AnyObj): PosCheckDetail {
  // [V3] unitQty/price semantics confirmed in sandbox 2026-10-15: Clover v3
  // does not persist unitQty for fixed-price items (returns null) — each
  // line item is 1 unit, so quantity = number of line items with that name.
  // Order.total is also absent; total = sum(line item prices).
  const rawItems = (order?.lineItems?.elements ?? order?.lineItems ?? []) as AnyObj[];
  const items = rawItems.map((li: AnyObj) => ({
    name: String(li?.name ?? 'Item'),
    quantity: 1,
    amountCents: Math.round(li?.price ?? 0),
  }));
  const totalCents = order?.total ?? rawItems.reduce((sum, li) => sum + Math.round(li?.price ?? 0), 0);
  const paid = mapTenders(order).reduce((sum, t) => sum + t.amountCents, 0);
  return {
    id: String(order?.id ?? ''),
    items,
    tenders: mapTenders(order),
    totalCents,
    remainingCents: Math.max(0, totalCents - paid),
    // [V5] confirm merchant currency field; default CAD for the Canadian pilot.
    currency: String(order?.currency ?? 'CAD'),
    state: mapState(order?.state),
  };
}

const firstHeader = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v ?? '').split(',')[0]?.trim() ?? '';

export const cloverAdapter: PosAdapter = {
  posType: 'clover',

  async listOpenChecks(locationRef: string, token?: string): Promise<PosOpenCheckSummary[]> {
    const mId = pathSeg(locationRef, 'merchant_id');
    // [V2] confirm server-side state filtering; until then filter client-side.
    // Pull today's orders and keep the open ones.
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const data: AnyObj = await cl(
      'GET',
      `/v3/merchants/${mId}/orders?filter=createdTime>=${sinceMs}&limit=100&expand=payments`,
      undefined,
      token,
    );
    const orders: AnyObj[] = data?.elements ?? [];
    return orders
      .filter((o) => mapState(o?.state) === 'OPEN')
      .map((o) => {
        const d = mapDetail(o);
        return {
          // Composite id "<mId>:<orderId>": self-contained for
          // getCheckDetail/recordExternalPayment (see note there).
          id: `${locationRef}:${d.id}`,
          displayLabel: `Order ${d.id.slice(0, 8)}`,
          totalCents: d.totalCents,
          remainingCents: d.remainingCents,
          currency: d.currency,
          openedAt: o?.createdTime ? new Date(o.createdTime).toISOString() : null,
        };
      });
  },

  async getCheckDetail(checkId: string, token?: string): Promise<PosCheckDetail> {
    // locationRef (merchant id) is not in this signature; the route layer
    // resolves the merchant from the location and calls with a merchant-
    // scoped path via listOpenChecks context. For direct calls we need the
    // merchant id — carried in the checkId as "<mId>:<orderId>".
    const [mIdRaw, orderIdRaw] = String(checkId).split(':');
    if (!orderIdRaw) throw badRequest('invalid checkId (expected <merchantId>:<orderId>)');
    const mId = pathSeg(mIdRaw, 'merchant_id');
    const orderId = pathSeg(orderIdRaw, 'order_id');
    const order: AnyObj = await cl(
      'GET',
      `/v3/merchants/${mId}/orders/${orderId}?expand=lineItems,payments`,
      undefined,
      token,
    );
    // Echo the composite checkId back so ids round-trip through listOpenChecks.
    return { ...mapDetail(order), id: checkId };
  },

  async recordExternalPayment(
    checkId: string,
    amountCents: number,
    currency: string,
    method: string,
    idempotencyKey: string,
    token?: string,
  ): Promise<PosPaymentResult> {
    const [mIdRaw, orderIdRaw] = String(checkId).split(':');
    if (!orderIdRaw) throw badRequest('invalid checkId (expected <merchantId>:<orderId>)');
    const mId = pathSeg(mIdRaw, 'merchant_id');
    const orderId = pathSeg(orderIdRaw, 'order_id');
    // [V4] verified 2026-10-15: Clover needs the tender UUID from GET /tenders.
    const tenderId = await resolveTenderId(mId, method, token);
    const payment: AnyObj = await cl(
      'POST',
      `/v3/merchants/${mId}/orders/${orderId}/payments`,
      {
        amount: amountCents,
        currency,
        tender: { id: tenderId },
        note: `Smart Table external payment (${method})`,
        // Clover has no native idempotency key on this endpoint; callers must
        // dedupe via our payments table (same discipline as Square's key).
        externalReferenceId: idempotencyKey.slice(0, 64),
      },
      token,
    );
    const order: AnyObj = await cl(
      'GET',
      `/v3/merchants/${mId}/orders/${orderId}?expand=payments`,
      undefined,
      token,
    );
    const d = mapDetail(order);
    return {
      paymentId: String(payment?.id ?? ''),
      remainingCents: d.remainingCents,
      currency: d.currency,
      replayed: false,
    };
  },

  async chargeCard(args: ChargeCardArgs): Promise<PosPaymentResult> {
    // Clover card flow (Ecommerce API):
    //   1. The guest browser tokenizes the card directly with Clover
    //      (POST {tokenHost}/v1/tokens, apikey = Ecommerce public token) ->
    //      one-time `clv_...` source token. Card data never touches our server.
    //   2. We pay the order here (POST {ecomHost}/v1/orders/{orderId}/pay,
    //      Bearer = Ecommerce private token) — this charges the card AND
    //      links the payment to the Clover order in one call.
    const [mIdRaw, orderIdRaw] = String(args.checkId).split(':');
    if (!orderIdRaw) throw badRequest('invalid checkId (expected <merchantId>:<orderId>)');
    const orderId = pathSeg(orderIdRaw, 'order_id');
    const privateToken = args.card.privateToken;
    if (!privateToken) {
      throw badRequest('card payments are not configured for this merchant (missing Clover Ecommerce private token)');
    }
    if (!/^clv_/i.test(args.cardToken)) throw badRequest('invalid card token');

    const pay: AnyObj = await ecom(
      'POST',
      `/v1/orders/${orderId}/pay`,
      {
        amount: args.amountCents,
        currency: args.currency.toLowerCase(),
        source: args.cardToken,
        // Tip was silently dropped before (review observation): pass it explicitly.
        ...(args.tipCents > 0 ? { tip_amount: args.tipCents } : {}),
      },
      privateToken,
    );
    const paymentId = String(pay?.id ?? pay?.paymentId ?? '');
    if (!paymentId) throw new Error('Clover order pay returned no payment id');

    const [mId] = [pathSeg(mIdRaw, 'merchant_id')];
    const order: AnyObj = await cl(
      'GET',
      `/v3/merchants/${mId}/orders/${orderId}?expand=payments`,
      undefined,
      args.token,
    );
    const d = mapDetail(order);
    return {
      paymentId,
      remainingCents: d.remainingCents,
      currency: d.currency,
      replayed: false,
    };
  },

  async getCardConfig(locationRef: string, card: CardCredentials): Promise<CardPaymentConfig> {
    if (!card.publicToken) {
      throw badRequest('card payments are not configured for this merchant (missing Clover Ecommerce public token)');
    }
    return {
      provider: 'clover',
      publishableKey: card.publicToken,
      extra: {
        merchantId: locationRef,
        tokenHost: TOKEN_BASE,
        ecomHost: ECOM_BASE,
      },
    };
  },

  async registerWebhooks(_locationRef: string, _webhookUrl: string): Promise<void> {
    // Clover webhooks are registered in the Developer Dashboard
    // (App Settings -> Webhooks: enter URL, verify code, subscribe to
    // event types O=orders, P=payments) — not via API. Manual step per app.
    return;
  },

  // QR ordering -----------------------------------------------------------
  // Menu: Clover inventory items (price in cents, per-unit).
  async getMenu(locationRef: string, token?: string): Promise<PosMenuItem[]> {
    const mId = pathSeg(locationRef, 'merchant_id');
    const data: AnyObj = await cl(
      'GET',
      `/v3/merchants/${mId}/items?limit=100&expand=categories`,
      undefined,
      token,
    );
    const items: AnyObj[] = data?.elements ?? [];
    return items
      // M3 fix: skip variable-price, hidden, and unavailable items.
      .filter((it) => it?.priceType !== 'VARIABLE' && !it?.hidden && it?.available !== false)
      .map((it) => ({
        id: String(it?.id ?? ''),
        name: String(it?.name ?? 'Item'),
        description: null,
        priceCents: Number(it?.price ?? 0),
        currency: 'USD', // [V5] sandbox merchant currency; confirm per merchant
        category: null,
        imageUrl: null,
      }))
      .filter((m) => m.id && m.priceCents > 0);
  },

  // Order: create an open Clover order with the table label in the note,
  // then attach line items referencing the inventory items.
  async createCheck(args: CreateCheckArgs): Promise<{ checkId: string }> {
    const mId = pathSeg(args.locationRef, 'merchant_id');
    if (!args.items.length) throw new Error('order must have at least one item');
    // M2 fix: validate EVERYTHING before creating the order, so a bad item
    // never leaves an empty orphan order in the POS. Cap total units.
    const menu = await this.getMenu!(args.locationRef, args.token);
    const byId = new Map(menu.map((m) => [m.id, m]));
    let totalUnits = 0;
    for (const i of args.items) {
      const m = byId.get(i.menuItemId);
      if (!m) throw new Error(`unknown menu item: ${String(i.menuItemId).slice(0, 32)}`);
      const qty = Math.floor(i.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error('invalid quantity');
      totalUnits += qty;
    }
    if (totalUnits > 40) throw new Error('too many units in one order (max 40)');
    // 1. Create the open order (note carries the table label for staff).
    const order: AnyObj = await cl(
      'POST',
      `/v3/merchants/${mId}/orders`,
      { state: 'open', note: `SmartTable table ${args.tableLabel}` },
      args.token,
    );
    const orderId = String(order?.id ?? '');
    if (!orderId) throw new Error('Clover did not return an order id');
    try {
      // 2. Attach line items. Clover v3 ignores unitQty for fixed-price items,
      // so one line item per unit (verified in sandbox 2026-10-15).
      for (const i of args.items) {
        const m = byId.get(i.menuItemId)!;
        for (let n = 0; n < Math.floor(i.quantity); n++) {
          await cl(
            'POST',
            `/v3/merchants/${mId}/orders/${orderId}/line_items`,
            { item: { id: m.id }, price: m.priceCents },
            args.token,
          );
        }
      }
    } catch (e) {
      // M2 fix: void the partial order instead of leaving it orphaned.
      await cl('POST', `/v3/merchants/${mId}/orders/${orderId}`, { state: 'voided' }, args.token).catch(() => undefined);
      throw e;
    }
    return { checkId: `${args.locationRef}:${orderId}` };
  },

  async parseWebhookEvent({ headers, body }): Promise<PosEvent[]> {
    // Dashboard-issued verification: every webhook carries X-Clover-Auth.
    // M5 fix: constant-time comparison so the key can't be probed byte-by-byte.
    const key = firstHeader(headers['x-clover-auth']);
    if (config.cloverWebhookKey) {
      if (!key || !safeEqual(key, config.cloverWebhookKey)) throw new Error('invalid clover webhook key');
    } else if (config.isProd) {
      throw new Error('webhook verification is not configured');
    }
    // Payload: { appId, merchants: { <mId>: [{ objectId: "O:<orderId>", type, ts }] } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evt: any = body;
    const events: PosEvent[] = [];
    const merchants: AnyObj = evt?.merchants ?? {};
    for (const entries of Object.values(merchants) as AnyObj[]) {
      for (const e of entries as AnyObj[]) {
        const objectId: string = String(e?.objectId ?? '');
        const [kind, id] = objectId.split(':');
        if (!id) continue;
        if (kind === 'O') {
          events.push({
            type: e?.type === 'DELETE' ? 'check.closed' : 'check.updated',
            checkId: id,
            eventId: `${objectId}:${e?.type ?? 'UNKNOWN'}`,
            rawType: `orders.${e?.type ?? 'UNKNOWN'}`,
          });
        } else if (kind === 'P') {
          events.push({ type: 'payment.recorded', checkId: '', eventId: `${objectId}:${e?.type ?? 'UNKNOWN'}`, rawType: `payments.${e?.type ?? 'UNKNOWN'}` });
        }
      }
    }
    return events;
  },

  getOAuthConnectUrl(state: string): string {
    const clientId = config.cloverAppId;
    if (!clientId) throw new Error('CLOVER_APP_ID is not set');
    const redirect = encodeURIComponent(`${config.appUrl}/api/oauth/callback/clover`);
    // Clover v2 OAuth: merchant installs from App Market, we get merchantId
    // on launch; authorize with client_id + redirect_uri (+ PKCE for low-trust).
    return (
      `${OAUTH_AUTHORIZE_BASE}/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${redirect}&state=${encodeURIComponent(state)}&response_type=code`
    );
  },

  async handleOAuthCallback({ code, merchantRef }): Promise<PosCredentials> {
    if (!config.cloverAppId || !config.cloverAppSecret) throw new Error('CLOVER_APP_ID/SECRET not set');
    const mId = merchantRef ? assertCloverId(merchantRef, 'merchant_id') : '';
    const tokenHost =
      config.cloverEnv === 'production' ? 'https://api.clover.com' : 'https://apisandbox.dev.clover.com';
    const res = await fetch(`${tokenHost}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.cloverAppId, client_secret: config.cloverAppSecret, code }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new CloverError(res.status, data);
    const accessToken: string = data.access_token;
    if (!accessToken) throw new Error('Clover OAuth: no access_token in response');
    // Merchant profile for display name; currency confirmed in sandbox [V5].
    let name = mId || 'Clover merchant';
    try {
      const m: AnyObj = await cl('GET', `/v3/merchants/${pathSeg(mId || 'me', 'merchant_id')}`, undefined, accessToken);
      if (m?.name) name = String(m.name);
    } catch {
      /* non-fatal: keep fallback name */
    }
    return {
      merchantRef: mId,
      accessToken,
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.access_token_expiration ? new Date(data.access_token_expiration * 1000).toISOString() : null,
      locations: mId ? [{ ref: mId, name, currency: 'CAD' }] : [],
    };
  },
};
