-- Issue #322 -- scheduled_jobs heartbeat surface for periodic workers.
-- Replaces the previous pattern of writing daily-prune ticks into
-- audit_log (which is reserved for user-visible state changes).
-- Each row tracks one named scheduled job (e.g. 'prune_pipeline_events')
-- and stores its last-run timestamp, status, optional structured meta,
-- and elapsed duration. Future scheduled jobs (HyDE backfill,
-- fragment-relationship backfill, etc.) write to this same table via
-- recordJobRun so operators have one place to confirm cron health.
--
-- Additive: no existing tables touched. Idempotent against a partial
-- apply (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
  "job_name" text PRIMARY KEY,
  "last_run_at" timestamptz NOT NULL,
  "last_run_status" text NOT NULL,
  "last_run_meta" jsonb,
  "last_run_duration_ms" integer,
  CONSTRAINT "scheduled_jobs_status_check"
    CHECK ("last_run_status" IN ('completed', 'failed', 'partial'))
);
