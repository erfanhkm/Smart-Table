-- v0.8.15 (C3-1-9): persist the POS-side refund status. A refund the
-- POS has only ACCEPTED (Square: PENDING) is not a completed refund —
-- it can still be rejected — so refunds.ts now records what the POS
-- reported and only completes (and reverses fees) on COMPLETED /
-- CANCELED. Resolving PENDING refunds stays with the F1-11
-- refund-reconciliation work.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS pos_status TEXT;
