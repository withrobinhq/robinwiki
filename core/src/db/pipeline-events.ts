import { lt, and, eq, or, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { pipelineEvents } from './schema.js'

/**
 * Top-level stage taxonomy for `pipeline_events.stage`. Five names cover
 * every queue worker:
 *   - capture: extraction worker (intake + persist)
 *   - fragment: fragmentation sub-stage
 *   - classify: link worker (wiki-classify, frag-relate, entity-extract)
 *   - regen: regen worker (single + batch)
 *   - embed: embedding-retry worker
 *
 * Sub-stage detail (entity-extract, wiki-classify, persist, etc.) goes into
 * `metadata.substage` so /admin/diagnose can render it without re-introducing
 * a string-typed stage column. `entry_key` is nullable because regen and
 * embedding-retry jobs are not entry-scoped.
 */
export type PipelineStage = 'capture' | 'fragment' | 'classify' | 'regen' | 'embed'

export type PipelineStatus = 'started' | 'completed' | 'failed'

export interface EmitEventParams {
  /** May be null for regen / embed batch jobs that are not entry-scoped. */
  entryKey: string | null
  jobId: string
  stage: PipelineStage
  status: PipelineStatus
  fragmentKey?: string
  metadata?: Record<string, unknown>
}

export async function emitPipelineEvent(
  db: PostgresJsDatabase,
  params: EmitEventParams
): Promise<void> {
  await db.insert(pipelineEvents).values({
    id: crypto.randomUUID(),
    entryKey: params.entryKey,
    jobId: params.jobId,
    stage: params.stage,
    status: params.status,
    fragmentKey: params.fragmentKey ?? null,
    metadata: params.metadata ?? null,
  })
}

interface PruneOptions {
  successDays?: number
  failureDays?: number
}

export async function prunePipelineEvents(
  db: PostgresJsDatabase,
  options: PruneOptions = {}
): Promise<number> {
  const successDays = options.successDays ?? 30
  const failureDays = options.failureDays ?? 90

  const result = await db
    .delete(pipelineEvents)
    .where(
      or(
        and(
          eq(pipelineEvents.status, 'completed'),
          lt(pipelineEvents.createdAt, sql`NOW() - INTERVAL '${sql.raw(String(successDays))} days'`)
        ),
        and(
          eq(pipelineEvents.status, 'failed'),
          lt(pipelineEvents.createdAt, sql`NOW() - INTERVAL '${sql.raw(String(failureDays))} days'`)
        )
      )
    )
    .returning({ id: pipelineEvents.id })

  return result.length
}
