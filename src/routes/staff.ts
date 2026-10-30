// Staff helpers: locations, live open checks from the location's POS (for
// linking checks), and recording cash / outside-rail payments. All routes are
// staff-only.
//
// v0.3 multi-POS: open checks come from the location's adapter, never from a
// hard-coded POS client.
import { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { getCheckPos, getLocationPos } from '../services/pos/context.js';
import { getTables } from '../services/floor.js';
import { assertSquareId, searchOpenOrders } from '../square.js';
import { parsePaymentBody, payCheck } from '../services/payments.js';
import { assertNotDemoLocation } from '../services/demo-guard.js';
import { logAudit } from '../services/audit.js';
import { requirePortalRole, scopedLocationId, staffOnly } from '../auth.js';

/** C-11: validate a Google review URL by parsing it — the old regex accepted
 * https://google.attacker.com/maps. Hosts: google.<tld>[/maps...], g.page,
 * goo.gl, maps.app.goo.gl only.
 *
 * F6-2: the label heuristic (each TLD label 2–3 letters) also accepted
 * google.xy.com / google.abc.io — domains anyone can register. The suffix
 * after "google." must now be on an exact allow-list of suffixes Google
 * actually operates (single ccTLDs and the known two-part ones). */
const GOOGLE_SUFFIXES = new Set([
  'com', 'ca', 'us', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'be', 'ch', 'at',
  'se', 'no', 'dk', 'fi', 'ie', 'pl', 'gr', 'cz', 'hu',
  'co.uk', 'com.au', 'co.nz', 'com.mx', 'com.br', 'com.ar', 'co.in',
  'com.sg', 'com.hk', 'com.tw', 'co.jp', 'co.kr', 'co.za', 'com.tr',
  'co.th', 'com.my', 'com.ph', 'co.id', 'com.vn', 'com.co', 'cl', 'pe',
]);

export function isValidGoogleReviewUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'g.page' || host === 'goo.gl' || host === 'maps.app.goo.gl' || host === 'share.google') return true;
  const parts = host.split('.');
  const bare = parts[0] === 'www' ? parts.slice(1) : parts;
  // google.<suffix> or maps.google.<suffix>, suffix exactly allow-listed.
  const g = bare[0] === 'maps' ? bare.slice(1) : bare;
  if (g[0] !== 'google' || g.length < 2) return false;
  if (!GOOGLE_SUFFIXES.has(g.slice(1).join('.'))) return false;
  return u.pathname.startsWith('/maps');
}

export async function staffRoutes(app: FastifyInstance) {
  app.get('/api/locations', staffOnly, async (req) => {
    // Portal users only ever see their own location: without this, a second
    // restaurant's owner could operate on the first location in the list.
    const u = req.portalUser;
    if (u) {
      const r = await query(
        `SELECT id, pos_type, pos_location_ref, square_location_id, name, currency, qr_ordering_enabled,
                loyalty_enabled, loyalty_visits_required, loyalty_reward_text, google_review_url
         FROM locations WHERE id = $1`,
        [u.location_id],
      );
      return { locations: r.rows };
    }
    const r = await query(
      `SELECT id, pos_type, pos_location_ref, square_location_id, name, currency, qr_ordering_enabled,
              loyalty_enabled, loyalty_visits_required, loyalty_reward_text, google_review_url
       FROM locations ORDER BY name`,
    );
    return { locations: r.rows };
  });

  // Owner: recent guest feedback (private, 1-3 star reviews land here).
  app.get('/api/feedback', staffOnly, async (req) => {
    const u = req.portalUser;
    const { location_id } = req.query as { location_id?: string };
    let locId = location_id;
    if (u) {
      if (location_id && location_id !== u.location_id) throw notFound('not found');
      locId = u.location_id;
    }
    if (!locId) throw badRequest('location_id is required');
    const r = await query(
      `SELECT rating, comment, created_at FROM feedback
       WHERE location_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [locId],
    );
    return { feedback: r.rows };
  });

  // Service Recovery (idea 1): open alerts for the location — a guest needs
  // help NOW (1-3 star rating or repeated waiter calls). Portal-scoped like
  // /api/feedback. Resolve once a staff member has been to the table.
  app.get('/api/service-alerts', staffOnly, async (req) => {
    const u = req.portalUser;
    const { location_id, status } = req.query as { location_id?: string; status?: string };
    let locId = location_id;
    if (u) {
      if (location_id && location_id !== u.location_id) throw notFound('not found');
      locId = u.location_id;
    }
    if (!locId) throw badRequest('location_id is required');
    const st = status === 'resolved' ? 'resolved' : 'open';
    const r = await query(
      `SELECT a.id, a.kind, a.rating, a.comment, a.status, a.created_at, a.resolved_at,
              a.table_id, t.name AS table_name
       FROM service_alerts a LEFT JOIN tables t ON t.id = a.table_id
       WHERE a.location_id = $1 AND a.status = $2
       ORDER BY a.created_at DESC LIMIT 50`,
      [locId, st],
    );
    return { alerts: r.rows };
  });

  app.post('/api/service-alerts/:id/resolve', staffOnly, async (req) => {
    const u = req.portalUser;
    const id = (req.params as { id: string }).id;
    const r = u
      ? await query(
          `UPDATE service_alerts SET status = 'resolved', resolved_at = now()
           WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING id`,
          [id, u.location_id],
        )
      : await query(
          `UPDATE service_alerts SET status = 'resolved', resolved_at = now()
           WHERE id = $1 AND status = 'open' RETURNING id`,
          [id],
        );
    if (r.rowCount === 0) throw notFound('open alert not found');
    return { ok: true, id: r.rows[0].id };
  });

  // Toggle QR ordering for a location (owner opt-in).
  // Also: loyalty settings + Google review URL (v0.2 review/loyalty).
  app.patch('/api/locations/:id', staffOnly, async (req) => {
    const u = req.portalUser;
    const id = (req.params as { id: string }).id;
    // Portal users can only change their own location.
    if (u && u.location_id !== id) throw notFound('not found');
    // Settings are an owner/manager action (C-10).
    requirePortalRole(req, 'owner', 'manager');
    const body = (req.body ?? {}) as {
      qr_ordering_enabled?: unknown;
      loyalty_enabled?: unknown;
      loyalty_visits_required?: unknown;
      loyalty_reward_text?: unknown;
      google_review_url?: unknown;
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (typeof body.qr_ordering_enabled === 'boolean') {
      sets.push(`qr_ordering_enabled = $${i++}`); vals.push(body.qr_ordering_enabled);
    }
    if (typeof body.loyalty_enabled === 'boolean') {
      sets.push(`loyalty_enabled = $${i++}`); vals.push(body.loyalty_enabled);
    }
    if (body.loyalty_visits_required !== undefined) {
      const n = Number(body.loyalty_visits_required);
      if (!Number.isInteger(n) || n < 2 || n > 50) throw badRequest('loyalty_visits_required must be 2-50');
      sets.push(`loyalty_visits_required = $${i++}`); vals.push(n);
    }
    if (body.loyalty_reward_text !== undefined) {
      if (typeof body.loyalty_reward_text !== 'string' || !body.loyalty_reward_text.trim() || body.loyalty_reward_text.length > 100) {
        throw badRequest('loyalty_reward_text must be 1-100 characters');
      }
      sets.push(`loyalty_reward_text = $${i++}`); vals.push(body.loyalty_reward_text.trim());
    }
    if (body.google_review_url !== undefined) {
      const url = typeof body.google_review_url === 'string' ? body.google_review_url.trim() : '';
      if (url && !isValidGoogleReviewUrl(url)) {
        throw badRequest('google_review_url must be a Google Maps / g.page link');
      }
      // v0.8.12 (F9-3): the review URL is where 4-5 star demo guests are
      // sent — a prospect with a demo login must not be able to point
      // it somewhere malicious. Review-URL changes are refused for
      // demo locations (other settings stay editable).
      await assertNotDemoLocation(id, 'Google review URL changes');
      sets.push(`google_review_url = $${i++}`); vals.push(url || null);
    }
    if (!sets.length) throw badRequest('nothing to update');
    vals.push(id);
    const r = await query(
      `UPDATE locations SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
      vals,
    );
    if (r.rowCount === 0) throw notFound('location not found');
    // F6-6: settings changes are audited (fields only, never values that
    // could carry a URL someone pasted by mistake — the field names suffice).
    await logAudit({
      actorType: u ? 'portal_user' : 'staff_token',
      actorId: u?.id ?? null,
      role: u?.role ?? null,
      ip: req.ip,
      action: 'location_settings_update',
      locationId: id,
      target: id,
      detail: `fields: ${sets.map((s) => s.split(' ')[0]).join(',')}`,
    });
    return { ok: true, id: r.rows[0].id };
  });

  // Generic: live open checks from the location's POS.
  // location_id = OUR location id (as returned by /api/locations).
  // v0.6.5 (C-2): portal users are pinned to their own location.
  app.get('/api/pos-open-checks', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const scopedId = scopedLocationId(req, location_id);
    // F6-12: no catch-all here — getLocationPos already throws a clean 404
    // for an unknown location; flattening EVERY error (decrypt failure, DB
    // outage) into that same 404 hid real breakage behind "unknown id".
    const ctx = await getLocationPos(scopedId);
    const checks = await ctx.adapter.listOpenChecks(ctx.locationRef, ctx.token);
    return {
      pos_type: ctx.posType,
      checks: checks.map((c) => ({
        id: c.id,
        display_label: c.displayLabel,
        total_cents: c.totalCents,
        remaining_cents: c.remainingCents,
        currency: c.currency,
        opened_at: c.openedAt,
      })),
    };
  });

  // I-1/G-5 aggregate: Live Orders in ONE request. The portal used to make
  // one live POS call per open table from the browser every 5s (17+ tables
  // saturated the shared rate bucket and the POS). Here the server fans
  // out with a concurrency cap of 3 and caches the result for 4 seconds
  // per location, so a second portal tab costs nothing. Per-table
  // failures keep the portal's "Unavailable — retry" row shape.
  const openDetailCache = new Map<string, { at: number; orders: unknown[] }>();
  // F6-7: single-flight — while one fan-out for a location is running,
  // concurrent portal polls share it (or get the last cached result flagged
  // stale) instead of each starting another full fan-out against a possibly
  // degraded POS.
  const openDetailInflight = new Map<string, Promise<unknown[]>>();
  async function fetchOpenDetail(scopedId: string): Promise<unknown[]> {
    const tables = (await getTables(scopedId)).filter((t) => t.open_order_id);
    const orders: unknown[] = new Array(tables.length);
    let next = 0;
    async function worker() {
      while (next < tables.length) {
        const idx = next++;
        const t = tables[idx];
        try {
          const row = await query(
            `SELECT id FROM checks WHERE table_id = $1 AND (external_check_ref = $2 OR square_order_id = $2)`,
            [t.id, t.open_order_id],
          );
          if (row.rowCount === 0) throw new Error('check row not found');
          const ctx = await getCheckPos(row.rows[0].id as string);
          const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
          orders[idx] = {
            table_id: t.id,
            table_name: t.name,
            id: t.open_order_id,
            total: detail.totalCents,
            paid: detail.tenders.reduce((s, x) => s + (x.amountCents || 0), 0),
            remaining: detail.remainingCents,
            currency: detail.currency || 'CAD',
            error: false,
          };
        } catch {
          orders[idx] = { table_id: t.id, table_name: t.name, id: t.open_order_id, error: true };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, tables.length) }, worker));
    return orders;
  }
  app.get('/api/portal/open-checks-detail', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const scopedId = scopedLocationId(req, location_id);
    const hit = openDetailCache.get(scopedId);
    if (hit && Date.now() - hit.at < 4_000) return { orders: hit.orders };
    const inflight = openDetailInflight.get(scopedId);
    if (inflight) {
      // A refresh is already running: serve the last known result rather
      // than piling another fan-out onto the POS; only block when there is
      // nothing cached at all yet.
      if (hit) return { orders: hit.orders, stale: true };
      return { orders: await inflight };
    }
    const p = fetchOpenDetail(scopedId);
    openDetailInflight.set(scopedId, p);
    try {
      const orders = await p;
      openDetailCache.set(scopedId, { at: Date.now(), orders });
      return { orders };
    } finally {
      openDetailInflight.delete(scopedId);
    }
  });

  // Legacy (portal compat): Square-shaped open orders; Square locations only.
  app.get('/api/square-open-orders', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const scopedId = scopedLocationId(req, location_id);
    const loc = await query<{ pos_type: string; square_location_id: string; pos_location_ref: string | null }>(
      `SELECT pos_type, square_location_id, pos_location_ref FROM locations WHERE id = $1`,
      [scopedId],
    );
    if (loc.rowCount === 0) throw notFound('unknown location_id');
    if (loc.rows[0].pos_type !== 'square') {
      throw badRequest('this location is not a Square location; use /api/pos-open-checks');
    }
    const ref = loc.rows[0].pos_location_ref ?? loc.rows[0].square_location_id;
    const ctx = await getLocationPos(scopedId);
    const { orders } = await searchOpenOrders(assertSquareId(ref, 'square_location_id'), ctx.token);
    return {
      orders: (orders ?? []).map((o) => ({
        id: o.id,
        total_money: o.total_money,
        state: o.state,
        created_at: o.created_at,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: (o.line_items ?? []).map((li: any) => `${li.quantity}x ${li.name}`).join(', '),
      })),
    };
  });

  // Staff records a payment that happened outside the POS (cash, ...).
  // Same body as the guest endpoint minus card_nonce (idempotency_key is required here too).
  // :ref is the POS-native check reference.
  //
  // v0.6.5 (C-1, Critical): this used to run payCheck against ANY check on
  // the platform by bare ref — any portal user could close another
  // restaurant's bill with a fake cash payment. Now: the check is resolved
  // first, its location (from its table / its own location_id) must be the
  // caller's, portal users need the owner/manager role, payCheck runs
  // against the verified internal check id, and the actor is recorded.
  app.post('/api/checks/:ref/record-external-payment', staffOnly, async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const p = parsePaymentBody(req.body);
    requirePortalRole(req, 'owner', 'manager');
    const u = req.portalUser;
    // F6-12: external refs are unique only per location. A staff-token
    // caller has no home location, so it must name one — otherwise a ref
    // collision across tenants resolved to an arbitrary restaurant's check.
    const bodyLoc = (req.body as { location_id?: unknown } | null)?.location_id;
    if (!u && (typeof bodyLoc !== 'string' || !bodyLoc)) {
      throw badRequest('location_id is required for staff-token callers');
    }
    const rows = await query<{ id: string; location_id: string | null }>(
      `SELECT c.id, COALESCE(c.location_id, t.location_id) AS location_id
       FROM checks c LEFT JOIN tables t ON t.id = c.table_id
       WHERE c.external_check_ref = $1 OR c.square_order_id = $1`,
      [ref],
    );
    const wantLoc = u ? u.location_id : (bodyLoc as string);
    const row = rows.rows.find((r) => r.location_id === wantLoc);
    if (!row) throw notFound('check not found');
    // v0.8.12 (F9-3): recording a cash payment closes a demo check with
    // fake money — refused for demo locations.
    if (row.location_id) await assertNotDemoLocation(row.location_id, 'Recording cash payments');
    const actor = u ? u.id : 'staff-token';
    const result = await payCheck({
      checkRef: ref,
      checkId: row.id,
      ...p,
      source: { kind: 'external', label: 'Smart Table staff' },
      // F6-6: the actor is written inside payCheck's reservation insert —
      // atomic with the payment and immutable on replay.
      recordedBy: actor,
    });
    // Legacy fallback for rows reserved before v0.8.7: set the actor only
    // where it is still empty, never overwrite an existing one.
    await query(`UPDATE payments SET recorded_by = $1 WHERE idempotency_key = $2 AND recorded_by IS NULL`, [
      actor,
      p.idempotencyKey,
    ]).catch(() => undefined);
    await logAudit({
      actorType: u ? 'portal_user' : 'staff_token',
      actorId: u?.id ?? null,
      role: u?.role ?? null,
      ip: req.ip,
      action: 'external_payment_recorded',
      locationId: row.location_id,
      target: row.id,
      detail: `ref=${ref} amount=${p.amountCents ?? 'full'}`,
    });
    return result;
  });
}
