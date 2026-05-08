import type { JobResult, FragmentRelationshipBackfillJob } from '@robin/queue'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLog, fragments, edges } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { emitAuditEvent } from '../db/audit.js'

const log = logger.child({ component: 'fragment-relationship-backfill' })

/**
 * Stream D / D5 — fragment-relationship backfill (#258).
 *
 * The single-tenant Robin corpus accumulated fragments before the
 * FRAGMENT_RELATED_TO_FRAGMENT edge logic landed in regen.ts. Those rows
 * are embedded but have no related-edges. This worker walks them in batches
 * and computes RELATED_TO edges using cosine similarity, mirroring the
 * threshold and shape from createRelatedToEdges() in lib/regen.ts.
 *
 * Researcher's Option A: user-triggered + nightly cron, idempotent. The
 * unique index on edges (srcType, srcId, dstType, dstId, edgeType) makes
 * re-runs cheap — onConflictDoNothing absorbs the duplicates.
 */

const RELATED_FRAGMENT_THRESHOLD = 0.75
const BATCH_SIZE = 50
const NEIGHBOUR_LIMIT = 20

/** Fragments needing backfill: embedded, not soft-deleted, with no outgoing RELATED_TO edge. */
function fragmentsNeedingBackfillSubquery() {
  return sql`
    ${fragments.lookupKey} IN (
      SELECT f.lookup_key
      FROM fragments f
      WHERE f.embedding IS NOT NULL
        AND f.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.src_id = f.lookup_key
            AND e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
            AND e.deleted_at IS NULL
        )
    )
  `
}

/**
 * Outstanding-backfill counters surfaced on /settings/outstanding. The
 * "Run now" button on the settings page calls
 * POST /admin/backfill/fragment-relationships to enqueue a manual job.
 *
 * `lastCronRunAt` looks at the most recent
 * `audit_log` row of type fragment_relationship_backfill.{started,completed}.
 * No new table needed — the audit log already serves as the run history.
 */
export async function getOutstandingBackfillState(): Promise<{
  fragmentsAwaitingBackfill: number
  lastCronRunAt: string | null
  lastRunStatus: 'started' | 'completed' | 'failed' | null
  lastRunDetail: Record<string, unknown> | null
}> {
  const [{ count }] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(fragments)
    .where(
      and(
        isNull(fragments.deletedAt),
        sql`${fragments.embedding} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.src_id = ${fragments.lookupKey}
            AND e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
            AND e.deleted_at IS NULL
        )`,
      ),
    )

  // Most recent run regardless of source — surfaces both cron and manual
  // triggers. The eventType prefix is what /settings/outstanding filters on.
  const [recent] = await db
    .select({
      eventType: auditLog.eventType,
      detail: auditLog.detail,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'fragment_relationship_backfill'),
        sql`${auditLog.eventType} IN ('started', 'completed', 'failed')`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1)

  return {
    fragmentsAwaitingBackfill: count ?? 0,
    lastCronRunAt: recent?.createdAt?.toISOString() ?? null,
    lastRunStatus: (recent?.eventType ?? null) as
      | 'started'
      | 'completed'
      | 'failed'
      | null,
    lastRunDetail: (recent?.detail as Record<string, unknown> | null) ?? null,
  }
}

/**
 * Walk fragments that need RELATED_TO edges and create them in batches.
 * Returns counts so the worker can report back via JobResult and audit.
 */
export async function runFragmentRelationshipBackfill(opts: {
  jobId: string
  triggeredBy: 'scheduler' | 'manual'
}): Promise<{
  scanned: number
  edgesCreated: number
  durationMs: number
}> {
  const t0 = performance.now()

  await emitAuditEvent(db as never, {
    entityType: 'fragment_relationship_backfill',
    entityId: opts.jobId,
    eventType: 'started',
    source: 'system',
    summary: `Fragment-relationship backfill started (${opts.triggeredBy})`,
    detail: { jobId: opts.jobId, triggeredBy: opts.triggeredBy, threshold: RELATED_FRAGMENT_THRESHOLD },
  })

  let scanned = 0
  let edgesCreated = 0

  // Pull all fragment keys needing backfill once (single-tenant corpus, bounded
  // size). Embedding is fetched per row inside the inner loop to keep memory
  // flat — embeddings are 1536-dim floats and the batch could be thousands.
  const candidates = await db
    .select({ lookupKey: fragments.lookupKey })
    .from(fragments)
    .where(
      and(
        isNull(fragments.deletedAt),
        sql`${fragments.embedding} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.src_id = ${fragments.lookupKey}
            AND e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
            AND e.deleted_at IS NULL
        )`,
      ),
    )

  log.info({ jobId: opts.jobId, candidateCount: candidates.length }, 'backfill scan complete')

  for (const { lookupKey } of candidates) {
    scanned++
    try {
      const created = await backfillOneFragment(lookupKey)
      edgesCreated += created
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ jobId: opts.jobId, fragmentKey: lookupKey, err: message }, 'per-fragment backfill failed')
    }
    if (scanned % BATCH_SIZE === 0) {
      log.info(
        { jobId: opts.jobId, scanned, edgesCreated },
        'backfill progress',
      )
    }
  }

  const durationMs = Math.round(performance.now() - t0)

  await emitAuditEvent(db as never, {
    entityType: 'fragment_relationship_backfill',
    entityId: opts.jobId,
    eventType: 'completed',
    source: 'system',
    summary: `Fragment-relationship backfill completed: scanned ${scanned}, created ${edgesCreated}`,
    detail: {
      jobId: opts.jobId,
      triggeredBy: opts.triggeredBy,
      scanned,
      edgesCreated,
      durationMs,
      threshold: RELATED_FRAGMENT_THRESHOLD,
    },
  })

  log.info({ jobId: opts.jobId, scanned, edgesCreated, durationMs }, 'backfill completed')
  return { scanned, edgesCreated, durationMs }
}

/**
 * Single-fragment backfill: cosine-similarity walk against the rest of the
 * corpus, write edges above threshold. Mirrors createRelatedToEdges() in
 * lib/regen.ts but is NOT wiki-scoped — backfill connects fragments
 * regardless of which wiki they live in (or whether they're filed at all).
 */
async function backfillOneFragment(fragmentKey: string): Promise<number> {
  const [frag] = await db
    .select({ embedding: fragments.embedding })
    .from(fragments)
    .where(and(eq(fragments.lookupKey, fragmentKey), isNull(fragments.deletedAt)))
    .limit(1)

  if (!frag?.embedding) return 0

  const vecLiteral = JSON.stringify(frag.embedding)
  const maxDistance = 1 - RELATED_FRAGMENT_THRESHOLD

  const neighbours = await db
    .select({
      lookupKey: fragments.lookupKey,
      distance: sql<number>`${fragments.embedding} <=> ${vecLiteral}::vector`,
    })
    .from(fragments)
    .where(
      and(
        isNull(fragments.deletedAt),
        sql`${fragments.embedding} IS NOT NULL`,
        sql`${fragments.lookupKey} != ${fragmentKey}`,
        sql`${fragments.embedding} <=> ${vecLiteral}::vector < ${maxDistance}`,
      ),
    )
    .orderBy(sql`${fragments.embedding} <=> ${vecLiteral}::vector`)
    .limit(NEIGHBOUR_LIMIT)

  let created = 0
  for (const neighbour of neighbours) {
    const similarity = 1 - neighbour.distance
    const fwd = await db
      .insert(edges)
      .values({
        id: crypto.randomUUID(),
        srcType: 'fragment',
        srcId: fragmentKey,
        dstType: 'fragment',
        dstId: neighbour.lookupKey,
        edgeType: 'FRAGMENT_RELATED_TO_FRAGMENT',
        attrs: { score: similarity, method: 'cosine-backfill' },
      })
      .onConflictDoNothing()
      .returning({ id: edges.id })
    const rev = await db
      .insert(edges)
      .values({
        id: crypto.randomUUID(),
        srcType: 'fragment',
        srcId: neighbour.lookupKey,
        dstType: 'fragment',
        dstId: fragmentKey,
        edgeType: 'FRAGMENT_RELATED_TO_FRAGMENT',
        attrs: { score: similarity, method: 'cosine-backfill' },
      })
      .onConflictDoNothing()
      .returning({ id: edges.id })

    if (fwd.length > 0 || rev.length > 0) created++
  }
  return created
}

/** Worker entry point. Wraps runFragmentRelationshipBackfill in JobResult shape. */
export async function processFragmentRelationshipBackfillJob(
  job: FragmentRelationshipBackfillJob,
): Promise<JobResult> {
  log.info({ jobId: job.jobId, triggeredBy: job.triggeredBy }, 'processing backfill job')

  try {
    const result = await runFragmentRelationshipBackfill({
      jobId: job.jobId,
      triggeredBy: job.triggeredBy,
    })
    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
      ...result,
    } as JobResult
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ jobId: job.jobId, err: message }, 'backfill job failed')
    await emitAuditEvent(db as never, {
      entityType: 'fragment_relationship_backfill',
      entityId: job.jobId,
      eventType: 'failed',
      source: 'system',
      summary: `Fragment-relationship backfill failed: ${message}`,
      detail: { jobId: job.jobId, error: message },
    })
    return {
      jobId: job.jobId,
      success: false,
      error: message,
      processedAt: new Date().toISOString(),
    }
  }
}

// Suppress the unused subquery helper (kept for future direct-SQL usage).
void fragmentsNeedingBackfillSubquery
