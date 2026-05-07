-- Phyl #12 drift-detection scope: a one-row-per-key store for migration
-- metadata. The boot path writes the SHA of `drizzle/migrations/meta/_journal.json`
-- here on successful apply; subsequent boots compare disk SHA to DB SHA.
--
-- Idempotent: IF NOT EXISTS so a partially-applied migration during a CI rerun
-- doesn't fail.

CREATE TABLE IF NOT EXISTS migrations_meta (
  id text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

-- Pipeline-events coverage extension (#A1): regen and embedding-retry batch
-- jobs are not entry-scoped, so entry_key must be nullable for those rows.
-- The data already in production is all entry-scoped (capture/fragment/classify
-- only emit today), so the DROP NOT NULL is a no-op for existing rows.
ALTER TABLE pipeline_events ALTER COLUMN entry_key DROP NOT NULL;

-- /admin/diagnose joins audit_log + pipeline_events by job_id. Add an index so
-- the join doesn't fall back to a full scan once the table grows past a few
-- thousand rows.
CREATE INDEX IF NOT EXISTS pipeline_events_job_id_idx ON pipeline_events (job_id);
