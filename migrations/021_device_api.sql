-- v0.7 Device API: STT-101 tabletop terminals.
-- A device is paired to exactly one table via a single-use 8-digit claim code
-- (portal-generated, 10-minute expiry, stored hashed like portal tokens).
-- The device authenticates with its own bearer token (hashed at rest) and
-- polls state, posts waiter calls + heartbeats, and pulls print jobs.
-- Receipt content is formatted by the server; the device is a dumb printer.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  fw_version TEXT,
  last_seen_at TIMESTAMPTZ,
  battery_pct INTEGER,
  charging BOOLEAN,
  rssi INTEGER,
  paper_ok BOOLEAN,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_devices_battery CHECK (battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100))
);
CREATE INDEX IF NOT EXISTS idx_devices_table ON devices(table_id);
CREATE INDEX IF NOT EXISTS idx_devices_location ON devices(location_id);
-- One live device per table; re-pairing revokes the previous unit first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_active_table ON devices(table_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS device_claim_codes (
  code_hash TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_codes_table ON device_claim_codes(table_id);

CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  check_id TEXT,
  lines TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at TIMESTAMPTZ,
  CONSTRAINT chk_print_jobs_status CHECK (status IN ('pending', 'sent', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_device ON print_jobs(device_id, status);
