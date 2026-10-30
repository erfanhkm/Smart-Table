// Device API (v0.7): STT-101 tabletop terminals.
//
// Pairing: the portal generates a single-use 8-digit claim code for a table
// (10-minute expiry, stored hashed). The device exchanges it for its own
// bearer token (hashed at rest, same standard as portal tokens) and receives
// the table's QR token so it can render the guest QR locally, offline.
// Re-pairing a table revokes the previous unit.
//
// Device surface (bearer = device token):
//   POST /api/device/claim            (no auth — the code IS the credential)
//   GET  /api/device/state            table/check/service state + pending print job ids
//   POST /api/device/call             physical service button -> waiter-call event
//   GET  /api/device/print-jobs       pending jobs (server-formatted receipt lines)
//   POST /api/device/print-jobs/:id/ack
//   POST /api/device/heartbeat        firmware / battery / paper health
//
// Portal surface (staff auth, tenant-scoped like every portal route):
//   POST /api/portal/devices/claim-code   { table_id } -> { code, expires_at }
//   GET  /api/portal/devices              health list for the location
//   POST /api/portal/devices/:id/revoke
//   POST /api/tables/:id/print-job        { lines[] } -> { job_id }
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { query, withTx } from '../db.js';
import { badRequest, conflict, notFound } from '../http.js';
import { assertPortalLocation, extractBearer, requirePortalRole, scopedLocationId, staffOnly } from '../auth.js';
import { hashToken } from './portal.js';
import { raiseServiceAlert } from '../services/alerts.js';
import { rateLimit } from '../rate-limit.js';
import { config } from '../config.js';
import { logAudit } from '../services/audit.js';
import { sanitizePrintLines } from '../services/receiptLines.js';

// v0.8.14 (F11-1): claim codes are 8 digits (~27 bits) — a plain SHA-256 of
// the code is a dictionary waiting to be enumerated offline. Store them
// HMAC-keyed with the deployment's encryption key instead, so a database
// copy alone reveals nothing. Codes minted before this change are stored
// as legacy SHA-256; the claim path tries the HMAC hash first and falls
// back to the legacy hash (codes live 10 minutes, so the fallback only
// bridges the deploy window and can be dropped in a later release).
function claimCodeKey(): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(config.encryptionKeyHex)) return Buffer.from(config.encryptionKeyHex, 'hex');
  return createHash('sha256').update(`stt101-claim-key:${config.staffApiToken}`).digest();
}

export function hashClaimCode(code: string): string {
  return createHmac('sha256', claimCodeKey()).update(`stt101-claim-code:${code}`, 'utf8').digest('hex');
}

// v0.8.14 (F11-1): the claim endpoint is the one unauthenticated
// credential-issuing surface. Give it a dedicated per-IP budget sized to
// the code lifetime — pairing is a rare staff action, so 15 attempts per
// 10 minutes is generous for humans and useless for enumeration. The
// generic limiter counts successes too, which is correct here: a minted
// code is single-use, so a successful claim needs no follow-up attempts.
const claimLimiter = rateLimit({ name: 'device-claim', windowMs: 10 * 60_000, max: 15 });

// v0.8.14 (F11-3/F11-4): print-queue bounds. A device pulls at most 20 jobs
// per fetch, so more than 20 active (pending+sent) jobs per device is a
// runaway queue, not a backlog; and a job nobody collected within 15
// minutes is a stale receipt — it must never print hours later.
export const MAX_ACTIVE_PRINT_JOBS = 20;
const PRINT_JOB_TTL_MS = 15 * 60_000;

export async function countActivePrintJobs(deviceId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM print_jobs WHERE device_id = $1 AND status IN ('pending','sent')`,
    [deviceId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Fail (server-side) any of the device's active jobs older than the TTL. */
async function expireStalePrintJobs(deviceId: string): Promise<void> {
  await query(
    `UPDATE print_jobs SET status = 'failed', error = 'expired before printing'
     WHERE device_id = $1 AND status IN ('pending','sent') AND created_at < $2`,
    [deviceId, new Date(Date.now() - PRINT_JOB_TTL_MS)],
  );
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (!err) return false;
  if (err.code === '23505') return true;
  return typeof err.message === 'string' && /unique constraint|duplicate key/i.test(err.message);
}

interface DeviceIdentity {
  id: string;
  location_id: string;
  table_id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the caller authenticated with a paired device token. */
    device?: DeviceIdentity;
  }
}

async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const token = extractBearer(req.headers.authorization);
  if (token) {
    const r = await query<{ id: string; location_id: string; table_id: string }>(
      `SELECT id, location_id, table_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    if (r.rowCount > 0) {
      req.device = r.rows[0];
      return undefined;
    }
  }
  req.log.warn({ path: req.url.split('?')[0], ip: req.ip }, 'device auth failed');
  return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
}

const deviceOnly = { onRequest: requireDevice };

function device(req: FastifyRequest): DeviceIdentity {
  // Guaranteed by the deviceOnly onRequest hook on every route that calls this.
  return req.device as DeviceIdentity;
}

export async function deviceRoutes(app: FastifyInstance) {
  // ---- Pairing -------------------------------------------------------------
  // v0.8.14 (F11-1/F11-2): one generic error for unknown / used / expired —
  // distinguishable answers would confirm a probed code exists. The code is
  // consumed by ONE conditional UPDATE (unused + unexpired in the
  // predicate), so a racing second claim finds nothing; revoke + insert
  // then run in a single transaction with the partial unique index as the
  // race arbiter.
  app.post('/api/device/claim', { preHandler: claimLimiter }, async (req) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string' || !/^\d{8}$/.test(code)) {
      throw badRequest('claim code is required (8 digits)');
    }
    let cc: { location_id: string; table_id: string } | undefined;
    for (const hash of [hashClaimCode(code), hashToken(code)]) {
      const r = await query<{ location_id: string; table_id: string }>(
        `UPDATE device_claim_codes SET used_at = now()
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING location_id, table_id`,
        [hash],
      );
      if (r.rowCount > 0) {
        cc = r.rows[0];
        break;
      }
    }
    if (!cc) {
      req.log.warn({ ip: req.ip }, 'device claim failed');
      throw badRequest('invalid claim code');
    }

    const t = await query<{ id: string; name: string; qr_token: string }>(
      `SELECT id, name, qr_token FROM tables WHERE id = $1`,
      [cc.table_id],
    );
    if (t.rowCount === 0) throw badRequest('table no longer exists');

    // Re-pairing replaces the table's previous unit — atomically, so a
    // concurrent claim for the same table can't interleave revoke/insert.
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    await withTx(async (client) => {
      await client.query(`UPDATE devices SET revoked_at = now() WHERE table_id = $1 AND revoked_at IS NULL`, [
        cc.table_id,
      ]);
      await client.query(`INSERT INTO devices(id, location_id, table_id, token_hash) VALUES ($1,$2,$3,$4)`, [
        id,
        cc.location_id,
        cc.table_id,
        hashToken(token),
      ]);
    });
    // v0.8.14 (F11-5): pairing is a credential-issuing event — audit it
    // like the staff surfaces (best-effort, never blocks the pairing).
    await logAudit({
      actorType: 'system',
      ip: req.ip,
      action: 'device.paired',
      locationId: cc.location_id,
      target: id,
      detail: `table ${cc.table_id}`,
    });
    return {
      device_token: token,
      device_id: id,
      table: { id: t.rows[0].id, name: t.rows[0].name },
      table_token: t.rows[0].qr_token,
    };
  });

  // ---- State ---------------------------------------------------------------
  app.get('/api/device/state', deviceOnly, async (req) => {
    const d = device(req);
    // v0.8.14 (F11-6): last_seen is a freshness signal for the portal, not
    // a per-poll write — at a 5s poll per device the unconditional UPDATE
    // was pure write load. Refresh at most every 30s.
    await query(`UPDATE devices SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)`, [
      d.id,
      new Date(Date.now() - 30_000),
    ]);

    const t = await query<{ name: string; state: string; qr_token: string }>(
      `SELECT name, state, qr_token FROM tables WHERE id = $1`,
      [d.table_id],
    );
    const table = t.rows[0];

    const open = await query(
      `SELECT id FROM checks WHERE table_id = $1 AND state = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
      [d.table_id],
    );
    let checkState = 'none';
    if (open.rowCount > 0) {
      checkState = 'awaiting_payment';
    } else {
      // Paid window: the table's newest settled payment on a completed check
      // within the last 60s drives the green "paid" LED state. v0.8.14
      // (F11-6): the scan is bounded to the last 5 minutes of payments —
      // the MAX() previously walked the table's entire payment history on
      // every 5s poll; the 60s decision window is unchanged.
      const paid = await query<{ last_paid: string | null }>(
        `SELECT MAX(p.created_at) AS last_paid FROM payments p JOIN checks c ON c.id = p.check_id
         WHERE c.table_id = $1 AND c.state = 'COMPLETED' AND p.status IN ('AUTHORIZED','COMPLETED')
           AND p.created_at > $2`,
        [d.table_id, new Date(Date.now() - 5 * 60_000)],
      );
      const lp = paid.rows[0]?.last_paid ? new Date(paid.rows[0].last_paid).getTime() : 0;
      if (lp && Date.now() - lp < 60_000) checkState = 'paid';
    }

    const ev = await query<{ type: string; created_at: string }>(
      `SELECT type, created_at FROM events WHERE table_id = $1 AND type IN ('call_waiter','waiter_ack')
       ORDER BY created_at DESC LIMIT 1`,
      [d.table_id],
    );
    let serviceState = 'none';
    if (ev.rowCount > 0) {
      if (ev.rows[0].type === 'call_waiter') serviceState = 'pending';
      else if (Date.now() - new Date(ev.rows[0].created_at).getTime() < 20_000) serviceState = 'acked';
    }

    // v0.8.14 (F11-4): never advertise a job the fetch path would refuse
    // as expired.
    await expireStalePrintJobs(d.id);
    const jobs = await query<{ id: string }>(
      `SELECT id FROM print_jobs WHERE device_id = $1 AND status IN ('pending','sent')
       ORDER BY created_at ASC LIMIT 20`,
      [d.id],
    );
    return {
      table: { id: d.table_id, name: table?.name ?? null },
      // v0.8.14 (F11-7): the CURRENT table token, additively — the device
      // received it once at claim time, so after a staff QR rotation it
      // kept rendering the dead code. A future firmware can refresh its
      // QR from this field; current firmware ignores unknown fields.
      table_token: table?.qr_token ?? null,
      table_status: (table?.state ?? 'FREE').toLowerCase(),
      check_state: checkState,
      service_state: serviceState,
      print_jobs: jobs.rows.map((j) => j.id),
      server_time: new Date().toISOString(),
    };
  });

  // ---- Service button --------------------------------------------------------
  app.post('/api/device/call', deviceOnly, async (req) => {
    const d = device(req);
    // Button-bounce guard: a press within 20s of the previous call is the
    // same press, not a new request.
    const last = await query<{ created_at: string }>(
      `SELECT created_at FROM events WHERE table_id = $1 AND type = 'call_waiter' ORDER BY created_at DESC LIMIT 1`,
      [d.table_id],
    );
    if (last.rowCount > 0 && Date.now() - new Date(last.rows[0].created_at).getTime() < 20_000) {
      return { ok: true, deduped: true };
    }
    await query(`INSERT INTO events(id, table_id, type) VALUES ($1,$2,'call_waiter')`, [randomUUID(), d.table_id]);
    // Same Service Recovery rule as the guest button: 3+ calls in 10 minutes
    // means the guest feels ignored — raise an alert (deduped while open).
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const recent = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE table_id = $1 AND type = 'call_waiter' AND created_at > $2`,
      [d.table_id, cutoff],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= 3) {
      await raiseServiceAlert({ locationId: d.location_id, tableId: d.table_id, kind: 'waiter_repeat' });
    }
    return { ok: true };
  });

  // ---- Print jobs ------------------------------------------------------------
  app.get('/api/device/print-jobs', deviceOnly, async (req) => {
    const d = device(req);
    // v0.8.14 (F11-4): jobs nobody collected within the TTL fail
    // server-side instead of printing whenever the device returns.
    await expireStalePrintJobs(d.id);
    const r = await query<{ id: string; lines: string; check_id: string | null; created_at: string }>(
      `SELECT id, lines, check_id, created_at FROM print_jobs
       WHERE device_id = $1 AND status IN ('pending','sent') ORDER BY created_at ASC LIMIT 20`,
      [d.id],
    );
    // At-least-once delivery: jobs stay visible until acked; fetched
    // 'pending' jobs are marked 'sent' so the portal can tell them apart.
    // v0.8.14 (F11-4): mark ONLY the rows this fetch actually returned —
    // the old bulk update also flipped rows beyond the LIMIT.
    if (r.rowCount > 0) {
      const ids = r.rows.map((j) => j.id);
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
      await query(`UPDATE print_jobs SET status = 'sent' WHERE device_id = $1 AND status = 'pending' AND id IN (${placeholders})`, [
        d.id,
        ...ids,
      ]);
    }
    return {
      jobs: r.rows.map((j) => {
        let lines: string[] = [];
        try {
          const parsed = JSON.parse(j.lines) as unknown;
          if (Array.isArray(parsed)) lines = parsed.filter((x): x is string => typeof x === 'string');
        } catch { /* a malformed job prints nothing rather than garbage */ }
        return { id: j.id, lines, check_id: j.check_id, created_at: j.created_at };
      }),
    };
  });

  app.post('/api/device/print-jobs/:id/ack', deviceOnly, async (req) => {
    const d = device(req);
    const jobId = (req.params as { id: string }).id;
    const { status, error } = (req.body ?? {}) as { status?: unknown; error?: unknown };
    if (status !== 'done' && status !== 'failed') throw badRequest("status must be 'done' or 'failed'");
    // v0.8.14 (F11-4): the transition is constrained to the job's live
    // states in the UPDATE itself — the old select-then-update let a
    // re-ack silently overwrite a terminal state (done -> failed).
    const r = await query(
      `UPDATE print_jobs SET status = $1, error = $2, acked_at = now()
       WHERE id = $3 AND device_id = $4 AND status IN ('pending','sent') RETURNING id`,
      [status, typeof error === 'string' ? error.slice(0, 200) : null, jobId, d.id],
    );
    if (r.rowCount === 0) {
      const exists = await query(`SELECT id FROM print_jobs WHERE id = $1 AND device_id = $2`, [jobId, d.id]);
      if (exists.rowCount === 0) throw notFound('print job not found');
      throw conflict('print job already finalized');
    }
    return { ok: true };
  });

  // ---- Heartbeat ---------------------------------------------------------------
  app.post('/api/device/heartbeat', deviceOnly, async (req) => {
    const d = device(req);
    const b = (req.body ?? {}) as {
      fw_version?: unknown;
      battery_pct?: unknown;
      charging?: unknown;
      rssi?: unknown;
      paper_ok?: unknown;
      last_error?: unknown;
    };
    const fw = typeof b.fw_version === 'string' ? b.fw_version.slice(0, 32) : null;
    const battery =
      typeof b.battery_pct === 'number' && Number.isFinite(b.battery_pct)
        ? Math.max(0, Math.min(100, Math.round(b.battery_pct)))
        : null;
    const charging = typeof b.charging === 'boolean' ? b.charging : null;
    // v0.8.14 (F11 Low): RSSI is a dBm reading — clamp to the physical
    // range like battery_pct, so a garbage radio value can't poison the
    // registry (the firmware reports WiFi.RSSI(), roughly -30..-90).
    const rssi =
      typeof b.rssi === 'number' && Number.isFinite(b.rssi) ? Math.max(-100, Math.min(0, Math.round(b.rssi))) : null;
    const paperOk = typeof b.paper_ok === 'boolean' ? b.paper_ok : null;
    const lastError = typeof b.last_error === 'string' ? b.last_error.slice(0, 200) : null;
    // Partial heartbeats are normal: only overwrite fields the device sent.
    await query(
      `UPDATE devices SET last_seen_at = now(),
         fw_version = COALESCE($1, fw_version),
         battery_pct = COALESCE($2, battery_pct),
         charging = COALESCE($3, charging),
         rssi = COALESCE($4, rssi),
         paper_ok = COALESCE($5, paper_ok),
         last_error = COALESCE($6, last_error)
       WHERE id = $7`,
      [fw, battery, charging, rssi, paperOk, lastError, d.id],
    );
    return { ok: true };
  });

  // ---- Portal: pairing + registry ----------------------------------------------
  app.post('/api/portal/devices/claim-code', staffOnly, async (req) => {
    requirePortalRole(req, 'owner', 'manager');
    const { table_id } = (req.body ?? {}) as { table_id?: unknown };
    if (typeof table_id !== 'string' || !table_id) throw badRequest('table_id is required');
    const t = await query<{ id: string; location_id: string }>(`SELECT id, location_id FROM tables WHERE id = $1`, [table_id]);
    if (t.rowCount === 0) throw notFound('table not found');
    assertPortalLocation(req, t.rows[0].location_id);
    // One live code per table: a fresh code replaces any unused predecessor.
    await query(`DELETE FROM device_claim_codes WHERE table_id = $1 AND used_at IS NULL`, [table_id]);
    // v0.8.14 (F11 Low): used/expired code rows were never purged — sweep
    // anything a day past expiry opportunistically on mint.
    await query(`DELETE FROM device_claim_codes WHERE expires_at < now() - interval '1 day'`);
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    // v0.8.14 (F11 Low): a generated code can collide with another table's
    // live code on the primary key — retry with a fresh code instead of
    // surfacing a 500 for an unlucky mint.
    let code = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      try {
        await query(
          `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at) VALUES ($1,$2,$3,$4)`,
          [hashClaimCode(code), t.rows[0].location_id, table_id, expires],
        );
        break;
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e;
      }
    }
    return { code, expires_at: expires.toISOString() };
  });

  app.get('/api/portal/devices', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    const scopedId = scopedLocationId(req, location_id);
    const r = await query(
      `SELECT d.id, d.table_id, t.name AS table_name, d.label, d.fw_version, d.last_seen_at,
              d.battery_pct, d.charging, d.rssi, d.paper_ok, d.last_error, d.created_at
       FROM devices d JOIN tables t ON t.id = d.table_id
       WHERE d.location_id = $1 AND d.revoked_at IS NULL ORDER BY t.name`,
      [scopedId],
    );
    return { devices: r.rows };
  });

  app.post('/api/portal/devices/:id/revoke', staffOnly, async (req) => {
    requirePortalRole(req, 'owner', 'manager');
    const id = (req.params as { id: string }).id;
    const r = await query<{ location_id: string }>(
      `SELECT location_id FROM devices WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    if (r.rowCount === 0) throw notFound('device not found');
    // v0.8.14 (F11 Low): a device belonging to another location answers
    // with the SAME 404 as a nonexistent one — the old path confirmed
    // the id exists via a differently-worded error.
    if (req.portalUser && req.portalUser.location_id !== r.rows[0].location_id) throw notFound('device not found');
    assertPortalLocation(req, r.rows[0].location_id);
    await query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [id]);
    // v0.8.14 (F11-4): a revoked unit never fetches again — cancel its
    // queued jobs instead of leaving live-looking work behind.
    await query(
      `UPDATE print_jobs SET status = 'failed', error = 'device revoked' WHERE device_id = $1 AND status IN ('pending','sent')`,
      [id],
    );
    // v0.8.14 (F11-5): revocation is a credential event — audit it.
    await logAudit({
      actorType: req.portalUser ? 'portal_user' : 'staff_token',
      actorId: req.portalUser?.id ?? null,
      role: req.portalUser?.role ?? null,
      ip: req.ip,
      action: 'device.revoked',
      locationId: r.rows[0].location_id,
      target: id,
    });
    return { ok: true };
  });

  // Staff-triggered print (receipt reprint / test print) for a table's device.
  app.post('/api/tables/:id/print-job', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    const { lines, idempotency_key } = (req.body ?? {}) as { lines?: unknown; idempotency_key?: unknown };
    if (
      !Array.isArray(lines) ||
      lines.length === 0 ||
      lines.length > 100 ||
      !lines.every((l) => typeof l === 'string' && l.length <= 80)
    ) {
      throw badRequest('lines must be 1-100 strings of at most 80 characters');
    }
    const idemKey =
      typeof idempotency_key === 'string' && idempotency_key.length > 0 && idempotency_key.length <= 80
        ? idempotency_key
        : null;
    const t = await query<{ id: string; location_id: string }>(`SELECT id, location_id FROM tables WHERE id = $1`, [tableId]);
    if (t.rowCount === 0) throw notFound('table not found');
    assertPortalLocation(req, t.rows[0].location_id);
    const dev = await query<{ id: string }>(
      `SELECT id FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [tableId],
    );
    if (dev.rowCount === 0) throw badRequest('no paired device for this table');
    const deviceId = dev.rows[0].id;
    // v0.8.14 (F11-3): a retried request carrying the same idempotency key
    // replays the original job instead of queueing a duplicate receipt.
    if (idemKey) {
      const existing = await query<{ id: string }>(
        `SELECT id FROM print_jobs WHERE device_id = $1 AND idempotency_key = $2`,
        [deviceId, idemKey],
      );
      if (existing.rowCount > 0) return { job_id: existing.rows[0].id, replayed: true };
    }
    // v0.8.14 (F11-3): the queue is capped per device — an authorized
    // caller must not be able to bury a unit under unbounded jobs.
    if ((await countActivePrintJobs(deviceId)) >= MAX_ACTIVE_PRINT_JOBS) {
      throw badRequest('print queue is full for this device');
    }
    const jobId = randomUUID();
    try {
      await query(
        `INSERT INTO print_jobs(id, device_id, location_id, table_id, lines, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)`,
        // v0.8.14 (F11-3): lines are printed by ESC/POS hardware — strip
        // control characters before they can become printer commands.
        [jobId, deviceId, t.rows[0].location_id, tableId, JSON.stringify(sanitizePrintLines(lines)), idemKey],
      );
    } catch (e) {
      // Lost a race against the same idempotency key: replay the winner.
      if (idemKey && isUniqueViolation(e)) {
        const existing = await query<{ id: string }>(
          `SELECT id FROM print_jobs WHERE device_id = $1 AND idempotency_key = $2`,
          [deviceId, idemKey],
        );
        if (existing.rowCount > 0) return { job_id: existing.rows[0].id, replayed: true };
      }
      throw e;
    }
    return { job_id: jobId };
  });
}
