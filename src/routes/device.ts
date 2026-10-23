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
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { assertPortalLocation, extractBearer, requirePortalRole, scopedLocationId, staffOnly } from '../auth.js';
import { hashToken } from './portal.js';
import { raiseServiceAlert } from '../services/alerts.js';

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
  app.post('/api/device/claim', async (req) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string' || !/^\d{8}$/.test(code)) {
      throw badRequest('claim code is required (8 digits)');
    }
    const codeHash = hashToken(code);
    const r = await query<{ location_id: string; table_id: string; expires_at: string; used_at: string | null }>(
      `SELECT location_id, table_id, expires_at, used_at FROM device_claim_codes WHERE code_hash = $1`,
      [codeHash],
    );
    if (r.rowCount === 0) throw badRequest('invalid claim code');
    const cc = r.rows[0];
    if (cc.used_at) throw badRequest('claim code already used');
    if (new Date(cc.expires_at).getTime() < Date.now()) throw badRequest('claim code expired');
    // Single-use: conditional update so a racing second claim finds it used.
    await query(`UPDATE device_claim_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL`, [codeHash]);

    const t = await query<{ id: string; name: string; qr_token: string }>(
      `SELECT id, name, qr_token FROM tables WHERE id = $1`,
      [cc.table_id],
    );
    if (t.rowCount === 0) throw badRequest('table no longer exists');

    // Re-pairing replaces the table's previous unit.
    await query(`UPDATE devices SET revoked_at = now() WHERE table_id = $1 AND revoked_at IS NULL`, [cc.table_id]);
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    await query(`INSERT INTO devices(id, location_id, table_id, token_hash) VALUES ($1,$2,$3,$4)`, [
      id,
      cc.location_id,
      cc.table_id,
      hashToken(token),
    ]);
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
    await query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [d.id]);

    const t = await query<{ name: string; state: string }>(`SELECT name, state FROM tables WHERE id = $1`, [d.table_id]);
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
      // within the last 60s drives the green "paid" LED state.
      const paid = await query<{ last_paid: string | null }>(
        `SELECT MAX(p.created_at) AS last_paid FROM payments p JOIN checks c ON c.id = p.check_id
         WHERE c.table_id = $1 AND c.state = 'COMPLETED' AND p.status IN ('AUTHORIZED','COMPLETED')`,
        [d.table_id],
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

    const jobs = await query<{ id: string }>(
      `SELECT id FROM print_jobs WHERE device_id = $1 AND status IN ('pending','sent')
       ORDER BY created_at ASC LIMIT 20`,
      [d.id],
    );
    return {
      table: { id: d.table_id, name: table?.name ?? null },
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
    const r = await query<{ id: string; lines: string; check_id: string | null; created_at: string }>(
      `SELECT id, lines, check_id, created_at FROM print_jobs
       WHERE device_id = $1 AND status IN ('pending','sent') ORDER BY created_at ASC LIMIT 20`,
      [d.id],
    );
    // At-least-once delivery: jobs stay visible until acked; fetched
    // 'pending' jobs are marked 'sent' so the portal can tell them apart.
    if (r.rowCount > 0) {
      await query(`UPDATE print_jobs SET status = 'sent' WHERE device_id = $1 AND status = 'pending'`, [d.id]);
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
    const r = await query(`SELECT id FROM print_jobs WHERE id = $1 AND device_id = $2`, [jobId, d.id]);
    if (r.rowCount === 0) throw notFound('print job not found');
    await query(`UPDATE print_jobs SET status = $1, error = $2, acked_at = now() WHERE id = $3`, [
      status,
      typeof error === 'string' ? error.slice(0, 200) : null,
      jobId,
    ]);
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
    const rssi = typeof b.rssi === 'number' && Number.isFinite(b.rssi) ? Math.round(b.rssi) : null;
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
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `INSERT INTO device_claim_codes(code_hash, location_id, table_id, expires_at) VALUES ($1,$2,$3,$4)`,
      [hashToken(code), t.rows[0].location_id, table_id, expires],
    );
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
    assertPortalLocation(req, r.rows[0].location_id);
    await query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  // Staff-triggered print (receipt reprint / test print) for a table's device.
  app.post('/api/tables/:id/print-job', staffOnly, async (req) => {
    const tableId = (req.params as { id: string }).id;
    const { lines } = (req.body ?? {}) as { lines?: unknown };
    if (
      !Array.isArray(lines) ||
      lines.length === 0 ||
      lines.length > 100 ||
      !lines.every((l) => typeof l === 'string' && l.length <= 80)
    ) {
      throw badRequest('lines must be 1-100 strings of at most 80 characters');
    }
    const t = await query<{ id: string; location_id: string }>(`SELECT id, location_id FROM tables WHERE id = $1`, [tableId]);
    if (t.rowCount === 0) throw notFound('table not found');
    assertPortalLocation(req, t.rows[0].location_id);
    const dev = await query<{ id: string }>(
      `SELECT id FROM devices WHERE table_id = $1 AND revoked_at IS NULL`,
      [tableId],
    );
    if (dev.rowCount === 0) throw badRequest('no paired device for this table');
    const jobId = randomUUID();
    await query(
      `INSERT INTO print_jobs(id, device_id, location_id, table_id, lines) VALUES ($1,$2,$3,$4,$5)`,
      [jobId, dev.rows[0].id, t.rows[0].location_id, tableId, JSON.stringify(lines)],
    );
    return { job_id: jobId };
  });
}
