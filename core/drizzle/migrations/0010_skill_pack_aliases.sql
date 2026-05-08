-- Stream I Phases 5+6 -- server-side skill-pack alias registry.
-- Each row maps a user-facing alias name (e.g. /short-capture) to the
-- canonical MCP tool name (e.g. log_entry) plus optional default args
-- baked in at install time. The alias resolver consumes these rows at
-- MCP tool-list time so the user sees the alias without any client-side
-- manifest plumbing (Andrew lock 2026-05-07 -- gate #6 server-side).
--
-- Pre-allocated migration index 0010; gaps 0005..0009 are reserved for
-- co-landing C/E/F/G/H stream migrations and are intentionally skipped.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS skill_pack_aliases (
  id text PRIMARY KEY,
  pack text NOT NULL,
  alias_name text NOT NULL,
  mcp_tool_name text NOT NULL,
  args_template jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_pack_aliases_pack_alias_uidx
  ON skill_pack_aliases (pack, alias_name);

CREATE INDEX IF NOT EXISTS skill_pack_aliases_mcp_tool_idx
  ON skill_pack_aliases (mcp_tool_name);
