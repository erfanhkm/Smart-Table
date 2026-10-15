-- 009: order idempotency (H3 fix) + reconcile hardening (M6 fix).
--
-- order_requests: server-side idempotency for QR orders. The key is bound to
-- the table that created it — a replayed key from a different table is rejected.
CREATE TABLE IF NOT EXISTS order_requests (
  idempotency_key TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  pos_type TEXT NOT NULL,
  external_check_ref TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  -- Unique per reservation attempt: lets the creator distinguish "I just
  -- created this" from "a concurrent request did" without relying on
  -- RETURNING row counts (pg-mem quirk).
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_order_requests_table ON order_requests(table_id, created_at DESC);

-- Per-table order rate limiting (H4 fix): count recent orders per table.
-- (Enforced in the route; index supports the check.)

-- Reconcile poison-row backoff (M6 fix): track attempts so one bad row can't
-- starve the batch forever.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reconcile_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_reconcile_error TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_reconcile_at TIMESTAMPTZ;
-- POS reference for exact matching (H5 fix): stored at charge time so the
-- reconciler matches on the real tender reference instead of amount only.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS pos_tender_ref TEXT;
