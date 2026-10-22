// Owner/staff dashboard API: live table map, sales snapshot, service metrics.
// Staff-only, and always scoped to ONE location (location_id is required).
// Metrics are computed in JS from the events table (portable across Postgres/pg-mem).
import { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { query } from '../db.js';
import { getOpenWaiterCalls, getTables } from '../services/floor.js';
import { badRequest } from '../http.js';
import { scopedLocationId, staffOnly } from '../auth.js';

interface Ev {
  table_id: string | null;
  check_id: string | null;
  type: string;
  created_at: string;
}

function avgSeconds(pairs: Array<[string, string]>): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.reduce((s, [a, b]) => s + (new Date(b).getTime() - new Date(a).getTime()) / 1000, 0);
  return Math.round(total / pairs.length);
}

export interface DailyRow {
  date: string; // YYYY-MM-DD (UTC)
  checks: number;
  revenue_cents: number; // payments that day minus refunds that day
  avg_tip_cents: number; // average tip per settled check that day
}

/** Real per-day breakdown from the payments + refunds tables (aggregated
 *  in JS for pg-mem/Postgres portability, like the rest of this file). */
async function dailyBreakdown(locationId: string, sinceIso: string): Promise<DailyRow[]> {
  const pays = await query<{ check_id: string; amount_cents: number; tip_cents: number; created_at: string }>(
    `SELECT p.check_id, p.amount_cents, p.tip_cents, p.created_at
     FROM payments p
     JOIN checks c ON c.id = p.check_id
     JOIN tables t ON t.id = c.table_id
     WHERE t.location_id = $1 AND p.status IN ('AUTHORIZED', 'COMPLETED') AND p.created_at >= $2`,
    [locationId, sinceIso],
  );
  const refs = await query<{ amount_cents: number; created_at: string }>(
    `SELECT amount_cents, created_at FROM refunds
     WHERE location_id = $1 AND status = 'COMPLETED' AND created_at >= $2`,
    [locationId, sinceIso],
  );
  const byDay = new Map<string, { checks: Set<string>; revenue: number; tips: number }>();
  const dayOf = (iso: string) => new Date(iso).toISOString().slice(0, 10);
  for (const p of pays.rows) {
    const d = dayOf(p.created_at);
    if (!byDay.has(d)) byDay.set(d, { checks: new Set(), revenue: 0, tips: 0 });
    const row = byDay.get(d)!;
    row.checks.add(p.check_id);
    row.revenue += p.amount_cents + p.tip_cents;
    row.tips += p.tip_cents;
  }
  for (const r of refs.rows) {
    const d = dayOf(r.created_at);
    if (!byDay.has(d)) byDay.set(d, { checks: new Set(), revenue: 0, tips: 0 });
    byDay.get(d)!.revenue -= r.amount_cents;
  }
  return [...byDay.entries()]
    .map(([date, v]) => ({
      date,
      checks: v.checks.size,
      revenue_cents: v.revenue,
      avg_tip_cents: v.checks.size > 0 ? Math.round(v.tips / v.checks.size) : 0,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export interface TableRow {
  table_id: string;
  table_name: string;
  revenue_cents: number; // payments (amount+tip) in window minus refunds in window
  checks: number;        // distinct settled checks in window
  avg_bill_cents: number;
  tips_cents: number;
  share_pct: number;     // % of the location's total revenue in window
}

/** Idea 5 — per-table revenue analytics: which tables actually make money.
 *  Same convention as dailyBreakdown (settled payments minus completed
 *  refunds, aggregated in JS). Every table of the location is returned —
 *  zero-revenue tables included, so the floor heatmap is complete. */
async function tableBreakdown(locationId: string, sinceIso: string): Promise<TableRow[]> {
  const tables = await query<{ id: string; name: string }>(
    `SELECT id, name FROM tables WHERE location_id = $1 ORDER BY name`,
    [locationId],
  );
  const pays = await query<{ table_id: string; check_id: string; amount_cents: number; tip_cents: number }>(
    `SELECT c.table_id, p.check_id, p.amount_cents, p.tip_cents
     FROM payments p
     JOIN checks c ON c.id = p.check_id
     JOIN tables t ON t.id = c.table_id
     WHERE t.location_id = $1 AND p.status IN ('AUTHORIZED', 'COMPLETED') AND p.created_at >= $2`,
    [locationId, sinceIso],
  );
  const refs = await query<{ table_id: string; amount_cents: number }>(
    `SELECT c.table_id, r.amount_cents
     FROM refunds r
     JOIN checks c ON c.id = r.check_id
     WHERE r.location_id = $1 AND r.status = 'COMPLETED' AND r.created_at >= $2`,
    [locationId, sinceIso],
  );
  const agg = new Map<string, { checks: Set<string>; revenue: number; tips: number }>();
  for (const t of tables.rows) agg.set(t.id, { checks: new Set(), revenue: 0, tips: 0 });
  for (const p of pays.rows) {
    const a = agg.get(p.table_id);
    if (!a) continue;
    a.checks.add(p.check_id);
    a.revenue += p.amount_cents + p.tip_cents;
    a.tips += p.tip_cents;
  }
  for (const r of refs.rows) {
    const a = agg.get(r.table_id);
    if (a) a.revenue -= r.amount_cents;
  }
  const totalRevenue = [...agg.values()].reduce((s, a) => s + Math.max(0, a.revenue), 0);
  return tables.rows
    .map((t) => {
      const a = agg.get(t.id)!;
      return {
        table_id: t.id,
        table_name: t.name,
        revenue_cents: a.revenue,
        checks: a.checks.size,
        avg_bill_cents: a.checks.size > 0 ? Math.round(a.revenue / a.checks.size) : 0,
        tips_cents: a.tips,
        share_pct: totalRevenue > 0 ? Math.round((Math.max(0, a.revenue) / totalRevenue) * 1000) / 10 : 0,
      };
    })
    .sort((x, y) => y.revenue_cents - x.revenue_cents || x.table_name.localeCompare(y.table_name));
}

export interface EventStats {
  avg_settlement_secs: number | null;
  settled_checks: number;
  avg_waiter_response_secs: number | null;
  answered_calls: number;
  open_calls: number;
}

/** Service stats from the events stream (settlement + waiter response). */
async function eventStats(locationId: string, sinceIso: string): Promise<EventStats> {
  const r = await query<Ev>(
    `SELECT e.table_id, e.check_id, e.type, e.created_at FROM events e
     JOIN tables t ON t.id = e.table_id
     WHERE e.created_at >= $1 AND t.location_id = $2
     ORDER BY e.created_at`,
    [sinceIso, locationId],
  );
  const evs = r.rows;
  const firstPay = new Map<string, string>(); // check_id -> at
  const paid = new Map<string, string>();
  const calls: Array<{ table: string; at: string }> = [];
  const acks = new Map<string, string[]>(); // table_id -> [at]
  for (const e of evs) {
    if (e.type === 'first_payment' && e.check_id && !firstPay.has(e.check_id)) firstPay.set(e.check_id, e.created_at);
    if (e.type === 'paid' && e.check_id && !paid.has(e.check_id)) paid.set(e.check_id, e.created_at);
    if (e.type === 'call_waiter' && e.table_id) calls.push({ table: e.table_id, at: e.created_at });
    if (e.type === 'waiter_ack' && e.table_id) {
      if (!acks.has(e.table_id)) acks.set(e.table_id, []);
      acks.get(e.table_id)!.push(e.created_at);
    }
  }
  const settlementPairs: Array<[string, string]> = [];
  for (const [cid, at] of firstPay) if (paid.has(cid)) settlementPairs.push([at, paid.get(cid)!]);
  const responsePairs: Array<[string, string]> = [];
  for (const c of calls) {
    const later = (acks.get(c.table) ?? []).filter((a) => a > c.at).sort()[0];
    if (later) responsePairs.push([c.at, later]);
  }
  return {
    avg_settlement_secs: avgSeconds(settlementPairs),
    settled_checks: settlementPairs.length,
    avg_waiter_response_secs: avgSeconds(responsePairs),
    answered_calls: responsePairs.length,
    open_calls: calls.length - responsePairs.length,
  };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/overview', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    // v0.6.5 (C-2): portal users only ever see their own location's floor.
    const scopedId = scopedLocationId(req, location_id);
    const tables = await getTables(scopedId);
    const waiter_calls = await getOpenWaiterCalls(scopedId, 20);
    return { tables, waiter_calls };
  });

  app.get('/api/dashboard/metrics', staffOnly, async (req) => {
    const { location_id, days } = req.query as { location_id?: string; days?: string };
    const scopedId = scopedLocationId(req, location_id);
    const windowDays = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    return {
      window_days: windowDays,
      ...(await eventStats(scopedId, since)),
      daily: await dailyBreakdown(scopedId, since),
      tables: await tableBreakdown(scopedId, since),
    };
  });

  // Excel export (owner ask, 2026-10-21): everything on the Reports page —
  // Summary, Daily Breakdown, Revenue by Table, guest Feedback — as one
  // .xlsx for the selected range, downloadable any time. Portal users are
  // scoped to their own location, same rule as /api/feedback.
  app.get('/api/dashboard/export.xlsx', staffOnly, async (req, reply) => {
    const u = req.portalUser;
    const { location_id, days } = req.query as { location_id?: string; days?: string };
    let locId = location_id;
    if (u) {
      if (location_id && location_id !== u.location_id) throw badRequest('not your location');
      locId = u.location_id;
    }
    if (!locId) throw badRequest('location_id is required');
    const windowDays = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();

    const loc = await query<{ name: string }>(`SELECT name FROM locations WHERE id = $1`, [locId]);
    const stats = await eventStats(locId, since);
    const daily = await dailyBreakdown(locId, since);
    const tables = await tableBreakdown(locId, since);
    const fb = await query<{ rating: number; comment: string | null; created_at: string }>(
      `SELECT rating, comment, created_at FROM feedback WHERE location_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 500`,
      [locId, since],
    );
    const totalRevenue = daily.reduce((s, d) => s + d.revenue_cents, 0);
    const totalChecks = daily.reduce((s, d) => s + d.checks, 0);
    const totalTips = tables.reduce((s, t) => s + t.tips_cents, 0);
    const moneyFmt = '"$"#,##0.00';
    const mins = (secs: number | null) => (secs === null ? '—' : `${(secs / 60).toFixed(1)} min`);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Smart Table';
    wb.created = new Date();

    const summary = wb.addWorksheet('Summary');
    summary.columns = [{ width: 28 }, { width: 42 }];
    summary.addRow(['Smart Table — Reports']).font = { bold: true, size: 14 };
    const srows: Array<[string, string | number, boolean]> = [
      ['Location', loc.rows[0]?.name ?? locId, false],
      ['Range', windowDays === 1 ? 'Last 24 hours' : `Last ${windowDays} days`, false],
      ['Generated', new Date().toLocaleString('en-CA'), false],
      ['Total revenue', totalRevenue / 100, true],
      ['Settled checks', totalChecks, false],
      ['Total tips', totalTips / 100, true],
      ['Avg settlement time', mins(stats.avg_settlement_secs), false],
      ['Avg waiter response', mins(stats.avg_waiter_response_secs), false],
      ['Open waiter calls', stats.open_calls, false],
    ];
    for (const [k, v, isMoney] of srows) {
      const row = summary.addRow([k, v]);
      row.getCell(1).font = { bold: true };
      if (isMoney) row.getCell(2).numFmt = moneyFmt;
    }

    const dailyWs = wb.addWorksheet('Daily Breakdown');
    dailyWs.columns = [{ width: 14 }, { width: 12 }, { width: 16 }, { width: 14 }];
    dailyWs.addRow(['Date', 'Checks', 'Revenue', 'Avg Tip']).font = { bold: true };
    for (const d of daily) {
      const row = dailyWs.addRow([d.date, d.checks, d.revenue_cents / 100, d.avg_tip_cents / 100]);
      row.getCell(3).numFmt = moneyFmt;
      row.getCell(4).numFmt = moneyFmt;
    }

    const tableWs = wb.addWorksheet('Revenue by Table');
    tableWs.columns = [{ width: 14 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 10 }];
    tableWs.addRow(['Table', 'Revenue', 'Settled Checks', 'Avg Bill', 'Tips', 'Share']).font = { bold: true };
    for (const t of tables) {
      const row = tableWs.addRow([t.table_name, t.revenue_cents / 100, t.checks, t.avg_bill_cents / 100, t.tips_cents / 100, t.share_pct / 100]);
      row.getCell(2).numFmt = moneyFmt;
      row.getCell(4).numFmt = moneyFmt;
      row.getCell(5).numFmt = moneyFmt;
      row.getCell(6).numFmt = '0.0%';
    }

    const fbWs = wb.addWorksheet('Feedback');
    fbWs.columns = [{ width: 22 }, { width: 10 }, { width: 80 }];
    fbWs.addRow(['Date', 'Rating', 'Comment']).font = { bold: true };
    for (const f of fb.rows) {
      fbWs.addRow([new Date(f.created_at).toLocaleString('en-CA'), f.rating, f.comment ?? '']);
    }

    const buf = await wb.xlsx.writeBuffer();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="smart-table-report-last-${windowDays}-days.xlsx"`)
      .send(Buffer.from(buf as unknown as ArrayBuffer));
  });
}
