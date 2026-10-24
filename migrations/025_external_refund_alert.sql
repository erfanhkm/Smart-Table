-- v0.8.3 (F3-11): staff must be alerted when a refund is completed
-- directly in Square (outside Smart Table) — previously the webhook
-- handler dropped refund events silently. Adds the 'external_refund'
-- service-alert kind; money rows and fee reversal are NOT touched by
-- the alert (that stays with the refund reconciliation work).
-- The original inline CHECK is named service_alerts_kind_check by real
-- Postgres; pg-mem (test lane) calls it service_alerts_constraint_1.
-- Drop both spellings so the widened constraint replaces it everywhere.
ALTER TABLE service_alerts DROP CONSTRAINT IF EXISTS service_alerts_kind_check;
ALTER TABLE service_alerts DROP CONSTRAINT IF EXISTS service_alerts_constraint_1;
ALTER TABLE service_alerts
  ADD CONSTRAINT service_alerts_kind_check
  CHECK (kind IN ('low_rating', 'waiter_repeat', 'external_refund'));
