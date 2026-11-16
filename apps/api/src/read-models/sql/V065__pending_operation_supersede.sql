-- Additive links for proposal replacement; existing operations remain intact.
ALTER TABLE pending_operations
  ADD COLUMN IF NOT EXISTS supersedes_id UUID REFERENCES pending_operations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_id UUID REFERENCES pending_operations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pending_operations_v2_superseded_by_idx
  ON pending_operations (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

-- Rollback without discarding relationship data: the nullable columns/FKs can
-- remain unused; only the nonessential index may be dropped.
-- DROP INDEX IF EXISTS pending_operations_v2_superseded_by_idx;
