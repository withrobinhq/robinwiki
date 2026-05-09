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
 * No migration: we read `MAX(edges.created_at)` per wiki to derive the
 * last fragment-arrival time. `wikis.last_rebuilt_at` already exists.
 *
 * @see {@link processRegenBatchJob} -- the consumer
 * @see {@link handleRegenNow} -- on-demand bypass for the MCP tool
 ***********************************************************************/

import { eq, and, isNull, inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { wikis, edges } from '../db/schema.js'
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
 * Filter a candidate set down to wikis whose most-recent FRAGMENT_IN_WIKI
 * edge is older than `now - REGEN_DEBOUNCE_MS`. Wikis with no edges yet
 * (no fragments attached) are treated as eligible; the debounce only
 * delays regen during active ingest.
 *
 * Reads `MAX(edges.created_at)` grouped by `dst_id` for the
 * `FRAGMENT_IN_WIKI` edge type. Single query, indexed by `edges_dst_idx`.
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
      wikiKey: edges.dstId,
      lastEdgeAt: sql<Date>`MAX(${edges.createdAt})`,
    })
    .from(edges)
    .where(
      and(
        inArray(edges.dstId, candidateKeys),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )
    .groupBy(edges.dstId)

  const lastEdgeByWiki = new Map<string, Date>()
  for (const r of rows) {
    if (r.lastEdgeAt) lastEdgeByWiki.set(r.wikiKey, new Date(r.lastEdgeAt))
  }

  const cutoff = now.getTime() - debounceMs
  const eligible: string[] = []
  const debounced: { wikiKey: string; lastEdgeAt: Date; etaMs: number }[] = []
  for (const key of candidateKeys) {
    const last = lastEdgeByWiki.get(key)
    if (!last) {
      // No fragment edges yet -- nothing to wait on.
      eligible.push(key)
      continue
    }
    if (last.getTime() <= cutoff) {
      eligible.push(key)
    } else {
      debounced.push({
        wikiKey: key,
        lastEdgeAt: last,
        etaMs: last.getTime() + debounceMs - now.getTime(),
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
