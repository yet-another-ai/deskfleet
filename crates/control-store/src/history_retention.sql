-- A tombstone survives stale catalog/history uploads. Content is retained until
-- a future retention worker removes it; archive/restore do not create tombstones.
ALTER TABLE cp_sessions ADD COLUMN deleted_at BIGINT;
CREATE INDEX cp_sessions_deleted ON cp_sessions(deleted_at)
 WHERE deleted_at IS NOT NULL;
ALTER TABLE cp_catalogs ADD COLUMN inventory_revision BIGINT NOT NULL DEFAULT -1;
-- Existing inventories have no ordering information. Only the first versioned
-- catalog from the owning daemon can safely mark their missing Sessions deleted.
