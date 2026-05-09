#!/usr/bin/env tsx
/**
 * One-shot backfill for the kind='description' rows in wiki_agent_schema.
 *
 * Recovery scenario: a deployment ran for a while before #69 closed the
 * wiki_agent_schema chicken-and-egg loop. The result is a long tail of
 * wikis with no row in wiki_agent_schema, so they compete only via the
 * legacy wikis.embedding lane and rank far below populated wikis. This
 * script writes a kind='description' row for every such wiki by embedding
 * `wikis.description` directly through the existing embedding service.
 *
 * The kind='hyde_synthetic' rows are intentionally NOT written here. HyDE
 * is an LLM round-trip per wiki at 3 to 8s and ~thousands of tokens. The
 * heal worker (core/src/queue/embedding-retry-worker.ts) picks those up
 * incrementally on its 15-minute cron tick, bounded to AGENT_SCHEMA_HYDE_BATCH
 * per tick so a 200-wiki backfill spreads out over the day rather than
 * burning a single block of model spend.
 *
 * Idempotent. Re-running on a clean instance is a no-op: the helper uses
 * INSERT ... ON CONFLICT DO UPDATE on (wiki_key, kind), and this script
 * only targets wikis where the row is missing or has a NULL embedding.
 *
 * Flags:
 *   --dry-run    Report the intended target count without writing. No
 *                OpenRouter calls. Safe to run anywhere DATABASE_URL
 *                points at a live DB.
 *   --limit N    Cap the number of wikis processed in this run. Useful
 *                when paginating across a very large instance. Defaults
 *                to no cap.
 *
 * Usage:
 *   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts
 *   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts -- --dry-run
 *   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts -- --limit 50
 */

import 'dotenv/config'
import { embedText } from '@robin/agent'
import { db } from '../src/db/client.js'
import { logger } from '../src/lib/logger.js'
import { loadOpenRouterConfig } from '../src/lib/openrouter-config.js'
import {
  findWikisMissingDescriptionRow,
  upsertDescriptionAgentSchemaRow,
} from '../src/lib/wiki-agent-schema.js'

const log = logger.child({ component: 'backfill-wiki-agent-schema' })

function parseFlags(argv: string[]): { dryRun: boolean; limit: number } {
  const args = argv.slice(2)
  let dryRun = false
  let limit = Number.MAX_SAFE_INTEGER
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--limit') {
      const next = args[i + 1]
      const parsed = Number(next)
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed)
        i++
      }
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length))
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed)
    }
  }
  return { dryRun, limit }
}

async function main(): Promise<void> {
  const { dryRun, limit } = parseFlags(process.argv)

  // Pull targets in chunks of 100. The heal-worker query already orders by
  // created_at ASC, so successive calls naturally page through the tail.
  const PAGE_SIZE = 100
  let processed = 0
  let ok = 0
  let failed = 0
  let scanned = 0

  let config: Awaited<ReturnType<typeof loadOpenRouterConfig>> | null = null
  if (!dryRun) {
    config = await loadOpenRouterConfig()
  }

  while (processed < limit) {
    const remaining = limit - processed
    const chunk = await findWikisMissingDescriptionRow(
      db,
      Math.min(PAGE_SIZE, remaining),
    )
    if (chunk.length === 0) break
    scanned += chunk.length

    for (const target of chunk) {
      if (dryRun) {
        log.info(
          { wikiKey: target.wikiKey, descriptionLen: target.description.length },
          'dry-run: would backfill description row',
        )
        ok++
        processed++
        continue
      }

      try {
        const vec = await embedText(target.description, {
          apiKey: config!.apiKey,
          model: config!.models.embedding,
        })
        if (vec) {
          await upsertDescriptionAgentSchemaRow(
            db,
            target.wikiKey,
            target.description,
            vec,
          )
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

    // The query is "still missing", so once we write rows, the next call
    // returns the next batch of unwritten wikis. Loop until empty or limit.
    if (chunk.length < PAGE_SIZE) break
  }

  log.info(
    { dryRun, scanned, ok, failed },
    `backfill done: ${ok} written, ${failed} failed, ${scanned} scanned`,
  )

  // Hard exit so the postgres pool teardown does not leave handles hanging
  // on `tsx` runs from a pnpm script context.
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'backfill failed')
  process.exit(2)
})
