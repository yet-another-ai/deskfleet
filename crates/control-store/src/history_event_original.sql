-- Exact serialized JSON for events that JSONB cannot represent (notably NUL).
-- Existing records remain the query/search projection and need no backfill.
ALTER TABLE cp_events ADD COLUMN record_original TEXT;
