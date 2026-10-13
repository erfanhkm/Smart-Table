import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeConfig, config } from './config.js';
import { httpError } from './http.js';
import { migrate } from './migrate.js';
import { tableRoutes } from './routes/tables.js';
import { customerRoutes } from './routes/customer.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { oauthRoutes } from './routes/oauth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { staffRoutes } from './routes/staff.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // Refuse to boot on an unsafe production configuration (see config.ts).
  assertSafeConfig();

  const app = Fastify({ logger: opts.logger ?? true, trustProxy: config.trustProxy });

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

  app.get('/healthz', async () => ({ ok: true, env: config.squareEnv }));

  // Pretty URLs for the two frontends.
  app.get('/t/:token', async (_req, reply) => reply.sendFile('t/index.html'));
  app.get('/dashboard', async (_req, reply) => reply.sendFile('dashboard/index.html'));

  await app.register(tableRoutes);
  await app.register(customerRoutes);
  await app.register(dashboardRoutes);
  await app.register(oauthRoutes);
  await app.register(webhookRoutes);
  await app.register(staffRoutes);
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
