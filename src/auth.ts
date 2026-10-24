// Staff authentication: a single bearer token from STAFF_API_TOKEN,
// or a per-user portal token issued by POST /api/portal/login.
// (Full RBAC is a later batch; this closes the "anyone can call
// the staff API" hole.) Fail-closed: if STAFF_API_TOKEN is unset nothing passes.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { badRequest, forbidden, notFound } from './http.js';
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
  if (token && isValidStaffToken(token)) {
    // F5-1 (mitigation): the shared staff token bypasses tenant scoping BY
    // DESIGN (it is the venue staff-device credential) — so every use is
    // audit-logged with route + caller, giving the trail Claude's review
    // found missing. The structural fix (per-location, revocable device
    // tokens) is scheduled pre-pilot with the C-14/A-13 token work.
    req.log.info({ path: req.url.split('?')[0], ip: req.ip }, 'staff token authenticated');
    return undefined;
  }
  if (token) {
    const user = await getPortalUser(token);
    if (user) {
      req.portalUser = user;
      return undefined;
    }
  }
  // Path only, never the query string: URLs here can carry table tokens.
  req.log.warn({ path: req.url.split('?')[0], ip: req.ip }, 'staff auth failed');
  return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
}

/** Spread into a route definition: app.post(path, staffOnly, handler). */
export const staffOnly = { onRequest: requireStaff };

// ---- Tenant scoping (v0.6.5, Claude review C-1/C-2/C-10) --------------------
// Portal users are pinned to their own location. Staff-token callers carry no
// portalUser and stay global BY DESIGN (the shared staff credential is the
// venue's own staff device token). Cross-tenant access answers 404 so a
// portal user can't probe which IDs exist at other restaurants.

/** Assert that a row's location belongs to the calling portal user. */
export function assertPortalLocation(req: FastifyRequest, locationId: string | null | undefined): void {
  const u = req.portalUser;
  if (u && (!locationId || u.location_id !== locationId)) throw notFound('not found');
}

/** Role gate for portal users (refunds, cash recording, settings, QR, billing writes). */
export function requirePortalRole(req: FastifyRequest, ...roles: string[]): void {
  const u = req.portalUser;
  // F5-19: the client gets a generic denial — the required roles are an
  // internal authorization detail, not something an error should teach a
  // caller probing the API.
  if (u && !roles.includes(u.role)) throw forbidden('forbidden');
}

/**
 * The location a request may act on: a portal user's own location (a foreign
 * location_id in the request is a 404), or the explicitly given one for
 * staff-token callers.
 */
export function scopedLocationId(req: FastifyRequest, given?: string | null): string {
  const u = req.portalUser;
  if (u) {
    if (given && given !== u.location_id) throw notFound('location not found');
    return u.location_id;
  }
  if (!given) throw badRequest('location_id is required');
  return given;
}
