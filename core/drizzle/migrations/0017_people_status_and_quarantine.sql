-- v0.2.2 Stream P: people quarantine model.
--
-- Adds the lifecycle columns required to gate auto-extracted persons
-- behind an operator approval step. Existing rows default to status
-- 'verified' so live deployments keep behaving exactly as before.
--
-- Five new affordances:
--   1. people.status text NOT NULL DEFAULT 'verified' with a CHECK
--      pinning the column to one of {verified, pending, rejected}.
--   2. people.created_via text NULL — provenance label so admin tools
--      can render where each row came from (seeded, mcp_create,
--      mcp_update, extractor_pending, extractor_auto).
--   3. people.extracted_from_fragment_id text NULL — backref to the
--      fragment that surfaced a candidate during entity-extract.
--   4. people.context_notes jsonb NULL — append-only history of notes
--      that the matcher reads back for additional context.
--   5. app_settings entry `auto_accept_persons` (default false). When
--      true the extractor flips new candidates straight to verified
--      instead of routing them through quarantine.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards every column, the index
-- is conditional, and the CHECK constraint is re-added only when
-- absent. Operators can rerun the migration safely.

ALTER TABLE people ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'verified';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'people' AND constraint_name = 'people_status_check'
  ) THEN
    ALTER TABLE people
      ADD CONSTRAINT people_status_check
      CHECK (status IN ('verified', 'pending', 'rejected'));
  END IF;
END $$;

ALTER TABLE people ADD COLUMN IF NOT EXISTS created_via text;
-- 'seeded' | 'mcp_create' | 'mcp_update' | 'extractor_pending' | 'extractor_auto'

ALTER TABLE people ADD COLUMN IF NOT EXISTS extracted_from_fragment_id text;

ALTER TABLE people ADD COLUMN IF NOT EXISTS context_notes jsonb;
-- Structured notes appended via update_person; matcher reads for context.

CREATE INDEX IF NOT EXISTS people_status_idx ON people(status);

INSERT INTO app_settings (key, value)
  VALUES ('auto_accept_persons', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;
