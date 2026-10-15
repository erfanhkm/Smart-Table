// Floor helpers shared by the staff API and the dashboard.
// Written with plain, portable SQL (no correlated subqueries) so the same code
// runs on real Postgres and on the pg-mem in-memory DB used by tests.
// Both readers REQUIRE a location_id: there is no "all locations" fallback.
import { query } from '../db.js';

export interface TableView {
  id: string;
  name: string;
  state: string;
  qr_token: string;
  location_id: string;
  open_order_id: string | null;
  paid_cents: number;
}

function requireLocation(locationId: unknown, fn: string): string {
  if (typeof locationId !== 'string' || locationId.length === 0) {
    throw new Error(`${fn} requires a location_id`);
  }
  return locationId;
}

export async function getTables(locationId: string): Promise<TableView[]> {
  const loc = requireLocation(locationId, 'getTables');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = await query<any>(
    `SELECT t.id, t.name, t.state, t.qr_token, t.location_id FROM tables t
     WHERE t.location_id = $1
     ORDER BY t.name`,
    [loc],
  );
  const ids = new Set(tables.rows.map((r) => r.id));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const checks = await query<any>(
    `SELECT table_id, external_check_ref, created_at FROM checks WHERE state = 'OPEN' ORDER BY created_at DESC`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paid = await query<any>(
    `SELECT c.table_id, SUM(p.amount_cents) AS paid_cents
     FROM payments p JOIN checks c ON c.id = p.check_id
     WHERE c.state = 'OPEN' AND p.status IN ('AUTHORIZED','COMPLETED')
     GROUP BY c.table_id`,
  );

  const openByTable = new Map<string, string>();
  for (const c of checks.rows) {
    if (ids.has(c.table_id) && !openByTable.has(c.table_id)) openByTable.set(c.table_id, c.external_check_ref);
  }
  const paidByTable = new Map<string, number>();
  for (const p of paid.rows) {
    if (ids.has(p.table_id)) paidByTable.set(p.table_id, Number(p.paid_cents));
  }
  return tables.rows.map((t) => ({
    id: t.id,
    name: t.name,
    state: t.state,
    qr_token: t.qr_token,
    location_id: t.location_id,
    open_order_id: openByTable.get(t.id) ?? null,
    paid_cents: paidByTable.get(t.id) ?? 0,
  }));
}

export interface WaiterCall {
  id: string;
  table_id: string;
  table_name: string;
  created_at: string;
}

/** Waiter calls at one location with no later acknowledgement. */
export async function getOpenWaiterCalls(locationId: string, limit = 20): Promise<WaiterCall[]> {
  const loc = requireLocation(locationId, 'getOpenWaiterCalls');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = await query<any>(
    `SELECT e.id, e.table_id, t.name AS table_name, e.created_at
     FROM events e JOIN tables t ON t.id = e.table_id
     WHERE e.type = 'call_waiter' AND t.location_id = $1
     ORDER BY e.created_at DESC LIMIT 100`,
    [loc],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acks = await query<any>(
    `SELECT e.table_id, e.created_at
     FROM events e JOIN tables t ON t.id = e.table_id
     WHERE e.type = 'waiter_ack' AND t.location_id = $1
     ORDER BY e.created_at`,
    [loc],
  );
  return calls.rows
    .filter((c) => !acks.rows.some((a) => a.table_id === c.table_id && a.created_at > c.created_at))
    .slice(0, limit);
}
