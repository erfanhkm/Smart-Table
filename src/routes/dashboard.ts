// Owner/staff dashboard API: live table map, sales snapshot, service metrics.
// Staff-only, and always scoped to ONE location (location_id is required).
// Metrics are computed in JS from the events table (portable across Postgres/pg-mem).
import { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { getOpenWaiterCalls, getTables } from '../services/floor.js';
import { badRequest } from '../http.js';
import { staffOnly } from '../auth.js';

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

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard/overview', staffOnly, async (req) => {
    const { location_id } = req.query as { location_id?: string };
    if (!location_id) throw badRequest('location_id is required');
    const tables = await getTables(location_id);
    const waiter_calls = await getOpenWaiterCalls(location_id, 20);
    return { tables, waiter_calls };
  });

  app.get('/api/dashboard/metrics', staffOnly, async (req) => {
    const { location_id, days } = req.query as { location_id?: string; days?: string };
    if (!location_id) throw badRequest('location_id is required');
    const windowDays = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const r = await query<Ev>(
      `SELECT e.table_id, e.check_id, e.type, e.created_at FROM events e
       JOIN tables t ON t.id = e.table_id
       WHERE e.created_at >= $1 AND t.location_id = $2
       ORDER BY e.created_at`,
      [since, location_id],
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
      window_days: windowDays,
      avg_settlement_secs: avgSeconds(settlementPairs),
      settled_checks: settlementPairs.length,
      avg_waiter_response_secs: avgSeconds(responsePairs),
      answered_calls: responsePairs.length,
      open_calls: calls.length - responsePairs.length,
    };
  });
}
