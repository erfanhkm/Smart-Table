// Guest-facing API: QR resolve, bill view, payment. All public (no staff auth).
//
// v0.3 multi-POS: every POS call resolves the location's adapter from its
// pos_type (see src/services/pos/context.ts). The bill view is normalized;
// Square order ids keep working as the :ref for Square locations.
import { FastifyInstance } from 'fastify';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { query, withTx } from '../db.js';
import { config } from '../config.js';
import { rateLimit } from '../rate-limit.js';
import { getCachedMenu, getCheckPos, getLocationPos } from '../services/pos/context.js';
import { PosCheckDetail } from '../services/pos/types.js';
import { CARD_NONCE_RE, parsePaymentBody, payCheck } from '../services/payments.js';
import { sendReceiptEmail } from '../services/email.js';
import { buildReceiptLines, sanitizePrintLines } from '../services/receiptLines.js';
import { countActivePrintJobs, MAX_ACTIVE_PRINT_JOBS } from './device.js';
import { raiseServiceAlert } from '../services/alerts.js';
import { badRequest, conflict, httpError, notFound } from '../http.js';
import { claimItem, listClaims, listDeviceClaimIndexes, releaseAllClaims, releaseClaimIndexes, unclaimItem } from '../services/grouppay.js';
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

// v0.8.5 (F4-5): check refs are unique per (location_id, pos_type) only —
// the same ref can exist at several locations. Callers that already know
// the tenant MUST scope the lookup, or rows[0] can be another location's
// check (which then fails the table match and locks out the real guest).
async function loadCheckRow(ref: string, scope?: { tableId?: string; locationId?: string }) {
  const conds = ['(c.external_check_ref = $1 OR c.square_order_id = $1)'];
  const params: unknown[] = [ref];
  if (scope?.tableId) { params.push(scope.tableId); conds.push(`c.table_id = $${params.length}`); }
  if (scope?.locationId) {
    // Match on the check's own location_id, or via its table for legacy
    // rows whose checks.location_id was never backfilled.
    params.push(scope.locationId);
    conds.push(`(c.location_id = $${params.length} OR c.table_id IN (SELECT id FROM tables WHERE location_id = $${params.length}))`);
  }
  const c = await query(
    `SELECT c.* FROM checks c WHERE ${conds.join(' AND ')}`,
    params,
  );
  if (c.rowCount === 0) throw notFound('check not found');
  return c.rows[0];
}

// C-8: brief (3s) cache for POS check details on the guest bill poll —
// every guest at a table polls every few seconds, and each poll used to
// cost one live POS call per open check.
// v0.8.5 (F4-6): keyed by the check's DB id (refs can collide across
// tenants; a posType:ref key could serve one restaurant's bill to
// another's guest), size-capped, and invalidated when a payment lands.
const detailCache = new Map<string, { at: number; detail: PosCheckDetail }>();
async function cachedCheckDetail(ctx: Awaited<ReturnType<typeof getCheckPos>>, checkDbId: string): Promise<PosCheckDetail> {
  const hit = detailCache.get(checkDbId);
  if (hit && Date.now() - hit.at < 3_000) return hit.detail;
  const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
  if (detailCache.size > 1000) detailCache.clear();
  detailCache.set(checkDbId, { at: Date.now(), detail });
  return detail;
}
function invalidateCheckDetail(checkDbId: string): void {
  detailCache.delete(checkDbId);
}

// C-9: an order attempt is FAILED only on a DEFINITIVE error (a 4xx that
// is not a timeout/rate-limit). Anything else (network, timeout, 5xx)
// leaves the reservation PENDING so the same idempotency key can resume.
function isDefinitiveError(e: unknown): boolean {
  const s = (e as { status?: unknown; statusCode?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;
  return typeof s === 'number' && s >= 400 && s < 500 && s !== 408 && s !== 429;
}

export async function customerRoutes(app: FastifyInstance) {
  // v0.8.5 (Low): guest API responses carry bill/payment state — never
  // let a browser or intermediary cache them.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/t/') || req.url.startsWith('/api/checks/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  // C-8: per-TOKEN write limiter for guest actions (the global limiters in
  // index.ts key by IP; a venue's guests share one IP, and one abusive
  // token shouldn't ride on it). 30 writes/minute per table token.
  // v0.8.5 (F4-7): the bucket key comes from the DECODED route params /
  // query — keying on the raw url let percent-encoded token spellings
  // mint a fresh bucket per variant.
  const tokenKey = (req: { url: string; ip: string }): string => {
    const r = req as unknown as {
      params?: { token?: unknown };
      query?: { table_token?: unknown };
    };
    const fromParams = typeof r.params?.token === 'string' ? r.params.token : null;
    const fromQuery = typeof r.query?.table_token === 'string' ? r.query.table_token : null;
    if (fromParams || fromQuery) return `t:${fromParams ?? fromQuery}`;
    const seg = /^\/api\/t\/([^/?#]+)/.exec(req.url)?.[1];
    if (seg) {
      try { return `t:${decodeURIComponent(seg)}`; } catch { return `t:${seg}`; }
    }
    return `ip:${req.ip}`;
  };
  const tokenWriteLimiter = rateLimit({
    name: 'guest-token-write',
    windowMs: 60_000,
    max: 30,
    key: tokenKey,
  });
  // v0.8.5 (F4-13): claims get their own bucket per token+device — a
  // table of guests tapping items must not starve the write bucket above,
  // and one device must not flood claims either.
  const claimsLimiter = rateLimit({
    name: 'guest-claims',
    windowMs: 60_000,
    max: 60,
    key: (req) => {
      const body = (req as unknown as { body?: { device_id?: unknown } }).body;
      const dev = typeof body?.device_id === 'string' ? body.device_id.slice(0, 64) : '';
      return `${tokenKey(req)}:d:${dev}`;
    },
  });
  // v0.8.5 (F4-10): feedback is capped per table per hour on top of the
  // per-minute write limiter.
  const feedbackLimiter = rateLimit({
    name: 'guest-feedback-hourly',
    windowMs: 60 * 60_000,
    max: 10,
    key: tokenKey,
  });
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
    // C-12: the poll may identify the caller's device to flag its own claims;
    // raw device ids are never returned.
    const myDevice = String((req.query as { device_id?: unknown }).device_id ?? '').slice(0, 64) || undefined;
    const checks = [];
    let posFailures = 0;
    for (const row of c.rows) {
      try {
        const ctx = await getCheckPos(row.id);
        const detail = await cachedCheckDetail(ctx, row.id);
        const view = billView(detail, row) as ReturnType<typeof billView> & { item_claims: unknown[] };
        // Group Pay (idea 2): live item claims ride along with the bill poll.
        view.item_claims = await listClaims(row.id, myDevice);
        checks.push(view);
      } catch (e) {
        // Skip checks whose POS order vanished; don't break the whole page.
        // v0.8.5 (F4-12): log it — a silent skip made a POS outage look
        // like "no bill" and guests walked out; the flag below lets the
        // page say "temporarily unavailable, ask staff" instead.
        posFailures++;
        console.error(`[guest] bill load failed for check ${row.id} (table ${table.id}):`, e);
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
      // Open checks exist but none could be loaded from the POS.
      pos_unavailable: c.rowCount > 0 && checks.length === 0 && posFailures > 0,
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
    // v0.8.5 (F4-5): every path resolves the check SCOPED to its tenant
    // (the token's table, or the portal user's location) — never a bare
    // ref lookup whose rows[0] might be another location's check.
    let row;
    if (tableToken) {
      row = await assertTableToken(ref, tableToken);
    } else {
      const bearer = extractBearer(req.headers.authorization);
      const user = bearer ? await getPortalUser(bearer) : null;
      if (user) {
        row = await loadCheckRow(ref, { locationId: user.location_id });
      } else if (bearer && isValidStaffToken(bearer)) {
        row = await loadCheckRow(ref);
        if (!row.table_id) throw notFound('check not found');
      } else {
        throw badRequest('table_token is required');
      }
    }
    const ctx = await getCheckPos(row.id);
    const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
    return { ...billView(detail, row), pos_state: detail.state };
  });

  // ---- Group Pay (idea 2): item claims --------------------------------------
  // Guests at the same table coordinate who pays what: claiming an item shows
  // it as taken on every other phone at the table (via the bill poll), so the
  // same dish is never paid twice. Guests authenticate with the table's QR
  // token — the same rule as GET /api/checks/:ref above.
  async function assertTableToken(ref: string, tableToken: string) {
    // v0.8.5 (F4-5): resolve the table from the token FIRST and scope the
    // check lookup to it — refs are only unique per location, so the old
    // unscoped rows[0] could pick another location's check with the same
    // ref and 404 the legitimate guest.
    const tok = await query(`SELECT id FROM tables WHERE qr_token = $1`, [tableToken]);
    if (tok.rowCount === 0) throw notFound('check not found');
    const row = await loadCheckRow(ref, { tableId: tok.rows[0].id });
    if (!row.table_id) throw notFound('check not found');
    return row;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function parseClaimBody(req: { body?: unknown }) {
    const body = (req.body ?? {}) as { item_index?: unknown; fingerprint?: unknown; device_id?: unknown };
    const itemIndex = Number(body.item_index);
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 500) throw badRequest('item_index must be a non-negative integer');
    // v0.8.5 (F4-13): device ids are the app's UUIDs — an arbitrary string
    // let one guest collide with (and unclaim) another's items.
    if (typeof body.device_id !== 'string' || !UUID_RE.test(body.device_id)) throw badRequest('device_id is required');
    return { itemIndex, deviceId: body.device_id, fingerprint: body.fingerprint };
  }

  app.post('/api/checks/:ref/claims', { preHandler: claimsLimiter }, async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const tableToken = String((req.query as { table_token?: unknown }).table_token ?? '');
    if (!tableToken) throw badRequest('table_token is required');
    const row = await assertTableToken(ref, tableToken);
    const { itemIndex, deviceId, fingerprint } = parseClaimBody(req);
    if (typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 300) throw badRequest('fingerprint is required');
    // v0.8.5 (F4-13): the claim must name an item that exists on the LIVE
    // bill, with the fingerprint the client computes from that item
    // (name|quantity|amount_cents — public/t/app.js itemFp). A junk claim
    // otherwise occupies the (check, item_index) slot and blocks the real
    // item from ever being claimed.
    const ctx = await getCheckPos(row.id);
    const detail = await cachedCheckDetail(ctx, row.id);
    const item = detail.items[itemIndex];
    if (!item) throw badRequest('item_index is out of range for this bill');
    const expectedFp = `${item.name}|${item.quantity}|${item.amountCents}`;
    if (fingerprint !== expectedFp) throw badRequest('fingerprint does not match the bill item');
    const mine = await claimItem(row.id, itemIndex, fingerprint, deviceId);
    if (!mine) throw conflict('that item was just claimed by someone else at your table', 'item_claimed');
    return { ok: true };
  });

  app.delete('/api/checks/:ref/claims', { preHandler: claimsLimiter }, async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    const tableToken = String((req.query as { table_token?: unknown }).table_token ?? '');
    if (!tableToken) throw badRequest('table_token is required');
    const row = await assertTableToken(ref, tableToken);
    const { itemIndex, deviceId } = parseClaimBody(req);
    await unclaimItem(row.id, itemIndex, deviceId);
    return { ok: true };
  });

  // Pay by card: full | equal | items | custom. See src/services/payments.ts.
  // card_nonce (provider SDK token: Square cnon:..., Clover clv_..., Helcim
  // cardToken) and idempotency_key (client UUID v4) are REQUIRED. The token
  // format is validated per the check's POS; POS without card support return
  // a clear 400 from payCheck(). There is deliberately no guest-reachable
  // "external / no card" path: cash is recorded by staff through
  // POST /api/checks/:ref/record-external-payment.
  app.post('/api/checks/:ref/pay', { preHandler: tokenWriteLimiter }, async (req) => {
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
      /^[A-Za-z0-9_-]{8,200}$/.test(nonce); // helcim (v0.8.5 F4: aligned with the per-POS check below — 8+ chars)
    if (!plausible) throw badRequest('invalid card token');
    // Validate the payment body (idempotency_key, mode, amounts) before
    // touching the DB, so malformed requests get 400 even for unknown checks.
    const p = parsePaymentBody(body);
    // v0.6.5 (C-3, High): pay requires the table's QR token, exactly like the
    // bill view and claims. A bare POS ref was enough to charge a card
    // against any check — an enumeration oracle for card testing and a way
    // to close strangers' bills. The check is then resolved by its verified
    // internal id, never by the bare ref (B-6).
    const tableToken = String((req.query as { table_token?: unknown }).table_token ?? '');
    if (!tableToken) throw badRequest('table_token is required');
    const row = await assertTableToken(ref, tableToken);
    // New charges only from a live table; a replayed idempotency key skips
    // the gate so payCheck can return its stored result.
    const prior = await query(`SELECT 1 FROM payments WHERE idempotency_key = $1`, [p.idempotencyKey]);
    if (prior.rowCount === 0) {
      const tbl = await query<{ state: string }>(`SELECT state FROM tables WHERE id = $1`, [row.table_id]);
      // v0.8.5 (F4-11): a table flipped to PAID early (stale webhook, staff
      // action) must not block paying a check that is still OPEN — the
      // check itself is the authority (payCheck re-reads its live
      // remaining). Only a FREE (unseated) table blocks new charges.
      if (!tbl.rows[0] || !['SEATED', 'PAYING', 'PAID'].includes(tbl.rows[0].state)) {
        throw badRequest('table is not seated');
      }
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
    // v0.8.5 (F4-13): in items mode, snapshot THIS device's claims before
    // the charge — those are the items being paid for, and only those
    // claims are released afterwards (the old blanket release also
    // dropped claims for items selected but not paid in this payment).
    const dev = body.device_id;
    const paidClaimIndexes = p.mode === 'items' && typeof dev === 'string' && dev
      ? await listDeviceClaimIndexes(row.id, dev).catch(() => [] as number[])
      : null;
    const result = await payCheck({ checkRef: ref, checkId: row.id, ...p, source: { kind: 'card', nonce }, clientIp: req.ip });
    // The bill just changed — never serve the pre-payment snapshot again.
    invalidateCheckDetail(row.id);
    // Group Pay (idea 2): a successful payment releases claims — the payer's
    // own claims in "items" mode; every claim when the whole bill was paid.
    // Claims are coordination only: never fail a completed payment over them.
    try {
      if (p.mode === 'items') {
        if (typeof dev === 'string' && dev && dev.length <= 64 && paidClaimIndexes) {
          await releaseClaimIndexes(row.id, dev, paidClaimIndexes);
        }
      } else if (p.mode === 'full') {
        await releaseAllClaims(row.id);
      }
    } catch { /* ignore */ }
    return result;
  });


  // ---- Review capture (frictionless: tap stars, no login) ---------------------
  // POST /api/t/:token/feedback { rating: 1-5, comment? }
  // 4-5 stars: guest gets the Google review link (frontend shows it).
  // 1-3 stars: private feedback saved for the owner.
  app.post('/api/t/:token/feedback', { preHandler: [tokenWriteLimiter, feedbackLimiter] }, async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.state, t.location_id, l.google_review_url FROM tables t
       JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const body = (req.body ?? {}) as { rating?: unknown; comment?: unknown };
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('rating must be 1-5');
    // v0.8.5 (F4-10): feedback belongs to a visit — the table must be in
    // service (seated/paying/just paid) or have a settled payment within
    // the last 2 hours. Before this, any holder of a photographed QR
    // could post ratings (and raise staff alerts) at any time, forever.
    const tableState = String(t.rows[0].state ?? '');
    if (!['SEATED', 'PAYING', 'PAID'].includes(tableState)) {
      const recent = await query(
        `SELECT 1 FROM payments p JOIN checks c ON c.id = p.check_id
          WHERE c.table_id = $1 AND p.status IN ('AUTHORIZED','COMPLETED')
            AND p.created_at > now() - interval '2 hours' LIMIT 1`,
        [t.rows[0].id],
      );
      if (recent.rowCount === 0) throw badRequest('feedback is available during your visit — ask staff for help');
    }
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
    // Service Recovery (idea 1): a 1-3 star rating raises an instant alert so
    // staff can reach the table BEFORE the guest leaves (and before a public
    // review). Deduped while an alert for this table is still open.
    if (rating <= 3) {
      await raiseServiceAlert({
        locationId: t.rows[0].location_id, tableId: t.rows[0].id,
        checkId: c.rows[0]?.id ?? null, kind: 'low_rating', rating, comment,
      });
    }
    return {
      ok: true,
      // Frontend: 4-5 stars -> open this URL; otherwise show "thanks".
      google_review_url: rating >= 4 ? t.rows[0].google_review_url : null,
    };
  });

  // ---- Loyalty (frictionless: phone number only, no account) ------------------
  // POST /api/t/:token/loyalty { phone, payment_id? }
  // Counts a visit for the phone hash; returns progress + reward status.
  //
  // v0.8.5 (F4-1/F4-2/F4-9): a visit counts ONLY against a payment the
  // caller actually made — payment_id from their own pay response,
  // settled, on a check of THIS table, within 24 hours, at least $1,
  // not refunded, and countable by exactly ONE phone number
  // (loyalty_payment_claims, migration 027). Before this, the route
  // counted the table's latest settled payment for ANY phone number any
  // token holder typed. Without payment_id the route is now a pure
  // progress lookup: it creates no row and counts nothing.
  app.post('/api/t/:token/loyalty', { preHandler: tokenWriteLimiter }, async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.location_id, l.loyalty_enabled, l.loyalty_visits_required, l.loyalty_reward_text
       FROM tables t JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const loc = t.rows[0];
    if (!loc.loyalty_enabled) throw badRequest('loyalty is not enabled here');
    const body = (req.body ?? {}) as { phone?: unknown; payment_id?: unknown };
    const digits = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    if (digits.length < 7 || digits.length > 15) throw badRequest('enter a valid phone number');
    // C-7: the phone hash is an HMAC keyed with the server secret — a bare
    // sha256 of location+digits was reversible by dictionary attack over
    // phone-number space. v0.8.5 (F4-9): the HMAC key is purpose-derived
    // from the secret, never the raw data-encryption key itself. (Hash
    // format changed again in v0.8.5: pre-launch, no real balances.)
    const loyaltyKey = createHash('sha256').update(`loyalty-hmac:${config.encryptionKeyHex || 'smart-table-dev'}`).digest();
    const phoneHash = createHmac('sha256', loyaltyKey)
      .update(`loyalty:${loc.location_id}:${digits}`)
      .digest('hex');
    const required = Math.max(2, Math.min(50, Number(loc.loyalty_visits_required) || 5));

    const paymentId = typeof body.payment_id === 'string' && body.payment_id ? body.payment_id : null;
    let payRow: { id: string; check_id: string } | null = null;
    if (paymentId) {
      const p = await query<{ id: string; check_id: string }>(
        `SELECT p.id, p.check_id FROM payments p JOIN checks c ON c.id = p.check_id
          WHERE (p.external_payment_ref = $2 OR p.square_payment_id = $2) AND c.table_id = $1
            AND p.status IN ('AUTHORIZED','COMPLETED')
            AND p.created_at > now() - interval '24 hours'
            AND (p.amount_cents + p.tip_cents) >= 100`,
        [loc.id, paymentId],
      );
      if (p.rowCount === 0) throw badRequest('that payment cannot count a loyalty visit');
      // A refunded payment counts nothing. (Separate query on purpose: a
      // correlated NOT EXISTS here is valid Postgres but unplannable in
      // pg-mem, and this codebase keeps its SQL portable across both.)
      const refunded = await query(
        `SELECT 1 FROM refunds WHERE payment_row_id = $1 AND status = 'COMPLETED' LIMIT 1`,
        [p.rows[0].id],
      );
      if (refunded.rowCount > 0) throw badRequest('that payment cannot count a loyalty visit');
      payRow = p.rows[0];
    }

    const state = await withTx(async (client) => {
      const existing = await client.query(
        `SELECT visit_count, rewards_earned, last_counted_check_id FROM loyalty_visits
         WHERE location_id = $1 AND phone_hash = $2`,
        [loc.location_id, phoneHash],
      );
      let row = existing.rows[0] ?? null;
      let counted = false;
      let rewardEarned = false;
      if (payRow) {
        // The payment counts for ONE phone number — claimed atomically.
        // (Verified by SELECT afterwards: pg-mem's ON CONFLICT RETURNING
        // reports the pre-existing row, real Postgres returns none.)
        await client.query(
          `INSERT INTO loyalty_payment_claims(payment_id, location_id, phone_hash)
           VALUES ($1,$2,$3) ON CONFLICT (payment_id) DO NOTHING`,
          [payRow.id, loc.location_id, phoneHash],
        );
        const prior = await client.query(
          `SELECT phone_hash FROM loyalty_payment_claims WHERE payment_id = $1`,
          [payRow.id],
        );
        const ours = prior.rows[0]?.phone_hash === phoneHash;
        if (ours) {
          if (!row) {
            await client.query(
              `INSERT INTO loyalty_visits(id, location_id, phone_hash, visit_count)
               VALUES ($1,$2,$3,0)`,
              [randomUUID(), loc.location_id, phoneHash],
            );
            row = { visit_count: 0, rewards_earned: 0, last_counted_check_id: null };
          }
          if (row.last_counted_check_id !== payRow.check_id) {
            // F4-1: the once-per-check guard lives IN the UPDATE's WHERE —
            // the old code decided on a stale SELECT, so parallel requests
            // each incremented (one check minted many visits). (Spelled
            // IS NULL OR <> instead of IS DISTINCT FROM: pg-mem cannot
            // parse the latter with a bound parameter.)
            const upd = await client.query(
              `UPDATE loyalty_visits SET
                 visit_count = CASE WHEN visit_count + 1 >= $3 THEN 0 ELSE visit_count + 1 END,
                 rewards_earned = rewards_earned + CASE WHEN visit_count + 1 >= $3 THEN 1 ELSE 0 END,
                 last_counted_check_id = $4, last_visit_at = now()
               WHERE location_id = $1 AND phone_hash = $2
                 AND (last_counted_check_id IS NULL OR last_counted_check_id <> $4)
               RETURNING rewards_earned`,
              [loc.location_id, phoneHash, required, payRow.check_id],
            );
            if ((upd.rowCount ?? 0) > 0) {
              counted = true;
              rewardEarned = Number(upd.rows[0].rewards_earned) > Number(row.rewards_earned);
            }
          }
        }
      }
      const after = row || counted
        ? await client.query(
            `SELECT visit_count, rewards_earned FROM loyalty_visits WHERE location_id = $1 AND phone_hash = $2`,
            [loc.location_id, phoneHash],
          )
        : null;
      return {
        visits: Number(after?.rows[0]?.visit_count ?? 0),
        earned: Number(after?.rows[0]?.rewards_earned ?? 0),
        counted,
        rewardEarned,
      };
    });
    return {
      ok: true,
      counted: state.counted,
      visits: state.visits,
      visits_required: required,
      visits_remaining: required - state.visits,
      reward_earned: state.rewardEarned,
      reward_text: loc.loyalty_reward_text,
      total_rewards: state.earned,
    };
  });

  // ---- Receipt email (per-payment, guest opts in) -------------------------------
  // POST /api/t/:token/receipt-email { email, payment_id }
  // C-6: the receipt binds to ONE payment — the one the guest just made
  // (payment_id from the pay response), inside a short window, and can be
  // emailed once per payment. Before this, the route emailed the latest
  // payment across ALL of the table's checks with items taken from a
  // DIFFERENT (newest) check, with no time bound — any holder of a table
  // photo could pull receipts for later parties at that table forever.
  app.post('/api/t/:token/receipt-email', { preHandler: tokenWriteLimiter }, async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.name AS table_name, t.location_id, l.name AS location_name, l.demo AS location_demo
       FROM tables t JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const body = (req.body ?? {}) as { email?: unknown; payment_id?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('valid email is required');
    // The pay response's paymentId is the POS-side payment reference —
    // match it against both stored ref columns, always scoped to a check
    // on THIS table.
    const paymentId = typeof body.payment_id === 'string' && body.payment_id ? body.payment_id : null;
    // v0.8.5 (F4-8): payment_id is REQUIRED. The old no-id fallback emailed
    // the table's latest settled payment to any address a token holder
    // typed — and burned the real payer's one-send slot. Current clients
    // always send the id from their own pay response.
    if (!paymentId) throw badRequest('payment_id is required');
    const p = await query(
      `SELECT p.id, p.check_id, p.amount_cents, p.tip_cents, p.currency, p.created_at
       FROM payments p JOIN checks c ON c.id = p.check_id
       WHERE (p.external_payment_ref = $2 OR p.square_payment_id = $2) AND c.table_id = $1
         AND p.status IN ('AUTHORIZED','COMPLETED')
         AND p.created_at > now() - interval '60 minutes'`,
      [t.rows[0].id, paymentId],
    );
    if (p.rowCount === 0) throw badRequest('no recent completed payment found for this table');
    const pay = p.rows[0];
    // v0.8.12 (F9-1): DEMO locations never actually send. The published
    // demo token would otherwise turn this route into an email relay to
    // arbitrary addresses. The response is indistinguishable from an
    // accepted send (guest UX identical), the one-send slot is NOT
    // claimed, and the suppression is logged.
    if (t.rows[0].location_demo) {
      console.log(`[demo] receipt email suppressed for demo location ${t.rows[0].location_id} (payment ${pay.id})`);
      return { ok: true, sent: true };
    }
    // One send per payment: claim the receipt slot atomically.
    const claim = await query(
      `UPDATE payments SET receipt_emailed_at = now() WHERE id = $1 AND receipt_emailed_at IS NULL RETURNING id`,
      [pay.id],
    );
    if (claim.rowCount === 0) throw badRequest('a receipt was already emailed for this payment');
    // Item breakdown from THE payment's own check (best effort).
    let items: { name: string; quantity: number; amountCents: number }[] = [];
    try {
      const ctx = await getCheckPos(pay.check_id);
      const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
      items = detail.items.map((i) => ({ name: i.name, quantity: i.quantity, amountCents: i.amountCents }));
    } catch { /* receipt still sends with totals */ }
    const result = await sendReceiptEmail(email, {
      restaurantName: t.rows[0].location_name || 'Smart Table',
      tableName: t.rows[0].table_name,
      items,
      totalCents: pay.amount_cents + pay.tip_cents,
      currency: pay.currency || 'CAD',
      paidAt: new Date(pay.created_at).toLocaleString(),
    });
    if (!result.sent) {
      // Release the claim so the guest can retry (e.g. provider hiccup).
      await query(`UPDATE payments SET receipt_emailed_at = NULL WHERE id = $1`, [pay.id]).catch(() => undefined);
    }
    return { ok: true, ...result };
  });

  // ---- Receipt print on the table device (guest opts in) ----------------------
  // POST /api/t/:token/receipt-print { payment_id }
  // The guest picks "Print" (or "Print + Email") on their phone after
  // paying; the receipt prints on the table's own STT-101 device — the
  // device has no screen UI for this, it just polls print jobs. Same
  // payment binding + one-print-per-payment claim as the email route.
  // A table with no paired device is NOT an error for the guest: the
  // route answers printed:false / reason:'no_device' and the page tells
  // them the server can print it instead.
  app.post('/api/t/:token/receipt-print', { preHandler: tokenWriteLimiter }, async (req) => {
    const { token } = req.params as { token: string };
    const t = await query(
      `SELECT t.id, t.name AS table_name, t.location_id, l.name AS location_name, l.demo AS location_demo
       FROM tables t JOIN locations l ON l.id = t.location_id WHERE t.qr_token = $1`,
      [token],
    );
    if (t.rowCount === 0) throw badRequest('unknown table');
    const body = (req.body ?? {}) as { payment_id?: unknown };
    const paymentId = typeof body.payment_id === 'string' && body.payment_id ? body.payment_id : null;
    // v0.8.5 (F4-8): payment_id is REQUIRED — the no-id fallback printed
    // the table's latest settled payment for any token holder and burned
    // the real payer's one-print slot. Clients send their pay-response id.
    if (!paymentId) throw badRequest('payment_id is required');
    const p = await query(
      `SELECT p.id, p.check_id, p.amount_cents, p.tip_cents, p.currency, p.created_at
       FROM payments p JOIN checks c ON c.id = p.check_id
       WHERE (p.external_payment_ref = $2 OR p.square_payment_id = $2) AND c.table_id = $1
         AND p.status IN ('AUTHORIZED','COMPLETED')
         AND p.created_at > now() - interval '60 minutes'`,
      [t.rows[0].id, paymentId],
    );
    if (p.rowCount === 0) throw badRequest('no recent completed payment found for this table');
    const pay = p.rows[0];
    // v0.8.12 (F9-1): DEMO locations never queue a print job — the
    // published demo token must not be able to drive a paired device's
    // printer. The response matches a successful queue (guest UX
    // identical); no job is created and the one-print slot is NOT
    // claimed.
    if (t.rows[0].location_demo) {
      console.log(`[demo] receipt print suppressed for demo location ${t.rows[0].location_id} (payment ${pay.id})`);
      return { ok: true, printed: true, demo: true };
    }
    const dev = await query<{ id: string }>(
      `SELECT id FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [t.rows[0].id],
    );
    if (dev.rowCount === 0) return { ok: true, printed: false, reason: 'no_device' };
    // v0.8.14 (F11-3): same per-device queue cap as the staff print route —
    // checked BEFORE claiming the one-print slot so a full queue doesn't
    // burn the guest's single print.
    if ((await countActivePrintJobs(dev.rows[0].id)) >= MAX_ACTIVE_PRINT_JOBS) {
      return { ok: true, printed: false, reason: 'queue_full' };
    }
    // One device print per payment: claim the slot atomically.
    const claim = await query(
      `UPDATE payments SET receipt_printed_at = now() WHERE id = $1 AND receipt_printed_at IS NULL RETURNING id`,
      [pay.id],
    );
    if (claim.rowCount === 0) return { ok: true, printed: false, reason: 'already_printed' };
    // Item breakdown from THE payment's own check (best effort).
    let items: { name: string; quantity: number; amountCents: number }[] = [];
    try {
      const ctx = await getCheckPos(pay.check_id);
      const detail = await ctx.adapter.getCheckDetail(ctx.checkRef, ctx.token);
      items = detail.items.map((i) => ({ name: i.name, quantity: i.quantity, amountCents: i.amountCents }));
    } catch { /* receipt still prints with totals */ }
    const lines = buildReceiptLines({
      restaurantName: t.rows[0].location_name || 'Smart Table',
      tableName: t.rows[0].table_name,
      items,
      amountCents: pay.amount_cents,
      tipCents: pay.tip_cents,
      currency: pay.currency || 'CAD',
      paidAt: new Date(pay.created_at).toLocaleString(),
    });
    const jobId = randomUUID();
    try {
      await query(
        `INSERT INTO print_jobs(id, device_id, location_id, table_id, check_id, lines) VALUES ($1,$2,$3,$4,$5,$6)`,
        // v0.8.14 (F11-3): sanitize at creation like every print-job path.
        [jobId, dev.rows[0].id, t.rows[0].location_id, t.rows[0].id, pay.check_id, JSON.stringify(sanitizePrintLines(lines))],
      );
    } catch (err) {
      // Release the claim so the guest can retry.
      await query(`UPDATE payments SET receipt_printed_at = NULL WHERE id = $1`, [pay.id]).catch(() => undefined);
      throw err;
    }
    return { ok: true, printed: true, job_id: jobId };
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
    let row = prev.rows[0];
    if (!row) throw new Error('idempotency reservation vanished');
    if (row.table_id !== table.id) {
      throw badRequest('idempotency key belongs to another table');
    }
    if (row.status === 'COMPLETED' && row.external_check_ref) {
      // Replay of a finished order: return the original check, don't charge again.
      const detail = await ctx.adapter.getCheckDetail(row.external_check_ref, ctx.token);
      const chk = await query(`SELECT id FROM checks WHERE location_id = $1 AND pos_type = $2 AND external_check_ref = $3`, [
        table.location_id,
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
      // A previous attempt failed definitively; start fresh with a new key.
      throw badRequest('this order attempt failed — please start a new order');
    }
    if (row.nonce !== myNonce) {
      // C-9: a PENDING row whose owner vanished mid-flight (unknown
      // outcome — timeout/5xx) must be resumable with the SAME key: after
      // 10 minutes the reservation is stale and this request takes it
      // over. (v0.8.5, F4-4: was 2 minutes — a slow Clover createCheck,
      // up to ~40 sequential line-item calls, can outlast that, and only
      // Square dedupes a second create; a taken-over reservation whose
      // predecessor already persisted external_check_ref resumes LINKING
      // that order below instead of creating a duplicate.) A fresh
      // in-flight reservation still 409s.
      const take = await query(
        `UPDATE order_requests SET nonce = $2 WHERE idempotency_key = $1 AND status = 'PENDING'
           AND created_at < now() - interval '10 minutes' RETURNING *`,
        [key, myNonce],
      );
      if (take.rowCount === 0) {
        throw httpError(409, 'this order is already being processed — please wait');
      }
      row = take.rows[0];
    }
    // We hold the reservation. Proceed to the POS call (Square dedupes by
    // idempotency key as a second layer).

    try {
      // v0.8.5 (F4-4): a resumed reservation may already carry the POS ref
      // (persisted by the attempt that created the order) — then skip
      // creation entirely and just finish linking it.
      let checkId = (row.external_check_ref as string | null) ?? null;
      if (!checkId) {
        const created = await ctx.adapter.createCheck({
          locationRef: ctx.locationRef,
          items: normalized,
          tableLabel: table.name,
          idempotencyKey: key,
          token: ctx.token,
        });
        checkId = created.checkId;
        // Persist the ref on the reservation IMMEDIATELY — if anything
        // below fails, a same-key retry resumes THIS order instead of
        // creating a second one on POS systems without create dedupe.
        await query(
          `UPDATE order_requests SET external_check_ref = $2 WHERE idempotency_key = $1`,
          [key, checkId],
        );
      }
      // Link the new POS check to this table (same shape as staff link-check).
      // v0.8.5 (F4-4): the read-back is best-effort — a 404 right after
      // creation (POS eventual consistency) must not fail the attempt and
      // orphan the created order; link with a minimal detail instead and
      // let the bill poll refresh it.
      let detail: PosCheckDetail;
      try {
        detail = await ctx.adapter.getCheckDetail(checkId, ctx.token);
      } catch (readErr) {
        console.error(`[order] post-create read failed for ${checkId} — linking with a minimal detail:`, readErr);
        detail = {
          id: checkId, items: [], tenders: [], totalCents: 0, remainingCents: 0,
          currency: (table as { currency?: string }).currency ?? 'CAD', state: 'OPEN',
        };
      }
      const checkDbId = randomUUID();
      // M1 fix: DO NOTHING on conflict — never re-point or re-open a check.
      // v0.6.5 (C-4): identity is (location_id, pos_type, ref).
      await query(
        `INSERT INTO checks(id, table_id, location_id, square_order_id, external_check_ref, pos_type, merchant_id, state, total_cents, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,$9)
         ON CONFLICT (location_id, pos_type, external_check_ref) DO NOTHING`,
        [
          checkDbId,
          table.id,
          table.location_id,
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
      // v0.8.5 (F4 Low): on a link conflict the INSERT above was a no-op
      // and checkDbId names no row — answer with the EXISTING row's id.
      const linked = await query(
        `SELECT id FROM checks WHERE location_id = $1 AND pos_type = $2 AND external_check_ref = $3`,
        [table.location_id, ctx.posType, checkId],
      );
      const linkedId = linked.rows[0]?.id ?? checkDbId;
      return { ok: true, check: billView(detail, { id: linkedId, external_check_ref: checkId, square_order_id: ctx.posType === 'square' ? checkId : null, pos_type: ctx.posType, state: 'OPEN' }) };
    } catch (e) {
      // C-9: FAILED only on a definitive error. An unknown outcome
      // (timeout, network, 5xx) leaves the reservation PENDING — the POS
      // may have created the order, and the same key must be able to
      // resume/dedupe instead of the guest starting over with a new key
      // (which defeats the POS's own idempotency and double-orders).
      if (isDefinitiveError(e)) {
        await query(`UPDATE order_requests SET status = 'FAILED', completed_at = now() WHERE idempotency_key = $1`, [key]);
      } else {
        console.error(`[order] unknown-outcome error for key ${key} — reservation left PENDING for same-key resume:`, e);
      }
      throw e;
    }
  });

  // Card payment configuration for the guest browser: tells the payment page
  // which provider SDK to load (Square Web Payments SDK, Clover tokenization,
  // HelcimPay.js). Public endpoint — only publishable keys are returned.
  // :ref is the POS-native check reference.
  app.get('/api/checks/:ref/card-config', { preHandler: tokenWriteLimiter }, async (req) => {
    const ref = String((req.params as { ref: string }).ref ?? '');
    // v0.6.5 (C-3): same table-token binding as pay — card-config hands out
    // the location's payment configuration, so a bare ref must not unlock it.
    const tableToken = String((req.query as { table_token?: unknown }).table_token ?? '');
    if (!tableToken) throw badRequest('table_token is required');
    const row = await assertTableToken(ref, tableToken);
    const ctx = await getCheckPos(row.id);
    if (!ctx.adapter.getCardConfig || !ctx.adapter.chargeCard) {
      throw badRequest(`card payments are not supported for ${ctx.posType} locations`);
    }
    return ctx.adapter.getCardConfig(ctx.locationRef, ctx.card, ctx.token);
  });
}

// Re-export for the staff routes that share the loader.
export { loadCheckRow };
