// Multi-POS adapter layer (v0.3).
//
// Smart Table talks to many POS systems (Square, Clover, Toast, Lightspeed,
// TouchBistro, Shopify, Helcim) through ONE normalized interface: PosAdapter.
// Every adapter maps its POS-native order/check model onto the normalized
// types below, so the portal, floor service and payment flows never touch
// POS-specific shapes directly.
//
// Money is always integer minor units (cents). IDs are opaque strings;
// each adapter validates/encodes them before interpolating into URLs.
export type PosType = 'square' | 'lightspeed' | 'toast' | 'touchbistro' | 'clover' | 'shopify' | 'helcim';

export const POS_TYPES: PosType[] = ['square', 'lightspeed', 'toast', 'touchbistro', 'clover', 'shopify', 'helcim'];

export function assertPosType(v: unknown): PosType {
  if (typeof v === 'string' && (POS_TYPES as string[]).includes(v)) return v as PosType;
  throw new Error(`unsupported pos_type: ${String(v).slice(0, 32)}`);
}

/** Normalized line item on a check. */
export interface PosLineItem {
  name: string;
  quantity: number;
  /** Line total in minor units (incl. tax as reported by the POS). */
  amountCents: number;
}

/** Normalized tender/payment already applied to the check. */
export interface PosTender {
  /** POS-native payment id (opaque). */
  id: string;
  type: string;
  amountCents: number;
}

export type PosCheckState = 'OPEN' | 'CLOSED' | 'CANCELLED';

/** Full normalized check detail — what the portal renders. */
export interface PosCheckDetail {
  /** POS-native check/order id (opaque). */
  id: string;
  items: PosLineItem[];
  tenders: PosTender[];
  totalCents: number;
  remainingCents: number;
  currency: string;
  state: PosCheckState;
}

/** Lightweight summary for the "link a check" picker and Live Orders. */
export interface PosOpenCheckSummary {
  id: string;
  /** Human label, e.g. "Table 10" or "Order #A127". */
  displayLabel: string;
  totalCents: number;
  remainingCents: number;
  currency: string;
  /** ISO timestamp when the check was opened, if the POS reports it. */
  openedAt: string | null;
}

export interface PosPaymentResult {
  /** POS-native payment id. */
  paymentId: string;
  remainingCents: number;
  currency: string;
  /** True when the idempotency key replayed an already-recorded payment. */
  replayed: boolean;
}

/** Internal domain events produced from POS webhooks. */
export type PosEventType = 'check.updated' | 'check.closed' | 'payment.recorded';

export interface PosEvent {
  type: PosEventType;
  /** POS-native check/order id the event refers to. */
  checkId: string;
  /** POS-native webhook event id, for idempotent processing. */
  eventId: string;
  /** Raw event type from the POS, for debugging. */
  rawType: string;
}

/** Per-merchant credentials returned by the OAuth callback. Store encrypted. */
export interface PosCredentials {
  /** POS-native merchant/account id. */
  merchantRef: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  /** POS-native location/site id + display name pairs. */
  locations: Array<{ ref: string; name: string; currency: string }>;
}

/** Card payment configuration for the guest browser: which provider SDK to load. */
export interface CardPaymentConfig {
  /** Card processor for this location's POS. */
  provider: 'square' | 'clover' | 'helcim';
  /** Publishable key for the provider's browser SDK (Square app id, Clover Ecommerce public token, Helcim.js configuration token). */
  publishableKey: string;
  /** Provider-specific extras (e.g. Clover merchant id for the iframe, Helcim environment). */
  extra?: Record<string, string>;
}

export interface ChargeCardArgs {
  /** Adapter-native check id. */
  checkId: string;
  amountCents: number;
  currency: string;
  /** Single-use card token from the provider's browser SDK. */
  cardToken: string;
  tipCents: number;
  idempotencyKey: string;
  /**
   * POS-native ids of previously authorized (not yet closed) payments for this
   * check, oldest first — for POS that close explicitly (Square PayOrder).
   * Callers read these from our payments table.
   */
  priorPaymentIds: string[];
  /** Card processing credentials (Ecommerce private token, Helcim API token...). */
  card: CardCredentials;
  token?: string;
}

/** A menu item from the POS catalog, for QR ordering. */
export interface PosMenuItem {
  /** POS-native catalog/variation id (opaque) — passed back to createCheck. */
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  category: string | null;
  imageUrl: string | null;
}

export interface CreateCheckItem {
  /** PosMenuItem.id from getMenu. */
  menuItemId: string;
  quantity: number;
  note: string | null;
}

export interface CreateCheckArgs {
  locationRef: string;
  items: CreateCheckItem[];
  /** Human table label, e.g. "T1" — attached to the POS order so staff see it. */
  tableLabel: string;
  idempotencyKey: string;
  token?: string;
}

/** Card processing credentials, resolved per merchant+POS from pos_credentials. */
export interface CardCredentials {
  /** Publishable token for the browser SDK (safe for guests). */
  publicToken?: string;
  /** Private token for server-side charging (never leaves the server). */
  privateToken?: string;
}

/**
 * Contract every POS adapter implements.
 *
 * Conventions:
 * - `locationRef` is the POS-native location/merchant/site id (for Square:
 *   the Square location id). Adapters validate it before use.
 * - `token` is a per-merchant OAuth access token; when omitted the adapter
 *   falls back to the app-level configured token (single-location demo mode).
 * - recordExternalPayment records money that moved OUTSIDE the POS
 *   (cash, e-transfer): it must be idempotent on `idempotencyKey`.
 * - chargeCard / getCardConfig are optional: only POS with a guest card
 *   flow implement them. payCheck() returns a clear 400 for card payments
 *   on POS without chargeCard.
 */
export interface PosAdapter {
  readonly posType: PosType;

  listOpenChecks(locationRef: string, token?: string): Promise<PosOpenCheckSummary[]>;
  getCheckDetail(checkId: string, token?: string): Promise<PosCheckDetail>;
  recordExternalPayment(
    checkId: string,
    amountCents: number,
    currency: string,
    method: string,
    idempotencyKey: string,
    token?: string,
  ): Promise<PosPaymentResult>;
  /**
   * Charge a single-use card token from the provider's browser SDK.
   * Records the payment on the POS check/invoice and returns the remaining
   * balance. Optional: locations on a POS without this get a clear 400 for
   * card payments.
   */
  chargeCard?(args: ChargeCardArgs): Promise<PosPaymentResult>;
  /**
   * Publishable card config for the guest browser SDK. Implement alongside
   * chargeCard. `card.publicToken` carries the merchant's publishable card
   * credential (Clover Ecommerce public token, Helcim.js config token).
   */
  getCardConfig?(locationRef: string, card: CardCredentials, token?: string): Promise<CardPaymentConfig>;

  /**
   * Menu for QR ordering (optional). Returns the location's sellable items
   * from the POS catalog.
   */
  getMenu?(locationRef: string, token?: string): Promise<PosMenuItem[]>;
  /**
   * Create a POS check/order from a guest cart (QR ordering). The adapter
   * attaches the table label so staff see it in the POS. Returns the
   * POS-native check id (same shape as listOpenChecks ids).
   */
  createCheck?(args: CreateCheckArgs): Promise<{ checkId: string }>;

  /** Register this app's webhook endpoint with the POS (per location). */
  registerWebhooks(locationRef: string, webhookUrl: string, token?: string): Promise<void>;
  /**
   * Verify the webhook signature (per POS scheme) and map the payload to
   * internal events. `rawBody` is the exact request bytes the POS signed;
   * `notificationUrl` is the public URL the POS signed (for schemes like
   * Square's that bind the signature to the URL). Throws on invalid
   * signature — callers turn that into 401.
   */
  parseWebhookEvent(args: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    body: unknown;
    notificationUrl: string;
  }): Promise<PosEvent[]>;

  /** OAuth connect flow for per-merchant onboarding. */
  getOAuthConnectUrl(state: string): string;
  /**
   * Exchange the callback code for credentials. Some POS (Clover) pass the
   * merchant/account ref as a separate callback query param — the route
   * forwards it via merchantRef when present.
   */
  handleOAuthCallback(args: { code: string; merchantRef?: string }): Promise<PosCredentials>;
}
