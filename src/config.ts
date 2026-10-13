// Central env config. Required vars throw only when actually needed so that
// `npm run typecheck` etc. work without a full environment.

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: parseInt(opt('PORT', '3000'), 10),
  appUrl: opt('APP_URL', 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: opt('DATABASE_URL'),
  usePgMem: opt('PG_MEM') === '1',
  squareEnv: opt('SQUARE_ENV', 'sandbox'),
  squareAccessToken: opt('SQUARE_ACCESS_TOKEN'),
  squareLocationId: opt('SQUARE_LOCATION_ID'),
  squareAppId: opt('SQUARE_APP_ID'),
  squareAppSecret: opt('SQUARE_APP_SECRET'),
  squareWebhookKey: opt('SQUARE_WEBHOOK_SIGNATURE_KEY'),
  encryptionKeyHex: opt('ENCRYPTION_KEY'),
};

export function requireSquareToken(): string {
  if (!config.squareAccessToken) throw new Error('SQUARE_ACCESS_TOKEN is not set');
  return config.squareAccessToken;
}
