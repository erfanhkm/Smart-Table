-- v0.7.3 — Claude cycle-2 F1 hardening.
-- F1-2: a durable "charge started" marker, written in autocommit BEFORE the
-- POS charge call. A resumed request that finds the marker but no tender
-- ref knows a charge may exist at the POS even when the process died
-- before the ref write landed — on adapters without native idempotency
-- it must never blindly charge again.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS charge_started_at TIMESTAMPTZ;

-- F1-10: fee-reversal rows are tied to the refund that produced them, so
-- the reversal ledger is auditable per refund (the per-payment advisory
-- lock remains the race guard).
ALTER TABLE fee_ledger ADD COLUMN IF NOT EXISTS refund_id TEXT;
CREATE INDEX IF NOT EXISTS idx_fee_ledger_refund ON fee_ledger(refund_id);
