// Append-only audit trail for sensitive actions (v0.8.7, F6-5/F6-6):
// POS credential writes, cash/external payment recording, table free /
// QR rotation, location settings changes, founder billing runs and the
// admin-login lockout. Best-effort by design: an audit failure must never
// break the action it records — it logs loudly instead.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

export interface AuditEntry {
  actorType: 'portal_user' | 'staff_token' | 'founder' | 'system';
  actorId?: string | null;
  role?: string | null;
  ip?: string | null;
  action: string;
  locationId?: string | null;
  target?: string | null;
  detail?: string | null;
}

export async function logAudit(e: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log(id, actor_type, actor_id, role, ip, action, location_id, target, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        e.actorType,
        e.actorId ?? null,
        e.role ?? null,
        e.ip ?? null,
        e.action,
        e.locationId ?? null,
        e.target ?? null,
        e.detail ? String(e.detail).slice(0, 500) : null,
      ],
    );
  } catch (err) {
    console.error('[audit] failed to write audit row', e.action, err instanceof Error ? err.message : err);
  }
}
