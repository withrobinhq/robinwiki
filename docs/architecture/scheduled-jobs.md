# Scheduled Jobs

`scheduled_jobs` is Robin's heartbeat surface for periodic background workers. One row per named job, holding the timestamp, status, optional structured meta, and elapsed duration of that job's most recent run.

## Purpose

Operators need a single place to confirm a recurring job actually fired today. Reading individual log lines is fine for debugging a single tick, but for "is the cron alive" the answer should be a single SQL query. Each scheduled worker writes one row per tick (upserted by `job_name`), so the table always reflects the latest state per job.

## Convention

Every scheduled worker calls `recordJobRun(db, jobName, status, meta, durationMs)` from `core/src/lib/scheduled-jobs.ts` at the end of each run. Status is `'completed'`, `'failed'`, or `'partial'`. Meta is free-form jsonb (deleted counts, error messages, batch sizes, anything that helps the next operator).

The helper is an `INSERT ... ON CONFLICT (job_name) DO UPDATE`, so the row is created on first run and overwritten on every subsequent tick. There is no per-tick history by design. If a future caller needs a full event log, that should land as a separate table, not by fanning rows out of `scheduled_jobs`.

## Distinction from audit_log

- `audit_log` is for user-visible state changes (a wiki was published, a fragment was edited, a token was rotated). Operator audits and user-facing history both read from here.
- `scheduled_jobs` is worker telemetry. No user action triggered it; the cron did. Mixing the two surfaces dilutes the signal in either direction.

If a scheduled worker also performs a user-visible action mid-run (rare), the worker should write to both surfaces: `recordJobRun` for the heartbeat and `emitAuditEvent` for the user-visible change.

## Currently registered jobs

- `prune_pipeline_events`: daily prune of `pipeline_events` rows past the retention window. Cron 03:00 UTC. See `core/src/queue/prune-pipeline-events-worker.ts`.

## Adding a new scheduled job

1. Build the worker as usual under `core/src/queue/`.
2. At the end of each run, call `recordJobRun(db, '<job_name>', status, meta, durationMs)`. Pick a stable snake-case `job_name` and never change it (the row is keyed on it).
3. Add the job's name to the registered list in this doc so operators have one place to look.
