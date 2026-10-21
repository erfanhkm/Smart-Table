-- Idea 1 (Service Recovery): instant alerts so staff can reach an unhappy
-- guest BEFORE they leave — a 1-3 star rating, or repeated waiter calls from
-- the same table in a short window. Alerts are raised by the guest routes,
-- listed/resolved through the staff API, and shown at the top of the portal
-- Overview until resolved. Dedupe (one OPEN alert per table + kind) is
-- enforced in src/services/alerts.ts.
CREATE TABLE IF NOT EXISTS service_alerts (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  table_id TEXT,
  check_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('low_rating', 'waiter_repeat')),
  rating INTEGER,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_service_alerts_loc_status ON service_alerts(location_id, status);
CREATE INDEX IF NOT EXISTS idx_service_alerts_table ON service_alerts(table_id);
