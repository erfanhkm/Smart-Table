// POS onboarding: Square OAuth + manual API-token onboarding for other POS.
//
// Square: restaurant onboarding via OAuth. Each restaurant authorizes the Smart
// Table app on THEIR Square account; tokens are encrypted at rest.
// Sandbox authorize URL: https://connect.squareupsandbox.com/oauth2/authorize
//
// Other POS (Clover, Shopify, Helcim, ...): merchants create an API token in
// their POS dashboard and paste it here (staff-only). The token is encrypted
// at rest in pos_credentials; the location's pos_type then routes every
// backend call to the right adapter. Single-POS-per-location is enforced:
// a merchant with open checks on another POS cannot add a new one.
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { exchangeOAuthCode, getMerchantProfile, listLocations, squareAuthorizeUrl } from '../square.js';
import { assertPosType, POS_TYPES, PosType } from '../services/pos/types.js';
import { storePosCredential } from '../services/pos/context.js';
import { badRequest } from '../http.js';
import { staffOnly } from '../auth.js';

// Short-lived OAuth state tokens (CSRF protection), bound to the staff user
// who started the flow so the callback can tie the merchant to them.
const states = new Map<string, { created: number; userId?: string; locationId?: string }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of states) if (now - v.created > 10 * 60 * 1000) states.delete(k);
}, 60 * 1000).unref();

async function upsertMerchant(posType: PosType, externalRef: string): Promise<string> {
  const id = randomUUID();
  const r = await query<{ id: string }>(
    `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc)
     VALUES ($1,$2,$3,$4,'','')
     ON CONFLICT (pos_type, external_merchant_ref) DO UPDATE SET pos_type = EXCLUDED.pos_type
     RETURNING id`,
    [id, posType, externalRef, posType === 'square' ? externalRef : null],
  );
  return r.rows[0].id;
}

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

    const ourMerchantId = await upsertMerchant('square', merchantId);
    await query(
      `UPDATE merchants SET access_token_enc=$1, refresh_token_enc=$2, token_expires_at=$3,
        square_merchant_id=$4, external_merchant_ref=$4
       WHERE id=$5`,
      [encryptSecret(accessToken), encryptSecret(refreshToken ?? ''), expiresAt, merchantId, ourMerchantId],
    );
    await storePosCredential({
      merchantId: ourMerchantId,
      posType: 'square',
      externalMerchantRef: merchantId,
      accessToken,
      refreshToken: refreshToken ?? undefined,
      expiresAt,
    });

    const { locations } = await listLocations(accessToken);
    let n = 0;
    for (const loc of locations ?? []) {
      await query(
        `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
         VALUES ($1,$2,'square',$3,$3,$4,$5)
         ON CONFLICT (square_location_id) DO UPDATE SET
           name = EXCLUDED.name, pos_type = 'square', pos_location_ref = EXCLUDED.pos_location_ref`,
        [randomUUID(), ourMerchantId, loc.id, loc.name ?? null, loc.currency ?? 'CAD'],
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

  // Manual API-token onboarding for non-OAuth POS (Clover, Shopify, Helcim, ...).
  // The merchant pastes the token they created in their POS dashboard; we
  // encrypt it and bind it to (merchant, pos_type). Staff-only.
  app.post('/api/oauth/manual-token', staffOnly, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const posType = assertPosType(b.pos_type);
    if (posType === 'square') throw badRequest('square uses OAuth; use /api/oauth/start');
    const accessToken = b.access_token;
    const merchantRef = b.external_merchant_ref;
    const locationRef = b.location_ref;
    const locationName = b.location_name;
    if (typeof accessToken !== 'string' || accessToken.length < 8 || accessToken.length > 4096) {
      throw badRequest('access_token is required');
    }
    for (const [k, v] of [['external_merchant_ref', merchantRef], ['location_ref', locationRef]] as const) {
      if (typeof v !== 'string' || !v.trim() || v.length > 255) throw badRequest(`${k} is required`);
    }
    if (typeof locationName !== 'string' || !locationName.trim() || locationName.length > 128) {
      throw badRequest('location_name is required (1-128 characters)');
    }
    const currency = typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : 'CAD';

    const ourMerchantId = await upsertMerchant(posType, (merchantRef as string).trim());
    await storePosCredential({
      merchantId: ourMerchantId,
      posType,
      externalMerchantRef: (merchantRef as string).trim(),
      accessToken,
    });

    const locId = randomUUID();
    await query(
      `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, name, currency)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [locId, ourMerchantId, posType, (locationRef as string).trim(), (locationName as string).trim(), currency],
    );
    // If the location ref already exists (no unique constraint hit info from
    // DO NOTHING), fetch the canonical id.
    const existing = await query<{ id: string }>(
      `SELECT id FROM locations WHERE merchant_id=$1 AND pos_type=$2 AND pos_location_ref=$3`,
      [ourMerchantId, posType, (locationRef as string).trim()],
    );
    return { ok: true, pos_type: posType, location_id: existing.rows[0]?.id ?? locId };
  });

  // POS types the portal can offer for manual onboarding.
  app.get('/api/oauth/pos-types', staffOnly, async () => ({
    pos_types: POS_TYPES.filter((p) => p !== 'square'),
  }));
}
