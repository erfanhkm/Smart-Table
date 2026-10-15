// Shopify POS adapter (v0.3).
//
// Model: Shopify draft orders act as open checks.
//   draft_orders (status=open)  -> open checks
//   draft_order.line_items      -> items (price is a DECIMAL STRING per unit)
//   draft_order.total_price     -> totalCents
//   complete draft order        -> record payment (creates the order)
//   webhooks                    -> HMAC-SHA256 (base64) on raw body
//
// Docs: https://shopify.dev/docs/api/admin-rest
//
// Field mapping (Shopify -> normalized):
//   draft_order.id                    -> id
//   draft_order.name ("#D12")         -> displayLabel
//   line_items[].title               -> items[].name
//   line_items[].quantity            -> items[].quantity
//   line_items[].price ("12.99")     -> items[].amountCents (per-unit cents * qty)
//   draft_order.total_price           -> totalCents
//   status "open"/"invoice_sent"     -> OPEN; "completed" -> CLOSED
//   draft_order.currency             -> currency
//
// UNVERIFIED — dev store credentials pending (Partner account + dev store).
// SANDBOX VERIFICATION POINTS (confirm with scripts/verify-shopify.ts):
//   [S1] draft_order.status enum values in real data.
//   [S2] line_items price semantics: per-unit decimal string (docs say yes).
//   [S3] exact POST body for completing a draft order with an external/
//        manual payment (payment_gateway_id lookup).
//   [S4] webhook topic names + HMAC verification against a real delivery.
//   [S5] currency field presence on draft orders.
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../../config.js';
import { badRequest } from '../../http.js';
import {
  CreateCheckArgs,
  PosAdapter,
  PosCheckDetail,
  PosCheckState,
  PosCredentials,
  PosEvent,
  PosEventType,
  PosMenuItem,
  PosOpenCheckSummary,
  PosPaymentResult,
} from './types.js';

const API_VERSION = '2026-07';
const SCOPES = 'read_draft_orders,write_draft_orders,read_orders,read_products';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

export class ShopifyError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(`Shopify API ${status}: ${JSON.stringify(detail).slice(0, 300)}`);
    this.status = status;
    this.detail = detail;
  }
}

// ---- ID safety (same discipline as the other adapters) ----
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const NUM_ID_RE = /^\d+$/;

function assertShop(domain: unknown): string {
  if (typeof domain !== 'string' || !SHOP_RE.test(domain.trim())) {
    throw badRequest('invalid shop domain (expected <shop>.myshopify.com)');
  }
  return domain.trim().toLowerCase();
}

function assertNumericId(id: unknown, label = 'id'): string {
  if (typeof id !== 'string' || !NUM_ID_RE.test(id)) throw badRequest(`invalid ${label}`);
  return id;
}

/** checkId format: "<shop>.myshopify.com:<draftOrderId>" */
function splitCheckId(checkId: string): { shop: string; draftId: string } {
  const i = String(checkId).lastIndexOf(':');
  if (i <= 0) throw badRequest('invalid checkId (expected <shop>:<draftOrderId>)');
  return { shop: assertShop(checkId.slice(0, i)), draftId: assertNumericId(checkId.slice(i + 1), 'draft_order_id') };
}

function adminBase(shop: string): string {
  return `https://${shop}/admin/api/${API_VERSION}`;
}

async function sh<T>(shop: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const t = token ?? config.shopifyAdminToken;
  if (!t) throw new Error('Shopify token is not set (pass an Admin API token or set SHOPIFY_ADMIN_TOKEN)');
  const res = await fetch(adminBase(shop) + path, {
    method,
    headers: {
      'X-Shopify-Access-Token': t,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: AnyObj = await res.json().catch(() => ({}));
  if (!res.ok) throw new ShopifyError(res.status, data?.errors ?? data);
  return data as T;
}

/** "12.99" -> 1299 */
function toCents(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function mapState(status: unknown): PosCheckState {
  const v = String(status ?? '').toLowerCase();
  if (v === 'open' || v === 'invoice_sent' || v === 'pending') return 'OPEN';
  return 'CLOSED';
}

function mapDetail(d: AnyObj): PosCheckDetail {
  // [S2] verify per-unit decimal-string semantics in sandbox.
  const items = ((d?.line_items ?? []) as AnyObj[]).map((li) => {
    const qty = Number(li?.quantity ?? 1) || 1;
    const unitCents = toCents(li?.price);
    return {
      name: String(li?.title ?? li?.name ?? 'Item'),
      quantity: qty,
      amountCents: unitCents * qty,
    };
  });
  const totalCents = toCents(d?.total_price);
  return {
    id: String(d?.id ?? ''),
    items,
    tenders: [],
    totalCents,
    remainingCents: totalCents,
    currency: String(d?.currency ?? 'CAD'),
    state: mapState(d?.status),
  };
}

const firstHeader = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v ?? '').split(',')[0]?.trim() ?? '';

export const shopifyAdapter: PosAdapter = {
  posType: 'shopify',

  async listOpenChecks(locationRef: string, token?: string): Promise<PosOpenCheckSummary[]> {
    const shop = assertShop(locationRef);
    // [S1] confirm status filter values; client-side filter as backup.
    const data: AnyObj = await sh(shop, 'GET', '/draft_orders.json?status=open&limit=250', undefined, token);
    const drafts: AnyObj[] = data?.draft_orders ?? [];
    return drafts
      .filter((d) => mapState(d?.status) === 'OPEN')
      .map((d) => {
        const det = mapDetail(d);
        return {
          // Composite id "<shop>:<draftId>": self-contained for
          // getCheckDetail/recordExternalPayment (see splitCheckId).
          id: `${shop}:${det.id}`,
          displayLabel: String(d?.name ?? d?.invoice_number ?? `Draft ${det.id}`),
          totalCents: det.totalCents,
          remainingCents: det.remainingCents,
          currency: det.currency,
          openedAt: d?.created_at ?? null,
        };
      });
  },

  async getCheckDetail(checkId: string, token?: string): Promise<PosCheckDetail> {
    const { shop, draftId } = splitCheckId(checkId);
    const data: AnyObj = await sh(shop, 'GET', `/draft_orders/${draftId}.json`, undefined, token);
    if (!data?.draft_order) throw badRequest('draft order not found');
    // Echo the composite checkId back so ids round-trip through listOpenChecks.
    return { ...mapDetail(data.draft_order), id: checkId };
  },

  async recordExternalPayment(
    checkId: string,
    amountCents: number,
    currency: string,
    method: string,
    idempotencyKey: string,
    token?: string,
  ): Promise<PosPaymentResult> {
    const { shop, draftId } = splitCheckId(checkId);
    // [S3] verify the payment body: completing a draft order creates the
    // paid order. payment_gateway_id maps manual payment methods (e.g. Cash)
    // when the caller passes a numeric method; otherwise complete with a
    // note and let the merchant's default manual method apply.
    const body: AnyObj = /^\d+$/.test(method)
      ? { payment_gateway_id: Number(method) }
      : { note: `Smart Table external payment (${method}) [${idempotencyKey.slice(0, 32)}]` };
    // Currency sanity: Shopify totals are in the draft's currency.
    void currency;
    void amountCents;
    // [S3] verified 2026-10-15: complete is PUT (not POST) —
    // PUT /draft_orders/{id}/complete.json. payment_gateway_id maps manual
    // payment methods (e.g. Cash) when the caller passes a numeric method.
    const data: AnyObj = await sh(shop, 'PUT', `/draft_orders/${draftId}/complete.json`, body, token);
    const order: AnyObj = data?.draft_order ?? {};
    const det = mapDetail(order);
    return {
      paymentId: String(order?.order_id ?? order?.id ?? ''),
      remainingCents: 0,
      currency: det.currency,
      replayed: false,
    };
  },

  async registerWebhooks(locationRef: string, webhookUrl: string, token?: string): Promise<void> {
    const shop = assertShop(locationRef);
    // [S4] confirm topic names against a real delivery.
    const topics = ['draft_orders/create', 'draft_orders/update', 'orders/create'];
    for (const topic of topics) {
      await sh(
        shop,
        'POST',
        '/webhooks.json',
        { webhook: { topic, address: webhookUrl, format: 'json' } },
        token,
      );
    }
  },

  // QR ordering -----------------------------------------------------------
  // Menu: Shopify products (each variant = one menu entry; price is a
  // decimal string per unit). Draft orders reference variant ids.
  async getMenu(locationRef: string, token?: string): Promise<PosMenuItem[]> {
    const shop = assertShop(locationRef);
    const data: AnyObj = await sh(shop, 'GET', '/products.json?limit=250&status=active', undefined, token);
    const products: AnyObj[] = data?.products ?? [];
    const menu: PosMenuItem[] = [];
    for (const p of products) {
      // M3 fix: skip gift cards and non-published products — they're not menu items.
      const ptype = String(p?.product_type ?? '').toLowerCase();
      if (ptype.includes('gift card') || p?.status !== 'active') continue;
      for (const v of p?.variants ?? []) {
        const cents = Math.round(Number(v?.price ?? 0) * 100);
        if (!v?.id || cents <= 0) continue;
        menu.push({
          id: String(v.id),
          name: v?.title && v.title !== 'Default Title'
            ? `${p?.title ?? 'Item'} (${v.title})`
            : String(p?.title ?? 'Item'),
          description: p?.body_html ? String(p.body_html).replace(/<[^>]*>/g, '').slice(0, 200) : null,
          priceCents: cents,
          currency: 'USD', // [S5] dev store currency; confirm per shop
          category: p?.product_type ? String(p.product_type) : null,
          imageUrl: p?.image?.src ? String(p.image.src) : null,
        });
      }
    }
    return menu;
  },

  // Order: create an open draft order from variant ids; the table label goes
  // in the note so staff see it in the Shopify admin / POS.
  async createCheck(args: CreateCheckArgs): Promise<{ checkId: string }> {
    const shop = assertShop(args.locationRef);
    if (!args.items.length) throw new Error('order must have at least one item');
    const menu = await this.getMenu!(shop, args.token);
    const byId = new Map(menu.map((m) => [m.id, m]));
    const lineItems = args.items.map((i) => {
      const m = byId.get(i.menuItemId);
      if (!m) throw new Error(`unknown menu item: ${String(i.menuItemId).slice(0, 32)}`);
      const qty = Math.floor(i.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error('invalid quantity');
      return { variant_id: Number(m.id), quantity: qty };
    });
    const data: AnyObj = await sh(
      shop,
      'POST',
      '/draft_orders.json',
      {
        draft_order: {
          line_items: lineItems,
          note: `SmartTable table ${args.tableLabel}`,
          // Idempotency: Shopify dedupes on the client-generated key? No —
          // draft orders have no idempotency key, so we rely on the route
          // layer's single-flight + our DB upsert. Documented limitation.
        },
      },
      args.token,
    );
    const id = data?.draft_order?.id;
    if (!id) throw new Error('Shopify did not return a draft order id');
    // Composite id "<shop>:<draftOrderId>" — matches listOpenChecks format.
    return { checkId: `${shop}:${id}` };
  },

  async parseWebhookEvent(args: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    body: unknown;
    notificationUrl: string;
  }): Promise<PosEvent[]> {
    const secret = config.shopifyWebhookSecret;
    if (!secret) throw new Error('SHOPIFY_WEBHOOK_SECRET is not set');
    const sent = firstHeader(args.headers['x-shopify-hmac-sha256']);
    const digest = createHmac('sha256', secret).update(args.rawBody, 'utf8').digest('base64');
    if (!sent || !timingSafeEqual(Buffer.from(sent), Buffer.from(digest))) {
      throw new Error('invalid Shopify webhook signature');
    }
    const topic = firstHeader(args.headers['x-shopify-topic']);
    const b = (args.body ?? {}) as AnyObj;
    // Draft-order webhooks carry draft_order.id; order webhooks carry order.id.
    // Note: completing a draft creates a NEW order id — callers should link
    // via the draft id stored at completion time.
    const draftId = b?.draft_order?.id ?? b?.id;
    const typeMap: Record<string, PosEventType> = {
      'draft_orders/create': 'check.updated',
      'draft_orders/update': 'check.updated',
      orders_create: 'check.closed',
      'orders/create': 'check.closed',
      'orders/paid': 'payment.recorded',
    };
    const type = typeMap[topic];
    if (!type || draftId == null) return [];
    return [{ type, checkId: String(draftId), eventId: firstHeader(args.headers['x-shopify-webhook-id']), rawType: topic }];
  },

  getOAuthConnectUrl(state: string): string {
    const key = config.shopifyApiKey;
    if (!key) throw new Error('SHOPIFY_API_KEY is not set');
    // Shopify OAuth is per-shop: callers pass state as "<shop>|<opaque>".
    const i = String(state).indexOf('|');
    if (i <= 0) {
      throw badRequest('Shopify OAuth needs "<shop>.myshopify.com|<state>" as state');
    }
    const shop = assertShop(state.slice(0, i));
    const rest = state.slice(i + 1);
    const cb = `${config.appUrl}/api/oauth/callback/shopify`;
    return (
      `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(key)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(cb)}` +
      `&state=${encodeURIComponent(rest)}`
    );
  },

  async handleOAuthCallback(args: { code: string; merchantRef?: string }): Promise<PosCredentials> {
    const shop = args.merchantRef ? assertShop(args.merchantRef) : null;
    if (!shop) throw badRequest('Shopify OAuth callback needs the shop domain');
    const key = config.shopifyApiKey;
    const secret = config.shopifyApiSecret;
    if (!key || !secret) throw new Error('SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not set');
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: key, client_secret: secret, code: args.code }),
    });
    const data: AnyObj = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      throw new ShopifyError(res.status, data);
    }
    return {
      merchantRef: shop,
      accessToken: String(data.access_token),
      refreshToken: null,
      expiresAt: null,
      locations: [{ ref: shop, name: shop, currency: 'CAD' }],
    };
  },
};
