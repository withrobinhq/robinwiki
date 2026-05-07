-- Stream E (#0008-pre-allocated): dirty-state lifecycle column + per-wiki auto-regen
-- toggle + last-regen completion timestamp. Andrew-locked 2026-05-07:
--   * `state` text column with values 'learning' | 'dreaming' | 'filed'.
--     Default 'filed' for new and existing rows; this is the post-regen steady
--     state. Transitions: 'learning' on FRAGMENT_IN_WIKI insert,
--     'dreaming' on regen worker pickup, 'filed' on regen complete.
--   * `auto_regen` boolean — wiki-level toggle for the midnight cron. Default
--     false (#259 lock: feature is opt-in per wiki).
--   * `last_regen_at` timestamptz — distinct from `last_rebuilt_at` (which the
--     E1 partition reads). last_regen_at carries the most-recent regen-complete
--     wall-clock for UI surfaces (chip tooltip, profile counter). The partition
--     keeps reading last_rebuilt_at to preserve E1 semantics.
--
-- The schema also adds a `wiki_dirty_state` column that is conceptually the
-- public name for the lifecycle tag; we keep `state` (the existing object_state
-- enum on baseColumns) untouched and add the lifecycle as a sibling text column
-- named `lifecycle_state` so we don't collide with the LINKING/RESOLVED state
-- machine. The orchestrator's directive named the column `wikis.state` but the
-- existing object_state column already owns that name. Naming it
-- `lifecycle_state` keeps the two state machines orthogonal.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards re-runs.

ALTER TABLE wikis
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'filed',
  ADD COLUMN IF NOT EXISTS auto_regen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_regen_at timestamp;

-- Index for the midnight cron's "find wikis with auto_regen=true and
-- lifecycle_state in (learning, dreaming)" sweep. Partial index keeps the
-- scan cheap regardless of total wiki count.
CREATE INDEX IF NOT EXISTS wikis_auto_regen_lifecycle_idx
  ON wikis (lifecycle_state)
  WHERE auto_regen = true AND deleted_at IS NULL;
