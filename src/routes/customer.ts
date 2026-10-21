// Guest-facing API: QR resolve, bill view, payment, waiter call. All public (no staff auth).
//
// v0.3 multi-POS: every POS call resolves the location's adapter from its
// pos_type (see src/services/pos/context.ts). The bill view is normalized;
// Square order ids keep working as the :ref for Square locations.
import { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { getCachedMenu, getCheckPos, getLocationPos } from '../services/pos/context.js';
import { PosCheckDetail } from '../services/pos/types.js';
import { CARD_NONCE_RE, parsePaymentBody, payCheck } from '../services/payments.js';
import { sendReceiptEmail } from '../services/email.js';
import { badRequest, httpError, notFound } from '../http.js';
import { extractBearer, isValidStaffToken } from '../auth.js';
import { getPortalUser } from './portal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function billView(detail: PosCheckDetail, row: any) {
  return {
    id: row.id,
    external_check_ref: row.external_check_ref ?? row.square_order_id,
    pos_type: row.pos_type ?? 'square',
    // Legacy field: still the Square order id for Square locations (portal compat).
    square_order_id: row.square_order_id,
    state: row.state,
    total_cents: detail.totalCents,
    currency: detail.currency,
    remaining_cents: detail.remainingCents,
    items: detail.items.map((i) => ({ name: i.name, quantity: i.quantity, amount_cents: i.amountCents })),
    tenders: detail.tenders.map((t) => ({ amount_cents: t.amountCents, type: t.type })),
  };
}

async function loadCheckRow(ref: string) {
  const c = await query(
    `SELECT * FROM checks WHERE external_check_ref = $1 OR square_order_id = $1`,
    [ref],
  );
  if (c.rowCount === 0) throw notFound('check not found');
  return c.rows[0];
}

export async function customerRoutes(app: FastifyInstance) {
  // Resolve a scanned QR token -> table + live bill of its open check.
  // Also reports whether QR ordering is enabled for this location (the guest
  // page then offers MENU alongside PAY YOUR BILL).
  app.get('/api/t/:token', async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.*, l.currency, l.qr_ordering_enabled, l.loyalty_enabled FROM tables t
       JOIN locations l ON l.id = t.location_id
       WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table — ask staff for help');
    const table = t.rows[0];
    // Review observation fix: return ALL open checks, not just the newest.
    // Each QR order creates its own check; earlier unpaid ones must stay visible.
    const c = await query(
      `SELECT * FROM checks WHERE table_id = $1 AND state = 'OPEN' ORDER BY created_at ASC`,
      [table.id],
    );
    const checks = [];
    for (const row of c.rows) {
      try {
        const ctx = await getCheckPos(row.id);
        const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
        checks.push(billView(detail, row));
      } catch {
        // Skip checks whose POS order vanished; don't break the whole page.
      }
    }
    // Back-compat: `check` is the newest open check (what the client used before).
    const check = checks.length > 0 ? checks[checks.length - 1] : null;
    return {
      table: { id: table.id, name: table.name, state: table.state },
      check,
      checks,
      ordering_enabled: !!table.qr_ordering_enabled,
      loyalty_enabled: !!table.loyalty_enabled,
    };
  });

  // Bill detail for a check that has been linked to a table (arbitrary POS
  // checks are not readable here). :ref is the POS-native check reference.
  // Review fix: guests must present the table's QR token (?table_token=...)
  // so sequential POS refs (e.g. Shopify numeric IDs) can't be enumerated
  // across shops.
  // v0.4.2 fix: the restaurant portal reads check detail with a staff/portal
  // bearer token instead (Live Orders + Check Detail) — the QR-token-only
  // rule broke every open check in the portal ("Unavailable — retry").
  // Portal users are scoped to their own location, same as refunds.
  app.get('/api/checks/:ref', async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const tableToken = String((req.query as { table_token?: unknown }).table_token ?? '');
    const row = await loadCheckRow(ref);
    if (!row.table_id) throw notFound('check not found');
    if (tableToken) {
      const tok = await query(`SELECT id FROM tables WHERE id = $1 AND qr_token = $2`, [row.table_id, tableToken]);
      if (tok.rowCount === 0) throw notFound('check not found');
    } else {
      const bearer = extractBearer(req.headers.authorization);
      let allowed = !!bearer && isValidStaffToken(bearer);
      if (!allowed && bearer) {
        const user = await getPortalUser(bearer);
        if (user) {
          const t = await query<{ location_id: string }>(`SELECT location_id FROM tables WHERE id = $1`, [row.table_id]);
          if (t.rows[0]?.location_id === user.location_id) allowed = true;
          else throw notFound('check not found');
        }
      }
      if (!allowed) throw badRequest('table_token is required');
    }
    const ctx = await getCheckPos(row.id);
    const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
    return { ...billView(detail, row), pos_state: detail.state };
  });

  // Pay by card: full | equal | items | custom. See src/services/payments.ts.
  // card_nonce (provider SDK token: Square cnon:..., Clover clv_..., Helcim
  // cardToken) and idempotency_key (client UUID v4) are REQUIRED. The token
  // format is validated per the check's POS; POS without card support return
  // a clear 400 from payCheck(). There is deliberately no guest-reachable
  // "external / no card" path: cash is recorded by staff through
  // POST /api/checks/:ref/record-external-payment.
  app.post('/api/checks/:ref/pay', async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nonce = body.card_nonce ?? body.card_token;
    if (typeof nonce !== 'string' || !nonce) {
      throw badRequest('card_nonce is required (card token from the payment provider SDK)');
    }
    // Pre-check before we know the POS: must look like SOME provider's token.
    // This keeps 'EXTERNAL', 'CASH' and stored-card ids unreachable.
    const plausible =
      CARD_NONCE_RE.test(nonce) || // square cnon:...
      /^clv_[A-Za-z0-9_-]{1,200}$/i.test(nonce) || // clover
      /^[A-Za-z0-9_-]{20,200}$/.test(nonce); // helcim (long random tokens)
    if (!plausible) throw badRequest('invalid card token');
    // Validate the payment body (idempotency_key, mode, amounts) before
    // touching the DB, so malformed requests get 400 even for unknown checks.
    const p = parsePaymentBody(body);
    // Resolve the POS to validate the token shape precisely (payCheck re-validates).
    let row;
    try {
      row = await loadCheckRow(ref);
    } catch {
      throw badRequest('check is not linked to a table yet — link it first');
    }
    const posType = (await getCheckPos(row.id)).posType;
    const ok =
      posType === 'square' ? CARD_NONCE_RE.test(nonce) :
      posType === 'clover' ? /^clv_[A-Za-z0-9_-]{1,200}$/i.test(nonce) :
      posType === 'helcim' ? /^[A-Za-z0-9_-]{8,200}$/.test(nonce) :
      false;
    if (!ok) throw badRequest('invalid card token for this location');
    // v0.3 wallets: the guest page may declare how the token was produced
    // (Square Web Payments SDK card form, Apple Pay or Google Pay). Wallet
    // tokens are Square cnon: tokens, so they pass the same validation above;
    // the label only tells staff how the guest paid. Wallets are Square-only.
    const method = body.payment_method;
    if (method !== undefined && method !== null) {
      if (method !== 'card' && method !== 'apple_pay' && method !== 'google_pay') {
        throw badRequest('payment_method must be card | apple_pay | google_pay');
      }
      if (method !== 'card' && posType !== 'square') {
        throw badRequest('wallet payments are only available at Square locations');
      }
      if (method !== 'card' && !p.payerLabel) {
        p.payerLabel = method === 'apple_pay' ? 'Apple Pay' : 'Google Pay';
      }
    }
    return payCheck({ checkRef: ref, ...p, source: { kind: 'card', nonce } });
  });

  // Guest calls the waiter from the web app (physical button comes with hardware).
  app.post('/api/tables/:id/call-waiter', async (req) => {
    const tableId = (req.params as { id: string }).id;
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'call_waiter')`, [randomUUID(), tableId]);
    return { ok: true };
  });

  // ---- Review capture (frictionless: tap stars, no login) ---------------------
  // POST /api/t/:token/feedback { rating: 1-5, comment? }
  // 4-5 stars: guest gets the Google review link (frontend shows it).
  // 1-3 stars: private feedback saved for the owner.
  app.post('/api/t/:token/feedback', async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.location_id, l.google_review_url FROM tables t
       JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const body = (req.body ?? {}) as { rating?: unknown; comment?: unknown };
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('rating must be 1-5');
    const comment = typeof body.comment === 'string' ? body.comment.slice(0, 1000) : null;
    // Latest check on this table (for context; nullable).
    const c = await query(
      `SELECT id FROM checks WHERE table_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [t.rows[0].id],
    );
    await query(
      `INSERT INTO feedback(id, location_id, check_id, rating, comment) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), t.rows[0].location_id, c.rows[0]?.id ?? null, rating, comment],
    );
    return {
      ok: true,
      // Frontend: 4-5 stars -> open this URL; otherwise show "thanks".
      google_review_url: rating >= 4 ? t.rows[0].google_review_url : null,
    };
  });

  // ---- Loyalty (frictionless: phone number only, no account) ------------------
  // POST /api/t/:token/loyalty { phone }
  // Counts a visit for the phone hash; returns progress + reward status.
  app.post('/api/t/:token/loyalty', async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.location_id, l.loyalty_enabled, l.loyalty_visits_required, l.loyalty_reward_text
       FROM tables t JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const loc = t.rows[0];
    if (!loc.loyalty_enabled) throw badRequest('loyalty is not enabled here');
    const body = (req.body ?? {}) as { phone?: unknown };
    const digits = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    if (digits.length < 7 || digits.length > 15) throw badRequest('enter a valid phone number');
    const phoneHash = createHash('sha256').update(`loyalty:${loc.location_id}:${digits}`).digest('hex');
    const required = Math.max(2, Math.min(50, Number(loc.loyalty_visits_required) || 5));

    // Upsert visit count.
    const r = await query(
      `INSERT INTO loyalty_visits(id, location_id, phone_hash, visit_count)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (location_id, phone_hash) DO UPDATE SET
         visit_count = loyalty_visits.visit_count + 1,
         last_visit_at = now()
       RETURNING visit_count, rewards_earned`,
      [randomUUID(), loc.location_id, phoneHash],
    );
    let { visit_count: visits, rewards_earned: earned } = r.rows[0];
    let rewardEarned = false;
    if (visits >= required) {
      // Reward unlocked: reset counter, increment earned.
      await query(
        `UPDATE loyalty_visits SET visit_count = 0, rewards_earned = rewards_earned + 1
         WHERE location_id = $1 AND phone_hash = $2`,
        [loc.location_id, phoneHash],
      );
      visits = 0;
      earned += 1;
      rewardEarned = true;
    }
    return {
      ok: true,
      visits,
      visits_required: required,
      visits_remaining: required - visits,
      reward_earned: rewardEarned,
      reward_text: loc.loyalty_reward_text,
      total_rewards: earned,
    };
  });

  // ---- Receipt email (per-payment, guest opts in) -------------------------------
  // POST /api/t/:token/receipt-email { email }
  // Sends the latest payment receipt for this table's check.
  app.post('/api/t/:token/receipt-email', async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.name AS table_name, t.location_id, l.name AS location_name
       FROM tables t JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('valid email is required');
    // Latest completed payment on this table's most recent check.
    const p = await query(
      `SELECT p.amount_cents, p.tip_cents, p.currency, p.created_at, c.total_cents
       FROM payments p JOIN checks c ON c.id = p.check_id
       WHERE c.table_id = $1 AND p.status IN ('AUTHORIZED','COMPLETED')
       ORDER BY p.created_at DESC LIMIT 1`,
      [t.rows[0].id],
    );
    if (p.rowCount === 0) throw badRequest('no completed payment found');
    const pay = p.rows[0];
    // Item breakdown from the check (best effort).
    const c = await query(`SELECT * FROM checks WHERE table_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.rows[0].id]);
    let items: { name: string; quantity: number; amountCents: number }[] = [];
    if (c.rowCount > 0) {
      try {
        const ctx = await getCheckPos(c.rows[0].id);
        const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
        items = detail.items.map((i) => ({ name: i.name, quantity: i.quantity, amountCents: i.amountCents }));
      } catch { /* receipt still sends with totals */ }
    }
    const result = await sendReceiptEmail(email, {
      restaurantName: t.rows[0].location_name || 'Smart Table',
      tableName: t.rows[0].table_name,
      items,
      totalCents: pay.amount_cents + pay.tip_cents,
      currency: pay.currency || 'CAD',
      paidAt: new Date(pay.created_at).toLocaleString(),
    });
    return { ok: true, ...result };
  });

  // ---- QR ordering (optional per-location) ---------------------------------
  // GET  /api/t/:token/menu  -> { enabled, items[] } (from the POS catalog)
  // POST /api/t/:token/order -> { check } creates a POS order from the cart
  //   body: { items: [{ menu_item_id, quantity, note? }], idempotency_key }
  // The order is created in the POS with the table label attached, then
  // linked to this table like a staff-linked check. After ordering, the
  // guest page shows MENU + PAY YOUR BILL.
  async function loadOrderingTable(token: string) {
    const t = await query(
      `SELECT t.*, l.qr_ordering_enabled, l.currency FROM tables t
       JOIN locations l ON l.id = t.location_id
       WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table — ask staff for help');
    const table = t.rows[0];
    if (!table.qr_ordering_enabled) throw badRequest('ordering is not enabled for this location');
    return table;
  }

  app.get('/api/t/:token/menu', async (req) => {
    const { token } = req.params as { token: string };
    const table = await loadOrderingTable(token);
    const ctx = await getLocationPos(table.location_id);
    const items = await getCachedMenu(ctx);
    return { enabled: true, currency: table.currency, items };
  });

  app.post('/api/t/:token/order', async (req) => {
    const { token } = req.params as { token: string };
    const table = await loadOrderingTable(token);
    const body = (req.body ?? {}) as { items?: unknown; idempotency_key?: unknown };
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      throw badRequest('items must be a non-empty array (max 50)');
    }
    // H3 fix: require a real UUIDv4, bound to this table (checked below).
    const key = body.idempotency_key;
    if (
      typeof key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    ) {
      throw badRequest('idempotency_key must be a UUIDv4');
    }
    const normalized = items.map((i) => {
      const o = i as { menu_item_id?: unknown; quantity?: unknown };
      if (typeof o.menu_item_id !== 'string' || !o.menu_item_id) throw badRequest('invalid menu_item_id');
      const qty = Number(o.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw badRequest('invalid quantity');
      // L5 fix: per-item notes were parsed here but never sent to any adapter
      // (and the client never sends them). Dropped instead of silently ignored.
      return { menuItemId: o.menu_item_id, quantity: qty, note: null };
    });
    // H4 fix: cap total units per order (also see M2: adapters must validate first).
    const totalUnits = normalized.reduce((s, i) => s + i.quantity, 0);
    if (totalUnits > 40) throw badRequest('too many items in one order (max 40 units)');

    // H4 fix: only a seated table can order. A photo of the QR code alone
    // isn't enough — staff must have seated the table.
    if (table.state !== 'SEATED') {
      throw badRequest('this table is not seated — ask staff for help');
    }
    // H4 fix: per-table order rate limit (5 orders per 10 minutes).
    const recent = await query(
      `SELECT COUNT(*)::int AS n FROM order_requests
       WHERE table_id = $1 AND created_at > now() - interval '10 minutes'`,
      [table.id],
    );
    if (recent.rows[0].n >= 5) {
      throw httpError(429, 'too many orders for this table, please wait a few minutes');
    }

    const ctx = await getLocationPos(table.location_id);
    if (!ctx.adapter.createCheck) throw badRequest(`ordering is not supported for ${ctx.posType} locations yet`);

    // H3 fix: server-side idempotency. Reserve the key BEFORE touching the POS.
    // The nonce distinguishes "I just created this reservation" from "a
    // concurrent request did" — portable across Postgres and pg-mem (which
    // returns the existing row on CONFLICT DO NOTHING instead of zero rows).
    const myNonce = randomUUID();
    await query(
      `INSERT INTO order_requests(idempotency_key, table_id, location_id, pos_type, status, nonce)
       VALUES ($1,$2,$3,$4,'PENDING',$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, table.id, table.location_id, ctx.posType, myNonce],
    );
    const prev = await query(`SELECT * FROM order_requests WHERE idempotency_key = $1`, [key]);
    const row = prev.rows[0];
    if (!row) throw new Error('idempotency reservation vanished');
    if (row.table_id !== table.id) {
      throw badRequest('idempotency key belongs to another table');
    }
    if (row.status === 'COMPLETED' && row.external_check_ref) {
      // Replay of a finished order: return the original check, don't charge again.
      const detail = await ctx.adapter.getCheckDetail(row.external_check_ref, ctx.token);
      const chk = await query(`SELECT id FROM checks WHERE pos_type = $1 AND external_check_ref = $2`, [
        ctx.posType,
        row.external_check_ref,
      ]);
      return {
        ok: true,
        duplicate: true,
        check: billView(detail, {
          id: chk.rows[0]?.id ?? row.external_check_ref,
          external_check_ref: row.external_check_ref,
          square_order_id: ctx.posType === 'square' ? row.external_check_ref : null,
          pos_type: ctx.posType,
          state: 'OPEN',
        }),
      };
    }
    if (row.status !== 'PENDING') {
      // A previous attempt failed; start fresh with a new key.
      throw badRequest('this order attempt failed — please start a new order');
    }
    if (row.nonce !== myNonce) {
      // Another request holds this key and is still in-flight — don't stack
      // a second POS order on it.
      throw httpError(409, 'this order is already being processed — please wait');
    }
    // We hold the reservation. Proceed to the POS call (Square dedupes by
    // idempotency key as a second layer).

    try {
      const { checkId } = await ctx.adapter.createCheck({
        locationRef: ctx.locationRef,
        items: normalized,
        tableLabel: table.name,
        idempotencyKey: key,
        token: ctx.token,
      });
      // Link the new POS check to this table (same shape as staff link-check).
      const detail = await ctx.adapter.getCheckDetail(checkId, ctx.token);
      const checkDbId = randomUUID();
      // M1 fix: DO NOTHING on conflict — never re-point or re-open a check.
      await query(
        `INSERT INTO checks(id, table_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8)
         ON CONFLICT (pos_type, external_check_ref) DO NOTHING`,
        [
          checkDbId,
          table.id,
          ctx.posType === 'square' ? checkId : null,
          checkId,
          ctx.posType,
          ctx.merchantId,
          detail.totalCents,
          detail.currency,
        ],
      );
      await query(
        `UPDATE order_requests SET status = 'COMPLETED', external_check_ref = $2, completed_at = now()
         WHERE idempotency_key = $1`,
        [key, checkId],
      );
      await query(`UPDATE tables SET state = 'SEATED' WHERE id = $1`, [table.id]);
      return { ok: true, check: billView(detail, { id: checkDbId, external_check_ref: checkId, square_order_id: ctx.posType === 'square' ? checkId : null, pos_type: ctx.posType, state: 'OPEN' }) };
    } catch (e) {
      await query(`UPDATE order_requests SET status = 'FAILED', completed_at = now() WHERE idempotency_key = $1`, [key]);
      throw e;
    }
  });

  // Card payment configuration for the guest browser: tells the payment page
  // which provider SDK to load (Square Web Payments SDK, Clover tokenization,
  // HelcimPay.js). Public endpoint — only publishable keys are returned.
  // :ref is the POS-native check reference.
  app.get('/api/checks/:ref/card-config', async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const row = await loadCheckRow(ref);
    const ctx = await getCheckPos(row.id);
    if (!ctx.adapter.getCardConfig || !ctx.adapter.chargeCard) {
      throw badRequest(`card payments are not supported for ${ctx.posType} locations`);
    }
    return ctx.adapter.getCardConfig(ctx.locationRef, ctx.card, ctx.token);
  });
}

// Re-export for the staff routes that share the loader.
export { loadCheckRow };
