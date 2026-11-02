-- v0.10.1 (C3-2-1): store the commission fee DECISION on each payment row
-- at charge time, so the missing-fee sweep can honor the plan/bps that
-- were in force when the payment was made instead of re-judging with
-- today's plan. Values:
--   'commission'   — a card payment charged under the commission plan;
--                    fee_bps holds the rate that applied.
--   'subscription' — a card payment made inside a paid subscription
--                    period: no fee by design, sweep must skip.
--   'external'     — a staff-recorded external (cash / outside rails)
--                    payment: never carries a fee, sweep must skip.
--   NULL           — legacy row (pre-dates this column) or the billing
--                    lookup failed at charge time: the sweep falls back
--                    to its bounded-window legacy heuristic.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee_decision TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee_bps INTEGER;
