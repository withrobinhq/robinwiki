#!/usr/bin/env tsx
/**
 * One-shot backfill for the kind='description' rows in wiki_agent_schema.
 *
 * The body of this script lives in core/src/lib/backfill-runner.ts so the
 * same loop powers POST /admin/backfill/wiki-agent-schema. The CLI wrapper
 * here just parses flags and prints a summary.
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
 * incrementally on its 15-minute cron tick.
 *
 * Idempotent: a clean instance is a no-op.
 *
 * Flags:
 *   --dry-run    Report the intended target count without writing.
 *   --limit N    Cap the number of wikis processed in this run.
 *
 * Usage:
 *   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts
 *   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts -- --dry-run
 *   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts -- --limit 50
 */

import 'dotenv/config'
import { db } from '../src/db/client.js'
import { logger } from '../src/lib/logger.js'
import { runWikiAgentSchemaBackfill } from '../src/lib/backfill-runner.js'

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
  const result = await runWikiAgentSchemaBackfill(db, { dryRun, limit })

  log.info(
    { dryRun, scanned: result.scanned, ok: result.ok, failed: result.failed },
    `backfill done: ${result.ok} written, ${result.failed} failed, ${result.scanned} scanned`,
  )

  // Hard exit so the postgres pool teardown does not leave handles hanging
  // on `tsx` runs from a pnpm script context.
  process.exit(result.failed > 0 ? 1 : 0)
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'backfill failed')
  process.exit(2)
})
