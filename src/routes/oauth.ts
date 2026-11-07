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
import { getAdapter } from '../services/pos/registry.js';
import { badRequest, conflict, notFound } from '../http.js';
import { rateLimit } from '../rate-limit.js';
import { logAudit } from '../services/audit.js';
import { requirePortalRole, requireStaff, staffOnly } from '../auth.js';

// Credential writes are rare and sensitive: cap them hard (E-1).
const manualTokenLimiter = rateLimit({ name: 'manual-token', windowMs: 60 * 60_000, max: 10 });

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

// v0.10.5 (C3-6-7d): a failed token validation used to always read "the POS
// rejected this token" — including when the POS was simply unreachable,
// which sent owners debugging a good token. Distinguish the two shapes:
// an HTTP 401/403 from the POS is a rejection; anything else (no status,
// 5xx, network) is reachability.
function posValidationError(e: unknown): Error {
  const status = (e as { status?: unknown })?.status;
  if (status === 401 || status === 403) {
    return badRequest('the POS rejected this token; check it and try again');
  }
  return badRequest('could not reach the POS to validate this token; try again in a moment');
}

export async function oauthRoutes(app: FastifyInstance) {
  // Starts Square OAuth for the logged-in staff user. Returns the Square
  // authorize URL; the portal navigates there. (A plain redirect cannot carry
  // the bearer header, and a public GET starter could be triggered by anyone.)
  app.post('/api/oauth/start', staffOnly, async (req) => {
    // F6-9: connecting (or re-connecting) the restaurant's POS is an
    // owner/manager action, and one user may hold only a few live states —
    // the map used to grow without bound for any logged-in account.
    requirePortalRole(req, 'owner', 'manager');
    const u = req.portalUser;
    if (u) {
      let live = 0;
      for (const s of states.values()) if (s.userId === u.id) live++;
      if (live >= 5) throw conflict('too many connection attempts in progress; finish or wait for one to expire', 'oauth_state_limit');
    }
    const state = randomUUID();
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

    // E-10: bind the callback to the flow's starting location. The state
    // record carried the starter's locationId but it was never checked —
    // any valid OAuth completion overwrote tokens and re-created location
    // rows regardless of who started it. If the starting location already
    // belongs to a DIFFERENT Square merchant, refuse before storing
    // anything: the authorizing account is not this restaurant's.
    //
    // v0.10.5 (C3-6-1, High): a location bound to a PENDING merchant (the
    // founder-provisioned shape from POST /api/admin/locations) is the one
    // exception — refusing it made every provisioned restaurant unable to
    // connect Square at all. A pending binding is not a different
    // restaurant; it is this restaurant waiting for its first connection,
    // and the callback below binds it to the authorizing merchant.
    let startingLocation: { id: string; merchant_id: string; name: string | null } | null = null;
    let pendingMerchantId: string | null = null;
    if (st.locationId) {
      const existing = await query<{ id: string; merchant_id: string; name: string | null; external_merchant_ref: string | null }>(
        `SELECT l.id, l.merchant_id, l.name, m.external_merchant_ref FROM locations l
         JOIN merchants m ON m.id = l.merchant_id WHERE l.id = $1`,
        [st.locationId],
      );
      const row = existing.rows[0];
      if (row) {
        startingLocation = { id: row.id, merchant_id: row.merchant_id, name: row.name };
        const boundRef = row.external_merchant_ref;
        if (boundRef && boundRef.startsWith('pending-')) {
          pendingMerchantId = row.merchant_id;
        } else if (boundRef && boundRef !== merchantId) {
          throw badRequest(
            'this Square account belongs to a different restaurant than the one that started the connection',
          );
        }
      }
    }

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
    const squareLocations = locations ?? [];

    // v0.10.5 (C3-6-1): a location-started flow binds THAT location to the
    // authorizing merchant instead of creating a fresh location row for
    // every Square location of the merchant (the orphans of C3-6-7a).
    if (startingLocation) {
      if (squareLocations.length === 0) throw badRequest('the authorized Square account has no locations');
      const chosen =
        squareLocations.length === 1
          ? squareLocations[0]
          : (squareLocations.find(
              (l) => l.name && startingLocation!.name && l.name.trim().toLowerCase() === startingLocation!.name.trim().toLowerCase(),
            ) ?? squareLocations[0]);
      // The Square location must not already be connected as a DIFFERENT
      // location row (square_location_id is UNIQUE — a blind UPDATE would
      // 500 on the constraint instead of explaining the state).
      const clash = await query<{ id: string }>(
        `SELECT id FROM locations WHERE square_location_id = $1 AND id <> $2`,
        [chosen.id, startingLocation.id],
      );
      if (clash.rowCount > 0) {
        throw conflict('this Square location is already connected to another restaurant record', 'square_location_bound_elsewhere');
      }
      await query(
        `UPDATE locations SET merchant_id = $1, pos_location_ref = $2, square_location_id = $2, currency = $3
         WHERE id = $4`,
        [ourMerchantId, chosen.id, chosen.currency ?? 'CAD', startingLocation.id],
      );
      // Retire the pending placeholder merchant once nothing references it.
      if (pendingMerchantId && pendingMerchantId !== ourMerchantId) {
        await query(
          `DELETE FROM merchants WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM locations WHERE merchant_id = $1)`,
          [pendingMerchantId],
        ).catch(() => undefined);
      }
      await logAudit({
        actorType: 'portal_user',
        actorId: st.userId ?? null,
        role: null,
        ip: req.ip,
        action: 'pos_connected',
        locationId: startingLocation.id,
        target: ourMerchantId,
        detail: `pos=square square_location=${chosen.id} pending_bound=${pendingMerchantId ? 'yes' : 'no'}`,
      });
      return {
        ok: true,
        merchant: merchant.business_name ?? merchantId,
        locations_connected: 1,
        bound_location_id: startingLocation.id,
        bound_square_location_id: chosen.id,
        bound_square_location_name: chosen.name ?? null,
        square_locations_available: squareLocations.length,
        dashboard: `${config.appUrl}/portal`,
        started_by_location_id: st.locationId ?? null,
      };
    }

    let n = 0;
    for (const loc of squareLocations) {
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
      dashboard: `${config.appUrl}/portal`,
      started_by_location_id: st.locationId ?? null,
    };
  });

  // Manual API-token onboarding for non-OAuth POS (Clover, Shopify, Helcim, ...).
  // The merchant pastes the token they created in their POS dashboard; we
  // encrypt it and bind it to (merchant, pos_type). Staff-only.
  //
  // v0.6.5 (E-1, Critical): the original version upserted a merchant from a
  // CLIENT-SUPPLIED ref and overwrote its stored credential — any portal
  // user could replace any restaurant's POS token (DoS everywhere, stolen
  // payments on account-wide tokens like Helcim's). Portal users now bind
  // a token ONLY to their own location's merchant: owner role, the
  // location's own pos_type and refs, an explicit replace:true to overwrite
  // an existing credential, and the token is validated against the POS
  // before it is stored. The create-merchant+location flow remains for
  // staff-token (founder) callers only. Rate-limited + audit-logged.
  app.post(
    '/api/oauth/manual-token',
    { onRequest: [requireStaff, manualTokenLimiter] },
    async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const posType = assertPosType(b.pos_type);
      if (posType === 'square') throw badRequest('square uses OAuth; use /api/oauth/start');
      const accessToken = b.access_token;
      if (typeof accessToken !== 'string' || accessToken.length < 8 || accessToken.length > 4096) {
        throw badRequest('access_token is required');
      }
      const u = req.portalUser;

      if (u) {
        requirePortalRole(req, 'owner');
        const loc = await query<{
          id: string; merchant_id: string; pos_type: string;
          pos_location_ref: string | null; square_location_id: string | null;
          external_merchant_ref: string;
        }>(
          `SELECT l.id, l.merchant_id, l.pos_type, l.pos_location_ref, l.square_location_id,
                  m.external_merchant_ref
           FROM locations l JOIN merchants m ON m.id = l.merchant_id
           WHERE l.id = $1`,
          [u.location_id],
        );
        if (loc.rowCount === 0) throw notFound('location not found');
        const mine = loc.rows[0];
        if (mine.pos_type !== posType) {
          throw badRequest(`this location is a ${mine.pos_type} location; its POS type cannot be changed here`);
        }
        const myRef = mine.pos_location_ref ?? mine.square_location_id ?? '';
        if (typeof b.location_ref === 'string' && b.location_ref.trim() && b.location_ref.trim() !== myRef) {
          throw badRequest('location_ref does not match your location');
        }
        if (
          typeof b.external_merchant_ref === 'string' &&
          b.external_merchant_ref.trim() &&
          b.external_merchant_ref.trim() !== mine.external_merchant_ref
        ) {
          throw badRequest('external_merchant_ref does not match your location');
        }
        const existingCred = await query(
          `SELECT 1 FROM pos_credentials WHERE merchant_id = $1 AND pos_type = $2`,
          [mine.merchant_id, posType],
        );
        if (existingCred.rowCount > 0 && b.replace !== true) {
          throw conflict(
            'a POS credential is already stored for this location; send replace: true to overwrite it',
            'credential_exists',
          );
        }
        // Validate the token against the POS before storing it: a cheap
        // authenticated read on the location's own refs.
        try {
          await getAdapter(posType).listOpenChecks(myRef, accessToken);
        } catch (e) {
          throw posValidationError(e);
        }
        await storePosCredential({
          merchantId: mine.merchant_id,
          posType,
          externalMerchantRef: mine.external_merchant_ref,
          accessToken,
        });
        // F6-5/F6-6: credential writes land in the durable audit log, not
        // only the console.
        await logAudit({
          actorType: 'portal_user',
          actorId: u.id,
          role: u.role,
          ip: req.ip,
          action: 'pos_credential_stored',
          locationId: mine.id,
          target: mine.merchant_id,
          detail: `pos=${posType} replace=${existingCred.rowCount > 0} via=manual-token`,
        });
        return { ok: true, pos_type: posType, location_id: mine.id };
      }

      // Staff-token (founder) flow: create/find the merchant + location.
      const merchantRef = b.external_merchant_ref;
      const locationRef = b.location_ref;
      const locationName = b.location_name;
      for (const [k, v] of [['external_merchant_ref', merchantRef], ['location_ref', locationRef]] as const) {
        if (typeof v !== 'string' || !v.trim() || v.length > 255) throw badRequest(`${k} is required`);
      }
      if (typeof locationName !== 'string' || !locationName.trim() || locationName.length > 128) {
        throw badRequest('location_name is required (1-128 characters)');
      }
      const currency = typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : 'CAD';
      const merchantRefTrimmed = (merchantRef as string).trim();
      const locationRefTrimmed = (locationRef as string).trim();

      // v0.10.5 (C3-6-7c): the founder branch used to upsert the merchant
      // BEFORE validating, so a bad token left a junk merchant row behind,
      // and it could answer ok:true with the id of a location row that was
      // never inserted (the ref already belonged to another merchant).
      // Validate first, prove the ref is free (or already ours), and only
      // then create rows.
      try {
        await getAdapter(posType).listOpenChecks(locationRefTrimmed, accessToken);
      } catch (e) {
        throw posValidationError(e);
      }
      const priorMerchant = await query<{ id: string }>(
        `SELECT id FROM merchants WHERE pos_type = $1 AND external_merchant_ref = $2`,
        [posType, merchantRefTrimmed],
      );
      const priorMerchantId = priorMerchant.rows[0]?.id ?? null;
      const refOwner = await query<{ merchant_id: string }>(
        `SELECT merchant_id FROM locations WHERE square_location_id = $1`,
        [locationRefTrimmed],
      );
      if (refOwner.rowCount > 0 && refOwner.rows[0].merchant_id !== priorMerchantId) {
        throw conflict('location_ref is already connected to a different merchant', 'location_ref_in_use');
      }

      const ourMerchantId = await upsertMerchant(posType, merchantRefTrimmed);
      // F6-5: the founder branch used to skip BOTH safeguards the portal
      // branch has — no POS validation and no replace guard, so a mistyped
      // (or malicious) token silently overwrote a working credential. Same
      // rules here now: an existing credential needs replace: true, and the
      // token must answer a live read against the location's own ref first
      // (the read now happens before any row is created — see above).
      const existingCred = await query(
        `SELECT 1 FROM pos_credentials WHERE merchant_id = $1 AND pos_type = $2`,
        [ourMerchantId, posType],
      );
      if (existingCred.rowCount > 0 && b.replace !== true) {
        throw conflict(
          'a POS credential is already stored for this merchant; send replace: true to overwrite it',
          'credential_exists',
        );
      }
      await storePosCredential({
        merchantId: ourMerchantId,
        posType,
        externalMerchantRef: merchantRefTrimmed,
        accessToken,
      });

      const locId = randomUUID();
      // locations.square_location_id is NOT NULL (legacy name — for
      // non-Square locations it carries the POS location ref, the same
      // fallback getLocationPos reads). Omitting it made every founder
      // manual-token location insert fail with a 500 (found by F6 tests).
      await query(
        `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency)
         VALUES ($1,$2,$3,$4,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [locId, ourMerchantId, posType, locationRefTrimmed, (locationName as string).trim(), currency],
      );
      // Resolve the canonical row (ours — ownership was proven above).
      const existing = await query<{ id: string }>(
        `SELECT id FROM locations WHERE merchant_id=$1 AND pos_type=$2 AND pos_location_ref=$3`,
        [ourMerchantId, posType, locationRefTrimmed],
      );
      const resolvedLocId = existing.rows[0]?.id ?? locId;
      await logAudit({
        actorType: 'staff_token',
        actorId: null,
        role: null,
        ip: req.ip,
        action: 'pos_credential_stored',
        locationId: resolvedLocId,
        target: ourMerchantId,
        detail: `pos=${posType} replace=${existingCred.rowCount > 0} via=manual-token-founder`,
      });
      return { ok: true, pos_type: posType, location_id: resolvedLocId };
    },
  );

  // POS types the portal can offer for manual onboarding.
  app.get('/api/oauth/pos-types', staffOnly, async () => ({
    pos_types: POS_TYPES.filter((p) => p !== 'square'),
  }));
}
