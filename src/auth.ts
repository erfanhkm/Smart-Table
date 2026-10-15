// Staff authentication: a single bearer token from STAFF_API_TOKEN,
// or a per-user portal token issued by POST /api/portal/login.
// (Full RBAC is a later batch; this closes the "anyone can call
// the staff API" hole.) Fail-closed: if STAFF_API_TOKEN is unset nothing passes.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { getPortalUser, type PortalIdentity } from './routes/portal.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the caller authenticated with a per-user portal token. */
    portalUser?: PortalIdentity;
  }
}

// Hash both sides so timingSafeEqual always gets equal-length buffers
// (and the token length is not leaked through an early length check).
const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export function isValidStaffToken(presented: string, expected: string = config.staffApiToken): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function extractBearer(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  return m ? m[1] : null;
}

/** Fastify onRequest hook: 401 JSON unless a valid staff bearer token or portal token is presented.
 * On a portal token the user's identity is attached to the request for per-user scoping. */
export async function requireStaff(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const token = extractBearer(req.headers.authorization);
  if (token && isValidStaffToken(token)) return undefined;
  if (token) {
    const user = await getPortalUser(token);
    if (user) {
      req.portalUser = user;
      return undefined;
    }
  }
  req.log.warn({ url: req.url, ip: req.ip }, 'staff auth failed');
  return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
}

/** Spread into a route definition: app.post(path, staffOnly, handler). */
export const staffOnly = { onRequest: requireStaff };
