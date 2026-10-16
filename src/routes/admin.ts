// Founder admin panel (v0.2).
//
// Separate from the restaurant owner portal (/portal). This is Erfan's own
// dashboard: all locations, payment stats, system health. Authenticated with
// the STAFF_API_TOKEN bearer <redacted> (founder-level, not per-location).
import { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { isValidStaffToken, extractBearer } from '../auth.js';
import { badRequest } from '../http.js';

/** Founder-only: requires the STAFF_API_TOKEN, not a portal user token. */
async function founderOnly(req: any, reply: any) {
  const token = extractBearer(req.headers.authorization);
  if (!token || !isValidStaffToken(token)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function adminRoutes(app: FastifyInstance) {
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
