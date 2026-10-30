// Founder admin panel (v0.2).
//
// Separate from the restaurant owner portal (/portal). This is Erfan's own
// dashboard: all locations, payment stats, system health, website analytics.
// Authenticated with ADMIN_USERNAME + ADMIN_PASSWORD_HASH (env vars) issuing
// short-lived session tokens. v0.6.4: STAFF_API_TOKEN no longer grants founder
// access — the staff token is tenant-wide by design and must never be a
// skeleton key to billing runs and cross-location data.
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { extractBearer } from '../auth.js';
import { verifyPassword } from '../crypto.js';
import { config } from '../config.js';
import { badRequest, httpError, unauthorized } from '../http.js';
import { rateLimit } from '../rate-limit.js';
import { logAudit } from '../services/audit.js';
import { processAccruedFees } from '../services/billing.js';

// Founder login is the highest-value credential in the system: strict
// per-IP limiter (10 attempts / 15 min) on top of scrypt (v0.6.4).
const adminLoginLimiter = rateLimit({ name: 'admin-login', windowMs: 15 * 60 * 1000, max: 10 });

// F6-1: the per-IP limiter alone never fires for a distributed attacker,
// and this account is a single fixed target. A GLOBAL failure budget sits
// behind it: 20 failures inside an hour lock ALL admin logins for 15
// minutes and raise an audit record. A successful login clears the count.
const ADMIN_FAIL_WINDOW_MS = 60 * 60 * 1000;
const ADMIN_FAIL_LIMIT = 20;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
let adminFailCount = 0;
let adminFailWindowStart = 0;
let adminLockedUntil = 0;

function adminLoginLocked(): boolean {
  return Date.now() < adminLockedUntil;
}

async function noteAdminFailure(ip: string | undefined): Promise<void> {
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

function noteAdminSuccess(): void {
  adminFailCount = 0;
  adminFailWindowStart = 0;
  adminLockedUntil = 0;
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
    if (adminLoginLocked()) throw httpError(429, 'too many failed login attempts; try again later');
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
    noteAdminSuccess();
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

  // ---- All locations with per-location stats ----
  // Aggregates computed per location with plain parameterized queries
  // (portable across Postgres/pg-mem — correlated scalar subqueries that
  // reference the outer row are not portable to pg-mem).
  app.get('/api/admin/locations', { onRequest: founderOnly }, async (req) => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // F6-11: bounded page size — the per-location fan-out below is 5
    // queries per location, so an unbounded list grows linearly worse.
    const limit = Math.min(500, Math.max(1, Number((req.query as any).limit) || 100));
    const locs = await query(
      `SELECT l.id, l.name, l.pos_type, l.currency, l.qr_ordering_enabled,
              l.loyalty_enabled, l.created_at,
              b.plan AS billing_plan, b.subscription_status
       FROM locations l
       LEFT JOIN billing_accounts b ON b.location_id = l.id
       ORDER BY l.created_at DESC LIMIT $1`,
      [limit],
    );
    const out = [];
    for (const l of locs.rows as any[]) {
      const [feesMonth, feesAccrued, tbls, openChecks, revenue] = await Promise.all([
        query(
          `SELECT COALESCE(SUM(fee_cents), 0)::bigint AS total FROM fee_ledger
           WHERE location_id = $1 AND status IN ('collected','charged') AND created_at >= $2`,
          [l.id, monthStart.toISOString()],
        ),
        query(
          `SELECT COALESCE(SUM(fee_cents), 0)::bigint AS total FROM fee_ledger
           WHERE location_id = $1 AND status = 'accrued'`,
          [l.id],
        ),
        query(`SELECT COUNT(*)::int AS n FROM tables WHERE location_id = $1`, [l.id]),
        query(
          `SELECT COUNT(*)::int AS n FROM checks c JOIN tables t ON t.id = c.table_id
           WHERE t.location_id = $1 AND c.state = 'OPEN'`,
          [l.id],
        ),
        query(
          `SELECT COALESCE(SUM(p.amount_cents + p.tip_cents), 0)::bigint AS total FROM payments p
           JOIN checks c ON c.id = p.check_id JOIN tables t ON t.id = c.table_id
           WHERE t.location_id = $1 AND p.status IN ('AUTHORIZED','COMPLETED') AND p.created_at > $2`,
          [l.id, dayAgo],
        ),
      ]);
      out.push({
        ...l,
        fees_this_month_cents: Number(feesMonth.rows[0].total),
        fees_accrued_cents: Number(feesAccrued.rows[0].total),
        tables: tbls.rows[0].n,
        open_checks: openChecks.rows[0].n,
        revenue_24h_cents: Number(revenue.rows[0].total),
      });
    }
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
