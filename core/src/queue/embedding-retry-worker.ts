import type { EmbeddingRetryJob, JobResult } from '@robin/queue'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { embedText, takeLastEmbedFailure } from '@robin/agent'
import { db } from '../db/client.js'
import { fragments, wikis, people } from '../db/schema.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { logger } from '../lib/logger.js'
import { emitPipelineEvent } from '../db/pipeline-events.js'
import { emitAuditEvent } from '../db/audit.js'

const log = logger.child({ component: 'embedding-retry' })

/** Max rows per table per tick. 15-min cron × 25 rows × 3 tables = 300/hour ceiling. */
const BATCH_LIMIT = 25

/** Attempt cap per row. Past this, the row is skipped until manual ops. */
const MAX_ATTEMPTS = 5

/** Minimum gap between retries of the same row, to avoid tick-level hammering. */
const MIN_RETRY_GAP_MS = 60 * 60 * 1000 // 1 hour

/** A row pulled from any embeddable table — just enough to feed embedText + write back. */
type EmbeddableRow = {
  lookupKey: string
  text: string
  attemptCount: number
}

/**
 * Heal one table's worth of unembedded rows. Each call selects up to
 * BATCH_LIMIT eligible rows, embeds each, and writes the vector or bumps
 * the attempt counter.
 *
 * Bounded:
 * - BATCH_LIMIT rows per tick per table
 * - MAX_ATTEMPTS attempts per row, tracked via embedding_attempt_count
 * - MIN_RETRY_GAP_MS between successive attempts on the same row
 *
 * NOTE: the cutoff Date must be passed via Drizzle's structured `lt()`
 * operator — interpolating it into a raw `sql\`< ${cutoff}\`` template
 * throws "Received an instance of Date" inside postgres-js parameter
 * binding (it expects string/Buffer/ArrayBuffer). Structured operators
 * know the column type (`timestamp`) and serialize Date → ISO. This was
 * the bug that broke the original fragment-only worker for months.
 */
async function retryTable<TableName extends 'fragments' | 'wikis' | 'people'>(
  tableName: TableName,
  cutoff: Date,
  embedConfig: { apiKey: string; model: string }
): Promise<{ scanned: number; ok: number; failed: number }> {
  let rows: EmbeddableRow[]

  if (tableName === 'fragments') {
    const out = await db
      .select({
        lookupKey: fragments.lookupKey,
        title: fragments.title,
        content: fragments.content,
        attemptCount: fragments.embeddingAttemptCount,
      })
      .from(fragments)
      .where(
        and(
          isNull(fragments.embedding),
          isNull(fragments.deletedAt),
          sql`${fragments.embeddingAttemptCount} < ${MAX_ATTEMPTS}`,
          or(
            isNull(fragments.embeddingLastAttemptAt),
            lt(fragments.embeddingLastAttemptAt, cutoff)
          )
        )
      )
      .orderBy(sql`${fragments.embeddingLastAttemptAt} NULLS FIRST`)
      .limit(BATCH_LIMIT)
    rows = out.map((r) => ({
      lookupKey: r.lookupKey,
      // Fall back to title when content is empty. Some fragments (e.g.
      // quick-capture title-only entries) have no content body but still
      // carry a meaningful title — embed that so vector search has at
      // least weak signal and the row stops cluttering health snapshots
      // as null_embedding forever.
      text:
        r.content && r.content.trim().length > 0
          ? r.content
          : r.title ?? '',
      attemptCount: r.attemptCount,
    }))
  } else if (tableName === 'wikis') {
    const out = await db
      .select({
        lookupKey: wikis.lookupKey,
        name: wikis.name,
        description: wikis.description,
        content: wikis.content,
        attemptCount: wikis.embeddingAttemptCount,
      })
      .from(wikis)
      .where(
        and(
          isNull(wikis.embedding),
          isNull(wikis.deletedAt),
          sql`${wikis.embeddingAttemptCount} < ${MAX_ATTEMPTS}`,
          or(
            isNull(wikis.embeddingLastAttemptAt),
            lt(wikis.embeddingLastAttemptAt, cutoff)
          )
        )
      )
      .orderBy(sql`${wikis.embeddingLastAttemptAt} NULLS FIRST`)
      .limit(BATCH_LIMIT)
    rows = out.map((r) => ({
      lookupKey: r.lookupKey,
      // Embed body content if present; otherwise fall back to title +
      // description (the same placeholder POST /wikis seeds with). Regen
      // will overwrite this with a content-based embedding once the wiki
      // synthesises.
      text:
        r.content && r.content.trim().length > 0
          ? r.content
          : `${r.name} ${r.description ?? ''}`.trim(),
      attemptCount: r.attemptCount,
    }))
  } else {
    const out = await db
      .select({
        lookupKey: people.lookupKey,
        name: people.name,
        aliases: people.aliases,
        relationship: people.relationship,
        content: people.content,
        attemptCount: people.embeddingAttemptCount,
      })
      .from(people)
      .where(
        and(
          isNull(people.embedding),
          isNull(people.deletedAt),
          sql`${people.embeddingAttemptCount} < ${MAX_ATTEMPTS}`,
          or(
            isNull(people.embeddingLastAttemptAt),
            lt(people.embeddingLastAttemptAt, cutoff)
          )
        )
      )
      .orderBy(sql`${people.embeddingLastAttemptAt} NULLS FIRST`)
      .limit(BATCH_LIMIT)
    rows = out.map((r) => ({
      lookupKey: r.lookupKey,
      // People embed source: name + aliases + relationship + content.
      // Mirrors what POST /people uses at create time, plus content if
      // a regen has filled it in.
      text: [
        r.name,
        ...(r.aliases ?? []),
        r.relationship ?? '',
        r.content ?? '',
      ]
        .filter((s) => s && s.length > 0)
        .join(' '),
      attemptCount: r.attemptCount,
    }))
  }

  let ok = 0
  let failed = 0

  for (const row of rows) {
    const vec = row.text.trim().length > 0 ? await embedText(row.text, embedConfig) : null

    if (vec) {
      if (tableName === 'fragments') {
        await db
          .update(fragments)
          .set({ embedding: vec, embeddingLastAttemptAt: new Date() })
          .where(eq(fragments.lookupKey, row.lookupKey))
      } else if (tableName === 'wikis') {
        await db
          .update(wikis)
          .set({ embedding: vec, embeddingLastAttemptAt: new Date() })
          .where(eq(wikis.lookupKey, row.lookupKey))
      } else {
        await db
          .update(people)
          .set({ embedding: vec, embeddingLastAttemptAt: new Date() })
          .where(eq(people.lookupKey, row.lookupKey))
      }
      ok++
    } else {
      const failure = takeLastEmbedFailure()
      log.warn(
        { table: tableName, lookupKey: row.lookupKey, attempt: row.attemptCount + 1, failure },
        'embedding retry failed'
      )
      const nextAttempt = row.attemptCount + 1
      if (tableName === 'fragments') {
        await db
          .update(fragments)
          .set({
            embeddingAttemptCount: nextAttempt,
            embeddingLastAttemptAt: new Date(),
          })
          .where(eq(fragments.lookupKey, row.lookupKey))
      } else if (tableName === 'wikis') {
        await db
          .update(wikis)
          .set({
            embeddingAttemptCount: nextAttempt,
            embeddingLastAttemptAt: new Date(),
          })
          .where(eq(wikis.lookupKey, row.lookupKey))
      } else {
        await db
          .update(people)
          .set({
            embeddingAttemptCount: nextAttempt,
            embeddingLastAttemptAt: new Date(),
          })
          .where(eq(people.lookupKey, row.lookupKey))
      }
      failed++
    }
  }

  return { scanned: rows.length, ok, failed }
}

/**
 * Scheduler-driven retry of fragments, wikis, and people whose embedding
 * column is still NULL (likely because the original ingest/create hit an
 * OpenRouter failure). Runs every 15 minutes per the BullMQ scheduler.
 *
 * Pairs with the boot-time reachability probe (issue #150) — if the probe
 * refuses to start workers, this never runs; if it allows workers to start,
 * this worker opportunistically heals rows that failed at create time.
 */
export async function processEmbeddingRetryJob(
  job: EmbeddingRetryJob
): Promise<JobResult> {
  log.info({ jobId: job.jobId }, 'processing embedding retry batch')
  const t0 = performance.now()

  // Embedding-retry batches sweep all unembedded rows across fragments / wikis /
  // people; there is no single entryKey. Pipeline-event emission keeps that
  // column null and surfaces detail (per-table scan/ok/failed counts) in
  // metadata. Audit log gets a parallel summary row so the cron run is visible
  // alongside other system audits.
  await emitPipelineEvent(db as never, {
    entryKey: null,
    jobId: job.jobId,
    stage: 'embed',
    status: 'started',
    metadata: { triggeredBy: job.triggeredBy },
  })

  let config: Awaited<ReturnType<typeof loadOpenRouterConfig>> | undefined
  try {
    config = await loadOpenRouterConfig()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ jobId: job.jobId, error: message }, 'openrouter config unavailable — skipping batch')
    // Treat a missing key as a non-fatal skip for the cron — emit a completed
    // row with reason so operators can see the retry batch ran but no-op'd.
    await emitPipelineEvent(db as never, {
      entryKey: null,
      jobId: job.jobId,
      stage: 'embed',
      status: 'completed',
      metadata: { skipped: true, reason: 'no_openrouter_config', error: message },
    })
    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  }

  const cutoff = new Date(Date.now() - MIN_RETRY_GAP_MS)
  const embedConfig = { apiKey: config.apiKey, model: config.models.embedding }

  try {
    const fragResult = await retryTable('fragments', cutoff, embedConfig)
    const wikiResult = await retryTable('wikis', cutoff, embedConfig)
    const peopleResult = await retryTable('people', cutoff, embedConfig)

    const elapsed = Math.round(performance.now() - t0)
    log.info(
      {
        jobId: job.jobId,
        fragments: fragResult,
        wikis: wikiResult,
        people: peopleResult,
        ms: elapsed,
      },
      'embedding retry batch done'
    )

    await emitPipelineEvent(db as never, {
      entryKey: null,
      jobId: job.jobId,
      stage: 'embed',
      status: 'completed',
      metadata: {
        fragments: fragResult,
        wikis: wikiResult,
        people: peopleResult,
        durationMs: elapsed,
      },
    })

    // Parallel audit row so /admin/diagnose's audit_log column carries a
    // human-readable summary of the cron tick (dashboards / log greps that
    // look at audit_log, not pipeline_events, still see embed activity).
    await emitAuditEvent(db, {
      entityType: 'embedding_retry',
      entityId: job.jobId,
      eventType: 'completed',
      source: 'system',
      summary: `Embedding retry batch: ${fragResult.ok}+${wikiResult.ok}+${peopleResult.ok} healed, ${fragResult.failed}+${wikiResult.failed}+${peopleResult.failed} still pending`,
      detail: {
        fragments: fragResult,
        wikis: wikiResult,
        people: peopleResult,
        durationMs: elapsed,
      },
    })

    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const elapsed = Math.round(performance.now() - t0)
    log.error({ jobId: job.jobId, error: message, ms: elapsed }, 'embedding retry batch failed')
    await emitPipelineEvent(db as never, {
      entryKey: null,
      jobId: job.jobId,
      stage: 'embed',
      status: 'failed',
      metadata: { error: message, durationMs: elapsed },
    })
    await emitAuditEvent(db, {
      entityType: 'embedding_retry',
      entityId: job.jobId,
      eventType: 'failed',
      source: 'system',
      summary: `Embedding retry batch failed: ${message}`,
      detail: { error: message, durationMs: elapsed },
    })
    throw err
  }
}
