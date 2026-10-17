// Founder admin panel (v0.2).
//
// Separate from the restaurant owner portal (/portal). This is Erfan's own
// dashboard: all locations, payment stats, system health, website analytics.
// Authenticated with ADMIN_USERNAME + ADMIN_PASSWORD_HASH (env vars),
// falling back to STAFF_API_TOKEN for API access.
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { isValidStaffToken, extractBearer } from '../auth.js';
import { verifyPassword } from '../crypto.js';
import { config } from '../config.js';
import { badRequest } from '../http.js';

// Short-lived admin sessions (in-memory, single instance).
const sessions = new Map<string, number>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v < now) sessions.delete(k);
}, 60 * 60 * 1000).unref();

/** Founder-only: STAFF_API_TOKEN bearer, or a valid admin session token. */
async function founderOnly(req: any, reply: any) {
  const token = extractBearer(req.headers.authorization);
  if (!token) return reply.code(401).send({ error: 'unauthorized' });
  if (isValidStaffToken(token)) return;
  const exp = sessions.get(token);
  if (exp && exp > Date.now()) return;
  sessions.delete(token);
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
  app.post('/api/admin/login', async (req) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const expectedUser = config.adminUsername;
    const expectedHash = config.adminPasswordHash;
    if (!expectedUser || !expectedHash) throw badRequest('admin login is not configured');
    if (username !== expectedUser) {
      // Constant-time-ish: still verify to avoid user enumeration timing.
      await verifyPassword('dummy', expectedHash).catch(() => false);
      throw badRequest('invalid credentials');
    }
    const ok = await verifyPassword(password, expectedHash);
    if (!ok) throw badRequest('invalid credentials');
    const token = randomUUID().replace(/-/g, '');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
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
    const query = `
      query {
        viewer {
          accounts(filter: { accountTag: "${accountTag}" }) {
            rumPageloadEventsAdaptiveGroups(
              filter: { siteTag: "${siteTag}", date_geq: "${start}", date_leq: "${end}" }
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
        body: JSON.stringify({ query }),
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
    const [locs, tables, checks, pays] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM locations`),
      query(`SELECT COUNT(*)::int AS n FROM tables`),
      query(`SELECT COUNT(*)::int AS n FROM checks WHERE state = 'OPEN'`),
      query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents + tip_cents), 0)::bigint AS total
         FROM payments WHERE status IN ('AUTHORIZED','COMPLETED')
         AND created_at > now() - interval '24 hours'`,
      ),
    ]);
    return {
      locations: locs.rows[0].n,
      tables: tables.rows[0].n,
      open_checks: checks.rows[0].n,
      payments_24h: pays.rows[0].n,
      revenue_24h_cents: Number(pays.rows[0].total),
    };
  });

  // ---- All locations with per-location stats ----
  app.get('/api/admin/locations', { onRequest: founderOnly }, async () => {
    const r = await query(
      `SELECT l.id, l.name, l.pos_type, l.currency, l.qr_ordering_enabled,
              l.loyalty_enabled, l.created_at,
              (SELECT COUNT(*)::int FROM tables t WHERE t.location_id = l.id) AS tables,
              (SELECT COUNT(*)::int FROM checks c JOIN tables t ON t.id = c.table_id
               WHERE t.location_id = l.id AND c.state = 'OPEN') AS open_checks,
              (SELECT COALESCE(SUM(p.amount_cents + p.tip_cents), 0)::bigint FROM payments p
               JOIN checks c ON c.id = p.check_id JOIN tables t ON t.id = c.table_id
               WHERE t.location_id = l.id AND p.status IN ('AUTHORIZED','COMPLETED')
               AND p.created_at > now() - interval '24 hours') AS revenue_24h_cents
       FROM locations l ORDER BY l.created_at DESC`,
    );
    return { locations: r.rows };
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
