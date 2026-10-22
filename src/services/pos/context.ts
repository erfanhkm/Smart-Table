// Per-location POS resolution (v0.3).
//
// Every backend path that touches a POS goes through getLocationPos():
// it loads the location's pos_type, resolves the adapter from the
// registry, and decrypts the (merchant_id, pos_type) credential row.
// A Square location therefore ALWAYS gets the Square adapter with the
// Square token; a Clover location can never see Square credentials.
//
// v0.6.5 (Claude review C-5/E-5/D-9): NO implicit app-level fallback.
// Adapters throw when they get no token. The single exception is a
// location explicitly flagged locations.demo = true (founder-controlled):
// only then does the platform's app-level credential stand in, and only
// here — never inside an adapter.
import { query } from '../../db.js';
import { config } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../crypto.js';
import { ensureFreshSquareToken } from './token-refresh.js';
import { getMenuCached } from './menu-cache.js';
import { getAdapter } from './registry.js';
import { assertPosType, CardCredentials, PosAdapter, PosMenuItem, PosType } from './types.js';
import { badRequest, notFound } from '../../http.js';

/** App-level credential for an explicitly demo-flagged location. */
function demoTokenFor(posType: PosType): string | undefined {
  switch (posType) {
    case 'square': return config.squareAccessToken || undefined;
    case 'shopify': return config.shopifyAdminToken || undefined;
    case 'helcim': return config.helcimApiToken || undefined;
    default: return undefined; // Clover has no valid app-level merchant token.
  }
}

// M4 fix: the menu cache itself lives in menu-cache.ts (shared with the
// adapters — D-10); these wrappers keep the context-shaped API.
export { invalidateMenuCache } from './menu-cache.js';

/** Get the location's menu, cached for 45s (menu-cache.ts). */
export async function getCachedMenu(ctx: PosContext): Promise<PosMenuItem[]> {
  if (!ctx.adapter.getMenu) throw badRequest(`ordering is not supported for ${ctx.posType} locations yet`);
  const items = await getMenuCached(ctx.adapter, ctx.posType, ctx.locationRef, ctx.token);
  // D-6: the LOCATION's currency is authoritative for display — stamp it
  // over whatever the adapter guessed (Clover items carry no currency).
  if (ctx.currency) return items.map((i) => ({ ...i, currency: ctx.currency as string }));
  return items;
}

export interface PosContext {
  adapter: PosAdapter;
  posType: PosType;
  /** Decrypted per-merchant token (or the app-level demo credential for a
   * demo-flagged location). Undefined = not connected: adapters must throw. */
  token: string | undefined;
  /** Card processing credentials (decrypted private token), or empty -> card payments unavailable. */
  card: CardCredentials;
  /** POS-native location/merchant/site reference for this location. */
  locationRef: string;
  merchantId: string;
  /** The location's own currency (authoritative — D-6). */
  currency: string | null;
  /** True only for the founder-flagged demo location. */
  demo: boolean;
}

interface LocationRow {
  id: string;
  merchant_id: string;
  pos_type: string;
  pos_location_ref: string | null;
  square_location_id: string | null;
  demo: boolean;
  currency: string | null;
}

/** Resolve the adapter + credentials for a location. Throws 404 for unknown locations. */
export async function getLocationPos(locationId: string): Promise<PosContext> {
  if (typeof locationId !== 'string' || !locationId) throw badRequest('location_id is required');
  const r = await query<LocationRow>(
    `SELECT id, merchant_id, pos_type, pos_location_ref, square_location_id, demo, currency FROM locations WHERE id = $1`,
    [locationId],
  );
  if (r.rowCount === 0) throw notFound('unknown location_id');
  const loc = r.rows[0];
  const posType = assertPosType(loc.pos_type);
  const locationRef = loc.pos_location_ref ?? loc.square_location_id ?? '';
  if (!locationRef) throw badRequest(`location ${locationId} has no POS location reference`);

  let token: string | undefined;
  const card: CardCredentials = {};
  const cred = await query<{
    access_token_enc: string;
    refresh_token_enc: string | null;
    token_expires_at: string | null;
    card_public_token: string | null;
    card_private_token_enc: string | null;
  }>(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at, card_public_token, card_private_token_enc FROM pos_credentials WHERE merchant_id = $1 AND pos_type = $2`,
    [loc.merchant_id, posType],
  );
  if (cred.rowCount > 0) {
    if (cred.rows[0].access_token_enc) token = decryptSecret(cred.rows[0].access_token_enc);
    if (cred.rows[0].card_public_token) card.publicToken = cred.rows[0].card_public_token;
    if (cred.rows[0].card_private_token_enc) card.privateToken = decryptSecret(cred.rows[0].card_private_token_enc);
    // D-7: refresh an expired / near-expiry Square token before use —
    // Square access tokens die ~30 days after connect and nothing else
    // renewed them. A failed refresh falls back to the stored token (the
    // POS call then fails visibly rather than silently skipping renewal).
    if (token && posType === 'square') {
      token = await ensureFreshSquareToken({
        merchantId: loc.merchant_id,
        currentToken: token,
        refreshTokenEnc: cred.rows[0].refresh_token_enc,
        expiresAt: cred.rows[0].token_expires_at,
      });
    }
  }
  // Explicit demo mode only (v0.6.5): a founder-flagged demo location runs
  // on the platform's app-level credential. Every other location without its
  // own credential row stays token-less and its adapter calls throw.
  if (!token && loc.demo) token = demoTokenFor(posType);
  return {
    adapter: getAdapter(posType),
    posType,
    token,
    card,
    locationRef,
    merchantId: loc.merchant_id,
    currency: loc.currency,
    demo: !!loc.demo,
  };
}

/** Resolve from a check row: the check's location determines the POS. */
export async function getCheckPos(checkId: string): Promise<PosContext & { checkRef: string; checkPosType: string; locationId: string }> {
  const r = await query<{ location_id: string; external_check_ref: string; pos_type: string }>(
    `SELECT t.location_id, c.external_check_ref, c.pos_type
     FROM checks c JOIN tables t ON t.id = c.table_id
     WHERE c.id = $1`,
    [checkId],
  );
  if (r.rowCount === 0) throw notFound('check not found');
  const row = r.rows[0];
  const ctx = await getLocationPos(row.location_id);
  // Defence in depth: the check's denormalized pos_type must agree with its
  // location's pos_type; a mismatch means data corruption, never silently
  // route to the wrong POS.
  if (row.pos_type !== ctx.posType) {
    throw new Error(`POS mismatch: check is ${row.pos_type} but its location is ${ctx.posType}`);
  }
  return { ...ctx, checkRef: row.external_check_ref, checkPosType: row.pos_type, locationId: row.location_id };
}

/**
 * Store (or replace) a per-merchant POS credential. Enforces single-POS-per-location:
 * refuses when the merchant already has locations on a DIFFERENT pos_type that
 * still have open checks.
 */
export async function storePosCredential(args: {
  merchantId: string;
  posType: PosType;
  externalMerchantRef: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
  /** Card processing credentials (Clover Ecommerce tokens, Helcim API token...). */
  cardPublicToken?: string;
  cardPrivateToken?: string;
}): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const openOther = await query(
    `SELECT l.id FROM locations l
     JOIN tables t ON t.location_id = l.id
     JOIN checks c ON c.table_id = t.id
     WHERE l.merchant_id = $1 AND l.pos_type <> $2 AND c.state = 'OPEN' LIMIT 1`,
    [args.merchantId, args.posType],
  );
  if ((openOther.rowCount ?? 0) > 0) {
    throw badRequest(
      `merchant already has open checks on a different POS; close them before switching to ${args.posType}`,
    );
  }
  await query(
    `INSERT INTO pos_credentials(id, merchant_id, pos_type, external_merchant_ref, access_token_enc, refresh_token_enc, token_expires_at, card_public_token, card_private_token_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (merchant_id, pos_type) DO UPDATE SET
       external_merchant_ref = EXCLUDED.external_merchant_ref,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_expires_at = EXCLUDED.token_expires_at,
       card_public_token = COALESCE(EXCLUDED.card_public_token, pos_credentials.card_public_token),
       card_private_token_enc = COALESCE(EXCLUDED.card_private_token_enc, pos_credentials.card_private_token_enc)`,
    [
      randomUUID(),
      args.merchantId,
      args.posType,
      args.externalMerchantRef,
      encryptSecret(args.accessToken),
      encryptSecret(args.refreshToken ?? ''),
      args.expiresAt ?? null,
      args.cardPublicToken ?? null,
      args.cardPrivateToken ? encryptSecret(args.cardPrivateToken) : null,
    ],
  );
}
