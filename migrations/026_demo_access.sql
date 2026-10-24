-- v0.8.4: owner-demo access requests from smarttablepay.com/owner-demo.
-- The public site is gated: a prospect submits their full details, the
-- request lands here (status 'pending') and Erfan is notified by email.
-- Approval itself is manual for now (a demo login is created per
-- approved request); the status column tracks the decision.
CREATE TABLE IF NOT EXISTS demo_access_requests (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  full_name TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  pos_system TEXT,
  locations_count INTEGER,
  tables_count INTEGER,
  website TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_demo_access_created ON demo_access_requests (created_at DESC);
