-- v0.2: QR ordering (optional per-location feature).
--
-- When enabled, guests scanning the table QR can browse the location's menu
-- (from the POS catalog) and submit orders, which are created in the POS and
-- linked to the table. The restaurant sees the order in its POS with the
-- table name attached.
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS qr_ordering_enabled BOOLEAN NOT NULL DEFAULT false;
