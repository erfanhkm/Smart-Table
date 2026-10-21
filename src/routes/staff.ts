// Staff helpers: locations, live open checks from the location's POS (for
// linking checks), and recording cash / outside-rail payments. All routes are
// staff-only.
//
// v0.3 multi-POS: open checks come from the location's adapter, never from a
// hard-coded POS client.
import { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { getLocationPos } from '../services/pos/context.js';
import { assertSquareId, searchOpenOrders } from '../square.js';
import { parsePaymentBody, payCheck } from '../services/payments.js';
import { staffOnly } from '../auth.js';

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
      if (location_id && location_id !== u.location_id) throw badRequest('not your location');
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
      if (location_id && location_id !== u.location_id) throw badRequest('not your location');
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
    if (u && u.location_id !== id) throw badRequest('not your location');
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
      if (url && !/^https:\/\/(www\.)?(google\.[a-z.]+\/maps|g\.page|goo\.gl)\//.test(url)) {
        throw badRequest('google_review_url must be a Google Maps / g.page link');
      }
      sets.push(`google_review_url = $${i++}`); vals.push(url || null);
    }
    if (!sets.length) throw badRequest('nothing to update');
    vals.push(id);
    const r = await query(
      `UPDATE locations SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
      vals,
    );
    if (r.rowCount === 0) throw notFound('location not found');
    return { ok: true, id: r.rows[0].id };
  });

  // Generic: live open checks from the location's POS.
  // location_id = OUR location id (as returned by /api/locations).
  app.get('/api/pos-open-checks', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    if (!location_id) throw badRequest('location_id is required');
    const ctx = await getLocationPos(location_id).catch(() => null);
    if (!ctx) throw notFound('unknown location_id');
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

  // Legacy (portal compat): Square-shaped open orders; Square locations only.
  app.get('/api/square-open-orders', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    if (!location_id) throw badRequest('location_id is required');
    const loc = await query<{ pos_type: string; square_location_id: string; pos_location_ref: string | null }>(
      `SELECT pos_type, square_location_id, pos_location_ref FROM locations WHERE id = $1`,
      [location_id],
    );
    if (loc.rowCount === 0) throw notFound('unknown location_id');
    if (loc.rows[0].pos_type !== 'square') {
      throw badRequest('this location is not a Square location; use /api/pos-open-checks');
    }
    const ref = loc.rows[0].pos_location_ref ?? loc.rows[0].square_location_id;
    const ctx = await getLocationPos(location_id);
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
  app.post('/api/checks/:ref/record-external-payment', staffOnly, async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const p = parsePaymentBody(req.body);
    return payCheck({ checkRef: ref, ...p, source: { kind: 'external', label: 'Smart Table staff' } });
  });
}
