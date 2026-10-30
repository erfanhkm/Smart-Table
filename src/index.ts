import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertSafeConfig, config } from './config.js';
import { closePool } from './db.js';
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
import { onboardingRoutes } from './routes/onboarding.js';
import { billingRoutes } from './routes/billing.js';
import { refundRoutes } from './routes/refunds.js';
import { deviceRoutes } from './routes/device.js';
import { demoAccessRoutes } from './routes/demoAccess.js';
import { processAccruedFees, resolveStuckFeeCharges, sweepMissingFees, syncAllSubscriptions } from './services/billing.js';
import { refreshExpiringTokens } from './services/pos/token-refresh.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // Refuse to boot on an unsafe production configuration (see config.ts).
  assertSafeConfig();

  // H2 fix: trust exactly TRUST_PROXY_HOPS hops, not every hop. Fastify's types
  // don't accept a raw hop-count number, so we pass an equivalent function:
  // proxy-addr calls it from the closest hop (0) outward, trusting the first N.
  const hops = config.trustProxy;
  const app = Fastify({
    // F5-16: an explicit ceiling on how long one request may run — a wedged
    // handler otherwise holds its connection (and its transaction) open
    // until a client or proxy gives up.
    requestTimeout: 30_000,
    // F-5: request logs must never contain guest table tokens — the /t/:token
    // path segment and the ?table_token= query value are bearer secrets.
    logger: (opts.logger ?? true)
      ? {
          serializers: {
            req(req: { method?: string; url?: string; hostname?: string }) {
              const url = String(req.url ?? '')
                .replace(/\/t\/[^/?#]+/g, '/t/…')
                .replace(/([?&]device_id=)[^&#]+/g, '$1…')
                // F5-15: OAuth callbacks carry code/state (and occasionally
                // tokens) in the query — same bearer-secret treatment.
                .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&#]+/g, '$1…')
                .replace(/([?&]table_token=)[^&#]+/g, '$1…');
              return { method: req.method, url, host: req.hostname };
            },
            // F5-15: pino's default err serializer copies a Postgres error's
            // own properties — including `detail`, which names the offending
            // VALUES (e.g. an email or token inside a unique violation).
            // Keep only the operationally useful, value-free fields.
            err(e: Error & { code?: string; statusCode?: number; errorCode?: string }) {
              return {
                type: e?.name ?? 'Error',
                message: e?.message ?? '',
                code: e?.code,
                statusCode: e?.statusCode,
                errorCode: e?.errorCode,
                stack: e?.stack ?? '',
              };
            },
          },
        }
      : false,
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
    const e = err as { statusCode?: number; message?: string; errorCode?: string; code?: string };
    // F5-3: a Postgres lock_timeout (55P03) is a transient contention state,
    // not a server fault — answer a retryable 409 so simultaneous payers on
    // one check see "payment in progress" instead of a generic 500.
    if (e.code === '55P03') {
      req.log.warn({ path: req.url.split('?')[0] }, 'lock timeout — answered 409');
      return reply.code(409).send({ error: 'another operation is in progress — please retry', code: 'lock_timeout' });
    }
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(500).send({ error: 'internal error' });
    }
    // F5-14: Fastify framework errors (body too large, unsupported media
    // type, malformed payloads, validation) carry internal wording — map
    // them to the same clean messages the API uses everywhere else.
    let message = e.message ?? 'bad request';
    if (typeof e.code === 'string' && e.code.startsWith('FST_ERR')) {
      message =
        status === 413 ? 'payload too large'
        : status === 415 ? 'unsupported media type'
        : status === 404 ? 'not found'
        : 'bad request';
    }
    return reply.code(status).send({ error: message, ...(e.errorCode ? { code: e.errorCode } : {}) });
  });

  // F5-14: one 404 shape for every unmatched route (Fastify's default names
  // the route and differs from the API's {error} shape).
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));

  // Security headers on EVERY response (API, portal, admin, guest page,
  // static assets). The portal route sets the same values itself; these are
  // the floor for everything else. HSTS is only honoured by browsers over
  // HTTPS, so local HTTP development is unaffected.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()');
    // Static asset caching (the static plugin sets one coarse maxAge for
    // everything; refine it here where our headers win): HTML always
    // revalidates so deploys take effect immediately, JS/CSS keep the
    // plugin's 1h, fonts/images cache for 30 days.
    const urlPath = _req.url.split('?')[0];
    if (urlPath === '/portal/app.js' || urlPath === '/t/app.js') {
      // v0.7.4: the app scripts must revalidate on every load. Setting
      // no-cache in the route handler (v0.7.2) did NOT survive — the
      // static plugin's send path applies its own Cache-Control and the
      // live response carried max-age=14400, so a stale script hid the
      // v0.7.1 fix on the owner's phone. onSend runs after the plugin,
      // so the header set here is the one that ships.
      reply.header('Cache-Control', 'no-cache');
    } else if (/^(?:\/portal|\/admin|\/dashboard|\/t)(?:\/|$)/.test(urlPath)) {
      if (/\.(?:woff2|png|jpe?g|svg|ico)$/i.test(urlPath)) {
        reply.header('Cache-Control', 'public, max-age=2592000, immutable');
      } else if (!/\.(?:js|css)$/i.test(urlPath)) {
        reply.header('Cache-Control', 'no-cache');
      }
    }
    // F5-16: API responses are per-user / per-table state — never storable
    // by any cache (extends the F4 no-store that covered /api/t/ and
    // /api/checks/ to the whole API surface).
    if (urlPath.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    // F5-10: the strict per-page CSPs are set by the NAMED routes (/portal,
    // /t/:token, /dashboard). The same files are also reachable as static
    // assets (/portal/index.html, /t/index.html, ...) where the static
    // plugin serves them with NO page CSP at all. Any HTML response that
    // reaches onSend without a CSP gets the portal's strict policy as a
    // floor, so the direct static URL is never the weakly-protected one.
    const ctype = reply.getHeader('content-type');
    if (
      typeof ctype === 'string' &&
      ctype.includes('text/html') &&
      !reply.getHeader('content-security-policy')
    ) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://*.squarecdn.com https://*.squareup.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.squarecdn.com https://*.squareup.com; frame-src https://*.squarecdn.com https://*.squareup.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
  });

  await app.register(fastifyStatic, {
    root: path.join(here, '..', 'public'),
    maxAge: '1h', // base policy; the onSend hook above refines it per asset type
  });

  // Rate limits. Each limiter has its own named bucket (H1 fix: pay and general
  // never share a counter). These global limiters key by IP; guest WRITE
  // routes additionally carry a per-table-token limiter (C-8, in
  // routes/customer.ts) so guests behind one venue Wi-Fi IP don't block
  // each other and one token can't spray writes.
  // Webhooks get a loose per-IP limit instead of a full exemption (M5 fix).
  const payLimiter = rateLimit({ name: 'pay', windowMs: 60_000, max: 20 });
  const generalLimiter = rateLimit({ name: 'general', windowMs: 60_000, max: 200 });
  const webhookLimiter = rateLimit({ name: 'webhook', windowMs: 60_000, max: 600 });
  // v0.8.14 (F11-6): device traffic gets its own generous bucket. A floor
  // of STT-101s polls state every 5s from behind one venue NAT; sharing
  // the 200/min general bucket with guest traffic let a busy rush 429 the
  // restaurant's own devices. 600/min/IP is far above any real floor
  // (dozens of devices) while staying bounded.
  const deviceLimiter = rateLimit({ name: 'device', windowMs: 60_000, max: 600 });
  app.addHook('onRequest', async (req, reply) => {
    // Redirect the raw Render hostname to the custom domain (v0.2).
    // portal.smarttablepay.com is the canonical host; smart-table-vc0t.onrender.com
    // is kept only as a deploy fallback and should not serve traffic directly.
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (host.endsWith('.onrender.com')) {
      const target = `https://portal.smarttablepay.com${req.url}`;
      // F5-13: 301 makes clients rewrite POSTs into GETs and drop bodies —
      // a webhook or API caller landing on the fallback host lost its
      // payload silently. 308 preserves method and body for non-GET.
      return reply.code(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308).header('Location', target).send();
    }
    if (req.url.startsWith('/api/webhooks/')) return webhookLimiter(req, reply);
    // v0.8.14 (F11-6): device paths leave the general bucket (see above).
    if (req.url.split('?')[0].startsWith('/api/device/')) return deviceLimiter(req, reply);
    // G-5: match the two money-moving POST routes EXACTLY. The old
    // substring test (url.includes('/pay')) also swept read-only routes
    // like GET /api/portal/checks/:id/payments and /api/admin/payments
    // into the tight 20/min pay bucket, so a busy portal could lock
    // itself out of its own payment history.
    const pathname = req.url.split('?')[0];
    const isPay =
      req.method === 'POST' &&
      (/^\/api\/checks\/[^/]+\/pay$/.test(pathname) ||
        /^\/api\/checks\/[^/]+\/record-external-payment$/.test(pathname));
    await (isPay ? payLimiter : generalLimiter)(req, reply);
  });

  // F5-16: guest payloads are tiny (an order, a payment token, a rating).
  // The framework's 1 MB default body limit on these public routes only
  // serves memory pressure — cap declared bodies at 64 KB up front.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0].startsWith('/api/t/')) {
      const len = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(len) && len > 65_536) {
        return reply.code(413).send({ error: 'payload too large' });
      }
    }
  });

  // F-11: healthz reports liveness only — the Square environment is
  // deployment detail that doesn't belong on a public endpoint.
  app.get('/healthz', async () => ({ ok: true }));

  // Apple Pay domain verification (v0.3 wallets). Square issues this file per
  // domain when the merchant registers the domain for Apple Pay on the web;
  // its contents come from the APPLE_PAY_DOMAIN_ASSOCIATION env var. 404 when
  // unconfigured — Apple Pay then stays unavailable, Google Pay is unaffected.
  // F-11: the association file is read ONCE and cached — it changes only
  // when a new domain is registered with Square (a redeploy).
  let applePayAssociationCache: string | null = null;
  app.get('/.well-known/apple-developer-merchantid-domain-association', async (_req, reply) => {
    // Prefer the committed file (public/.well-known/...): a 9 KB value
    // pasted into a dashboard env field silently lost ~330 characters
    // mid-string once (2026-10-20) and Square kept rejecting the domain
    // with 'partial response'. A file in git is byte-exact. The env var
    // remains as a fallback.
    if (applePayAssociationCache === null) {
      let content = '';
      try {
        content = fs
          .readFileSync(path.join(here, '..', 'public', '.well-known', 'apple-developer-merchantid-domain-association'), 'utf8')
          .trim();
      } catch { /* fall through to env */ }
      if (!content) content = config.applePayDomainAssociation;
      applePayAssociationCache = content;
    }
    if (!applePayAssociationCache) return reply.code(404).send({ error: 'not configured' });
    return reply.type('text/plain').send(applePayAssociationCache);
  });

  // Pretty URLs for the two frontends.
  // Guest page CSP (F-4): the app script now lives in /t/app.js, so
  // script-src no longer needs 'unsafe-inline'. The origin allowlist is the
  // containment — the page may only load scripts from / talk to / frame
  // content from the payment providers it uses (Square card + wallets,
  // Clover tokens, Helcim modal, Google Pay sheet). img-src allows https:
  // because menu photos are served from POS catalogs.
  app.get('/t/:token', async (_req, reply) =>
    reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://*.squarecdn.com https://*.squareup.com https://*.clover.com https://*.helcim.com https://pay.google.com; connect-src 'self' https://*.squarecdn.com https://*.squareup.com https://*.clover.com https://*.helcim.com https://apple-pay-gateway.apple.com; frame-src https://*.squarecdn.com https://*.squareup.com https://*.helcim.com https://pay.google.com; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      )
      .sendFile('t/index.html'),
  );
  // F-4 follow-through: the guest app script is an external file now, but
  // the /t/:token route above would happily swallow /t/app.js and return
  // the HTML page for it (wrong MIME -> browsers refuse to execute). The
  // explicit static route wins over the parametric one (same pattern as
  // /portal/app.js).
  app.get('/t/app.js', async (_req, reply) =>
    reply
      .header('X-Content-Type-Options', 'nosniff')
      // v0.7.2: app scripts must revalidate — the static plugin's 1h maxAge
      // served a stale portal app.js after the v0.7.1 fix deploy, so the
      // fix looked like it never shipped. no-cache still allows 304s.
      .header('Cache-Control', 'no-cache')
      .type('text/javascript')
      .sendFile('t/app.js'),
  );
  // F-11: /dashboard previously shipped with no CSP at all. Its script is
  // inline today, so script-src keeps 'unsafe-inline' (same posture as the
  // guest page until its script is externalized); everything else is
  // self-only and unframable.
  app.get('/dashboard', async (_req, reply) =>
    reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      )
      .sendFile('dashboard/index.html'),
  );
  // Restaurant portal: strict CSP (the page's script is external; styles are
  // inline in <style> and style="" attributes, so style-src allows 'unsafe-inline'
  // — safe for styles, unlike scripts), not framable — it has Record Cash / Free Table buttons.
  // Square is allowlisted for the Billing "Add card" form (Web Payments SDK:
  // script + card iframe + tokenization calls) — without it the SDK script was
  // CSP-blocked and the card form silently never rendered (bug fix 2026-10-21).
  // Same Square hosts as the guest page above, which is proven in production.
  app.get('/portal', async (_req, reply) =>
    reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://*.squarecdn.com https://*.squareup.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.squarecdn.com https://*.squareup.com; frame-src https://*.squarecdn.com https://*.squareup.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      )
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .sendFile('portal/index.html'),
  );
  app.get('/portal/app.js', async (_req, reply) =>
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-cache') // v0.7.2: see /t/app.js above
      .type('text/javascript')
      .sendFile('portal/app.js'),
  );

  // The portal subdomain's root used to 404 — send it to the portal login
  // (owner ask, 2026-10-21: "لینک پرتال کار نمیکنه" was the bare root URL).
  app.get('/', async (_req, reply) => reply.redirect('/portal'));

  await app.register(tableRoutes);
  await app.register(customerRoutes);
  await app.register(dashboardRoutes);
  await app.register(oauthRoutes);
  await app.register(webhookRoutes);
  await app.register(staffRoutes);
  await app.register(portalRoutes);
  await app.register(adminRoutes);
  await app.register(onboardingRoutes);
  await app.register(billingRoutes);
  await app.register(refundRoutes);
  await app.register(deviceRoutes);
  await app.register(demoAccessRoutes);

  // v0.4 billing: collect accrued commission fees on a slow timer (the
  // processor itself decides what is due: >= $50 accrued, or oldest fee
  // >= 25 days old). Skipped under pg-mem (tests) where no real Square
  // account exists.
  if (!config.usePgMem) {
    const runBilling = () =>
      // F2-1: refresh every stored subscription from Square FIRST — plan
      // decisions below (and every guest payment) read the stored state,
      // and a renewal nobody looked at must not flip a subscriber to
      // commission. Then the F1-6 missing-fee sweep, collection, and the
      // F2-5 stuck-batch resolver.
      syncAllSubscriptions()
        .catch((e) => app.log.error(e, '[billing] scheduled subscription sync failed'))
        .then(() => sweepMissingFees())
        .then((s) => {
          if (s.recorded > 0 || s.squareMissing > 0) {
            app.log.warn(s, '[billing] missing-fee sweep found gaps');
          }
        })
        .catch((e) => app.log.error(e, '[billing] missing-fee sweep failed'))
        .then(() => processAccruedFees())
        .then((r) => {
          if (r.locationsCharged > 0) {
            app.log.info(r, '[billing] accrued commission collected');
          }
        })
        .catch((e) => app.log.error(e, '[billing] accrued fee processing failed'))
        .then(() => resolveStuckFeeCharges())
        .then((r) => {
          if (r.resolved > 0 || r.manualReview > 0) {
            app.log.warn(r, '[billing] stuck fee-charge batches need attention');
          }
        })
        .catch((e) => app.log.error(e, '[billing] stuck fee-charge resolver failed'));
    setTimeout(runBilling, 60_000).unref();
    setInterval(runBilling, 6 * 60 * 60 * 1000).unref();
    // D-7 backstop: refresh Square OAuth tokens before they expire (the
    // on-demand refresh in getLocationPos is the primary path; this sweep
    // catches idle restaurants and logs unrefreshable credentials).
    const runTokenRefresh = () =>
      refreshExpiringTokens()
        .then((r) => {
          if (r.refreshed > 0 || r.failed > 0 || r.unrefreshable > 0) {
            app.log.warn(r, '[token-refresh] sweep finished with items needing attention');
          }
        })
        .catch((e) => app.log.error(e, '[token-refresh] sweep failed'));
    setTimeout(runTokenRefresh, 90_000).unref();
    setInterval(runTokenRefresh, 6 * 60 * 60 * 1000).unref();
  }
  return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // F5-6: log process-level failures instead of dying silently, and shut
  // down gracefully — Render sends SIGTERM on every deploy, and the old
  // behaviour killed in-flight requests mid-flight (a guest payment could
  // be charged at the POS and lose its bookkeeping to the restart).
  // app.close() stops accepting new connections and drains the in-flight
  // ones; a hard deadline keeps us inside Render's kill window.
  process.on('unhandledRejection', (e) => {
    console.error('[smart-table] unhandled rejection:', e);
  });
  try {
    const app = await buildApp();
    await migrate();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`[smart-table] listening on :${config.port} (square: ${config.squareEnv}, env: ${config.nodeEnv})`);
    let closing = false;
    const shutdown = (signal: string) => {
      if (closing) return;
      closing = true;
      console.log(`[smart-table] ${signal} — draining in-flight requests…`);
      setTimeout(() => process.exit(1), 10_000).unref();
      app
        .close()
        .then(() => closePool())
        .then(() => process.exit(0))
        .catch((e) => {
          console.error('[smart-table] graceful shutdown failed:', e);
          process.exit(1);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (e) {
    console.error('[smart-table] refusing to start:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
