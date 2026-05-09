/***********************************************************************
 * @module queue/regen-debounce
 *
 * @summary Per-wiki regen debounce + shared enqueue helper.
 *
 * @remarks
 * QA Issue 6 (2026-05-08): a 60-minute ingest of 89 entries / 534
 * fragments triggered 27 back-to-back regens because every fragment
 * landing a FRAGMENT_IN_WIKI edge immediately re-matched the regen
 * batch worker's "wiki has new edges since last_rebuilt_at" rule.
 *
 * Each regen is 70 to 180 seconds of LLM work. Most runs were
 * superseded by the next batch of fragment arrivals before the output
 * mattered. Net effect: continuous LLM cost during active capture.
 *
 * Fix: gate the two ingest-driven trigger reasons (unfiled fragments,
 * new fragment edges) behind a "wiki has been quiet for N minutes"
 * check. Recovery (Reason 3, stuck state) and the explicit-cadence
 * midnight cron (Reason 4) bypass the debounce.
 *
 * v0.2.2 (T4-bundle): read `wikis.dirty_since` directly. The query-time
 * `MAX(edges.created_at)` derivation went away when migration 0014 added
 * the column. The signal is identical (set on edge insert, cleared on
 * regen completion), but the read is one column lookup instead of a
 * grouped scan over edges.
 *
 * @see {@link processRegenBatchJob} -- the consumer
 * @see {@link handleRegenNow} -- on-demand bypass for the MCP tool
 ***********************************************************************/

import { eq, and, isNull, inArray, sql, desc } from 'drizzle-orm'
import { QUEUE_NAMES } from '@robin/queue'
import type { DB } from '../db/client.js'
import { wikis, fragments, pipelineEvents } from '../db/schema.js'
import { producer } from './producer.js'

/**
 * Default per-wiki quiet window before regen is eligible. Tunable via
 * the `REGEN_DEBOUNCE_MS` env var. Five minutes was picked to outlast
 * a typical conversational ingest burst (the QA scenario was 60 min
 * of mixed ingest, with bursts clustered every few minutes) without
 * starving the user of "I just dropped some thoughts, when does the
 * wiki update?" feedback longer than feels natural.
 */
export const DEFAULT_REGEN_DEBOUNCE_MS = 5 * 60 * 1000

/** Read the configured debounce window. Clamped to [0, 1 hour]. */
export function regenDebounceMs(): number {
  const raw = process.env.REGEN_DEBOUNCE_MS
  if (!raw) return DEFAULT_REGEN_DEBOUNCE_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REGEN_DEBOUNCE_MS
  // Hard ceiling so a typo cannot park regen indefinitely.
  return Math.min(n, 60 * 60 * 1000)
}

/**
 * Filter a candidate set down to wikis whose `dirty_since` is older than
 * `now - REGEN_DEBOUNCE_MS`. Wikis with `dirty_since IS NULL` (clean,
 * nothing to regen) are treated as eligible; the debounce only delays
 * regen during active ingest.
 *
 * v0.2.2 (T4-bundle): reads `wikis.dirty_since` directly. The signal is
 * stamped by every FRAGMENT_IN_WIKI edge insert and cleared on regen
 * completion, so it carries the same meaning as the old MAX(edges.created_at)
 * derivation but in a single column lookup.
 */
export async function filterDebouncedWikiKeys(
  db: DB,
  candidateKeys: string[],
  now: Date = new Date()
): Promise<{ eligible: string[]; debounced: { wikiKey: string; lastEdgeAt: Date; etaMs: number }[] }> {
  if (candidateKeys.length === 0) return { eligible: [], debounced: [] }
  const debounceMs = regenDebounceMs()
  if (debounceMs === 0) return { eligible: [...candidateKeys], debounced: [] }

  const rows = await db
    .select({
      wikiKey: wikis.lookupKey,
      dirtySince: wikis.dirtySince,
    })
    .from(wikis)
    .where(and(inArray(wikis.lookupKey, candidateKeys), isNull(wikis.deletedAt)))

  const dirtySinceByWiki = new Map<string, Date | null>()
  for (const r of rows) {
    dirtySinceByWiki.set(r.wikiKey, r.dirtySince ?? null)
  }

  const cutoff = now.getTime() - debounceMs
  const eligible: string[] = []
  const debounced: { wikiKey: string; lastEdgeAt: Date; etaMs: number }[] = []
  for (const key of candidateKeys) {
    const dirtySince = dirtySinceByWiki.get(key) ?? null
    if (!dirtySince) {
      // dirty_since is null, nothing to wait on.
      eligible.push(key)
      continue
    }
    if (dirtySince.getTime() <= cutoff) {
      eligible.push(key)
    } else {
      debounced.push({
        wikiKey: key,
        lastEdgeAt: dirtySince,
        etaMs: dirtySince.getTime() + debounceMs - now.getTime(),
      })
    }
  }
  return { eligible, debounced }
}

/**
 * Shared helper: enqueue a regen job for a single wiki via the same
 * BullMQ producer the batch worker uses. Used by both the batch worker
 * (after debounce filtering) and the on-demand `regen_now` MCP tool
 * (which bypasses debounce intentionally).
 *
 * Returns `{ jobId, queuedAt }`. BullMQ collapses duplicate
 * `regen-${wikiKey}` job ids on the producer side, so calling this
 * twice in quick succession is a no-op.
 */
export async function enqueueWikiRegen(
  wikiKey: string,
  triggeredBy: 'scheduler' | 'manual'
): Promise<{ jobId: string; queuedAt: string }> {
  const jobId = crypto.randomUUID()
  const queuedAt = new Date().toISOString()
  await producer.enqueueRegen({
    type: 'regen',
    jobId,
    objectKey: wikiKey,
    objectType: 'wiki',
    triggeredBy,
    enqueuedAt: queuedAt,
  })
  return { jobId, queuedAt }
}

/**
 * Validate a wikiKey or slug exists and is not soft-deleted. Returns
 * the wiki's lookupKey + slug on hit, or null on miss. Used by the
 * `regen_now` MCP tool for caller-friendly errors.
 */
export async function resolveWikiForRegen(
  db: DB,
  keyOrSlug: string
): Promise<{ lookupKey: string; slug: string } | null> {
  const trimmed = keyOrSlug.trim()
  if (!trimmed) return null
  // Try lookupKey first (exact), then slug.
  const [byKey] = await db
    .select({ lookupKey: wikis.lookupKey, slug: wikis.slug })
    .from(wikis)
    .where(and(eq(wikis.lookupKey, trimmed), isNull(wikis.deletedAt)))
    .limit(1)
  if (byKey) return byKey
  const [bySlug] = await db
    .select({ lookupKey: wikis.lookupKey, slug: wikis.slug })
    .from(wikis)
    .where(and(eq(wikis.slug, trimmed), isNull(wikis.deletedAt)))
    .limit(1)
  return bySlug ?? null
}

/**
 * Snapshot of the regen worker's current state, surfaced via the
 * `regen_status` MCP tool. QA Issue 6's closing line: "add a 'regen
 * happening now' indicator". Without this surface the user only
 * notices regen via UI chip flicker; the cost is otherwise invisible.
 */
export interface RegenStatusSnapshot {
  inFlight: { jobId: string; wikiKey: string; startedAt: string | null; triggeredBy: 'scheduler' | 'manual' | null }[]
  debounced: { wikiKey: string; lastEdgeAt: string; etaToEligibleMs: number }[]
  recent: { wikiKey: string | null; jobId: string; status: 'started' | 'completed' | 'failed'; startedAt: string; durationMs: number | null }[]
  debounceMs: number
}

interface RegenJobPayload {
  __sig?: string
  type?: string
  jobId?: string
  objectKey?: string
  triggeredBy?: 'scheduler' | 'manual'
}

/**
 * Build a regen-status snapshot. Reads:
 *   1. BullMQ active + waiting jobs on the regen queue (in-flight).
 *   2. Wikis whose most-recent fragment edge falls inside the debounce
 *      window (deferred regen candidates).
 *   3. Recent `pipeline_events` rows scoped to `stage='regen'` for the
 *      success-rate / latency view.
 *
 * No expensive aggregations -- this is a status pull, not a report.
 */
export async function getRegenStatus(
  db: DB,
  options: { recentLimit?: number } = {}
): Promise<RegenStatusSnapshot> {
  const recentLimit = Math.max(1, Math.min(options.recentLimit ?? 10, 100))

  // ── 1. In-flight regen jobs (BullMQ) ─────────────────────────────────
  // `getJobs` over active+waiting+delayed gives the live picture without
  // needing any persistence layer. Failures here log-and-continue so
  // status pulls degrade gracefully when redis blips.
  const inFlight: RegenStatusSnapshot['inFlight'] = []
  try {
    const queue = producer.getQueue(QUEUE_NAMES.regen)
    const jobs = await queue.getJobs(['active', 'waiting', 'delayed'], 0, 50)
    for (const job of jobs) {
      const data = job.data as RegenJobPayload
      const wikiKey = data?.objectKey ?? ''
      const jobId = (job.id as string) ?? data?.jobId ?? ''
      const startedAt = job.processedOn ? new Date(job.processedOn).toISOString() : null
      inFlight.push({
        jobId,
        wikiKey,
        startedAt,
        triggeredBy: data?.triggeredBy ?? null,
      })
    }
  } catch {
    // Redis unreachable -- inFlight stays empty. Caller can still use
    // the rest of the snapshot.
  }

  // ── 2. Debounced wikis ───────────────────────────────────────────────
  // Mirror the batch worker's Reason 1 + 2 candidate set, then run it
  // through filterDebouncedWikiKeys. The user-visible "what's it waiting
  // on?" view.
  const debounced: RegenStatusSnapshot['debounced'] = []
  try {
    const debounceCandidates = new Set<string>()

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
    if ((unfiledCount?.count ?? 0) > 0) {
      const rows = await db
        .select({ lookupKey: wikis.lookupKey })
        .from(wikis)
        .where(and(isNull(wikis.deletedAt), eq(wikis.autoregen, true)))
      for (const r of rows) debounceCandidates.add(r.lookupKey)
    }

    // T4-bundle (v0.2.2): dirty_since is now a column, read it directly
    // instead of joining edges and deriving freshness at query time.
    const wikisWithNewFragments = await db
      .select({ lookupKey: wikis.lookupKey })
      .from(wikis)
      .where(
        and(
          isNull(wikis.deletedAt),
          eq(wikis.autoregen, true),
          sql`${wikis.dirtySince} IS NOT NULL`,
        )
      )
    for (const r of wikisWithNewFragments) debounceCandidates.add(r.lookupKey)

    const { debounced: deferred } = await filterDebouncedWikiKeys(
      db,
      Array.from(debounceCandidates)
    )
    for (const d of deferred) {
      debounced.push({
        wikiKey: d.wikiKey,
        lastEdgeAt: d.lastEdgeAt.toISOString(),
        etaToEligibleMs: d.etaMs,
      })
    }
  } catch {
    // DB blip -- debounced stays empty rather than failing the whole call.
  }

  // ── 3. Recent regen events ───────────────────────────────────────────
  // Pull the last N completed/failed/started rows for stage='regen'.
  // The existing index `pipeline_events_status_stage_idx` makes this
  // cheap. Pair started + completed by jobId for duration display.
  const recent: RegenStatusSnapshot['recent'] = []
  try {
    const rows = await db
      .select({
        jobId: pipelineEvents.jobId,
        status: pipelineEvents.status,
        createdAt: pipelineEvents.createdAt,
        metadata: pipelineEvents.metadata,
      })
      .from(pipelineEvents)
      .where(eq(pipelineEvents.stage, 'regen'))
      .orderBy(desc(pipelineEvents.createdAt))
      .limit(recentLimit * 4)

    // Group by jobId, keep the latest status for each (rows already
    // ordered desc).
    const seen = new Map<string, typeof rows[number]>()
    for (const r of rows) {
      if (!seen.has(r.jobId)) seen.set(r.jobId, r)
      if (seen.size >= recentLimit) break
    }
    for (const r of seen.values()) {
      const meta = (r.metadata ?? {}) as { wikiKey?: string; durationMs?: number }
      const status = r.status as 'started' | 'completed' | 'failed'
      recent.push({
        wikiKey: meta.wikiKey ?? null,
        jobId: r.jobId,
        status,
        startedAt: r.createdAt.toISOString(),
        durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
      })
    }
  } catch {
    // Same fail-open posture.
  }

  return {
    inFlight,
    debounced,
    recent,
    debounceMs: regenDebounceMs(),
  }
}
