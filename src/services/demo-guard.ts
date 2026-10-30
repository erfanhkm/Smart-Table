// v0.8.12 (F9-1/F9-3): demo locations (locations.demo = true) back the
// PUBLIC guest demo — the marketing site links a live table token — and
// the gated owner demo, where prospects hold portal logins on the SAME
// location. Two protections hang off the flag:
//
//  - Guest flows on a demo location must not produce external side
//    effects (receipt emails to arbitrary addresses, device print jobs):
//    handled at the call sites in routes/customer.ts.
//  - Portal mutations that could break the published demo or move real
//    money (QR-token rotation, Google review URL, billing plan/card,
//    refunds, cash-payment recording) are refused for demo locations.
//
// There is no founder bypass on these routes: the founder admin panel
// (routes/admin.ts) exposes none of these mutations, so the guard
// applies to every caller (portal users and the staff token alike).
import { query } from '../db.js';
import { httpError } from '../http.js';

export async function isDemoLocation(locationId: string): Promise<boolean> {
  const r = await query<{ demo: boolean }>(`SELECT demo FROM locations WHERE id = $1`, [locationId]);
  return !!r.rows[0]?.demo;
}

/** Throws 403 when the location is a demo location. */
export async function assertNotDemoLocation(locationId: string, action: string): Promise<void> {
  if (await isDemoLocation(locationId)) {
    throw httpError(
      403,
      `${action} is disabled for demo locations — the shared demo location is read-only for this action.`,
      'demo_location',
    );
  }
}
