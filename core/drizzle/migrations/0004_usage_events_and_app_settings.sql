-- Phase A3 — Cost & spend (Component #4).
--
-- Adds two tables:
--   1. usage_events: sibling of pipeline_events. Every OpenRouter call (mastra
--      agent or embedding adapter) writes one row keyed by job_id, so cost
--      correlates 1:1 with pipeline state via the shared job_id column.
--      Cost stored as cost_usd_micros (1e-6 USD) for full precision; the
--      v0.2.0 model-pricing table is hardcoded in TS, OpenRouter /models
--      fetch is deferred to v0.3.0.
--   2. app_settings: single-tenant key/value store. v0.2.0 uses it for the
--      regen / embed / classify budget caps (Phase A4). Future settings
--      land here without new migrations.
--
-- Idempotent: IF NOT EXISTS so a partially-applied migration during a CI
-- rerun does not fail.

CREATE TABLE IF NOT EXISTS usage_events (
  id text PRIMARY KEY,
  entry_key text,
  wiki_key text,
  fragment_key text,
  user_id text,
  source_client text,
  stage text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  cost_usd_micros integer NOT NULL DEFAULT 0,
  duration_ms integer,
  job_id text,
  metadata jsonb,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_events_user_id_created_at_idx
  ON usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_wiki_key_created_at_idx
  ON usage_events (wiki_key, created_at);
CREATE INDEX IF NOT EXISTS usage_events_stage_created_at_idx
  ON usage_events (stage, created_at);
CREATE INDEX IF NOT EXISTS usage_events_job_id_idx
  ON usage_events (job_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
