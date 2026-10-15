// Helcim adapter (v0.3).
//
// Model: Helcim invoices act as open checks.
//   invoices (status=DUE)        -> open checks
//   invoice.lineItems            -> items (price is a FLOAT in major units)
//   invoice.amount               -> totalCents
//   update invoice status=PAID   -> record external payment
//   auth                         -> `api-token` request header (per-merchant
//                                   API Access Configuration, created in the
//                                   Helcim dashboard; no OAuth flow)
//
// Docs: https://devdocs.helcim.com/docs (Invoice API reference)
//
// Field mapping (Helcim -> normalized):
//   invoice.invoiceId            -> id
//   invoice.invoiceNumber        -> displayLabel
//   lineItems[].description      -> items[].name
//   lineItems[].quantity         -> items[].quantity
//   lineItems[].total (float)    -> items[].amountCents (line total * 100)
//   invoice.amount (float)       -> totalCents
//   status "DUE"                -> OPEN; "CANCELLED" -> CANCELLED; else CLOSED
//   invoice.currency ("CAD")    -> currency
//   invoice.dateCreated          -> openedAt
//
// UNVERIFIED — developer test account pending (email [email protected]).
// SANDBOX VERIFICATION POINTS (confirm with scripts/verify-helcim.ts):
//   [S1] invoice.status enum values in real data (docs: DUE default;
//        CANCELLED, DUE, PAID, SHIPPED, COMPLETED, REFUNDED, IN_PROGRESS).
//   [S2] lineItems price semantics: `total` is the line total in major
//        units (docs say yes); sku required for items to render.
//   [S3] PUT /v2/invoices/{id} with {status:"PAID"} — does the API accept a
//        direct status change for an externally-paid invoice, or must a
//        Payment API purchase be linked via invoiceNumber?
//   [S4] webhook topic names + signature scheme (dashboard-configured;
//        docs not yet reviewed).
//   [S5] remaining amount on partially-paid DUE invoices (status stays DUE
//        after partial payment; no explicit "remaining" field documented).
import { config } from '../../config.js';
import { badRequest } from '../../http.js';
import {
  CardCredentials,
  CardPaymentConfig,
  ChargeCardArgs,
  PosAdapter,
  PosCheckDetail,
  PosCheckState,
  PosCredentials,
  PosEvent,
  PosEventType,
  PosOpenCheckSummary,
  PosPaymentResult,
} from './types.js';

const API_BASE = 'https://api.helcim.com/v2';
const NUM_ID_RE = /^\d+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

export class HelcimError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(`Helcim API ${status}: ${JSON.stringify(detail).slice(0, 300)}`);
    this.status = status;
    this.detail = detail;
  }
}

// ---- ID safety (same discipline as the other adapters) ----
function assertInvoiceId(id: unknown): string {
  if (typeof id !== 'string' || !NUM_ID_RE.test(id)) throw badRequest('invalid helcim invoice id');
  return id;
}

async function hc<T>(method: string, path: string, body?: unknown, token?: string, idempotencyKey?: string): Promise<T> {
  const t = token ?? config.helcimApiToken;
  if (!t) throw new Error('Helcim token is not set (pass an API token or set HELCIM_API_TOKEN)');
  const headers: Record<string, string> = {
    'api-token': t,
    accept: 'application/json',
    'Content-Type': 'application/json',
  };
  // Payment API requires a 25-char alphanumeric idempotency-key header.
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 25).padEnd(25, '0');
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: AnyObj = await res.json().catch(() => ({}));
  if (!res.ok) throw new HelcimError(res.status, data?.errors ?? data);
  return data as T;
}

/** 50 (float, major units) -> 5000 */
function toCents(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function mapState(status: unknown): PosCheckState {
  const v = String(status ?? '').toUpperCase();
  if (v === 'DUE') return 'OPEN';
  if (v === 'CANCELLED') return 'CANCELLED';
  return 'CLOSED';
}

/** List endpoint returns { invoices: [...] }; single returns { invoice: {...} }. */
function unwrapList(data: AnyObj): AnyObj[] {
  if (Array.isArray(data?.invoices)) return data.invoices;
  if (Array.isArray(data)) return data;
  return [];
}

function mapDetail(inv: AnyObj): PosCheckDetail {
  // [S2] verify `total` semantics in sandbox.
  const items = ((inv?.lineItems ?? []) as AnyObj[]).map((li) => ({
    name: String(li?.description ?? li?.sku ?? 'Item'),
    quantity: Number(li?.quantity ?? 1) || 1,
    amountCents: toCents(li?.total ?? (Number(li?.price ?? 0) * Number(li?.quantity ?? 1))),
  }));
  const totalCents = toCents(inv?.amount);
  return {
    id: String(inv?.invoiceId ?? ''),
    items,
    tenders: [],
    totalCents,
    // [S5] partially-paid invoices keep status DUE with no explicit
    // remaining field; until verified, remaining == total for DUE.
    remainingCents: mapState(inv?.status) === 'OPEN' ? totalCents : 0,
    currency: String(inv?.currency ?? 'CAD'),
    state: mapState(inv?.status),
  };
}

class HelcimAdapter implements PosAdapter {
  readonly posType = 'helcim' as const;

  async listOpenChecks(_locationRef: string, token?: string): Promise<PosOpenCheckSummary[]> {
    // Helcim API tokens are per-merchant; locationRef is accepted for
    // interface conformance but scoping is by token.
    const data: AnyObj = await hc('GET', '/invoices?status=DUE', undefined, token);
    return unwrapList(data).map((inv) => {
      const d = mapDetail(inv);
      return {
        id: d.id,
        displayLabel: String(inv?.invoiceNumber ?? d.id),
        totalCents: d.totalCents,
        remainingCents: d.remainingCents,
        currency: d.currency,
        openedAt: inv?.dateCreated ? new Date(String(inv.dateCreated).replace(' ', 'T')).toISOString() : null,
      };
    });
  }

  async getCheckDetail(checkId: string, token?: string): Promise<PosCheckDetail> {
    const id = assertInvoiceId(checkId);
    const data: AnyObj = await hc('GET', `/invoices/${id}`, undefined, token);
    const inv = data?.invoice ?? data;
    if (!inv?.invoiceId) throw new HelcimError(404, { message: 'invoice not found' });
    return mapDetail(inv);
  }

  /**
   * Card payment via the Helcim Payment API (UNVERIFIED — test account pending).
   *
   * Flow:
   *   1. Guest browser tokenizes the card with HelcimPay.js (hosted modal):
   *      backend initializes via POST /v2/helcim-pay/initialize
   *      {paymentType:'verify'} (see getCardConfig) -> checkoutToken ->
   *      frontend renders the modal -> returns a cardToken. Card data never
   *      touches our servers.
   *   2. Here: POST /v2/payment/purchase {cardData:{cardToken}, amount,
   *      currency, invoiceNumber} with the idempotency-key header — moves the
   *      money and links the transaction to the invoice.
   *
   * Field names follow devdocs.helcim.com; confirm against the test account
   * ([S6]) before enabling for a real merchant.
   */
  async chargeCard(args: ChargeCardArgs): Promise<PosPaymentResult> {
    const invoiceId = assertInvoiceId(args.checkId);
    const apiToken = args.card.privateToken ?? args.token ?? config.helcimApiToken;
    if (!apiToken) {
      throw badRequest('card payments are not configured for this merchant (missing Helcim API token)');
    }
    // Raw invoice for the invoiceNumber (links the purchase to the invoice).
    const raw: AnyObj = await hc('GET', `/invoices/${invoiceId}`, undefined, args.token);
    const inv = raw?.invoice ?? raw;
    const invoiceNumber = String(inv?.invoiceNumber ?? '');
    if (!invoiceNumber) throw new Error('helcim invoice has no invoiceNumber');

    const purchase: AnyObj = await hc(
      'POST',
      '/payment/purchase',
      {
        cardData: { cardToken: args.cardToken },
        // Helcim takes major units (e.g. 24.00); keep two decimals.
        amount: Number((args.amountCents / 100).toFixed(2)),
        currency: args.currency,
        invoiceNumber,
        ecommerce: true,
      },
      apiToken,
      args.idempotencyKey,
    );
    // responseCode "0" == APPROVED (per devdocs + community SDKs).
    if (String(purchase?.responseCode ?? '') !== '0') {
      throw new HelcimError(402, purchase);
    }
    const detail = await this.getCheckDetail(invoiceId, args.token);
    return {
      paymentId: String(purchase?.transactionId ?? `helcim-${invoiceId}`),
      remainingCents: detail.remainingCents,
      currency: detail.currency,
      replayed: false,
    };
  }

  /**
   * Initializes a HelcimPay.js verify (tokenize-only) session. The returned
   * publishableKey is the checkoutToken the frontend passes to HelcimPay.js;
   * the modal returns a cardToken for chargeCard. [S6] unverified.
   */
  async getCardConfig(_locationRef: string, card: CardCredentials, token?: string): Promise<CardPaymentConfig> {
    const apiToken = card.privateToken ?? token ?? config.helcimApiToken;
    if (!apiToken) {
      throw badRequest('card payments are not configured for this merchant (missing Helcim API token)');
    }
    const init: AnyObj = await hc('POST', '/helcim-pay/initialize', { paymentType: 'verify' }, apiToken);
    const checkoutToken = String(init?.checkoutToken ?? '');
    if (!checkoutToken) throw new Error('HelcimPay.js initialize returned no checkoutToken');
    return {
      provider: 'helcim',
      publishableKey: checkoutToken,
      extra: {
        helcimPayJs: 'https://secure.helcim.app/helcim-pay/services/start.js',
      },
    };
  }

  async recordExternalPayment(
    checkId: string,
    amountCents: number,
    currency: string,
    method: string,
    idempotencyKey: string,
    token?: string,
  ): Promise<PosPaymentResult> {
    const id = assertInvoiceId(checkId);
    // [S3] unverified: docs say the system auto-sets PAID when a payment
    // requirement is met; whether a direct status update is accepted for an
    // externally-collected payment must be confirmed in the sandbox.
    // Idempotency: re-read first — if already PAID, replay the result.
    const current = await this.getCheckDetail(id, token);
    if (current.state !== 'OPEN') {
      return { paymentId: `helcim-${id}`, remainingCents: current.remainingCents, currency: current.currency, replayed: true };
    }
    void amountCents;
    void currency;
    void method;
    void idempotencyKey;
    const data: AnyObj = await hc('PUT', `/invoices/${id}`, { status: 'PAID' }, token);
    const inv = data?.invoice ?? {};
    return {
      paymentId: `helcim-${id}`,
      remainingCents: mapState(inv?.status) === 'OPEN' ? toCents(inv?.amount) : 0,
      currency: String(inv?.currency ?? current.currency),
      replayed: false,
    };
  }

  async registerWebhooks(_locationRef: string, _webhookUrl: string, _token?: string): Promise<void> {
    // [S4] Helcim webhooks are configured in the dashboard; topic names and
    // signature scheme not yet reviewed — do not claim webhook support.
    throw new Error('helcim webhooks not configured yet (set up in the Helcim dashboard, then implement parseWebhookEvent)');
  }

  async parseWebhookEvent(_args: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    body: unknown;
    notificationUrl: string;
  }): Promise<PosEvent[]> {
    throw new Error('helcim webhook parsing not implemented yet ([S4] pending)');
  }

  getOAuthConnectUrl(_state: string): string {
    // Helcim has no merchant OAuth flow: each merchant creates an API Access
    // Configuration (API token) manually in their Helcim dashboard. Smart
    // Table onboarding collects that token instead of an OAuth redirect.
    throw new Error('helcim uses manual API-token onboarding (dashboard -> All Tools -> Integrations -> API Access Configurations), not OAuth');
  }

  async handleOAuthCallback(_args: { code: string; merchantRef?: string }): Promise<PosCredentials> {
    throw new Error('helcim uses manual API-token onboarding, not OAuth');
  }
}

export const helcimAdapter: PosAdapter = new HelcimAdapter();

/** Event types this adapter may emit once webhooks are configured. */
export const HELCIM_EVENT_TYPES: PosEventType[] = ['check.updated', 'check.closed', 'payment.recorded'];
