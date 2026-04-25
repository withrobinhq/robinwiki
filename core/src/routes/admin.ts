import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { LinkJob, SchedulerJob } from '@robin/queue'
import { QUEUE_NAMES } from '@robin/queue'
import { db } from '../db/client.js'
import { fragments, entries } from '../db/schema.js'
import { producer } from '../queue/producer.js'
import { logger } from '../lib/logger.js'
import {
  retryStuckDryRunResponseSchema,
  retryStuckResponseSchema,
} from '../schemas/admin.schema.js'

const log = logger.child({ component: 'admin' })

export const adminRoutes = new Hono()

/**
 * Whitelist of scheduler job names that can be force-triggered via the
 * debug endpoint. Restricting to these names prevents arbitrary
 * job-name injection into the scheduler queue.
 */
const SCHEDULER_RUN_NOW_ALLOWED = ['embedding-retry', 'regen-batch'] as const
type SchedulerRunNowJobName = (typeof SCHEDULER_RUN_NOW_ALLOWED)[number]

/**
 * POST /admin/scheduler/run-now/:jobName  (dev-only)
 *
 * Force-triggers a scheduled job (`embedding-retry` or `regen-batch`) by
 * adding a one-shot job onto the scheduler queue with the same payload
 * shape the cron-driven scheduler emits. The existing scheduler worker
 * (see `core/src/queue/worker.ts`) dispatches by `job.type`, so this
 * route just enqueues a payload that matches the discriminated union.
 *
 * Registration is gated on `NODE_ENV !== 'production'` so the route is
 * literally absent in prod builds. A runtime 404 short-circuit protects
 * against env-mutation-after-start as defense-in-depth.
 *
 * Used by `.uat/plans/22-onboarding-demo-seed.md` step 9 to assert the
 * embedding-retry worker actually heals NULL embeddings.
 */
if (process.env.NODE_ENV !== 'production') {
  adminRoutes.post('/scheduler/run-now/:jobName', async (c) => {
    if (process.env.NODE_ENV === 'production') {
      return c.json({ error: 'not available' }, 404)
    }

    const jobName = c.req.param('jobName')
    if (!SCHEDULER_RUN_NOW_ALLOWED.includes(jobName as SchedulerRunNowJobName)) {
      return c.json({ error: `unknown job '${jobName}'` }, 400)
    }

    const allowedName = jobName as SchedulerRunNowJobName
    const debugId = `${allowedName}-debug-${Date.now()}`
    const payload: SchedulerJob =
      allowedName === 'regen-batch'
        ? {
            type: 'regen-batch',
            jobId: debugId,
            triggeredBy: 'scheduler',
            enqueuedAt: new Date().toISOString(),
          }
        : {
            type: 'embedding-retry',
            jobId: debugId,
            triggeredBy: 'scheduler',
            enqueuedAt: new Date().toISOString(),
          }

    const queue = producer.getQueue(QUEUE_NAMES.scheduler)
    const bullJob = await queue.add(allowedName, payload, { jobId: debugId })

    log.info(
      { jobName: allowedName, jobId: bullJob.id ?? debugId },
      'scheduler run-now triggered'
    )
    return c.json({ ok: true, jobId: bullJob.id ?? debugId })
  })
}

/**
 * POST /admin/retry-stuck
 *
 * Finds PENDING fragments older than ?minutes (default 5) and re-enqueues
 * their link jobs. No auth — intended for curl from the dev machine.
 *
 * Query params:
 *   minutes  — age threshold (default 5)
 *   dryRun   — if "true", returns what would be re-enqueued without doing it
 */
adminRoutes.post('/retry-stuck', async (c) => {
  const minutes = Number(c.req.query('minutes') ?? '5')
  const dryRun = c.req.query('dryRun') === 'true'

  const stuckFragments = (await db.execute(
    sql`SELECT f.lookup_key, f.entry_id, e.content
        FROM ${fragments} f
        JOIN ${entries} e ON e.lookup_key = f.entry_id
        WHERE f.state = 'PENDING'
          AND f.locked_by IS NULL
          AND f.updated_at < NOW() - INTERVAL '${sql.raw(String(minutes))} minutes'
        ORDER BY f.updated_at ASC`
  )) as Array<{
    lookup_key: string
    entry_id: string
    content: string
  }>

  if (dryRun) {
    return c.json(
      retryStuckDryRunResponseSchema.parse({
        dryRun: true,
        count: stuckFragments.length,
        fragments: stuckFragments.map((r) => ({
          fragmentKey: r.lookup_key,
          entryKey: r.entry_id,
        })),
      })
    )
  }

  let enqueued = 0
  const errors: Array<{ fragmentKey: string; error: string }> = []

  for (const row of stuckFragments) {
    const linkJob: LinkJob = {
      type: 'link',
      jobId: crypto.randomUUID(),
      fragmentKey: row.lookup_key,
      entryKey: row.entry_id,
      fragmentContent: row.content ?? '',
      enqueuedAt: new Date().toISOString(),
    }
    await producer.enqueueLink(linkJob)
    enqueued++
  }

  log.info({ enqueued, errors: errors.length, minutes }, 'retry-stuck completed')
  return c.json(retryStuckResponseSchema.parse({ enqueued, errors, minutes }))
})
