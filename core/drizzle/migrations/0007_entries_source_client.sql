-- Stream C / C2: `source_client` jsonb column on entries (raw_sources).
--
-- Captures the MCP `clientInfo` payload (`{name, version, ...}`) for any
-- entry created via the MCP transport, and `{name: 'web'}` for entries
-- captured through the web UI. NULL for legacy rows and any future
-- caller that doesn't supply client identity.
--
-- Decision 2026-05-07 (PLAN.md §C2): jsonb (not text), so the column
-- can carry the optional `version` and any future MCP-spec fields
-- without another migration.
--
-- No backfill: old rows return NULL by design.
-- Idempotent (IF NOT EXISTS) so a partial CI rerun doesn't fail.

ALTER TABLE raw_sources ADD COLUMN IF NOT EXISTS source_client jsonb;
