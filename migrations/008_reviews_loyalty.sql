-- v0.2: review capture + loyalty (both frictionless, no login).
--
-- Review capture: after payment, guest taps stars. 4-5 stars -> Google
-- review link (owner-configured); 1-3 stars -> private feedback for owner.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  check_id TEXT,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_location ON feedback(location_id);

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS google_review_url TEXT;

-- Loyalty (optional per location, owner-enabled): visit counting by phone
-- hash (no account, no login). Owner sets visits required + reward text.
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loyalty_visits_required INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS loyalty_reward_text TEXT NOT NULL DEFAULT 'Free dessert';

CREATE TABLE IF NOT EXISTS loyalty_visits (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  phone_hash TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 0,
  rewards_earned INTEGER NOT NULL DEFAULT 0,
  last_visit_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, phone_hash)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_location ON loyalty_visits(location_id);
