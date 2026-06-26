/**
 * Admin backfill HTTP endpoints (Stream U).
 *
 * Wraps the wiki_agent_schema backfill so an operator can trigger it from
 * the /settings/backfill panel without shelling into the host. The audit
 * endpoint is read-only; the trigger endpoint runs the same loop the CLI
 * script (core/scripts/backfill-wiki-agent-schema.ts) runs.
 *
 * Auth: session-authenticated. Robin is single-user, so the session check
 * is the only gate; there is no separate admin token. (Same pattern as
 * /admin/retry-stuck.)
 *
 * Endpoints:
 *   GET  /admin/backfill/audit                  read-only gap report
 *   POST /admin/backfill/wiki-agent-schema       trigger the runner
 *   GET  /admin/backfill/runs                    last-run records
 */

import { Hono } from 'hono'
import { db } from '../../db/client.js'
import { sessionMiddleware } from '../../middleware/session.js'
import { scheduledJobs } from '../../db/schema.js'
import { recordJobRun } from '../../lib/scheduled-jobs.js'
import { auditWikiAgentSchema, runWikiAgentSchemaBackfill } from '../../lib/backfill-runner.js'
import { logger } from '../../lib/logger.js'
import { sql } from 'drizzle-orm'

const log = logger.child({ component: 'admin-backfill' })

export const adminBackfillRoutes = new Hono()
adminBackfillRoutes.use('*', sessionMiddleware)

/**
 * GET /admin/backfill/audit
 *
 * Read-only sweep that returns the gap list for wiki_agent_schema rows.
 * The UI uses this to render "X wikis missing description, Y wikis
 * missing hyde" with per-section trigger buttons.
 */
adminBackfillRoutes.get('/audit', async (c) => {
  const audit = await auditWikiAgentSchema(db)

  // Pull the most recent audit-row timestamp, if any. We surface this
  // alongside the audit so the operator sees how stale the data is.
  const [row] = await db
    .select({
      lastRunAt: scheduledJobs.lastRunAt,
    })
    .from(scheduledJobs)
    .where(sql`${scheduledJobs.jobName} = 'wiki-agent-schema-audit'`)
    .limit(1)

  return c.json({
    wikiAgentSchema: {
      missingDescription: audit.missingDescription,
      missingHyde: audit.missingHyde,
    },
    generatedAt: audit.generatedAt,
    lastAuditAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
  })
})

/**
 * POST /admin/backfill/wiki-agent-schema
 *
 * Trigger the backfill runner. The runner is in-process (the v0.2.1
 * script's body lifted into core/src/lib/backfill-runner.ts), so the
 * response includes the result counts. The job-run row is written via
 * recordJobRun so /admin/backfill/runs can surface "last ran at X with
 * Y results".
 *
 * Body (optional):
 *   { wikiKey?: string }   when set, scope to a single wiki
 *
 * Response:
 *   { jobId, scope: 'all' | 'single', ok, failed, scanned, durationMs }
 */
adminBackfillRoutes.post('/wiki-agent-schema', async (c) => {
  let body: { wikiKey?: string } = {}
  try {
    body = (await c.req.json()) as { wikiKey?: string }
  } catch {
    // No body or non-JSON body. Treat as a full sweep.
  }

  const wikiKey = typeof body.wikiKey === 'string' && body.wikiKey.length > 0 ? body.wikiKey : undefined
  const scope: 'all' | 'single' = wikiKey ? 'single' : 'all'
  const jobId = `wiki-agent-schema-backfill-${crypto.randomUUID()}`

  log.info({ jobId, scope, wikiKey: wikiKey ?? null }, 'starting wiki_agent_schema backfill')

  const t0 = performance.now()
  let result: Awaited<ReturnType<typeof runWikiAgentSchemaBackfill>> | null = null
  let errorMessage: string | null = null
  try {
    result = await runWikiAgentSchemaBackfill(db, { wikiKey })
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    log.error({ jobId, scope, err: errorMessage }, 'backfill threw')
  }
  const durationMs = Math.round(performance.now() - t0)

  // Record the run for /admin/backfill/runs to surface in the panel.
  const status: 'completed' | 'failed' | 'partial' =
    errorMessage != null
      ? 'failed'
      : result && result.failed > 0 && result.ok > 0
        ? 'partial'
        : result && result.failed > 0
          ? 'failed'
          : 'completed'
  await recordJobRun(
    db,
    'wiki-agent-schema-backfill',
    status,
    {
      jobId,
      scope,
      wikiKey: wikiKey ?? null,
      ok: result?.ok ?? 0,
      failed: result?.failed ?? 0,
      scanned: result?.scanned ?? 0,
      error: errorMessage,
      triggeredBy: 'admin-http',
    },
    durationMs,
  )

  if (errorMessage != null) {
    return c.json(
      {
        jobId,
        scope,
        wikiKey: wikiKey ?? null,
        ok: 0,
        failed: 0,
        scanned: 0,
        durationMs,
        error: errorMessage,
      },
      500,
    )
  }

  return c.json({
    jobId,
    scope,
    wikiKey: wikiKey ?? null,
    ok: result?.ok ?? 0,
    failed: result?.failed ?? 0,
    scanned: result?.scanned ?? 0,
    durationMs,
  })
})

/**
 * GET /admin/backfill/runs
 *
 * Reads the scheduled_jobs telemetry table and returns the most recent
 * runs of any backfill-related job (wiki_agent_schema, fragment-relationship,
 * embedding-retry). The UI shows "last ran X minutes ago, status Y".
 */
adminBackfillRoutes.get('/runs', async (c) => {
  const rows = await db
    .select()
    .from(scheduledJobs)
    .where(sql`${scheduledJobs.jobName} LIKE '%backfill%' OR ${scheduledJobs.jobName} LIKE '%embedding%' OR ${scheduledJobs.jobName} LIKE '%audit%'`)
    .orderBy(sql`${scheduledJobs.lastRunAt} DESC`)
    .limit(50)

  return c.json({
    runs: rows.map((r) => ({
      jobName: r.jobName,
      lastRunAt: r.lastRunAt.toISOString(),
      lastRunStatus: r.lastRunStatus,
      lastRunMeta: r.lastRunMeta,
      lastRunDurationMs: r.lastRunDurationMs,
    })),
  })
})
