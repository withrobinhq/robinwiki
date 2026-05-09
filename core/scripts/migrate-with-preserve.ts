#!/usr/bin/env tsx
/**
 * Migration wrapper for the v0.2.2 T4-bundle (migration 0014). The bundle
 * drops `wikis.regenerate` and renames `wikis.auto_regen` to
 * `wikis.autoregen` with default false. Any wiki that had `regenerate=true`
 * and `auto_regen=false` (the v0.2.1 default for "regen runs on this wiki
 * via Reasons 1 and 2 of the batch worker") will stop regenerating
 * automatically after the migration applies.
 *
 * The migration is intentionally BREAKING. Operators have three paths:
 *
 *   1. Run plain `runMigrations()` (or `pnpm -C core db:migrate`). Existing
 *      wikis end up with autoregen=false. Operators flip the ones they
 *      want to keep automatic via PATCH /wikis/:id/auto-regen.
 *
 *   2. Run this script with `--preserve-existing` (or set
 *      `MIGRATION_PRESERVE_EXISTING=true`). Before the migration applies,
 *      we flip autoregen=true (writing into `auto_regen` since the rename
 *      hasn't happened yet) for every row where regenerate=true. Existing
 *      "regen runs on this wiki" behaviour is preserved.
 *
 *   3. Skip the migration. The old columns stay, the regen worker keeps
 *      using them. Not recommended; the column drift will trip drift
 *      detection on the next deploy.
 *
 * Either way we print a one-shot operator warning showing the count of
 * wikis whose effective regen behaviour just changed.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { logger } from '../src/lib/logger.js'

const log = logger.child({ component: 'migrate-with-preserve' })

function flagSet(): boolean {
  if (process.env.MIGRATION_PRESERVE_EXISTING === 'true') return true
  return process.argv.includes('--preserve-existing')
}

async function countRegeneratingWikis(): Promise<number> {
  // Pre-migration, the columns still exist. Post-migration, this query
  // would fail; we only call it before applying.
  try {
    const rows = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM wikis
      WHERE regenerate = true AND auto_regen = false AND deleted_at IS NULL
    `)
    const arr = Array.isArray(rows) ? rows : []
    return arr[0]?.count ?? 0
  } catch {
    return 0
  }
}

async function preserveExistingAutoRegen(): Promise<number> {
  // Run BEFORE the migration applies. The column is still named
  // `auto_regen` at this point.
  const rows = await db.execute<{ count: number }>(sql`
    UPDATE wikis SET auto_regen = true
    WHERE regenerate = true AND auto_regen = false AND deleted_at IS NULL
    RETURNING lookup_key
  `)
  const arr = Array.isArray(rows) ? rows : []
  return arr.length
}

async function main(): Promise<void> {
  const preserve = flagSet()
  const affected = await countRegeneratingWikis()

  if (preserve) {
    if (affected > 0) {
      const flipped = await preserveExistingAutoRegen()
      log.info(
        { flipped },
        `--preserve-existing: flipped autoregen=true for ${flipped} wikis to keep their regen behaviour after migration 0014`
      )
    } else {
      log.info('--preserve-existing: no wikis to flip (none had regenerate=true and auto_regen=false)')
    }
  } else if (affected > 0) {
    log.warn(
      { affected },
      `BREAKING: migration 0014 will stop auto-regenerating ${affected} wikis. ` +
        `They had regenerate=true and auto_regen=false. After migration, autoregen=false ` +
        `means the batch worker no longer touches them. Use --preserve-existing or ` +
        `MIGRATION_PRESERVE_EXISTING=true to flip autoregen=true for those wikis ` +
        `before the migration runs. To re-enable per wiki post-migration, ` +
        `PATCH /wikis/:id/auto-regen with {"autoRegen": true}.`
    )
  }

  const migrationsFolder = new URL('../drizzle/migrations', import.meta.url).pathname
  await migrate(db, { migrationsFolder })
  log.info('migrations applied')
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'migrate-with-preserve failed')
  process.exit(1)
})
