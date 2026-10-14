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
import { staffOnly } from '../auth.js';

// Short-lived OAuth state tokens (CSRF protection), bound to the staff user
// who started the flow so the callback can tie the merchant to them.
const states = new Map<string, { created: number; userId?: string; locationId?: string }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of states) if (now - v.created > 10 * 60 * 1000) states.delete(k);
}, 60 * 1000).unref();

export async function oauthRoutes(app: FastifyInstance) {
  // Starts Square OAuth for the logged-in staff user. Returns the Square
  // authorize URL; the portal navigates there. (A plain redirect cannot carry
  // the bearer header, and a public GET starter could be triggered by anyone.)
  app.post('/api/oauth/start', staffOnly, async (req) => {
    const state = randomUUID();
    const u = req.portalUser;
    states.set(state, { created: Date.now(), userId: u?.id, locationId: u?.location_id });
    return { url: squareAuthorizeUrl(state) };
  });

  app.get('/api/oauth/callback', async (req) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) throw badRequest('missing authorization code');
    const st = state ? states.get(state) : undefined;
    if (!st) throw badRequest('invalid or expired oauth state');
    states.delete(state!);

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
      started_by_location_id: st.locationId ?? null,
    };
  });
}
