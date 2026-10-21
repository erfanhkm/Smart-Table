// Central env config. Required vars throw only when actually needed so that
// `npm run typecheck` etc. work without a full environment.

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const nodeEnv = opt('NODE_ENV', 'development');

export const config = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  port: parseInt(opt('PORT', '3000'), 10),
  appUrl: opt('APP_URL', 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: opt('DATABASE_URL'),
  usePgMem: opt('PG_MEM') === '1',
  // Behind a reverse proxy (TLS terminator / load balancer): trust X-Forwarded-*.
  // H2 fix: this is a HOP COUNT, not a boolean. trustProxy: true trusts every
  // hop, letting an attacker spoof X-Forwarded-For and get a fresh rate-limit
  // bucket per request. Render adds exactly 1 proxy hop, so the default is 1.
  // Set TRUST_PROXY_HOPS=0 when running with no proxy in front.
  trustProxy: parseInt(opt('TRUST_PROXY_HOPS', '1'), 10),
  squareEnv: opt('SQUARE_ENV', 'sandbox'),
  squareAccessToken: opt('SQUARE_ACCESS_TOKEN'),
  squareLocationId: opt('SQUARE_LOCATION_ID'),
  squareAppId: opt('SQUARE_APP_ID'),
  squareAppSecret: opt('SQUARE_APP_SECRET'),
  squareWebhookKey: opt('SQUARE_WEBHOOK_SIGNATURE_KEY'),
  // ---- v0.3 multi-POS: Clover ----
  cloverEnv: opt('CLOVER_ENV', 'sandbox'),
  cloverAppId: opt('CLOVER_APP_ID'),
  cloverAppSecret: opt('CLOVER_APP_SECRET'),
  /** X-Clover-Auth webhook key shown in the Clover dashboard after URL verification. */
  cloverWebhookKey: opt('CLOVER_WEBHOOK_KEY'),
  // ---- v0.3 multi-POS: Shopify ----
  shopifyApiKey: opt('SHOPIFY_API_KEY'),
  shopifyApiSecret: opt('SHOPIFY_API_SECRET'),
  /** Admin API token for single-location demo mode (dev store custom app). */
  shopifyAdminToken: opt('SHOPIFY_ADMIN_TOKEN'),
  /** Webhook HMAC secret from the Shopify app dashboard. */
  shopifyWebhookSecret: opt('SHOPIFY_WEBHOOK_SECRET'),
  // ---- v0.3 multi-POS: Helcim ----
  /** API token from a Helcim API Access Configuration (single-location demo mode). */
  helcimApiToken: opt('HELCIM_API_TOKEN'),
  encryptionKeyHex: opt('ENCRYPTION_KEY'),
  // Bearer token for every staff-only API (see src/auth.ts). Empty = staff API rejects everything.
  staffApiToken: opt('STAFF_API_TOKEN'),
  // ---- v0.2 founder admin panel ----
  /** Admin panel username (for /admin login). */
  adminUsername: opt('ADMIN_USERNAME'),
  /** scrypt hash of the admin password (see crypto.hashPassword). */
  adminPasswordHash: opt('ADMIN_PASSWORD_HASH'),
  /** Cloudflare API token (Analytics:Read) for website stats in /admin. */
  cloudflareApiToken: opt('CLOUDFLARE_API_TOKEN'),
  /** Cloudflare account ID (for RUM/Web Analytics GraphQL queries). */
  cloudflareAccountId: opt('CLOUDFLARE_ACCOUNT_ID'),
  /** Cloudflare Web Analytics site tag for smarttablepay.com. */
  cloudflareSiteTag: opt('CLOUDFLARE_SITE_TAG'),
  /** Cloudflare zone ID for smarttablepay.com (kept for reference). */
  cloudflareZoneId: opt('CLOUDFLARE_ZONE_ID'),
  // ---- v0.3 wallets (Apple Pay / Google Pay via Square Web Payments SDK) ----
  /**
   * Contents of Apple's domain-association file for THIS domain, served at
   * /.well-known/apple-developer-merchantid-domain-association. Square issues
   * the file per domain in the Square Developer Dashboard (Apple Pay > Web >
   * register domain). Paste its full contents here. Empty = route answers 404
   * and the guest page simply never offers Apple Pay.
   */
  applePayDomainAssociation: opt('APPLE_PAY_DOMAIN_ASSOCIATION'),
  // ---- v0.2 receipts: Resend ----
  /** Resend API key for email receipts. Empty = emails logged & skipped. */
  resendApiKey: opt('RESEND_API_KEY'),
  /** Verified sender, e.g. receipts@smarttablepay.com. */
  receiptFromEmail: opt('RECEIPT_FROM_EMAIL'),
};

export function requireSquareToken(): string {
  if (!config.squareAccessToken) throw new Error('SQUARE_ACCESS_TOKEN is not set');
  return config.squareAccessToken;
}

export type SafetyConfig = Pick<typeof config, 'isProd' | 'usePgMem' | 'squareWebhookKey' | 'staffApiToken'>;

/**
 * Fail-closed startup checks. Throws (=> refuse to boot) when NODE_ENV=production and:
 *  - PG_MEM=1 (in-memory DB, silently drops row locks),
 *  - SQUARE_WEBHOOK_SIGNATURE_KEY is empty (webhooks would be unauthenticated),
 *  - STAFF_API_TOKEN is missing or shorter than 32 chars.
 * In non-production it only warns.
 */
export function assertSafeConfig(c: SafetyConfig = config, warn: (msg: string) => void = console.warn): void {
  const problems: string[] = [];
  if (c.isProd) {
    if (c.usePgMem) problems.push('PG_MEM=1 is not allowed when NODE_ENV=production');
    if (!c.squareWebhookKey) problems.push('SQUARE_WEBHOOK_SIGNATURE_KEY must be set when NODE_ENV=production');
    if (c.staffApiToken.length < 32) {
      problems.push('STAFF_API_TOKEN must be set (>= 32 chars, e.g. `openssl rand -hex 32`) when NODE_ENV=production');
    }
    if (problems.length > 0) throw new Error(`unsafe production configuration: ${problems.join('; ')}`);
    return;
  }
  if (!c.staffApiToken) {
    warn('[smart-table] WARNING: STAFF_API_TOKEN is not set — all staff endpoints will answer 401.');
  }
  if (!c.squareWebhookKey) {
    warn('[smart-table] WARNING: SQUARE_WEBHOOK_SIGNATURE_KEY is empty — webhooks are accepted UNVERIFIED (non-production only).');
  }
}
