// Restaurant portal authentication: email+password login issuing per-user
// bearer tokens (30-day expiry). Tokens are 256-bit random values; only
// their SHA-256 hex digest is stored in portal_tokens.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { verifyPassword } from '../crypto.js';
import { badRequest, unauthorized } from '../http.js';

const TOKEN_TTL_DAYS = 30;

interface PortalUser {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  location_id: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  // Public: exchange email+password for a bearer token.
  // Generic error on failure (no user enumeration).
  app.post('/api/portal/login', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 320 || password.length > 200) {
      throw badRequest('email and password are required');
    }

    const u = await query<PortalUser>(
      `SELECT id, email, password_hash, role, location_id FROM portal_users WHERE email = $1`,
      [email],
    );
    const user = u.rows[0];
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
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
  if (!presented) return false;
  try {
    const r = await query(
      `SELECT 1 FROM portal_tokens WHERE token_hash = $1 AND expires_at > now()`,
      [hashToken(presented)],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false; // e.g. migration 003 not applied yet
  }
}
