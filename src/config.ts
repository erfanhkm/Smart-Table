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
  trustProxy: opt('TRUST_PROXY') === '1',
  squareEnv: opt('SQUARE_ENV', 'sandbox'),
  squareAccessToken: opt('SQUARE_ACCESS_TOKEN'),
  squareLocationId: opt('SQUARE_LOCATION_ID'),
  squareAppId: opt('SQUARE_APP_ID'),
  squareAppSecret: opt('SQUARE_APP_SECRET'),
  squareWebhookKey: opt('SQUARE_WEBHOOK_SIGNATURE_KEY'),
  encryptionKeyHex: opt('ENCRYPTION_KEY'),
  // Bearer token for every staff-only API (see src/auth.ts). Empty = staff API rejects everything.
  staffApiToken: opt('STAFF_API_TOKEN'),
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
