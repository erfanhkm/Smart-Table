-- v0.8.7 (F6 hardening):
-- 1) audit_log: append-only record of sensitive staff/founder/credential
--    actions (F6-5/F6-6). Written best-effort by src/services/audit.ts.
-- 2) Table names unique per location (F6-4/F6-13): quick-tables and manual
--    creation could both mint duplicate "Table N" rows under concurrency.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  role TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  location_id TEXT,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tables_location_name ON tables (location_id, name);
