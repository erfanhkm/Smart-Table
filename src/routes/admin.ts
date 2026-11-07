// Founder admin panel (v0.2).
//
// Separate from the restaurant owner portal (/portal). This is Erfan's own
// dashboard: all locations, payment stats, system health, website analytics.
// Authenticated with ADMIN_USERNAME + ADMIN_PASSWORD_HASH (env vars) issuing
// short-lived session tokens. v0.6.4: STAFF_API_TOKEN no longer grants founder
// access — the staff token is tenant-wide by design and must never be a
// skeleton key to billing runs and cross-location data.
import { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { query, withTx } from '../db.js';
import { extractBearer } from '../auth.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { config } from '../config.js';
import { badRequest, conflict, httpError, unauthorized } from '../http.js';
import { rateLimit } from '../rate-limit.js';
import { logAudit } from '../services/audit.js';
import {
  isLocationTier,
  processAccruedFees,
  TIER_DEFAULTS,
  type BillingPlan,
  type LocationTier,
} from '../services/billing.js';

// Founder login is the highest-value credential in the system: strict
// per-IP limiter (10 attempts / 15 min) on top of scrypt (v0.6.4).
const adminLoginLimiter = rateLimit({ name: 'admin-login', windowMs: 15 * 60 * 1000, max: 10 });

// F6-1: the per-IP limiter alone never fires for a distributed attacker,
// and this account is a single fixed target. A GLOBAL failure budget sits
// behind it: 20 failures inside an hour lock ALL admin logins for 15
// minutes and raise an audit record. A successful login clears the count.
// v0.10.5 (C3-6-4): the global lock also locked out the FOUNDER — 20 bad
// tries from anywhere DoSed the one legitimate user. A source that has
// completed a successful admin login before is a KNOWN source: the lock
// does not apply to it and its failures do not feed the global counter
// (its strict per-IP limiter still applies). Unknown-source floods still
// lock unknown sources out, exactly as F6-1 intended.
const ADMIN_FAIL_WINDOW_MS = 60 * 60 * 1000;
const ADMIN_FAIL_LIMIT = 20;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
let adminFailCount = 0;
let adminFailWindowStart = 0;
let adminLockedUntil = 0;
const knownAdminIps = new Set<string>();

function adminLoginLocked(): boolean {
  return Date.now() < adminLockedUntil;
}

async function noteAdminFailure(ip: string | undefined): Promise<void> {
  if (ip && knownAdminIps.has(ip)) return;
  const now = Date.now();
  if (now - adminFailWindowStart > ADMIN_FAIL_WINDOW_MS) {
    adminFailWindowStart = now;
    adminFailCount = 0;
  }
  adminFailCount++;
  if (adminFailCount >= ADMIN_FAIL_LIMIT && !adminLoginLocked()) {
    adminLockedUntil = now + ADMIN_LOCKOUT_MS;
    console.error('[admin] login LOCKED after repeated failures');
    await logAudit({
      actorType: 'system',
      actorId: null,
      role: null,
      ip: ip ?? null,
      action: 'admin_login_lockout',
      detail: `${adminFailCount} failures within an hour; logins locked for 15 minutes`,
    });
  }
}

function noteAdminSuccess(ip?: string): void {
  adminFailCount = 0;
  adminFailWindowStart = 0;
  adminLockedUntil = 0;
  if (ip) knownAdminIps.add(ip);
}

// Short-lived admin sessions (in-memory, single instance). F6-11: capped
// at 100 live sessions and idle-timed-out after 2 hours on top of the
// 12-hour absolute TTL.
const sessions = new Map<string, { exp: number; seen: number }>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now || now - v.seen > SESSION_IDLE_MS) sessions.delete(k);
}, 60 * 60 * 1000).unref();

/** Founder-only: a valid admin session token. Nothing else — see header. */
async function founderOnly(req: any, reply: any) {
  const token = extractBearer(req.headers.authorization);
  if (!token) return reply.code(401).send({ error: 'unauthorized' });
  const s = sessions.get(token);
  const now = Date.now();
  if (s && s.exp > now && now - s.seen <= SESSION_IDLE_MS) {
    s.seen = now;
    return;
  }
  sessions.delete(token);
  req.log?.warn({ ip: req.ip, path: String(req.url ?? '').split('?')[0] }, 'admin auth failed');
  return reply.code(401).send({ error: 'unauthorized' });
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function adminRoutes(app: FastifyInstance) {
  // ---- Username/password login ----
  // POST /api/admin/login { username, password } -> { token }
  app.post('/api/admin/login', { onRequest: adminLoginLimiter }, async (req) => {
    // F6-1: global lockout after repeated failures (any source IPs).
    // v0.10.5 (C3-6-4): known sources (a prior successful login from this
    // IP) are exempt — the lock exists to stop attackers, not the founder.
    if (adminLoginLocked() && !knownAdminIps.has(req.ip)) {
      throw httpError(429, 'too many failed login attempts; try again later');
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const expectedUser = config.adminUsername;
    const expectedHash = config.adminPasswordHash;
    // F6-11: a generic 503 — the old message confirmed config state to
    // anonymous callers.
    if (!expectedUser || !expectedHash) throw httpError(503, 'login unavailable');
    // Over-long passwords are rejected before scrypt so they can't be used to
    // tie up the (small) scrypt worker pool (v0.6.4).
    // F6-11: failure logs carry the IP only — a submitted "username" can be
    // a mistyped password and must never land in a log.
    if (password.length > 200) {
      await noteAdminFailure(req.ip);
      req.log.warn({ ip: req.ip }, 'admin login failed');
      throw unauthorized('invalid credentials');
    }
    if (username !== expectedUser) {
      // Constant-time-ish: still verify to avoid user enumeration timing.
      await verifyPassword('dummy', expectedHash).catch(() => false);
      await noteAdminFailure(req.ip);
      req.log.warn({ ip: req.ip }, 'admin login failed');
      throw unauthorized('invalid credentials');
    }
    const ok = await verifyPassword(password, expectedHash);
    if (!ok) {
      await noteAdminFailure(req.ip);
      req.log.warn({ ip: req.ip }, 'admin login failed');
      throw unauthorized('invalid credentials');
    }
    noteAdminSuccess(req.ip);
    req.log.info({ ip: req.ip }, 'admin login succeeded');
    const token = randomUUID().replace(/-/g, '');
    const now = Date.now();
    sessions.set(token, { exp: now + SESSION_TTL_MS, seen: now });
    // F6-11: cap live sessions (evict least-recently-seen first).
    if (sessions.size > 100) {
      const bySeen = [...sessions.entries()].sort((a, b) => a[1].seen - b[1].seen);
      for (const [k] of bySeen.slice(0, sessions.size - 100)) sessions.delete(k);
    }
    return { ok: true, token };
  });

  app.post('/api/admin/logout', async (req) => {
    const token = extractBearer(req.headers.authorization);
    if (token) sessions.delete(token);
    return { ok: true };
  });

  // ---- Website analytics (Cloudflare Web Analytics API) ----
  // GET /api/admin/analytics -> { daily: [{ date, visitors, pageviews }] }
  // Uses the RUM (Web Analytics) GraphQL dataset: viewer.accounts -> rumPageloadEventsAdaptiveGroups
  app.get('/api/admin/analytics', { onRequest: founderOnly }, async () => {
    if (!config.cloudflareApiToken) throw badRequest('analytics is not configured');
    const accountTag = config.cloudflareAccountId;
    const siteTag = config.cloudflareSiteTag;
    if (!accountTag || !siteTag) throw badRequest('analytics is not configured');
    const start = daysAgo(7);
    const end = daysAgo(0);
    // F6-11: config values travel as GraphQL variables (never interpolated
    // into the query string) and the fetch has a hard timeout.
    const query = `
      query($accountTag: string!, $siteTag: string!, $start: Date!, $end: Date!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            rumPageloadEventsAdaptiveGroups(
              filter: { siteTag: $siteTag, date_geq: $start, date_leq: $end }
              limit: 10
              orderBy: [date_ASC]
            ) {
              count
              dimensions { date }
              sum { visits }
            }
          }
        }
      }`;
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.cloudflareApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { accountTag, siteTag, start, end } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Cloudflare API ${res.status}`);
      const data = (await res.json()) as any;
      const groups = data?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups ?? [];
      return {
        daily: groups.map((g: any) => ({
          date: g.dimensions?.date,
          pageviews: g.count ?? 0,
          visitors: g.sum?.visits ?? 0,
        })),
      };
    } catch (e) {
      throw badRequest('could not fetch analytics');
    }
  });

  // ---- Overview stats ----
  app.get('/api/admin/overview', { onRequest: founderOnly }, async () => {
    const [locs, tables, checks, pays, revByCur] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM locations`),
      query(`SELECT COUNT(*)::int AS n FROM tables`),
      query(`SELECT COUNT(*)::int AS n FROM checks WHERE state = 'OPEN'`),
      query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents + tip_cents), 0)::bigint AS total
         FROM payments WHERE status IN ('AUTHORIZED','COMPLETED')
         AND created_at > now() - interval '24 hours'`,
      ),
      // F10-5: revenue grouped by its real currency — the panel must
      // never present one mixed-currency sum labeled as CAD.
      query(
        `SELECT currency, COALESCE(SUM(amount_cents + tip_cents), 0)::bigint AS total
         FROM payments WHERE status IN ('AUTHORIZED','COMPLETED')
         AND created_at > now() - interval '24 hours'
         GROUP BY currency ORDER BY currency`,
      ),
    ]);
    return {
      locations: locs.rows[0].n,
      tables: tables.rows[0].n,
      open_checks: checks.rows[0].n,
      payments_24h: pays.rows[0].n,
      revenue_24h_cents: Number(pays.rows[0].total),
      revenue_24h_by_currency: revByCur.rows.map((r: any) => ({
        currency: r.currency ?? null,
        total_cents: Number(r.total),
      })),
    };
  });

  // ---- Manually trigger accrued-commission collection (v0.4) ----
  app.post('/api/admin/billing/run', { onRequest: founderOnly }, async (req) => {
    const result = await processAccruedFees();
    // F6-6: founder billing runs are audited like every other money action.
    await logAudit({
      actorType: 'founder',
      actorId: null,
      role: null,
      ip: req.ip,
      action: 'billing_run',
      detail: JSON.stringify(result).slice(0, 400),
    });
    return result;
  });

  // ---- Provision a brand-new restaurant (v0.10.0) ----
  // POST /api/admin/locations { name, owner_email, tier?, plan?, table_count? }
  // Creates merchant + location + billing account + owner portal login +
  // tables in ONE transaction. The restaurant connects Square later from
  // its portal (OAuth/manual token replaces the pending refs below).
  //
  // POS-not-connected representation: the merchant mirrors the shape
  // upsertMerchant() writes BEFORE any credential exists — pos_type
  // 'square', square_merchant_id NULL, access/refresh token columns ''
  // (they are NOT NULL), external ref 'pending-<merchant id>'. The
  // location carries 'pending-<location id>' in BOTH pos_location_ref
  // and square_location_id (the latter is NOT NULL + UNIQUE; the
  // 'pending-' prefix uses only [A-Za-z0-9-] so it passes the Square id
  // shape check, and uniqueness comes from the embedded uuid). No
  // pos_credentials row is created, so getLocationPos() resolves
  // token=undefined for this non-demo location and NO code path can fall
  // back to the platform env token (that fallback is demo-only since
  // v0.6.5, and sq() itself refuses token-less calls). Card payments
  // additionally hit the explicit pos_not_connected guard in payCheck().
  app.post('/api/admin/locations', { onRequest: founderOnly }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 120) throw badRequest('restaurant name is required (max 120 characters)');
    const ownerEmail = typeof b.owner_email === 'string' ? b.owner_email.trim().toLowerCase() : '';
    if (!ownerEmail || ownerEmail.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      throw badRequest('a valid owner email is required');
    }
    const tier: LocationTier = b.tier === undefined ? 'base' : (b.tier as LocationTier);
    if (!isLocationTier(tier)) throw badRequest("tier must be 'starter' or 'base'");
    const plan: BillingPlan = b.plan === undefined ? 'commission' : (b.plan as BillingPlan);
    if (plan !== 'commission' && plan !== 'subscription') {
      throw badRequest("plan must be 'commission' or 'subscription'");
    }
    const tableCount = b.table_count === undefined ? 10 : b.table_count;
    if (typeof tableCount !== 'number' || !Number.isInteger(tableCount) || tableCount < 1 || tableCount > 100) {
      throw badRequest('table_count must be a whole number between 1 and 100');
    }

    // Readable one-time password (no ambiguous characters), shown to the
    // founder exactly once in this response — only its scrypt hash is
    // stored and it is never written to any log.
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const pwBytes = randomBytes(16);
    const tempPassword = Array.from(pwBytes, (x) => ALPHABET[x % ALPHABET.length]).join('');
    const passwordHash = await hashPassword(tempPassword);

    const merchantId = randomUUID();
    const locationId = randomUUID();
    const ownerId = randomUUID();
    const defaults = TIER_DEFAULTS[tier];
    try {
      await withTx(async (client) => {
        const dupe = await client.query(`SELECT id FROM portal_users WHERE email = $1`, [ownerEmail]);
        if (dupe.rowCount && dupe.rowCount > 0) {
          throw conflict('owner email already in use', 'owner_email_in_use');
        }
        await client.query(
          `INSERT INTO merchants(id, pos_type, external_merchant_ref, square_merchant_id, access_token_enc, refresh_token_enc)
           VALUES ($1,'square',$2,NULL,'','')`,
          [merchantId, `pending-${merchantId}`],
        );
        await client.query(
          `INSERT INTO locations(id, merchant_id, pos_type, pos_location_ref, square_location_id, name, currency, demo, tier)
           VALUES ($1,$2,'square',$3,$3,$4,'CAD',false,$5)`,
          [locationId, merchantId, `pending-${locationId}`, name, tier],
        );
        // Same seed ensureBillingAccount() writes (tier defaults + chosen
        // plan), inlined so provisioning stays ONE transaction. A
        // 'subscription' plan here is the owner's choice recorded ahead
        // of a card on file — no Square subscription is created until
        // they add a card and switch plans from the portal.
        await client.query(
          `INSERT INTO billing_accounts(location_id, plan, commission_bps, subscription_price_cents, currency)
           VALUES ($1,$2,$3,$4,'CAD')`,
          [locationId, plan, defaults.commission_bps, defaults.subscription_price_cents],
        );
        await client.query(
          `INSERT INTO portal_users(id, email, password_hash, role, location_id, must_change_password) VALUES ($1,$2,$3,'owner',$4,true)`,
          [ownerId, ownerEmail, passwordHash, locationId],
        );
        for (let i = 1; i <= tableCount; i++) {
          await client.query(
            `INSERT INTO tables(id, location_id, name, qr_token, state) VALUES ($1,$2,$3,$4,'FREE')`,
            [randomUUID(), locationId, String(i), randomUUID().replace(/-/g, '')],
          );
        }
      });
    } catch (e) {
      // Lost a race on the UNIQUE email (the in-tx check passed, or a
      // concurrent create landed first): same clean 409, nothing partial.
      const msg = e instanceof Error ? e.message : '';
      if ((e as { statusCode?: number })?.statusCode !== 409 && /unique|duplicate/i.test(msg) && /portal_users|email/i.test(msg)) {
        throw conflict('owner email already in use', 'owner_email_in_use');
      }
      throw e;
    }
    await logAudit({
      actorType: 'founder',
      actorId: null,
      role: null,
      ip: req.ip,
      action: 'admin_location_created',
      locationId,
      target: ownerEmail,
      detail: `tier=${tier} plan=${plan} tables=${tableCount} name=${name}`.slice(0, 400),
    });
    return {
      location_id: locationId,
      merchant_id: merchantId,
      owner_email: ownerEmail,
      temp_password: tempPassword,
      tier,
      plan,
      tables_created: tableCount,
    };
  });

  // ---- All locations with per-location stats ----
  // v0.10.5 (C3-6-6): the stats used to fan out as 5 queries PER location
  // (up to 500 locations, sequential across them, on a page the panel
  // polls) — a self-inflicted pool flood next to live payments. The stats
  // are grouped aggregates now: a constant number of queries no matter
  // how many locations exist, joined onto the page in JS.
  app.get('/api/admin/locations', { onRequest: founderOnly }, async (req) => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const limit = Math.min(500, Math.max(1, Number((req.query as any).limit) || 100));
    const [locs, feesMonth, feesAccrued, tbls, openChecks, revenue] = await Promise.all([
      query(
        `SELECT l.id, l.name, l.pos_type, l.currency, l.qr_ordering_enabled,
                l.loyalty_enabled, l.created_at,
                b.plan AS billing_plan, b.subscription_status
         FROM locations l
         LEFT JOIN billing_accounts b ON b.location_id = l.id
         ORDER BY l.created_at DESC LIMIT $1`,
        [limit],
      ),
      query(
        `SELECT location_id, COALESCE(SUM(fee_cents), 0)::bigint AS total FROM fee_ledger
         WHERE status IN ('collected','charged') AND created_at >= $1 GROUP BY location_id`,
        [monthStart.toISOString()],
      ),
      query(
        `SELECT location_id, COALESCE(SUM(fee_cents), 0)::bigint AS total FROM fee_ledger
         WHERE status = 'accrued' GROUP BY location_id`,
      ),
      query(`SELECT location_id, COUNT(*)::int AS n FROM tables GROUP BY location_id`),
      query(
        `SELECT t.location_id, COUNT(*)::int AS n FROM checks c JOIN tables t ON t.id = c.table_id
         WHERE c.state = 'OPEN' GROUP BY t.location_id`,
      ),
      query(
        `SELECT t.location_id, COALESCE(SUM(p.amount_cents + p.tip_cents), 0)::bigint AS total FROM payments p
         JOIN checks c ON c.id = p.check_id JOIN tables t ON t.id = c.table_id
         WHERE p.status IN ('AUTHORIZED','COMPLETED') AND p.created_at > $1 GROUP BY t.location_id`,
        [dayAgo],
      ),
    ]);
    const byId = <T,>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, T>();
      for (const r of rows) m.set(key(r), r);
      return m;
    };
    const feesMonthBy = byId(feesMonth.rows as any[], (r) => r.location_id);
    const feesAccruedBy = byId(feesAccrued.rows as any[], (r) => r.location_id);
    const tblsBy = byId(tbls.rows as any[], (r) => r.location_id);
    const openBy = byId(openChecks.rows as any[], (r) => r.location_id);
    const revBy = byId(revenue.rows as any[], (r) => r.location_id);
    const out = (locs.rows as any[]).map((l) => ({
      ...l,
      fees_this_month_cents: Number(feesMonthBy.get(l.id)?.total ?? 0),
      fees_accrued_cents: Number(feesAccruedBy.get(l.id)?.total ?? 0),
      tables: tblsBy.get(l.id)?.n ?? 0,
      open_checks: openBy.get(l.id)?.n ?? 0,
      revenue_24h_cents: Number(revBy.get(l.id)?.total ?? 0),
    }));
    return { locations: out };
  });

  // ---- Recent payments across all locations ----
  app.get('/api/admin/payments', { onRequest: founderOnly }, async (req) => {
    const limit = Math.min(100, Math.max(1, Number((req.query as any).limit) || 20));
    const r = await query(
      `SELECT p.id, p.amount_cents, p.tip_cents, p.currency, p.status, p.created_at,
              l.name AS location_name, t.name AS table_name
       FROM payments p
       JOIN checks c ON c.id = p.check_id
       LEFT JOIN tables t ON t.id = c.table_id
       LEFT JOIN locations l ON l.id = t.location_id
       ORDER BY p.created_at DESC LIMIT $1`,
      [limit],
    );
    return { payments: r.rows };
  });

  // ---- System health ----
  app.get('/api/admin/health', { onRequest: founderOnly }, async () => {
    const [pending, failed] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM payments WHERE status = 'PENDING' AND created_at < now() - interval '10 minutes'`),
      query(`SELECT COUNT(*)::int AS n FROM payments WHERE status = 'FAILED' AND created_at > now() - interval '24 hours'`),
    ]);
    return {
      stuck_pending: pending.rows[0].n,
      failed_24h: failed.rows[0].n,
      uptime: process.uptime(),
    };
  });

  // ---- Serve the admin UI ----
  app.get('/admin', async (_req, reply) => {
    return reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      )
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
      .sendFile('admin/index.html');
  });
  app.get('/admin/app.js', async (_req, reply) =>
    reply.header('X-Content-Type-Options', 'nosniff').type('text/javascript').sendFile('admin/app.js'),
  );
}
