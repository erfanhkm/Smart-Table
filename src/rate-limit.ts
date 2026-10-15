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

export function rateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: AnyRequest) => string;
}) {
  const { name, windowMs, max } = opts;
  const keyFn = opts.key ?? ((req) => req.ip);
  return async (req: AnyRequest, reply: FastifyReply) => {
    // Namespace the bucket by limiter name so different limiters never share a counter.
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    reply.header('X-RateLimit-Limit', max);
    reply.header('X-RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) {
      reply.code(429);
      return reply.send({ error: 'too many requests, slow down' });
    }
  };
}
