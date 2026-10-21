// Service Recovery alerts (idea 1). Raised from the guest routes the moment a
// guest signals trouble — a 1-3 star rating or repeated waiter calls — so
// staff can fix the problem at the table before the guest leaves (and before
// a public review appears). One OPEN alert per (table, kind): while staff are
// already on it, further signals never spam duplicates.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

export type ServiceAlertKind = 'low_rating' | 'waiter_repeat';

export async function raiseServiceAlert(a: {
  locationId: string;
  tableId: string | null;
  checkId?: string | null;
  kind: ServiceAlertKind;
  rating?: number | null;
  comment?: string | null;
}): Promise<boolean> {
  if (a.tableId) {
    const open = await query(
      `SELECT id FROM service_alerts WHERE table_id = $1 AND kind = $2 AND status = 'open' LIMIT 1`,
      [a.tableId, a.kind],
    );
    if ((open.rowCount ?? 0) > 0) return false;
  }
  await query(
    `INSERT INTO service_alerts(id, location_id, table_id, check_id, kind, rating, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), a.locationId, a.tableId, a.checkId ?? null, a.kind, a.rating ?? null, a.comment ?? null],
  );
  return true;
}
