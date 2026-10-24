// Central env config. Required vars throw only when actually needed so that
// `npm run typecheck` etc. work without a full environment.

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const nodeEnv = opt('NODE_ENV', 'development');

export const config = {
  nodeEnv,
  // Fail-closed (v0.6.4): anything that is not explicitly development or test
  // counts as production. A missing/typo'd NODE_ENV previously disabled every
  // production guard (webhook verification, db-driver checks, seed refusal).
  isProd: nodeEnv !== 'development' && nodeEnv !== 'test',
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
  /** v0.8.4: where owner-demo access requests are emailed. */
  demoAccessNotifyEmail: opt('DEMO_ACCESS_NOTIFY_EMAIL', 'erfanbillion@gmail.com'),
  /** True when running on Render (the platform sets RENDER=true). */
  isRender: !!process.env.RENDER,
};

export function requireSquareToken(): string {
  if (!config.squareAccessToken) throw new Error('SQUARE_ACCESS_TOKEN is not set');
  return config.squareAccessToken;
}

export type SafetyConfig = Pick<
  typeof config,
  | 'isProd'
  | 'nodeEnv'
  | 'usePgMem'
  | 'squareWebhookKey'
  | 'staffApiToken'
  | 'encryptionKeyHex'
  | 'adminPasswordHash'
  | 'appUrl'
  | 'squareEnv'
  | 'helcimApiToken'
  | 'shopifyAdminToken'
  | 'port'
  | 'trustProxy'
  | 'isRender'
>;

/**
 * Fail-closed startup checks. Throws (=> refuse to boot) when NODE_ENV=production and:
 *  - PG_MEM=1 (in-memory DB, silently drops row locks),
 *  - SQUARE_WEBHOOK_SIGNATURE_KEY is empty (webhooks would be unauthenticated),
 *  - STAFF_API_TOKEN is missing or shorter than 32 chars,
 *  - ENCRYPTION_KEY is not exactly 64 hex chars (stored POS credentials
 *    would be undecryptable — or, worse, decryptable by a guessed key),
 *  - ADMIN_PASSWORD_HASH is set but not in the scrypt$<salt>$<hash> shape
 *    hashPassword produces (a malformed value locks the founder out),
 *  - APP_URL is not https or points at localhost (the Square webhook URL
 *    is pinned to it; a wrong value silently breaks signature checks),
 *  - SQUARE_ENV is not 'sandbox' or 'production',
 *  - RENDER is set while NODE_ENV says development/test (a mislabelled
 *    deploy would run with every production guard off),
 *  - PORT / TRUST_PROXY_HOPS did not parse to sane numbers (NaN port =
 *    random port; NaN proxy hops = spoofable rate-limit keys).
 * G-4 (Claude cycle-1 backlog). Two items are WARNING-only even in
 * production, deliberately: app-level Helcim/Shopify demo tokens may be
 * legitimately present while a location is explicitly flagged demo
 * (v0.6.5 demo flag), so refusing to boot would kill the live demo; and a
 * missing ADMIN_PASSWORD_HASH only disables the founder panel.
 * In non-production the same problems only warn.
 */
export function assertSafeConfig(c: SafetyConfig = config, warn: (msg: string) => void = console.warn): void {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
    problems.push('PORT must be an integer between 1 and 65535');
  }
  if (!Number.isInteger(c.trustProxy) || c.trustProxy < 0 || c.trustProxy > 10) {
    problems.push('TRUST_PROXY_HOPS must be an integer between 0 and 10');
  }
  if (c.isProd) {
    if (c.usePgMem) problems.push('PG_MEM=1 is not allowed when NODE_ENV=production');
    if (!c.squareWebhookKey) problems.push('SQUARE_WEBHOOK_SIGNATURE_KEY must be set when NODE_ENV=production');
    if (c.staffApiToken.length < 32) {
      problems.push('STAFF_API_TOKEN must be set (>= 32 chars, e.g. `openssl rand -hex 32`) when NODE_ENV=production');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(c.encryptionKeyHex)) {
      problems.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes) when NODE_ENV=production');
    }
    if (c.adminPasswordHash && !/^scrypt\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{128}$/.test(c.adminPasswordHash)) {
      problems.push('ADMIN_PASSWORD_HASH is set but malformed (expected scrypt$<32 hex salt>$<128 hex hash>)');
    }
    if (!c.adminPasswordHash) {
      warnings.push('ADMIN_PASSWORD_HASH is not set — the founder admin panel will reject every login.');
    }
    if (!c.appUrl.startsWith('https://') || /localhost|127\.0\.0\.1/.test(c.appUrl)) {
      problems.push('APP_URL must be an https URL (not localhost) when NODE_ENV=production');
    }
    if (c.squareEnv !== 'sandbox' && c.squareEnv !== 'production') {
      problems.push("SQUARE_ENV must be 'sandbox' or 'production'");
    }
    if (c.helcimApiToken || c.shopifyAdminToken) {
      warnings.push(
        'app-level Helcim/Shopify demo tokens are set in production — only locations explicitly flagged demo may use them (v0.6.5).',
      );
    }
  }
  if (c.isRender && (c.nodeEnv === 'development' || c.nodeEnv === 'test')) {
    problems.push(`RENDER is set but NODE_ENV=${c.nodeEnv} — refusing to run a Render deploy in non-production mode`);
  }
  if (problems.length > 0) {
    if (c.isProd || c.isRender) throw new Error(`unsafe production configuration: ${problems.join('; ')}`);
    for (const p of problems) warn(`[smart-table] WARNING: ${p}`);
  }
  for (const w of warnings) warn(`[smart-table] WARNING: ${w}`);
  if (!c.isProd) {
    if (!c.staffApiToken) {
      warn('[smart-table] WARNING: STAFF_API_TOKEN is not set — all staff endpoints will answer 401.');
    }
    if (!c.squareWebhookKey) {
      warn('[smart-table] WARNING: SQUARE_WEBHOOK_SIGNATURE_KEY is empty — webhooks are accepted UNVERIFIED (non-production only).');
    }
  }
}
