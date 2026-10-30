// v0.8.4: owner-demo access requests (smarttablepay.com/owner-demo).
//
// The owner demo is GATED: the marketing site collects the prospect's
// full details, this endpoint stores the request (demo_access_requests,
// status 'pending') and emails Erfan the complete submission. Approval
// is manual — an approved prospect gets a demo login for the Sample
// Bistro location. Nothing about the demo itself is public.
//
// The marketing site is a different origin, so this one route answers
// its own CORS preflight for the two site origins only. A honeypot
// field (company_fax, never rendered visibly) silently absorbs bots:
// they get the same { ok: true } and nothing is stored or emailed.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { badRequest } from '../http.js';
import { rateLimit } from '../rate-limit.js';
import { config } from '../config.js';
import { sendDemoAccessEmail } from '../services/email.js';

const ALLOWED_ORIGINS = new Set(['https://smarttablepay.com', 'https://www.smarttablepay.com']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function corsOrigin(req: { headers: Record<string, unknown> }): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function strField(b: Record<string, unknown>, name: string, max: number, required: boolean): string | null {
  const v = b[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be a string`);
  const s = v.trim();
  if (required && !s) throw badRequest(`${name} is required`);
  if (s.length > max) throw badRequest(`${name} is too long`);
  return s || null;
}

function intField(b: Record<string, unknown>, name: string): number | null {
  const v = b[name];
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw badRequest(`${name} must be a non-negative number`);
  return n;
}

export async function demoAccessRoutes(app: FastifyInstance) {
  const limiter = rateLimit({
    name: 'demo-access',
    windowMs: 60 * 60_000,
    max: 5,
    key: (req) => `ip:${req.ip}`,
  });

  app.options('/api/demo-access-requests', async (req, reply) => {
    const origin = corsOrigin(req);
    if (origin) {
      reply
        .header('Access-Control-Allow-Origin', origin)
        .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type')
        .header('Access-Control-Max-Age', '86400');
    }
    return reply.status(204).send();
  });

  app.post('/api/demo-access-requests', { preHandler: limiter }, async (req, reply) => {
    const origin = corsOrigin(req);
    if (origin) reply.header('Access-Control-Allow-Origin', origin);

    const b = (req.body ?? {}) as Record<string, unknown>;
    // Honeypot: humans never see or fill this field.
    if (typeof b.company_fax === 'string' && b.company_fax.trim()) return { ok: true };

    const fullName = strField(b, 'full_name', 120, true)!;
    const restaurantName = strField(b, 'restaurant_name', 160, true)!;
    const email = strField(b, 'email', 200, true)!;
    if (!EMAIL_RE.test(email)) throw badRequest('email is invalid');
    const phone = strField(b, 'phone', 40, true)!;
    const city = strField(b, 'city', 120, true)!;
    const posSystem = strField(b, 'pos_system', 40, false);
    const website = strField(b, 'website', 300, false);
    const message = strField(b, 'message', 2000, false);
    const locationsCount = intField(b, 'locations_count');
    const tablesCount = intField(b, 'tables_count');

    // v0.8.12 (F9-4/F9-16): dedupe — a double-submit (or an impatient
    // retry after a slow response) with the same email while a request
    // is still pending must not insert a second row or send Erfan a
    // second notification. The caller still sees the same success.
    const dupe = await query(
      `SELECT id FROM demo_access_requests WHERE lower(email) = lower($1) AND status = 'pending' LIMIT 1`,
      [email],
    );
    if ((dupe.rowCount ?? 0) > 0) return { ok: true };

    const id = randomUUID();
    const submittedAt = new Date().toISOString();
    await query(
      `INSERT INTO demo_access_requests
         (id, full_name, restaurant_name, email, phone, city, pos_system, locations_count, tables_count, website, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, fullName, restaurantName, email, phone, city, posSystem, locationsCount, tablesCount, website, message],
    );

    // The notification must never fail the request — the row is stored
    // either way and can be picked up from the database.
    try {
      await sendDemoAccessEmail(config.demoAccessNotifyEmail, {
        fullName, restaurantName, email, phone, city,
        posSystem, locationsCount, tablesCount, website, message, submittedAt,
      });
    } catch (e) {
      console.error(`[demo-access] notification email failed for request ${id}:`, e);
    }
    return { ok: true };
  });
}
