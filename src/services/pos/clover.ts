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
import { getMenuCached } from './menu-cache.js';

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
async function ecom<T>(method: string, path: string, body: unknown, privateToken: string, clientIp?: string): Promise<T> {
  const res = await fetch(ECOM_BASE + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${privateToken}`,
      'Content-Type': 'application/json',
      // D-11: the Ecommerce API wants the END CUSTOMER's IP for fraud
      // scoring — the guest's real IP is plumbed from the pay request;
      // the loopback placeholder remains only when no IP was supplied.
      'x-forwarded-for': clientIp || '127.0.0.1',
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
  // D-12: an EXPLICIT tender match is required. The old fallbacks (any
  // 'cash' tender, then simply the FIRST enabled tender) could record an
  // external payment against a completely unrelated tender type.
  const pick =
    enabled.find((t) => norm(t.label) === want) ??
    enabled.find((t) => norm(t.label).includes(want) || want.includes(norm(t.label)));
  if (!pick?.id) throw badRequest(`no ${method} tender is enabled for this merchant`);
  return String(pick.id);
}

async function cl<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  // v0.6.5 (D-9): the merchant's OAuth token is REQUIRED. The old fallback
  // sent CLOVER_APP_SECRET as a Bearer token — the app secret is not a
  // merchant credential and must never be used as one.
  const t = token;
  if (!t) throw new Error('clover is not connected for this location (no POS credential stored)');
  const res = await fetch(REST_BASE + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
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
    // PosTender contract (F2-13): amountCents is the TOTAL tendered,
    // tip included. Clover reports the tip separately (tipAmount) —
    // without it, tipped Clover payments never amount-match in reconcile.
    amountCents: (p?.amount ?? 0) + (p?.tipAmount ?? 0),
  }));
}

function mapDetail(order: AnyObj): PosCheckDetail {
  // [V3] unitQty/price semantics confirmed in sandbox 2026-10-15: Clover v3
  // does not persist unitQty for fixed-price items (returns null) — each
  // line item is 1 unit, so quantity = number of line items with that name.
  // Order.total is also absent; total = sum(line item prices).
  // F3-8: never bill for lines the POS marks voided/refunded/deleted
  // (present on some Clover payloads; absent fields keep the line).
  const rawItems = ((order?.lineItems?.elements ?? order?.lineItems ?? []) as AnyObj[]).filter(
    (li) => li?.voided !== true && li?.refunded !== true && li?.deleted !== true,
  );
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
    // D-15: PAGE through the window (100/page, up to 500) — a busy
    // restaurant's 101st open order used to be silently invisible to
    // link-check.
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const orders: AnyObj[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const data: AnyObj = await cl(
        'GET',
        `/v3/merchants/${mId}/orders?filter=createdTime>=${sinceMs}&limit=100&offset=${offset}&expand=payments`,
        undefined,
        token,
      );
      const page: AnyObj[] = data?.elements ?? [];
      orders.push(...page);
      if (page.length < 100) break;
    }
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
    // F3-1: the payment is already recorded at Clover. A failed read-back
    // (e.g. an expired OAuth token -> 401) must NOT surface as a payment
    // failure — the caller would mark the row FAILED and the guest would
    // pay twice. Unknown remaining is reported as null instead.
    let d: PosCheckDetail | null = null;
    try {
      const order: AnyObj = await cl(
        'GET',
        `/v3/merchants/${mId}/orders/${orderId}?expand=payments`,
        undefined,
        token,
      );
      d = mapDetail(order);
    } catch { /* read-back is best-effort after the money moved */ }
    return {
      paymentId: String(payment?.id ?? ''),
      remainingCents: d ? d.remainingCents : null,
      currency: d?.currency ?? currency,
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
      args.clientIp,
    );
    const paymentId = String(pay?.id ?? pay?.paymentId ?? '');
    if (!paymentId) throw new Error('Clover order pay returned no payment id');

    const [mId] = [pathSeg(mIdRaw, 'merchant_id')];
    // F3-1: same rule as recordExternalPayment — the charge has landed;
    // a failed read-back yields an unknown remaining, never a fake decline.
    let d: PosCheckDetail | null = null;
    try {
      const order: AnyObj = await cl(
        'GET',
        `/v3/merchants/${mId}/orders/${orderId}?expand=payments`,
        undefined,
        args.token,
      );
      d = mapDetail(order);
    } catch { /* read-back is best-effort after the money moved */ }
    return {
      paymentId,
      remainingCents: d ? d.remainingCents : null,
      currency: d?.currency ?? args.currency,
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
        currency: 'CAD', // [V5] placeholder only — getCachedMenu stamps the location's real currency over this (D-6)
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
    // D-10: validate against the SHARED menu cache (menu-cache.ts) — a
    // direct getMenu() here bypassed the 45s cache that protects the
    // merchant's POS API quota.
    const menu = await getMenuCached(this, 'clover', args.locationRef, args.token);
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
      // F3-12: an OVERALL deadline — up to 40 sequential 10s calls could
      // otherwise hang an order creation for minutes.
      const deadline = Date.now() + 90_000;
      for (const i of args.items) {
        const m = byId.get(i.menuItemId)!;
        for (let n = 0; n < Math.floor(i.quantity); n++) {
          if (Date.now() > deadline) throw new Error('clover order creation exceeded the overall deadline');
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
      // F3-12: a failed void is logged loudly — a half-built order sitting
      // in the kitchen queue must be findable, never silent.
      await cl('POST', `/v3/merchants/${mId}/orders/${orderId}`, { state: 'voided' }, args.token).catch(
        (voidErr) => console.error(`[clover] FAILED to void partial order ${orderId} — it may sit in the POS queue:`, voidErr),
      );
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
    // D-5 fixes:
    //  - checkId must be the COMPOSITE ref "<mId>:<orderId>" that our
    //    checks rows store (the merchants-map key carries the mId) — the
    //    bare order id could never match a stored ref.
    //  - eventId includes the payload ts: without it, every occurrence of
    //    the same CRUD type on the same object deduped into the first.
    //  - The event type is a CRUD verb on the object, NOT the order's
    //    payment state: a DELETE means the order was deleted, not paid.
    //    Never derive closure from the payload — order events are emitted
    //    as check.updated and the route re-fetches the order to decide.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evt: any = body;
    const events: PosEvent[] = [];
    const merchants: AnyObj = evt?.merchants ?? {};
    for (const [mId, entries] of Object.entries(merchants) as [string, AnyObj[]][]) {
      for (const e of entries as AnyObj[]) {
        const objectId: string = String(e?.objectId ?? '');
        const [kind, id] = objectId.split(':');
        if (!id) continue;
        const ts = e?.ts ?? e?.updatedTime ?? '';
        if (kind === 'O') {
          events.push({
            type: 'check.updated',
            checkId: `${mId}:${id}`,
            eventId: `${objectId}:${e?.type ?? 'UNKNOWN'}:${ts}`,
            rawType: `orders.${e?.type ?? 'UNKNOWN'}`,
          });
        } else if (kind === 'P') {
          events.push({ type: 'payment.recorded', checkId: '', eventId: `${objectId}:${e?.type ?? 'UNKNOWN'}:${ts}`, rawType: `payments.${e?.type ?? 'UNKNOWN'}` });
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
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.cloverAppId, client_secret: config.cloverAppSecret, code }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new CloverError(res.status, data);
    const accessToken: string = data.access_token;
    if (!accessToken) throw new Error('Clover OAuth: no access_token in response');
    // D-8: the merchant-profile fetch is now FATAL and ASSERTS identity.
    // It used to be a swallowed try/catch: a token issued for a DIFFERENT
    // merchant than the callback's merchantRef would have been stored
    // against the wrong merchant without anyone noticing. The profile's
    // own id must equal the claimed merchantRef.
    const profile: AnyObj = await cl('GET', `/v3/merchants/${mId || 'me'}`, undefined, accessToken);
    const profileId = String(profile?.id ?? '');
    if (!profileId) throw new Error('Clover OAuth: merchant profile returned no id');
    if (mId && profileId !== mId) {
      throw new Error(`Clover OAuth merchant mismatch: callback claimed ${mId} but the token belongs to ${profileId}`);
    }
    const name = profile?.name ? String(profile.name) : profileId;
    return {
      merchantRef: mId || profileId,
      accessToken,
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.access_token_expiration ? new Date(data.access_token_expiration * 1000).toISOString() : null,
      locations: [{ ref: profileId, name, currency: 'CAD' }],
    };
  },
};
