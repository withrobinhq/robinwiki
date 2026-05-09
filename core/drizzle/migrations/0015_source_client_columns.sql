-- Add source_client column to surface tables. v0.2.1 already added it to
-- entries (via the C2 migration). Stream V finishes the migration.

ALTER TABLE fragments ADD COLUMN IF NOT EXISTS source_client text NULL;
ALTER TABLE wikis ADD COLUMN IF NOT EXISTS source_client text NULL;
ALTER TABLE wiki_types ADD COLUMN IF NOT EXISTS source_client text NULL;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS source_client text NULL;

-- No backfill of legacy rows; new writes populate going forward. Operators
-- who want backfill can run a one-shot script that pulls source_client
-- from audit_log.detail JSON for matching entity rows.
