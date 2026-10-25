// Self-serve onboarding (v0.3): the portal's "Getting started" wizard.
//
// Three steps, all state derived from data we already have (nothing new to
// keep in sync):
//   1. POS connected   — a pos_credentials row exists for the location's
//      (merchant_id, pos_type), or an app-level demo credential is configured
//      for that POS (single-location demo mode, same fallback adapters use).
//   2. Menu verified   — the owner taps "Verify menu": we pull the live menu
//      from the POS catalog through the location's adapter (the same source
//      QR ordering serves to guests) and store when + item count on the
//      location. This is the "menu import" step: the menu is never copied —
//      it is verified against, and always read from, the POS.
//   3. Tables created  — at least one row in tables. quick-tables bulk-creates
//      "Table 1..N" so a floor is set up in one tap instead of N form fills.
//
// Portal users only ever act on their own location (same rule as
// /api/feedback); staff-token callers pass location_id explicitly.
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query, withAdvisoryLock } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { requirePortalRole, staffOnly } from '../auth.js';
import { getLocationPos } from '../services/pos/context.js';
import { PosType } from '../services/pos/types.js';

/** v0.6.5 (C-5): "connected" means a real credential row exists, or the
 * location is explicitly flagged demo (founder-controlled). The mere
 * presence of an app-level env token no longer marks a location connected —
 * that is exactly the state that used to route a production location's
 * payments into the platform's own POS account. */
function demoConfigured(loc: LocationRow): boolean {
  return loc.demo === true;
}

function resolveLocationId(req: FastifyRequest, given?: unknown): string {
  const u = req.portalUser;
  if (u) {
    if (given !== undefined && given !== null && given !== u.location_id) throw notFound('not found');
    return u.location_id;
  }
  if (typeof given !== 'string' || !given) throw badRequest('location_id is required');
  return given;
}

interface LocationRow {
  id: string;
  merchant_id: string;
  pos_type: string;
  pos_location_ref: string | null;
  square_location_id: string | null;
  onboarding_dismissed: boolean;
  menu_verified_at: string | null;
  menu_item_count: number | null;
  demo: boolean;
}

async function loadLocation(locationId: string): Promise<LocationRow> {
  const r = await query<LocationRow>(
    `SELECT id, merchant_id, pos_type, pos_location_ref, square_location_id,
            onboarding_dismissed, menu_verified_at, menu_item_count, demo
     FROM locations WHERE id = $1`,
    [locationId],
  );
  if (r.rowCount === 0) throw notFound('unknown location_id');
  return r.rows[0];
}

async function onboardingState(loc: LocationRow) {
  const cred = await query(
    `SELECT 1 FROM pos_credentials WHERE merchant_id = $1 AND pos_type = $2`,
    [loc.merchant_id, loc.pos_type],
  );
  const locationRef = loc.pos_location_ref ?? loc.square_location_id;
  const posConnected = cred.rowCount > 0 || (!!locationRef && demoConfigured(loc));
  const tables = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tables WHERE location_id = $1`, [loc.id]);
  const tablesCount = parseInt(tables.rows[0]?.n ?? '0', 10);
  const menuVerified = !!loc.menu_verified_at;
  return {
    location_id: loc.id,
    dismissed: !!loc.onboarding_dismissed,
    complete: posConnected && menuVerified && tablesCount > 0,
    steps: {
      pos_connected: { done: posConnected, pos_type: loc.pos_type },
      menu_verified: { done: menuVerified, verified_at: loc.menu_verified_at, item_count: loc.menu_item_count },
      tables_created: { done: tablesCount > 0, count: tablesCount },
    },
  };
}

export async function onboardingRoutes(app: FastifyInstance) {
  // Wizard state for the caller's location.
  app.get('/api/portal/onboarding', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const loc = await loadLocation(resolveLocationId(req, location_id));
    return onboardingState(loc);
  });

  // Step 2: pull the live menu from the POS and record the verification.
  // F6-14: owner/manager only + a 60-second per-location cooldown — every
  // call is a fresh full catalog pull against the merchant's POS quota.
  const lastVerifyAt = new Map<string, number>();
  app.post('/api/portal/onboarding/verify-menu', staffOnly, async (req) => {
    requirePortalRole(req, 'owner', 'manager');
    const body = (req.body ?? {}) as { location_id?: unknown };
    const locationId = resolveLocationId(req, body.location_id);
    const last = lastVerifyAt.get(locationId) ?? 0;
    if (Date.now() - last < 60_000) {
      throw badRequest('the menu was just verified — wait a minute before pulling it again');
    }
    const loc = await loadLocation(locationId);
    const state = await onboardingState(loc);
    if (!state.steps.pos_connected.done) {
      throw badRequest('Connect your POS first — the menu is pulled from your POS catalog.');
    }
    const ctx = await getLocationPos(locationId);
    if (!ctx.adapter.getMenu) {
      throw badRequest(`menu import is not supported for ${ctx.posType} locations yet`);
    }
    // Fresh pull (not the 45s cache): this is an explicit verification.
    const items = await ctx.adapter.getMenu(ctx.locationRef, ctx.token);
    lastVerifyAt.set(locationId, Date.now());
    await query(`UPDATE locations SET menu_verified_at = now(), menu_item_count = $2 WHERE id = $1`, [
      locationId,
      items.length,
    ]);
    return {
      ok: true,
      item_count: items.length,
      preview: items.slice(0, 10).map((m) => ({
        name: m.name,
        price_cents: m.priceCents,
        currency: m.currency,
        category: m.category,
      })),
    };
  });

  // Step 3 (fast path): bulk-create tables "Table 1..N", skipping names that
  // already exist. Mirrors POST /api/tables (same row shape + QR token).
  // F6-4: this path used to skip BOTH the owner/manager role gate and the
  // 200-table cumulative cap that POST /api/tables enforces — any logged-in
  // waiter could grow a location's tables without bound. Both apply here
  // too, under the same per-location advisory lock; the unique
  // (location_id, name) index + ON CONFLICT keep concurrent runs safe.
  app.post('/api/portal/onboarding/quick-tables', staffOnly, async (req) => {
    requirePortalRole(req, 'owner', 'manager');
    const body = (req.body ?? {}) as { location_id?: unknown; count?: unknown };
    const locationId = resolveLocationId(req, body.location_id);
    await loadLocation(locationId); // 404 for unknown locations
    const count = body.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) {
      throw badRequest('count must be an integer between 1 and 50');
    }
    const created = await withAdvisoryLock(
      `tables:${locationId}`,
      async () => {
        const existing = await query<{ name: string }>(`SELECT name FROM tables WHERE location_id = $1`, [locationId]);
        if (existing.rowCount >= 200) throw badRequest('table limit reached for this location (200)');
        const room = 200 - existing.rowCount;
        const names = new Set(existing.rows.map((r) => r.name));
        const made: Array<{ id: string; name: string; qr_url: string }> = [];
        for (let i = 1; made.length < Math.min(count, room) && i <= count + names.size + 50; i++) {
          const name = `Table ${i}`;
          if (names.has(name)) continue;
          const id = randomUUID();
          const qrToken = randomUUID().replace(/-/g, '');
          const ins = await query<{ id: string }>(
            `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')
             ON CONFLICT (location_id, name) DO NOTHING RETURNING id`,
            [id, locationId, name, qrToken],
          );
          // Created only when the returned row is OURS — pg-mem hands back
          // the pre-existing row on a DO NOTHING conflict.
          if (ins.rows[0]?.id !== id) continue; // lost a race for this name
          names.add(name);
          made.push({ id, name, qr_url: `${config.appUrl}/t/${qrToken}` });
        }
        return made;
      },
      { runIfUnsupported: true },
    );
    return { created: created ?? [] };
  });

  // Owner closed the wizard (complete or not) — don't nag them again.
  app.post('/api/portal/onboarding/dismiss', staffOnly, async (req) => {
    const body = (req.body ?? {}) as { location_id?: unknown };
    const locationId = resolveLocationId(req, body.location_id);
    await query(`UPDATE locations SET onboarding_dismissed = true WHERE id = $1`, [locationId]);
    return { ok: true };
  });
}
