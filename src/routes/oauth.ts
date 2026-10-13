// Square OAuth: restaurant onboarding. Each restaurant authorizes the Smart
// Table app on THEIR Square account; tokens are encrypted at rest.
// Sandbox authorize URL: https://connect.squareupsandbox.com/oauth2/authorize
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { exchangeOAuthCode, getMerchantProfile, listLocations, squareAuthorizeUrl } from '../square.js';
import { badRequest } from '../http.js';

// Short-lived OAuth state tokens (CSRF protection).
const states = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of states) if (now - v > 10 * 60 * 1000) states.delete(k);
}, 60 * 1000).unref();

export async function oauthRoutes(app: FastifyInstance) {
  app.get('/api/oauth/start', async (_req, reply) => {
    const state = randomUUID();
    states.set(state, Date.now());
    return reply.redirect(squareAuthorizeUrl(state));
  });

  app.get('/api/oauth/callback', async (req) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) throw badRequest('missing authorization code');
    if (!state || !states.has(state)) throw badRequest('invalid or expired oauth state');
    states.delete(state);

    const tok = await exchangeOAuthCode(code);
    const accessToken: string = tok.access_token;
    const refreshToken: string = tok.refresh_token;
    if (!accessToken) throw badRequest('token exchange failed');

    const { merchant } = await getMerchantProfile(accessToken);
    const merchantId: string = tok.merchant_id ?? merchant.id;
    const expiresAt: string | null = tok.expires_at ? new Date(tok.expires_at).toISOString() : null;

    await query(
      `INSERT INTO merchants(id, square_merchant_id, access_token_enc, refresh_token_enc, token_expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (square_merchant_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         token_expires_at = EXCLUDED.token_expires_at`,
      [randomUUID(), merchantId, encryptSecret(accessToken), encryptSecret(refreshToken ?? ''), expiresAt],
    );

    const { locations } = await listLocations(accessToken);
    let n = 0;
    for (const loc of locations ?? []) {
      await query(
        `INSERT INTO locations(id, merchant_id, square_location_id, name, currency)
         VALUES ($1, (SELECT id FROM merchants WHERE square_merchant_id = $2), $3, $4, $5)
         ON CONFLICT (square_location_id) DO UPDATE SET name = EXCLUDED.name`,
        [randomUUID(), merchantId, loc.id, loc.name ?? null, loc.currency ?? 'CAD'],
      );
      n++;
    }
    return {
      ok: true,
      merchant: merchant.business_name ?? merchantId,
      locations_connected: n,
      dashboard: `${config.appUrl}/dashboard`,
    };
  });
}
