-- v0.3 multi-POS: each location picks exactly one POS; the whole portal
-- and backend resolve that location's adapter from pos_type, so a Square
-- location only ever talks to Square, a Clover location only to Clover, etc.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS pos_type TEXT NOT NULL DEFAULT 'square';
-- Generic POS-native location reference (Square location id, Clover merchant id,
-- Toast restaurant guid, ...). Backfilled from square_location_id; the Square
-- adapter keeps reading square_location_id for now, new adapters use this.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS pos_location_ref TEXT;
UPDATE locations SET pos_location_ref = square_location_id WHERE pos_location_ref IS NULL;
