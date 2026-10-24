// Square adapter: implements PosAdapter on top of the low-level client in
// src/square.ts. This is the reference implementation — every other POS
// adapter must produce the same normalized shapes from its native API.
//
// Field mapping (Square -> normalized):
//   order.id                      -> id
//   line_items[].name             -> items[].name
//   line_items[].quantity (str)   -> items[].quantity (number)
//   line_items[].total_money      -> items[].amountCents  (fall back to
//                                    base_price_money * quantity when absent)
//   tenders[].id / .type          -> tenders[].id / .type
//   tenders[].amount_money.amount -> tenders[].amountCents
//   total_money.amount            -> totalCents
//   total - sum(tenders)          -> remainingCents  (orderRemaining())
//   total_money.currency          -> currency
//   state OPEN|COMPLETED|CANCELED -> OPEN|CLOSED|CANCELLED
import {
  assertSquareId,
  cancelPayment,
  createCatalogOrder,
  createPayment,
  createRefund,
  exchangeOAuthCode,
  getMerchantProfile,
  listLocations,
  orderRemaining,
  payOrder,
  retrieveOrder,
  retrievePayment,
  searchCatalogItems,
  searchOpenOrders,
  squareAuthorizeUrl,
  SquareError,
} from '../../square.js';
import { verifySquareWebhook } from '../../crypto.js';
import { badRequest } from '../../http.js';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
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
  PosRefundResult,
  RefundPaymentArgs,
} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOrder = any;

function mapState(s: unknown): PosCheckState {
  if (s === 'COMPLETED') return 'CLOSED';
  if (s === 'CANCELED') return 'CANCELLED';
  return 'OPEN';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTenders(order: AnyOrder): { id: string; type: string; amountCents: number }[] {
  return (order?.tenders ?? []).map((t: any) => ({
    id: String(t?.id ?? ''),
    type: String(t?.type ?? 'tender'),
    amountCents: t?.amount_money?.amount ?? 0,
  }));
}

// v0.8.4: every payment id tendered on the order, in tender order —
// PayOrder's required id list. Tenders carry `payment_id` (the tender's
// own `id` is the fallback). `fallback` is used when the order lists no
// tenders at all.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tenderPaymentIds(order: AnyOrder, fallback: string[]): string[] {
  const ids: string[] = (order?.tenders ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any): string => String(t?.payment_id ?? t?.id ?? ''))
    .filter((s: string) => Boolean(s));
  return ids.length ? [...new Set(ids)] : fallback;
}

function mapDetail(order: AnyOrder): PosCheckDetail {
  const items = (order?.line_items ?? []).map((li: any) => {
    const qty = parseFloat(li?.quantity ?? '1') || 1;
    const lineTotal = li?.total_money?.amount ?? (li?.base_price_money?.amount ?? 0) * qty;
    return { name: String(li?.name ?? 'Item'), quantity: qty, amountCents: Math.round(lineTotal) };
  });
  const totalCents = order?.total_money?.amount ?? 0;
  return {
    id: String(order?.id ?? ''),
    items,
    tenders: mapTenders(order),
    totalCents,
    remainingCents: orderRemaining(order),
    currency: String(order?.total_money?.currency ?? 'CAD'),
    state: mapState(order?.state),
  };
}

const firstHeader = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v ?? '').split(',')[0]?.trim() ?? '';

/**
 * D-4: does this Square rejection blame the application fee itself?
 * True when Square says the fee/scope is the problem — the seller lacks
 * the PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS OAuth scope (Square answers
 * INSUFFICIENT_PERMISSIONS) or the error text names the app fee. A card
 * decline never matches: retrying it without the fee would be a second,
 * pointless charge attempt on a doomed card.
 */
function isAppFeeRejection(e: SquareError): boolean {
  for (const err of e.errors ?? []) {
    if (err?.code === 'INSUFFICIENT_PERMISSIONS') return true;
    const text = `${String(err?.code ?? '')} ${String(err?.detail ?? '')}`.toLowerCase();
    if (text.includes('app_fee') || text.includes('application fee') || text.includes('additional_recipients')) {
      return true;
    }
  }
  return false;
}

export const squareAdapter: PosAdapter = {
  posType: 'square',
  // Square dedupes on our idempotency key: a same-key retry never charges twice.
  nativeIdempotency: true,

  async listOpenChecks(locationRef: string, token?: string): Promise<PosOpenCheckSummary[]> {
    const { orders } = await searchOpenOrders(assertSquareId(locationRef, 'location_id'), token);
    return (orders ?? []).map((o: AnyOrder) => {
      const d = mapDetail(o);
      return {
        id: d.id,
        // Square orders carry no table name; the portal joins our own
        // table mapping on top of this id.
        displayLabel: `Order ${d.id.slice(0, 8)}`,
        totalCents: d.totalCents,
        remainingCents: d.remainingCents,
        currency: d.currency,
        openedAt: o?.created_at ?? null,
      };
    });
  },

  async getCheckDetail(checkId: string, token?: string): Promise<PosCheckDetail> {
    const { order } = await retrieveOrder(checkId, token);
    return mapDetail(order);
  },

  async recordExternalPayment(
    checkId: string,
    amountCents: number,
    currency: string,
    method: string,
    idempotencyKey: string,
    token?: string,
  ): Promise<PosPaymentResult> {
    // Mirrors the cash flow in src/services/payments.ts: an EXTERNAL payment
    // (money moved outside Square) followed by PayOrder to close the order.
    // DB bookkeeping stays in payments.ts; the adapter only touches Square.
    const { payment } = await createPayment(
      {
        orderId: checkId,
        amountCents,
        currency,
        sourceId: 'EXTERNAL',
        externalSource: method,
        autocomplete: false,
        idempotencyKey,
      },
      token,
    );
    // v0.8.4: same PayOrder discipline as chargeCard — pay with EVERY
    // tendered payment id (Square rejects a list that omits payments
    // already on the order), and never throw after the tender landed:
    // staff would see a failure for money Square already recorded.
    let payIds: string[] = [payment.id];
    let freshCurrency: string | undefined;
    try {
      const { order: fresh } = await retrieveOrder(checkId, token);
      payIds = tenderPaymentIds(fresh, payIds);
      freshCurrency = mapDetail(fresh).currency;
    } catch { /* fall back to just our payment */ }
    try {
      const { order } = await payOrder(checkId, payIds, randomUUID(), token);
      const d = mapDetail(order);
      return { paymentId: payment.id, remainingCents: d.remainingCents, currency: d.currency, replayed: false };
    } catch (e) {
      console.error(
        `[square] PayOrder failed after recording an external payment (order ${checkId}, payment ${payment.id}); the tender stands in Square:`,
        e,
      );
      return { paymentId: payment.id, remainingCents: null, currency: freshCurrency ?? currency, replayed: false };
    }
  },

  async chargeCard(args: ChargeCardArgs): Promise<PosPaymentResult> {
    // Mirrors the verified guest card flow from payments.ts: authorize the
    // card (no auto-capture), then close the order with PayOrder once the
    // payment covers the remaining balance. priorPaymentIds carries earlier
    // authorized payments on this check so a split card payment still closes.
    //
    // SCA/3D Secure: handled by the Square Web Payments SDK at tokenize()
    // time in the guest browser — the SDK presents the verification challenge
    // when the issuer requires it, so the cnon: token arriving here is already
    // verification-aware. No backend changes needed.
    //
    // v0.4 billing: the commission rides along as a Square application fee.
    // A guest payment must NEVER fail because of our fee: if Square
    // definitively rejects the request BECAUSE OF THE FEE (e.g. the seller
    // never granted the application-fee OAuth scope), retry ONCE without
    // the fee under a derived idempotency key and report
    // feeCollected=false — the fee then accrues in the ledger instead.
    // D-4: the retry is ONLY for fee/scope rejections. Retrying a card
    // decline (or any other definitive error) without the fee would just
    // charge-attempt the same doomed card twice — declines must surface
    // immediately so the payments row can be marked FAILED with the
    // guest-safe decline code.
    const fee = args.appFeeCents && args.appFeeCents > 0 ? args.appFeeCents : 0;
    let payment;
    let feeCollected = false;
    try {
      ({ payment } = await createPayment(
        {
          orderId: args.checkId,
          amountCents: args.amountCents,
          currency: args.currency,
          sourceId: args.cardToken,
          tipCents: args.tipCents,
          autocomplete: false,
          idempotencyKey: args.idempotencyKey,
          appFeeCents: fee || undefined,
        },
        args.token,
      ));
      feeCollected = fee > 0;
    } catch (e) {
      const definitive =
        e instanceof SquareError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
      if (fee <= 0 || !definitive || !isAppFeeRejection(e)) throw e;
      console.error(
        `[billing] Square rejected payment with app fee (order ${args.checkId}); retrying without fee:`,
        e.message,
      );
      ({ payment } = await createPayment(
        {
          orderId: args.checkId,
          amountCents: args.amountCents,
          currency: args.currency,
          sourceId: args.cardToken,
          tipCents: args.tipCents,
          autocomplete: false,
          idempotencyKey: `${args.idempotencyKey}-nf`,
        },
        args.token,
      ));
      feeCollected = false;
    }
    // v0.8.4: the charge has LANDED by this point — nothing below may
    // throw, or the caller marks a PAID bill FAILED and loses the
    // payment's id (proven live 2026-10-24: a charge + app fee succeeded
    // at Square, then PayOrder rejected because its id list omitted a
    // pre-existing POS tender the payments table had no row for, and
    // the guest's successful payment was recorded FAILED).
    let order: AnyOrder;
    try {
      ({ order } = await retrieveOrder(args.checkId, args.token));
    } catch (e) {
      console.error(
        `[square] post-charge order read failed (order ${args.checkId}, payment ${payment.id}); reporting unknown remaining:`,
        e,
      );
      return { paymentId: payment.id, remainingCents: null, currency: args.currency, replayed: false, feeCollected };
    }
    const d = mapDetail(order);
    if (d.remainingCents > 0) {
      return { paymentId: payment.id, remainingCents: d.remainingCents, currency: d.currency, replayed: false, feeCollected };
    }
    // Fully covered: close the order in Square. PayOrder requires the ids
    // of EVERY payment tendered on the order — including tenders recorded
    // directly in the POS that we have no payments row for — so the list
    // comes from the order itself, not from our prior-payment bookkeeping.
    const payIds = tenderPaymentIds(order, [...args.priorPaymentIds, payment.id]);
    try {
      await payOrder(args.checkId, payIds, randomUUID(), args.token);
    } catch (e) {
      console.error(
        `[square] PayOrder close failed AFTER a successful charge (order ${args.checkId}, payment ${payment.id}); the charge stands — the order close needs reconcile:`,
        e,
      );
    }
    return { paymentId: payment.id, remainingCents: 0, currency: d.currency, replayed: false, feeCollected };
  },

  async refundPayment(args: RefundPaymentArgs): Promise<PosRefundResult> {
    // Local determinations in this method throw badRequest (F-2): the
    // refund state machine treats a 4xx-carrying error as a DEFINITIVE
    // rejection and anything else as an unknown outcome.
    // Only real card payments can be refunded through Square: an EXTERNAL
    // tender (cash recorded in the POS) never moved money through Square,
    // so there is nothing for Square to give back — staff refund cash at
    // the till. Verified against the payment object itself, not our rows.
    const { payment } = await retrievePayment(args.paymentId, args.token);
    if (!payment) throw badRequest('payment not found in Square');
    if (payment.source_type !== 'CARD') {
      throw badRequest('only card payments can be refunded here — cash is refunded at the till');
    }
    if (payment.status === 'COMPLETED') {
      // Captured/settled: the Refunds API applies (partial allowed). Square
      // also returns the proportional application fee with the refund.
      const { refund } = await createRefund(
        {
          paymentId: args.paymentId,
          amountCents: args.amountCents,
          currency: args.currency,
          idempotencyKey: args.idempotencyKey,
          reason: args.reason,
        },
        args.token,
      );
      if (!refund?.id) throw badRequest('Square refund creation failed');
      return { refundId: String(refund.id), status: String(refund.status ?? 'PENDING') };
    }
    if (payment.status === 'APPROVED') {
      // Authorized but not captured yet. Order-attached payments (our
      // guest flow) are guaranteed-to-complete: Square will not cancel
      // them, and the Refunds API will not touch them until they settle —
      // which takes seconds. Refuse with a clear "try again shortly".
      if (payment.order_id) {
        throw badRequest(
          'this payment is still settling with Square (usually under a minute) — refunds open as soon as it settles; try again shortly',
        );
      }
      // Standalone authorized payments can be VOIDED instead — but only
      // in full; a partial give-back opens once the payment settles.
      const total =
        Number(payment.amount_money?.amount ?? 0) + Number(payment.tip_money?.amount ?? 0);
      if (args.amountCents !== total) {
        throw badRequest(
          'this payment has not settled yet — until it does, only a full void of the whole payment is possible (partial refunds open once it settles)',
        );
      }
      await cancelPayment(args.paymentId, args.token);
      return { refundId: args.paymentId, status: 'CANCELED' };
    }
    throw badRequest(`payment is ${String(payment.status ?? 'unknown')} in Square and cannot be refunded`);
  },

  async getCardConfig(locationRef: string, _card: CardCredentials): Promise<CardPaymentConfig> {
    const appId = config.squareAppId;
    if (!appId) throw new Error('SQUARE_APP_ID is not configured');
    return {
      provider: 'square',
      publishableKey: appId,
      extra: {
        locationId: assertSquareId(locationRef, 'location_id'),
        environment: config.squareEnv,
      },
    };
  },

  async getMenu(_locationRef: string, token?: string): Promise<PosMenuItem[]> {
    // Square catalog: ITEM objects each carry variations (the sellable units).
    // We flatten to one menu entry per variation.
    const items = await searchCatalogItems(token);
    const menu: PosMenuItem[] = [];
    for (const item of items) {
      // M3 fix: skip deleted/archived catalog items.
      if (item?.is_deleted) continue;
      const data = item?.item_data;
      if (!data) continue;
      const category = data?.category_id ? String(data.category_id) : null;
      for (const v of data?.variations ?? []) {
        if (v?.is_deleted) continue;
        const vd = v?.item_variation_data;
        if (!vd) continue;
        const price = vd?.price_money;
        menu.push({
          id: String(v?.id ?? ''),
          name: vd?.name && vd.name !== 'Regular' ? `${data?.name ?? 'Item'} (${vd.name})` : String(data?.name ?? 'Item'),
          description: data?.description ? String(data.description) : null,
          priceCents: price?.amount ?? 0,
          currency: String(price?.currency ?? 'CAD'),
          category,
          imageUrl: null,
        });
      }
    }
    return menu.filter((m) => m.id && m.priceCents > 0);
  },

  async createCheck(args: CreateCheckArgs): Promise<{ checkId: string }> {
    const locationId = assertSquareId(args.locationRef, 'location_id');
    if (!args.items.length) throw new Error('order must have at least one item');
    if (args.items.length > 50) throw new Error('too many items in one order');
    // Resolve the currency from the location's catalog prices via getMenu?
    // Simpler: read it from the first menu item the caller validated. The
    // route layer validates items against getMenu() first, so prices here
    // come from the POS, never the client.
    const menu = await this.getMenu!(args.locationRef, args.token);
    const byId = new Map(menu.map((m) => [m.id, m]));
    const currency = menu[0]?.currency ?? 'CAD';
    const lineItems = args.items.map((i) => {
      const m = byId.get(i.menuItemId);
      if (!m) throw new Error(`unknown menu item: ${String(i.menuItemId).slice(0, 32)}`);
      const qty = Math.floor(i.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new Error('invalid quantity');
      return { catalogObjectId: m.id, quantity: qty };
    });
    const { order } = await createCatalogOrder(
      locationId,
      lineItems,
      currency,
      args.tableLabel,
      args.idempotencyKey,
      args.token,
    );
    return { checkId: String(order?.id ?? '') };
  },

  async registerWebhooks(_locationRef: string, _webhookUrl: string): Promise<void> {
    // Square webhooks are registered in the Square Developer Dashboard
    // (order.updated + payment.updated), not via API — nothing to do here.
    // Keep this as the documented manual step per location.
    return;
  },

  async parseWebhookEvent({ headers, rawBody, body, notificationUrl }): Promise<PosEvent[]> {
    const signature = firstHeader(headers['x-square-hmacsha256-signature']);
    if (config.squareWebhookKey) {
      if (!verifySquareWebhook(rawBody, signature, notificationUrl)) {
        throw new Error('invalid square webhook signature');
      }
    } else if (config.isProd) {
      throw new Error('webhook verification is not configured');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evt: any = body;
    const type: string = evt?.type ?? '';
    const events: PosEvent[] = [];
    if (type === 'order.updated') {
      const order = evt?.data?.object?.order;
      if (order?.id) {
        events.push({
          type: order.state === 'COMPLETED' ? 'check.closed' : 'check.updated',
          checkId: String(order.id),
          eventId: String(evt?.event_id ?? ''),
          rawType: type,
        });
      }
    } else if (type === 'payment.updated') {
      const payment = evt?.data?.object?.payment;
      // Square nests the order id on the payment; fall back to empty and let
      // the caller correlate via our payments table.
      events.push({
        type: 'payment.recorded',
        checkId: String(payment?.order_id ?? ''),
        eventId: String(evt?.event_id ?? ''),
        rawType: type,
      });
    }
    return events;
  },

  getOAuthConnectUrl(state: string): string {
    return squareAuthorizeUrl(state);
  },

  async handleOAuthCallback({ code }: { code: string }): Promise<PosCredentials> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await exchangeOAuthCode(code);
    const merchantToken: string = data.access_token;
    const { merchant } = await getMerchantProfile(merchantToken);
    const { locations } = await listLocations(merchantToken);
    return {
      merchantRef: String(merchant?.id ?? ''),
      accessToken: merchantToken,
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_at ?? null,
      locations: (locations ?? []).map((l: any) => ({
        ref: String(l?.id ?? ''),
        name: String(l?.name ?? ''),
        currency: String(l?.currency ?? 'CAD'),
      })),
    };
  },
};

export { SquareError };
