-- v0.3: self-serve onboarding state per location.
--
-- The portal's "Getting started" wizard tracks three steps: POS connected
-- (derived from pos_credentials, not stored), menu verified against the POS
-- catalog (the owner taps "Verify menu"; we store when + how many items we
-- saw), and tables created (derived from the tables table). Only the menu
-- verification result and the owner's dismiss choice are stored here.
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS menu_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS menu_item_count INTEGER;
