import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { tableRoutes } from './routes/tables.js';
import { customerRoutes } from './routes/customer.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { oauthRoutes } from './routes/oauth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { staffRoutes } from './routes/staff.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // Keep the raw JSON body for Square webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: e.message ?? 'internal error' });
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
  const app = await buildApp();
  await migrate();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[smart-table] listening on :${config.port} (square: ${config.squareEnv})`);
}
