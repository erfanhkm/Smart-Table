// Simple in-memory rate limiter (v0.2 pilot readiness).
//
// Per-key fixed window. Single-instance only: each Render instance tracks
// its own counters, which is fine for the pilot (one instance). If we ever
// scale horizontally, move this to Redis.
//
// IMPORTANT: every limiter instance MUST have a unique `name` — buckets are
// keyed as `${name}:${ip}` so the pay limiter and the general limiter never
// share a counter (H1 fix). Guest routes should pass a key function that
// includes the table token so guests behind one venue Wi-Fi (one IP) don't
// block each other.
//
// Usage: app.addHook('onRequest', rateLimit({ name: 'general', windowMs: 60_000, max: 200 }));
import { FastifyRequest, FastifyReply } from 'fastify';

// Loose request type: the limiter only reads .ip and .url, so it accepts any
// Fastify request variant (avoids generic-mismatch errors at call sites).
type AnyRequest = Pick<FastifyRequest, 'ip' | 'url'>;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Prune stale buckets every minute so the map doesn't grow forever
// (spoofed keys from H2-style attacks age out quickly).
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

// F5-5: hard cap between prunes. A high-rate sender minting fresh keys
// (rotating IPv6 addresses) could otherwise grow the map by hundreds of
// megabytes inside one prune interval. Evict oldest-inserted first.
const MAX_BUCKETS = 20_000;
function capBuckets(): void {
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/**
 * F5-5: bucket IPv6 clients by their /64 prefix. One /64 holds 2^64
 * addresses, so keying on the exact address hands an attacker a fresh
 * bucket per request and every per-IP limit (login, pay, webhook) is
 * decorative. IPv4 and IPv4-mapped forms pass through unchanged.
 */
export function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.toLowerCase();
  let addr = ip.split('%')[0].toLowerCase(); // strip zone id
  if (addr.includes('::')) {
    const [head, tail] = addr.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return ip;
    addr = [...headParts, ...Array(missing).fill('0'), ...tailParts].join(':');
  }
  const parts = addr.split(':');
  if (parts.length !== 8) return ip;
  return `${parts.slice(0, 4).join(':')}::/64`;
}

export function rateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: AnyRequest) => string;
}) {
  const { name, windowMs, max } = opts;
  // Default key: the client IP, IPv6-normalized to its /64 (F5-5). Custom
  // key functions (per-token guest limiters) already key on a scarce
  // resource, so their output is used as-is.
  const keyFn = opts.key ?? ((req) => normalizeIp(req.ip));
  return async (req: AnyRequest, reply: FastifyReply) => {
    // Namespace the bucket by limiter name so different limiters never share a counter.
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
      capBuckets();
    }
    b.count++;
    reply.header('X-RateLimit-Limit', max);
    reply.header('X-RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) {
      // F5-24: tell well-behaved clients when to retry instead of letting
      // them hammer the window blindly.
      reply.header('Retry-After', Math.max(1, Math.ceil((b.resetAt - now) / 1000)));
      reply.code(429);
      return reply.send({ error: 'too many requests, slow down' });
    }
  };
}
