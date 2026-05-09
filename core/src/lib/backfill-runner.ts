/**
 * Shared library for the wiki_agent_schema backfill (#69 D6 follow-up).
 *
 * Used by both:
 *   1. core/scripts/backfill-wiki-agent-schema.ts — operator CLI.
 *   2. core/src/routes/admin/backfill.ts — POST /admin/backfill/wiki-agent-schema.
 *
 * Extracted from the original script body so the API route can run the
 * same paginated loop without spawning a tsx subprocess.
 *
 * The HyDE pass remains the responsibility of the periodic heal worker
 * (core/src/queue/embedding-retry-worker.ts) because each HyDE write is a
 * 3 to 8 second LLM round-trip plus an embedding. This runner only writes
 * the kind='description' row so an operator-triggered backfill stays
 * bounded to embedding cost rather than burning model spend on a huge
 * batch of HyDE generations all at once.
 */

import { embedText } from '@robin/agent'
import type { DB } from '../db/client.js'
import { logger } from './logger.js'
import { loadOpenRouterConfig } from './openrouter-config.js'
import {
  ensureAgentSchema,
  findWikisMissingDescriptionRow,
  findWikisMissingHydeRow,
} from './wiki-agent-schema.js'
import { wikis, wikiAgentSchema } from '../db/schema.js'
import { and, eq, isNull, sql } from 'drizzle-orm'

const log = logger.child({ component: 'backfill-runner' })

export interface BackfillOptions {
  /** When true, scan only and report counts; do not embed or write. */
  dryRun?: boolean
  /** Cap on rows processed in this run. Defaults to no cap. */
  limit?: number
  /** Scope to a single wiki by lookup key. When set, --limit is ignored. */
  wikiKey?: string
}

export interface BackfillResult {
  ok: number
  failed: number
  scanned: number
  dryRun: boolean
  wikiKey: string | null
  durationMs: number
}

const PAGE_SIZE = 100

/**
 * Run the description-row backfill loop. Returns ok/failed/scanned counts
 * plus wall-clock duration. Caller is responsible for surfacing the
 * outcome (CLI logs it; the route records a scheduled-jobs row).
 */
export async function runWikiAgentSchemaBackfill(
  db: DB,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const dryRun = Boolean(opts.dryRun)
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : Number.MAX_SAFE_INTEGER
  const wikiKey = opts.wikiKey ?? null
  const t0 = performance.now()

  let ok = 0
  let failed = 0
  let scanned = 0

  // Embed config is required for the live (non-dryRun) path. Narrow it
  // once at the top so the inner loops can pass the typed config without
  // re-asserting on each call.
  const config = dryRun ? null : await loadOpenRouterConfig()
  const embedConfig = config
    ? { apiKey: config.apiKey, model: config.models.embedding }
    : null

  // Single-wiki scope: skip the paged sweep, target one row.
  if (wikiKey) {
    const targets = await findWikisMissingDescriptionRow(db, 1)
    const target = targets.find((t) => t.wikiKey === wikiKey)
    if (!target) {
      // The wiki either does not need backfill or does not exist; the
      // outcome is a no-op from the runner's perspective.
      return {
        ok: 0,
        failed: 0,
        scanned: 0,
        dryRun,
        wikiKey,
        durationMs: Math.round(performance.now() - t0),
      }
    }
    scanned = 1
    if (dryRun || !embedConfig || !config) {
      ok = 1
    } else {
      try {
        const vec = await embedText(target.description, embedConfig)
        if (vec) {
          await ensureAgentSchema(db, target.wikiKey, {
            mode: 'backfill',
            description: target.description,
            precomputedEmbedding: vec,
            orConfig: config,
            context: { source: 'system', triggeredBy: 'backfill' },
          })
          ok = 1
        } else {
          failed = 1
        }
      } catch (err) {
        failed = 1
        log.warn(
          { wikiKey: target.wikiKey, err: err instanceof Error ? err.message : String(err) },
          'single-wiki backfill threw',
        )
      }
    }
    return {
      ok,
      failed,
      scanned,
      dryRun,
      wikiKey,
      durationMs: Math.round(performance.now() - t0),
    }
  }

  // Bulk sweep: pull pages of missing-description targets until empty
  // or until we hit the limit cap.
  let processed = 0
  while (processed < limit) {
    const remaining = limit - processed
    const chunk = await findWikisMissingDescriptionRow(db, Math.min(PAGE_SIZE, remaining))
    if (chunk.length === 0) break
    scanned += chunk.length

    for (const target of chunk) {
      if (dryRun || !embedConfig || !config) {
        ok++
        processed++
        continue
      }
      try {
        const vec = await embedText(target.description, embedConfig)
        if (vec) {
          await ensureAgentSchema(db, target.wikiKey, {
            mode: 'backfill',
            description: target.description,
            precomputedEmbedding: vec,
            orConfig: config,
            context: { source: 'system', triggeredBy: 'backfill' },
          })
          ok++
        } else {
          failed++
          log.warn(
            { wikiKey: target.wikiKey },
            'embed returned null; skipping (heal worker will retry)',
          )
        }
      } catch (err) {
        failed++
        log.warn(
          {
            wikiKey: target.wikiKey,
            err: err instanceof Error ? err.message : String(err),
          },
          'backfill threw; skipping',
        )
      }
      processed++
    }

    if (chunk.length < PAGE_SIZE) break
  }

  return {
    ok,
    failed,
    scanned,
    dryRun,
    wikiKey: null,
    durationMs: Math.round(performance.now() - t0),
  }
}

export interface AuditResult {
  /** Wiki keys missing a kind='description' row (or NULL embedding). */
  missingDescription: string[]
  /** Wiki keys missing a kind='hyde_synthetic' row. */
  missingHyde: string[]
  /** When the audit ran. */
  generatedAt: string
}

/**
 * Read-only audit pass. Scans wikis for missing agent_schema rows and
 * returns the gap list. No writes, no LLM calls, no embedding calls.
 *
 * The trigger endpoint POST /admin/backfill/wiki-agent-schema runs the
 * actual backfill; the operator UI reads this audit to decide whether
 * to trigger it.
 */
export async function auditWikiAgentSchema(db: DB): Promise<AuditResult> {
  // Reuse the same helpers the heal worker uses. Pass a generous cap; the
  // single-tenant corpus is bounded and we surface the full list to the
  // operator (no pagination on the UI side yet).
  const HARD_CAP = 5000

  const missingDescriptionRows = await findWikisMissingDescriptionRow(db, HARD_CAP)
  const missingHyde = await findWikisMissingHydeRow(db, HARD_CAP)

  return {
    missingDescription: missingDescriptionRows.map((r) => r.wikiKey),
    missingHyde,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Per-wiki agent_schema status used by the Wikis panel's backfill column.
 * Returns one of:
 *   - 'complete'           — both description and hyde_synthetic present
 *   - 'missing_description' — kind='description' row missing or NULL embedding
 *   - 'missing_hyde'       — kind='hyde_synthetic' row missing
 *   - 'missing_both'       — neither kind written
 *
 * Does not call the helpers' query because callers want a per-wiki map
 * keyed by lookup_key, and findWikisMissing* return only the missing
 * rows. We do a single GROUP BY query.
 */
export type AgentSchemaStatus =
  | 'complete'
  | 'missing_description'
  | 'missing_hyde'
  | 'missing_both'

export async function loadAgentSchemaStatusByWiki(
  db: DB,
): Promise<Map<string, AgentSchemaStatus>> {
  // For each non-deleted wiki, count rows by kind. Empty description gates
  // the row; we treat missing-description as a real gap regardless of
  // whether wikis.description has text (the heal worker excludes empty).
  const rows = await db
    .select({
      wikiKey: wikis.lookupKey,
      kind: wikiAgentSchema.kind,
      hasEmbedding: sql<boolean>`(${wikiAgentSchema.embedding} IS NOT NULL)`,
    })
    .from(wikis)
    .leftJoin(wikiAgentSchema, eq(wikiAgentSchema.wikiKey, wikis.lookupKey))
    .where(and(isNull(wikis.deletedAt)))

  const map = new Map<string, { hasDesc: boolean; hasHyde: boolean }>()
  for (const r of rows) {
    const slot = map.get(r.wikiKey) ?? { hasDesc: false, hasHyde: false }
    if (r.kind === 'description' && r.hasEmbedding) slot.hasDesc = true
    if (r.kind === 'hyde_synthetic' && r.hasEmbedding) slot.hasHyde = true
    map.set(r.wikiKey, slot)
  }

  const out = new Map<string, AgentSchemaStatus>()
  for (const [wikiKey, slot] of map.entries()) {
    if (slot.hasDesc && slot.hasHyde) out.set(wikiKey, 'complete')
    else if (!slot.hasDesc && !slot.hasHyde) out.set(wikiKey, 'missing_both')
    else if (!slot.hasDesc) out.set(wikiKey, 'missing_description')
    else out.set(wikiKey, 'missing_hyde')
  }
  return out
}
