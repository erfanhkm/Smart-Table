// D-7: POS OAuth token refresh (v0.6.7).
//
// Before this module, NOTHING refreshed OAuth tokens: token_expires_at was
// stored at connect time and never read. Square access tokens expire ~30
// days after issue, so every connected Square restaurant would have
// started failing payments on a schedule.
//
// Two layers:
//  - On-demand: getLocationPos calls ensureFreshSquareToken() when the
//    stored Square token is expired or within 24h of expiry — the request
//    that needs the token refreshes it first (per-merchant mutex, so a
//    burst of concurrent requests refreshes once).
//  - Backstop: refreshExpiringTokens() (wired into the server's periodic
//    jobs) refreshes everything expiring within 48h and loudly logs
//    credentials that cannot be refreshed (no refresh token stored) so
//    they surface before payments start failing.
import { query } from '../../db.js';
import { decryptSecret, encryptSecret } from '../../crypto.js';
import { refreshSquareAccessToken } from '../../square.js';

const locks = new Map<string, Promise<string | null>>();

/**
 * Refresh one merchant's Square credential and persist the new tokens to
 * BOTH stores (pos_credentials is the read path; merchants mirrors it from
 * the OAuth callback). Returns the fresh access token, or null on failure
 * (logged — the caller falls back to the stored token).
 */
export function refreshSquareMerchant(merchantId: string, refreshToken: string): Promise<string | null> {
  const existing = locks.get(merchantId);
  if (existing) return existing;
  const run = (async (): Promise<string | null> => {
    try {
      const fresh = await refreshSquareAccessToken(refreshToken);
      await query(
        `UPDATE pos_credentials SET access_token_enc = $3, refresh_token_enc = $4, token_expires_at = $5
         WHERE merchant_id = $1 AND pos_type = $2`,
        [merchantId, 'square', encryptSecret(fresh.accessToken), encryptSecret(fresh.refreshToken), fresh.expiresAt],
      );
      await query(
        `UPDATE merchants SET access_token_enc = $2, refresh_token_enc = $3, token_expires_at = $4
         WHERE id = $1`,
        [merchantId, encryptSecret(fresh.accessToken), encryptSecret(fresh.refreshToken), fresh.expiresAt],
      ).catch(() => undefined);
      console.log(`[token-refresh] Square token refreshed for merchant ${merchantId} (expires ${fresh.expiresAt ?? 'unknown'})`);
      return fresh.accessToken;
    } catch (e) {
      console.error(`[token-refresh] Square token refresh FAILED for merchant ${merchantId}:`, e);
      return null;
    }
  })();
  locks.set(merchantId, run);
  run.then(() => locks.delete(merchantId), () => locks.delete(merchantId));
  return run;
}

/**
 * On-demand check used by getLocationPos: given the stored credential's
 * expiry and (encrypted) refresh token, refresh when expired or within
 * 24h of expiry. Returns the token to use (fresh on success, the current
 * one otherwise) — never throws.
 */
export async function ensureFreshSquareToken(args: {
  merchantId: string;
  currentToken: string;
  refreshTokenEnc: string | null;
  expiresAt: string | null;
}): Promise<string> {
  if (!args.expiresAt || !args.refreshTokenEnc) return args.currentToken;
  const expMs = new Date(args.expiresAt).getTime();
  if (!Number.isFinite(expMs) || expMs - Date.now() > 24 * 3600_000) return args.currentToken;
  let refreshToken = '';
  try {
    refreshToken = decryptSecret(args.refreshTokenEnc);
  } catch {
    return args.currentToken;
  }
  if (!refreshToken) return args.currentToken;
  const fresh = await refreshSquareMerchant(args.merchantId, refreshToken);
  return fresh ?? args.currentToken;
}

/**
 * Backstop sweep: refresh every Square credential expiring within 48h
 * (or already expired). Credentials expiring within 7 days WITHOUT a
 * usable refresh token are counted and logged as alerts — those
 * restaurants must reconnect before their tokens die.
 */
export async function refreshExpiringTokens(): Promise<{ refreshed: number; failed: number; unrefreshable: number }> {
  const rows = await query<{ merchant_id: string; refresh_token_enc: string | null; token_expires_at: string }>(
    `SELECT merchant_id, refresh_token_enc, token_expires_at FROM pos_credentials
     WHERE pos_type = 'square' AND token_expires_at IS NOT NULL
       AND token_expires_at < now() + interval '7 days'`,
  );
  let refreshed = 0;
  let failed = 0;
  let unrefreshable = 0;
  for (const row of rows.rows) {
    const expMs = new Date(row.token_expires_at).getTime();
    let refreshToken = '';
    try {
      refreshToken = row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : '';
    } catch {
      refreshToken = '';
    }
    if (!refreshToken) {
      unrefreshable += 1;
      console.error(
        `[token-refresh] ALERT: Square credential for merchant ${row.merchant_id} expires ${row.token_expires_at} and has NO refresh token — the restaurant must reconnect`,
      );
      continue;
    }
    if (expMs - Date.now() > 48 * 3600_000) continue; // inside 7d alert window but not yet in the 48h refresh window
    const fresh = await refreshSquareMerchant(row.merchant_id, refreshToken);
    if (fresh) refreshed += 1;
    else failed += 1;
  }
  return { refreshed, failed, unrefreshable };
}
