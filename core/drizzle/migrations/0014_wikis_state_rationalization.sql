-- v0.2.2 T4-bundle: rationalize wikis table state surface.
--
-- BREAKING: existing wikis with regenerate=true and auto_regen=false stop
-- regenerating automatically. Operators must set MIGRATION_PRESERVE_EXISTING=true
-- (or pass --preserve-existing to scripts/migrate-with-preserve.ts) to flip
-- autoregen=true for those wikis BEFORE this migration runs.
--
-- Four coupled changes:
--   1. Drop wikis.regenerate (de-facto gate but confusingly named).
--   2. Rename wikis.auto_regen to wikis.autoregen (one word).
--   3. Add wikis.dirty_since timestamptz NULL (column-backed dirty signal,
--      replacing the v0.2.1 MAX(edges.created_at) query-time derivation).
--   4. Drop wikis.lifecycle_state (deterministic function of state,
--      dirty_since, last_rebuilt_at; derived in app via Zod schema).

-- Drop the old partial index on auto_regen + lifecycle_state.
DROP INDEX IF EXISTS wikis_auto_regen_lifecycle_idx;

-- Drop redundant flag.
ALTER TABLE wikis DROP COLUMN regenerate;

-- Rename to one word.
ALTER TABLE wikis RENAME COLUMN auto_regen TO autoregen;

-- Add column-backed dirty signal.
ALTER TABLE wikis ADD COLUMN dirty_since timestamptz NULL;

-- Drop the redundant editorial state column; derived in app layer.
ALTER TABLE wikis DROP COLUMN lifecycle_state;

-- New indexes covering regen-worker scans.
CREATE INDEX wikis_state_dirty_idx ON wikis(state, dirty_since)
  WHERE deleted_at IS NULL;

CREATE INDEX wikis_autoregen_dirty_idx ON wikis(autoregen, dirty_since)
  WHERE autoregen = true AND deleted_at IS NULL;
