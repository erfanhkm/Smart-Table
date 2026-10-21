-- v0.4.1 refunds: staff-initiated refunds of guest card payments.
-- One row per refund attempt against a payments row. The idempotency key is
-- unique so a retried request can never refund twice; status moves
-- PENDING -> COMPLETED | FAILED once the POS answers. Fee give-backs are
-- recorded as negative rows in fee_ledger (method 'reversal'), not here.

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_row_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency CHAR(3) NOT NULL,
  pos_refund_ref TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_row_id);
CREATE INDEX IF NOT EXISTS idx_refunds_location ON refunds(location_id);
