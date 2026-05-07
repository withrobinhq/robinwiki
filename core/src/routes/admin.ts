import { Hono } from 'hono'
import { eq, inArray, or, sql } from 'drizzle-orm'
import type { LinkJob } from '@robin/queue'
import { db } from '../db/client.js'
import { fragments, entries, auditLog, pipelineEvents } from '../db/schema.js'
import { producer } from '../queue/producer.js'
import { logger } from '../lib/logger.js'
import { sessionMiddleware } from '../middleware/session.js'
import {
  retryStuckDryRunResponseSchema,
  retryStuckResponseSchema,
} from '../schemas/admin.schema.js'

const log = logger.child({ component: 'admin' })

export const adminRoutes = new Hono()
adminRoutes.use('*', sessionMiddleware)

/**
 * POST /admin/retry-stuck
 *
 * Finds PENDING fragments older than ?minutes (default 5) and re-enqueues
 * their link jobs. Session-authenticated.
 *
 * Query params:
 *   minutes  — age threshold (default 5, clamped 1-1440)
 *   dryRun   — if "true", returns what would be re-enqueued without doing it
 */
adminRoutes.post('/retry-stuck', async (c) => {
  const minutes = Math.max(1, Math.min(1440, Number(c.req.query('minutes') ?? '5') || 5))
  const dryRun = c.req.query('dryRun') === 'true'

  const stuckFragments = (await db.execute(
    sql`SELECT f.lookup_key, f.entry_id, e.content
        FROM ${fragments} f
        JOIN ${entries} e ON e.lookup_key = f.entry_id
        WHERE f.state = 'PENDING'
          AND f.locked_by IS NULL
          AND f.updated_at < NOW() - make_interval(mins => ${minutes})
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

/**
 * GET /admin/diagnose/:entryKey
 *
 * Single curl that surfaces the full pipeline state for one captured thought.
 * Joins audit_log + pipeline_events both directly (rows that mention the
 * entry_key) and transitively (rows from regen / embed jobs whose job_id
 * shares an entry-scoped emission). The session-authenticated caller is
 * expected to be the operator — same auth scope as /admin/retry-stuck.
 *
 * Response shape:
 *   {
 *     entryKey, entry: { ...row|null },
 *     pipelineEvents: [...],   // newest first
 *     auditEvents:    [...],   // newest first
 *     fragments:      [...]    // pipeline_events.fragment_key DISTINCT
 *   }
 */
adminRoutes.get('/diagnose/:entryKey', async (c) => {
  const entryKey = c.req.param('entryKey')
  if (!entryKey) {
    return c.json({ error: 'entryKey required' }, 400)
  }

  const [entryRow] = await db
    .select()
    .from(entries)
    .where(eq(entries.lookupKey, entryKey))
    .limit(1)

  // Pipeline rows directly tied to this entry. Newest first.
  const directPipelineRows = await db
    .select()
    .from(pipelineEvents)
    .where(eq(pipelineEvents.entryKey, entryKey))
    .orderBy(sql`${pipelineEvents.createdAt} DESC`)
    .limit(500)

  // Walk the job_ids and pull any pipeline rows that share them but have a
  // null entry_key (regen / embed crons triggered by edges that this entry
  // produced). Bounded query — at most ~5 stages × started+completed = 10
  // job_ids per entry.
  const jobIds = Array.from(new Set(directPipelineRows.map((r) => r.jobId)))
  const indirectPipelineRows = jobIds.length
    ? await db
        .select()
        .from(pipelineEvents)
        .where(
          sql`${pipelineEvents.jobId} = ANY(ARRAY[${sql.join(
            jobIds.map((j) => sql`${j}`),
            sql`, `
          )}]) AND ${pipelineEvents.entryKey} IS NULL`
        )
        .orderBy(sql`${pipelineEvents.createdAt} DESC`)
        .limit(500)
    : []

  const allPipelineRows = [...directPipelineRows, ...indirectPipelineRows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )

  // Audit rows: any row where entityType=raw_source, entityId=entryKey OR a
  // row whose detail.entryKey matches OR detail.jobId matches one of the
  // jobIds we collected. The detail-side scan uses a JSONB containment match.
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(
      or(
        sql`${auditLog.entityType} = 'raw_source' AND ${auditLog.entityId} = ${entryKey}`,
        sql`${auditLog.detail} @> ${JSON.stringify({ entryKey })}::jsonb`,
        jobIds.length
          ? sql`${auditLog.detail}->>'jobId' = ANY(ARRAY[${sql.join(
              jobIds.map((j) => sql`${j}`),
              sql`, `
            )}])`
          : sql`false`,
      ),
    )
    .orderBy(sql`${auditLog.createdAt} DESC`)
    .limit(500)

  // Derive the set of fragment keys touched by this entry's pipeline.
  const fragmentKeys = Array.from(
    new Set(
      allPipelineRows
        .map((r) => r.fragmentKey)
        .filter((f): f is string => Boolean(f)),
    ),
  )

  const fragmentRows =
    fragmentKeys.length > 0
      ? await db
          .select()
          .from(fragments)
          .where(inArray(fragments.lookupKey, fragmentKeys))
      : []

  return c.json({
    entryKey,
    entry: entryRow
      ? {
          ...entryRow,
          createdAt: entryRow.createdAt?.toISOString() ?? null,
          updatedAt: entryRow.updatedAt?.toISOString() ?? null,
          lastAttemptAt: entryRow.lastAttemptAt?.toISOString() ?? null,
        }
      : null,
    pipelineEvents: allPipelineRows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    auditEvents: auditRows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    fragments: fragmentRows.map((r) => ({
      lookupKey: r.lookupKey,
      slug: r.slug,
      title: r.title,
      state: r.state,
      embedding: r.embedding ? '<vector>' : null,
      embeddingAttemptCount: r.embeddingAttemptCount,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
  })
})
