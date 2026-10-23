-- v0.7.5 — Claude cycle-2 F2 hardening.
-- F2-6: accrued-fee charge failures back off per location instead of
-- retrying the same declined card on every timer run.
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS fee_charge_failures INT NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS fee_charge_next_attempt_at TIMESTAMPTZ;

-- Low: commission_bps had no bound — a data error could set a fee of
-- nearly 100% of the charge (feeFor caps at charge-1 cent). 1000 bps
-- (10%) is far above the product's 2% and still catches nonsense.
ALTER TABLE billing_accounts ADD CONSTRAINT billing_accounts_bps_range
  CHECK (commission_bps BETWEEN 0 AND 1000);

-- F2-5: when a fee-collection batch was claimed (rows flipped to
-- 'charging'), so the stuck-batch resolver knows the claim's age and only
-- re-sends inside Square's idempotency-key retention window.
ALTER TABLE fee_ledger ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
