-- v0.6.7 (F-9): refunds record WHO issued them (portal user id or the
-- staff-token actor), mirroring payments.recorded_by from migration 016.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS refunded_by TEXT;
