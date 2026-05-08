import type { JobResult, RegenJob, RegenBatchJob } from '@robin/queue'
import { eq, and, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { wikis, edges, fragments } from '../db/schema.js'
import { regenerateWiki } from '../lib/regen.js'
import { producer } from './producer.js'
import { logger } from '../lib/logger.js'
import { emitAuditEvent } from '../db/audit.js'
import { emitPipelineEvent } from '../db/pipeline-events.js'

const log = logger.child({ component: 'regen-worker' })

/** Max wikis to process in a single batch job */
const BATCH_LIMIT = 5

/** Stale threshold removed — wikis only regen when they have new fragments or are stuck */

export async function processRegenJob(job: RegenJob): Promise<JobResult> {
  log.info({ jobId: job.jobId, wikiKey: job.objectKey }, 'processing regen job')
  const t0 = performance.now()

  // Regen jobs key on wikiKey, not entryKey — pass null entryKey, surface the
  // wiki context via metadata so /admin/diagnose by entryKey still finds it
  // through the audit_log/job_id join.
  await emitPipelineEvent(db as never, {
    entryKey: null,
    jobId: job.jobId,
    stage: 'regen',
    status: 'started',
    metadata: {
      wikiKey: job.objectKey,
      objectType: job.objectType,
      triggeredBy: job.triggeredBy,
    },
  })

  try {
    const result = await regenerateWiki(db, job.objectKey, { jobId: job.jobId })
    const elapsed = Math.round(performance.now() - t0)
    log.info(
      { jobId: job.jobId, wikiKey: job.objectKey, fragmentCount: result.fragmentCount, ms: elapsed, timing: result.timing },
      'regen job completed'
    )
    await emitPipelineEvent(db as never, {
      entryKey: null,
      jobId: job.jobId,
      stage: 'regen',
      status: 'completed',
      metadata: {
        wikiKey: job.objectKey,
        fragmentCount: result.fragmentCount,
        durationMs: elapsed,
      },
    })
    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  } catch (err) {
    const elapsed = Math.round(performance.now() - t0)
    const message = err instanceof Error ? err.message : String(err)
    log.error({ jobId: job.jobId, wikiKey: job.objectKey, error: message, ms: elapsed }, 'regen job failed')
    await emitPipelineEvent(db as never, {
      entryKey: null,
      jobId: job.jobId,
      stage: 'regen',
      status: 'failed',
      metadata: {
        wikiKey: job.objectKey,
        error: message,
        durationMs: elapsed,
      },
    })
    return {
      jobId: job.jobId,
      success: false,
      error: message,
      processedAt: new Date().toISOString(),
    }
  }
}

export async function processRegenBatchJob(job: RegenBatchJob): Promise<JobResult> {
  log.info({ jobId: job.jobId }, 'processing regen batch job')

  try {
    const candidateKeys = new Set<string>()

    // ── Reason 1: Unfiled fragments exist → regen ALL wikis (mechanism #1 classifies them) ──
    const [unfiledCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(fragments)
      .where(
        and(
          isNull(fragments.deletedAt),
          sql`${fragments.embedding} IS NOT NULL`,
          sql`${fragments.lookupKey} NOT IN (
            SELECT src_id FROM edges
            WHERE edge_type = 'FRAGMENT_IN_WIKI' AND deleted_at IS NULL
          )`
        )
      )
    const hasUnfiled = (unfiledCount?.count ?? 0) > 0

    if (hasUnfiled) {
      // Only wikis with regenerate=true participate in unfiled fragment classification
      const rows = await db
        .select({ lookupKey: wikis.lookupKey })
        .from(wikis)
        .where(and(isNull(wikis.deletedAt), eq(wikis.regenerate, true)))
      for (const r of rows) candidateKeys.add(r.lookupKey)
      log.info({ unfiled: unfiledCount?.count, wikis: rows.length }, 'batch: unfiled fragments → regen-enabled wikis')
    }

    // ── Reason 2: Wikis with new fragments since last rebuild ──
    const wikisWithNewFragments = await db
      .select({ lookupKey: wikis.lookupKey })
      .from(wikis)
      .innerJoin(
        edges,
        and(
          eq(edges.dstId, wikis.lookupKey),
          eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
          isNull(edges.deletedAt),
        )
      )
      .where(
        and(
          isNull(wikis.deletedAt),
          eq(wikis.regenerate, true),
          sql`${edges.createdAt} > COALESCE(${wikis.lastRebuiltAt}, '1970-01-01'::timestamptz)`,
        )
      )
      .groupBy(wikis.lookupKey)
    for (const r of wikisWithNewFragments) candidateKeys.add(r.lookupKey)
    if (wikisWithNewFragments.length > 0) {
      log.info({ count: wikisWithNewFragments.length }, 'batch: wikis with new fragments since last rebuild')
    }

    // ── Reason 3: Wikis stuck in non-RESOLVED state ──
    // Respect the LINKING lock: only pick up LINKING wikis if they've been
    // stuck for over 15 minutes (stale lock from a crashed worker).
    const stuckWikis = await db
      .select({ lookupKey: wikis.lookupKey })
      .from(wikis)
      .where(
        and(
          isNull(wikis.deletedAt),
          sql`${wikis.state} != 'RESOLVED'`,
          sql`(${wikis.state} != 'LINKING' OR ${wikis.updatedAt} < NOW() - INTERVAL '15 minutes')`,
        )
      )
    for (const r of stuckWikis) candidateKeys.add(r.lookupKey)
    if (stuckWikis.length > 0) {
      log.info({ count: stuckWikis.length }, 'batch: wikis in non-RESOLVED state')
    }

    // ── Reason 4: Stream E5 auto-regen — auto_regen=true AND lifecycle='learning' ──
    // Andrew lock #259: midnight cron sweeps wikis the user has explicitly
    // opted into auto-regen for, where new fragments have landed since the
    // last regen (lifecycle_state='learning' is the dirty-state tag from E8).
    const autoRegenWikis = await db
      .select({ lookupKey: wikis.lookupKey })
      .from(wikis)
      .where(
        and(
          isNull(wikis.deletedAt),
          eq(wikis.autoRegen, true),
          eq(wikis.lifecycleState, 'learning')
        )
      )
    for (const r of autoRegenWikis) candidateKeys.add(r.lookupKey)
    if (autoRegenWikis.length > 0) {
      log.info({ count: autoRegenWikis.length }, 'batch: auto-regen wikis with learning state')
    }

    // ── Enqueue individual regen jobs (capped at BATCH_LIMIT) ──
    // Per-item failures previously logged a warn and disappeared (#273) — the
    // batch reported success regardless. Now: emit an audit row per failure
    // and bubble a `failed` count in the JobResult.detail so the orchestrator
    // can detect partial-success runs.
    const wikiKeysToRegen = Array.from(candidateKeys).slice(0, BATCH_LIMIT)
    let enqueued = 0
    let failed = 0
    for (const wikiKey of wikiKeysToRegen) {
      try {
        await producer.enqueueRegen({
          type: 'regen',
          jobId: crypto.randomUUID(),
          objectKey: wikiKey,
          objectType: 'wiki',
          triggeredBy: 'scheduler',
          enqueuedAt: new Date().toISOString(),
        })
        enqueued++
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ wikiKey, err }, 'batch regen: failed to enqueue regen job')
        await emitAuditEvent(db, {
          entityType: 'wiki',
          entityId: wikiKey,
          eventType: 'regen_batch_item_failed',
          source: 'system',
          summary: `Batch regen enqueue failed: ${message}`,
          detail: { error: message, batchJobId: job.jobId },
        })
      }
    }

    log.info(
      { jobId: job.jobId, enqueued, failed, hasUnfiled, candidates: candidateKeys.size, capped: wikiKeysToRegen.length },
      'regen batch completed'
    )

    // NOTE: Per-item failure count (`failed`) is surfaced via:
    //   1. Per-item audit row above (`regen_batch_item_failed`)
    //   2. The `regen batch completed` log line below carries `failed` field
    // We do NOT extend JobResult with a `detail` field here because that type
    // lives in @robin/queue and is shared across workers — out of scope for
    // this fix. Downstream observers should query the audit_log table or
    // tail the worker log for the `failed` field.
    return { jobId: job.jobId, success: true, processedAt: new Date().toISOString() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ jobId: job.jobId, error: message }, 'regen batch job failed')
    return {
      jobId: job.jobId,
      success: false,
      error: message,
      processedAt: new Date().toISOString(),
    }
  }
}
