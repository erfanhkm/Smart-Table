import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeConfig, config } from './config.js';
import { httpError } from './http.js';
import { migrate } from './migrate.js';
import { rateLimit } from './rate-limit.js';
import { tableRoutes } from './routes/tables.js';
import { customerRoutes } from './routes/customer.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { oauthRoutes } from './routes/oauth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { staffRoutes } from './routes/staff.js';
import { portalRoutes } from './routes/portal.js';
import { adminRoutes } from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // Refuse to boot on an unsafe production configuration (see config.ts).
  assertSafeConfig();

  // H2 fix: trust exactly TRUST_PROXY_HOPS hops, not every hop. Fastify's types
  // don't accept a raw hop-count number, so we pass an equivalent function:
  // proxy-addr calls it from the closest hop (0) outward, trusting the first N.
  const hops = config.trustProxy;
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: hops > 0 ? (_addr: string, hop: number) => hop < hops : false,
  });

  // Keep the raw JSON body for Square webhook signature verification.
  // - empty body (e.g. POST with a JSON content-type header but no payload) => undefined body
  // - reviver drops "__proto__" keys so nothing downstream can be tricked by them
  // - malformed JSON => 400 (not 500)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = body as string;
    (req as unknown as { rawBody?: string }).rawBody = raw;
    if (raw.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(raw, (k, v) => (k === '__proto__' ? undefined : v)));
    } catch {
      done(httpError(400, 'invalid JSON body'));
    }
  });

  // 4xx: the message is meant for the client. 5xx: generic message, details only in the server log
  // (Square error bodies and Postgres errors must never reach the browser).
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string; errorCode?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(500).send({ error: 'internal error' });
    }
    return reply.code(status).send({ error: e.message ?? 'bad request', ...(e.errorCode ? { code: e.errorCode } : {}) });
  });

  await app.register(fastifyStatic, { root: path.join(here, '..', 'public') });

  // Rate limits. Each limiter has its own named bucket (H1 fix: pay and general
  // never share a counter). Guest routes are keyed per table token where possible
  // so guests behind one venue Wi-Fi IP don't block each other.
  // Webhooks get a loose per-IP limit instead of a full exemption (M5 fix).
  const payLimiter = rateLimit({ name: 'pay', windowMs: 60_000, max: 20 });
  const generalLimiter = rateLimit({ name: 'general', windowMs: 60_000, max: 200 });
  const webhookLimiter = rateLimit({ name: 'webhook', windowMs: 60_000, max: 600 });
  app.addHook('onRequest', async (req, reply) => {
    // Redirect the raw Render hostname to the custom domain (v0.2).
    // portal.smarttablepay.com is the canonical host; smart-table-vc0t.onrender.com
    // is kept only as a deploy fallback and should not serve traffic directly.
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (host.endsWith('.onrender.com')) {
      const target = `https://portal.smarttablepay.com${req.url}`;
      return reply.code(301).header('Location', target).send();
    }
    if (req.url.startsWith('/api/webhooks/')) return webhookLimiter(req, reply);
    const isPay = req.url.includes('/pay') || req.url.includes('/record-external-payment');
    await (isPay ? payLimiter : generalLimiter)(req, reply);
  });

  app.get('/healthz', async () => ({ ok: true, env: config.squareEnv }));

  // Pretty URLs for the two frontends.
  app.get('/t/:token', async (_req, reply) => reply.sendFile('t/index.html'));
  app.get('/dashboard', async (_req, reply) => reply.sendFile('dashboard/index.html'));
  // Restaurant portal: strict CSP (the page's script is external; styles are
  // inline in <style> and style="" attributes, so style-src allows 'unsafe-inline'
  // — safe for styles, unlike scripts), not framable — it has Record Cash / Free Table buttons.
  app.get('/portal', async (_req, reply) =>
    reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      )
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .sendFile('portal/index.html'),
  );
  app.get('/portal/app.js', async (_req, reply) =>
    reply.header('X-Content-Type-Options', 'nosniff').type('text/javascript').sendFile('portal/app.js'),
  );

  await app.register(tableRoutes);
  await app.register(customerRoutes);
  await app.register(dashboardRoutes);
  await app.register(oauthRoutes);
  await app.register(webhookRoutes);
  await app.register(staffRoutes);
  await app.register(portalRoutes);
  await app.register(adminRoutes);
  return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const app = await buildApp();
    await migrate();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`[smart-table] listening on :${config.port} (square: ${config.squareEnv}, env: ${config.nodeEnv})`);
  } catch (e) {
    console.error('[smart-table] refusing to start:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
