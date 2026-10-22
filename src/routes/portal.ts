// Restaurant portal authentication: email+password login issuing per-user
// bearer tokens (7-day expiry). Tokens are 256-bit random values; only
// their SHA-256 hex digest is stored in portal_tokens.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db.js';
import { verifyPassword } from '../crypto.js';
import { badRequest, unauthorized } from '../http.js';

const TOKEN_TTL_DAYS = 7;

// Simple in-memory login rate limiter: 10 attempts per 5 minutes, tracked per
// IP AND per email (v0.6.4: the per-IP counter alone let an attacker rotate
// IPs against one account; the per-email counter closes that).
// (Single-process; a distributed limiter comes with production hardening.)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const loginAttemptsByEmail = new Map<string, { count: number; resetAt: number }>();
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

// Prune expired entries so the maps can't grow without bound (v0.6.4).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now >= v.resetAt) loginAttempts.delete(k);
  for (const [k, v] of loginAttemptsByEmail) if (now >= v.resetAt) loginAttemptsByEmail.delete(k);
}, 60 * 1000).unref();

function bumpAndAllowed(map: Map<string, { count: number; resetAt: number }>, key: string): boolean {
  const now = Date.now();
  const e = map.get(key);
  if (!e || now >= e.resetAt) {
    map.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  e.count += 1;
  return e.count <= LOGIN_LIMIT;
}

function loginAllowed(ip: string, email: string): boolean {
  const ipOk = bumpAndAllowed(loginAttempts, ip);
  const emailOk = bumpAndAllowed(loginAttemptsByEmail, email);
  return ipOk && emailOk;
}

// Precomputed scrypt hash of a throwaway password. Unknown-email logins verify
// against this so they pay the same scrypt cost as real ones — otherwise the
// response time reveals which emails have accounts (v0.6.4, mirrors admin.ts).
const DUMMY_PASSWORD_HASH =
  'scrypt$82718a0d4fc3d71d0bbd1a295ad48a7d$56c2749fc37bb2420f83ee4258029092ce9140412cb272d321549da40950d310a6faa951282f5e66c20d8be96ffd98fbaa2dc9d48adc19345dcd8534c1cc53e1';

export interface PortalIdentity {
  id: string;
  email: string;
  role: string;
  location_id: string;
}

interface PortalUser extends PortalIdentity {
  password_hash: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  // Public: exchange email+password for a bearer token.
  // Generic error on failure (no user enumeration). Rate-limited per IP.
  app.post('/api/portal/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!loginAllowed(req.ip, email || '-')) {
      return reply.code(429).send({ error: 'too many login attempts, try again in a few minutes' });
    }
    if (!email || !password || email.length > 320 || password.length > 200) {
      throw badRequest('email and password are required');
    }

    const u = await query<PortalUser>(
      `SELECT id, email, password_hash, role, location_id FROM portal_users WHERE email = $1`,
      [email],
    );
    const user = u.rows[0];
    // Always run scrypt — against the dummy hash when the email is unknown —
    // so timing does not reveal which emails exist (v0.6.4).
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
    if (!ok || !user) throw unauthorized('invalid email or password');

    const token = randomBytes(32).toString('hex');
    await query(
      `INSERT INTO portal_tokens(token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [hashToken(token), user.id, String(TOKEN_TTL_DAYS)],
    );
    // Opportunistic cleanup of expired tokens.
    await query(`DELETE FROM portal_tokens WHERE expires_at <= now()`);

    return {
      token,
      user: { email: user.email, role: user.role, location_id: user.location_id },
    };
  });

  // Authenticated: invalidate the calling token (logout).
  app.post('/api/portal/logout', async (req) => {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.headers.authorization ?? '');
    if (m) await query(`DELETE FROM portal_tokens WHERE token_hash = $1`, [hashToken(m[1])]);
    return { ok: true };
  });
}

/** Validate a portal bearer token against portal_tokens (unexpired). Fail-closed. */
export async function isValidPortalToken(presented: string): Promise<boolean> {
  return (await getPortalUser(presented)) !== null;
}

/** Resolve a portal bearer token to the user's identity (null when invalid/expired). */
export async function getPortalUser(presented: string): Promise<PortalIdentity | null> {
  if (!presented) return null;
  try {
    const r = await query<PortalIdentity>(
      `SELECT u.id, u.email, u.role, u.location_id
       FROM portal_tokens t JOIN portal_users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.expires_at > now()`,
      [hashToken(presented)],
    );
    return r.rows[0] ?? null;
  } catch (e) {
    // Fail closed, but never silently: a broken lookup (e.g. migration 003 not
    // applied yet) must be visible in the logs, not look like a bad token.
    console.error('[portal] getPortalUser lookup failed:', e);
    return null;
  }
}
