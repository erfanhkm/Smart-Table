// Per-location POS resolution (v0.3).
//
// Every backend path that touches a POS goes through getLocationPos():
// it loads the location's pos_type, resolves the adapter from the
// registry, and decrypts the (merchant_id, pos_type) credential row.
// A Square location therefore ALWAYS gets the Square adapter with the
// Square token; a Clover location can never see Square credentials.
//
// Adapters fall back to app-level demo tokens when no per-merchant
// credential row exists (single-location demo mode).
import { query } from '../../db.js';
import { decryptSecret, encryptSecret } from '../../crypto.js';
import { getAdapter } from './registry.js';
import { assertPosType, CardCredentials, PosAdapter, PosMenuItem, PosType } from './types.js';
import { badRequest, notFound } from '../../http.js';

// M4 fix: in-memory menu cache (45s per location). /menu and createCheck both
// hit the POS catalog; without a cache an attacker can burn the merchant's
// POS API quota (which also serves payments).
const MENU_TTL_MS = 45_000;
const menuCache = new Map<string, { items: PosMenuItem[]; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of menuCache) if (v.expiresAt <= now) menuCache.delete(k);
}, 60_000).unref();

/** Get the location's menu, cached for MENU_TTL_MS. */
export async function getCachedMenu(ctx: PosContext): Promise<PosMenuItem[]> {
  if (!ctx.adapter.getMenu) throw badRequest(`ordering is not supported for ${ctx.posType} locations yet`);
  const key = `${ctx.posType}:${ctx.locationRef}`;
  const hit = menuCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.items;
  const items = await ctx.adapter.getMenu(ctx.locationRef, ctx.token);
  menuCache.set(key, { items, expiresAt: Date.now() + MENU_TTL_MS });
  return items;
}

/** Invalidate the cached menu for a location (call after catalog changes). */
export function invalidateMenuCache(posType: string, locationRef: string): void {
  menuCache.delete(`${posType}:${locationRef}`);
}

export interface PosContext {
  adapter: PosAdapter;
  posType: PosType;
  /** Decrypted per-merchant token, or undefined -> adapter uses its app-level demo token. */
  token: string | undefined;
  /** Card processing credentials (decrypted private token), or empty -> card payments unavailable. */
  card: CardCredentials;
  /** POS-native location/merchant/site reference for this location. */
  locationRef: string;
  merchantId: string;
}

interface LocationRow {
  id: string;
  merchant_id: string;
  pos_type: string;
  pos_location_ref: string | null;
  square_location_id: string | null;
}

/** Resolve the adapter + credentials for a location. Throws 404 for unknown locations. */
export async function getLocationPos(locationId: string): Promise<PosContext> {
  if (typeof locationId !== 'string' || !locationId) throw badRequest('location_id is required');
  const r = await query<LocationRow>(
    `SELECT id, merchant_id, pos_type, pos_location_ref, square_location_id FROM locations WHERE id = $1`,
    [locationId],
  );
  if (r.rowCount === 0) throw notFound('unknown location_id');
  const loc = r.rows[0];
  const posType = assertPosType(loc.pos_type);
  const locationRef = loc.pos_location_ref ?? loc.square_location_id ?? '';
  if (!locationRef) throw badRequest(`location ${locationId} has no POS location reference`);

  let token: string | undefined;
  const card: CardCredentials = {};
  const cred = await query<{ access_token_enc: string; card_public_token: string | null; card_private_token_enc: string | null }>(
    `SELECT access_token_enc, card_public_token, card_private_token_enc FROM pos_credentials WHERE merchant_id = $1 AND pos_type = $2`,
    [loc.merchant_id, posType],
  );
  if (cred.rowCount > 0) {
    if (cred.rows[0].access_token_enc) token = decryptSecret(cred.rows[0].access_token_enc);
    if (cred.rows[0].card_public_token) card.publicToken = cred.rows[0].card_public_token;
    if (cred.rows[0].card_private_token_enc) card.privateToken = decryptSecret(cred.rows[0].card_private_token_enc);
  }
  return { adapter: getAdapter(posType), posType, token, card, locationRef, merchantId: loc.merchant_id };
}

/** Resolve from a check row: the check's location determines the POS. */
export async function getCheckPos(checkId: string): Promise<PosContext & { checkRef: string; checkPosType: string }> {
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
  return { ...ctx, checkRef: row.external_check_ref, checkPosType: row.pos_type };
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
