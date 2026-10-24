// Group Pay (idea 2): server-side item claims. Each guest phone has a stable
// random device id; claiming a bill item records (check, item_index) for that
// device. The claim list rides along with the bill poll, so every phone at
// the table sees live who is covering what — and the UNIQUE(check_id,
// item_index) constraint means an item can never be claimed (and thus paid)
// by two people. Claims are coordination only: money still flows through the
// guarded pay path, and a successful payment releases the payer's claims.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

/** Claim an item for a device. Returns true when the device holds the claim
 *  afterwards (fresh claim, or it already held it); false when another
 *  device holds it. */
export async function claimItem(
  checkId: string, itemIndex: number, fingerprint: string, deviceId: string,
): Promise<boolean> {
  // v0.8.5 (F4-13): claims expire — a guest who leaves must not hold items
  // hostage for the next party on the same still-open check.
  await query(
    `DELETE FROM item_claims WHERE check_id = $1 AND claimed_at <= now() - interval '3 hours'`,
    [checkId],
  );
  const id = randomUUID();
  const r = await query(
    `INSERT INTO item_claims(id, check_id, item_index, item_fingerprint, device_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (check_id, item_index) DO NOTHING
     RETURNING id`,
    [id, checkId, itemIndex, fingerprint, deviceId],
  );
  // The insert created the claim only when the returned row is OURS. (pg-mem
  // quirk: on conflict it returns the pre-existing row, where real Postgres
  // returns no rows — comparing ids is correct on both.)
  if (r.rows.length > 0 && r.rows[0].id === id) return true;
  const existing = await query(
    `SELECT device_id FROM item_claims WHERE check_id = $1 AND item_index = $2`,
    [checkId, itemIndex],
  );
  return existing.rows[0]?.device_id === deviceId;
}

/** Release one item, only if this device holds it. */
export async function unclaimItem(checkId: string, itemIndex: number, deviceId: string): Promise<void> {
  await query(
    `DELETE FROM item_claims WHERE check_id = $1 AND item_index = $2 AND device_id = $3`,
    [checkId, itemIndex, deviceId],
  );
}

/** Release everything a device claimed on a check (after it paid). */
export async function releaseClaims(checkId: string, deviceId: string): Promise<void> {
  await query(`DELETE FROM item_claims WHERE check_id = $1 AND device_id = $2`, [checkId, deviceId]);
}

/** Item indexes a device currently claims on a check. */
export async function listDeviceClaimIndexes(checkId: string, deviceId: string): Promise<number[]> {
  const r = await query<{ item_index: number }>(
    `SELECT item_index FROM item_claims WHERE check_id = $1 AND device_id = $2`,
    [checkId, deviceId],
  );
  return r.rows.map((row) => row.item_index);
}

/** v0.8.5 (F4-13): release ONLY the claims that were actually paid for —
 *  the blanket releaseClaims() also dropped claims for items the payer
 *  selected but did not pay for in this payment. */
export async function releaseClaimIndexes(checkId: string, deviceId: string, indexes: number[]): Promise<void> {
  if (indexes.length === 0) return;
  await query(
    `DELETE FROM item_claims WHERE check_id = $1 AND device_id = $2 AND item_index = ANY($3)`,
    [checkId, deviceId, indexes],
  );
}

/** Release every claim on a check (the whole bill was paid). */
export async function releaseAllClaims(checkId: string): Promise<void> {
  await query(`DELETE FROM item_claims WHERE check_id = $1`, [checkId]);
}

/**
 * Claims for the bill poll. v0.6.5 (C-12): raw device_id is personal data and
 * left the API on every poll — other guests learned each other's device ids.
 * Callers pass their own device id and get back only a `mine` flag.
 */
export async function listClaims(checkId: string, forDeviceId?: string) {
  const r = await query<{ item_index: number; item_fingerprint: string; device_id: string; claimed_at: string }>(
    `SELECT item_index, item_fingerprint, device_id, claimed_at FROM item_claims
     WHERE check_id = $1 AND claimed_at > now() - interval '3 hours' ORDER BY claimed_at`,
    [checkId],
  );
  return r.rows.map((row) => ({
    item_index: row.item_index,
    item_fingerprint: row.item_fingerprint,
    claimed_at: row.claimed_at,
    mine: !!forDeviceId && row.device_id === forDeviceId,
  }));
}
