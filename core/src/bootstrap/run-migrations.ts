import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { migrationsMeta } from '../db/schema.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'migrations' })

const JOURNAL_KEY = 'journal'

function readJournalSha(): string | null {
  try {
    const journalPath = new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url)
      .pathname
    const raw = readFileSync(journalPath, 'utf-8')
    return createHash('sha256').update(raw).digest('hex')
  } catch (err) {
    log.warn({ err }, 'could not read migration journal for drift detection')
    return null
  }
}

/**
 * Boot-time drift detection (Phyl #12). After Drizzle's migrate completes,
 * compare the SHA-256 of `meta/_journal.json` on disk to the value stored in
 * `migrations_meta` under id='journal'. Three outcomes:
 *
 *   - No DB row yet (first boot after migration 0003 lands): write the disk
 *     SHA in. Returns 'seeded'.
 *   - DB SHA matches disk SHA: returns 'match'. No-op.
 *   - DB SHA differs from disk SHA: returns 'drift' with both shas.
 *
 * The caller decides whether drift is fatal — production refuses to boot,
 * dev warns and updates the row so the next rebase doesn't keep tripping.
 */
export async function checkAndUpdateJournalDrift(): Promise<
  | { kind: 'seeded'; diskSha: string }
  | { kind: 'match'; sha: string }
  | { kind: 'drift'; diskSha: string; dbSha: string }
  | { kind: 'unavailable' }
> {
  const diskSha = readJournalSha()
  if (!diskSha) return { kind: 'unavailable' }

  const [row] = await db
    .select({ value: migrationsMeta.value })
    .from(migrationsMeta)
    .where(eq(migrationsMeta.id, JOURNAL_KEY))
    .limit(1)

  if (!row) {
    await db
      .insert(migrationsMeta)
      .values({ id: JOURNAL_KEY, value: diskSha })
      .onConflictDoUpdate({
        target: migrationsMeta.id,
        set: { value: diskSha, updatedAt: new Date() },
      })
    return { kind: 'seeded', diskSha }
  }

  if (row.value === diskSha) return { kind: 'match', sha: diskSha }

  return { kind: 'drift', diskSha, dbSha: row.value }
}

/**
 * Update the migrations_meta row to match the current disk SHA. Used by the
 * dev-warn path (we update so subsequent boots don't keep warning) and by the
 * post-migrate path (after a fresh migration applies, the journal SHA on disk
 * is the new authoritative value).
 */
export async function updateJournalSha(): Promise<void> {
  const diskSha = readJournalSha()
  if (!diskSha) return
  await db
    .insert(migrationsMeta)
    .values({ id: JOURNAL_KEY, value: diskSha })
    .onConflictDoUpdate({
      target: migrationsMeta.id,
      set: { value: diskSha, updatedAt: new Date() },
    })
}

/**
 * Run pending Drizzle migrations. Idempotent -- safe to call on every boot.
 * Logs which migrations were applied (or "no pending migrations" if none).
 *
 * On successful apply (newCount > 0), the migrations_meta journal row is
 * refreshed to the new disk SHA so drift detection on the *next* boot
 * compares against the post-migration value, not the pre-migration one.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = new URL('../../drizzle/migrations', import.meta.url).pathname

  // Read the journal to know which migrations exist on disk
  let journalEntries: { tag: string }[] = []
  try {
    const journalPath = new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url)
      .pathname
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    journalEntries = journal.entries ?? []
  } catch {
    log.warn('could not read migration journal — assuming first run')
  }

  // Count already-applied migrations before running
  let appliedBefore = 0
  try {
    const rows = await db.execute<{ created_at: number }>(
      /* sql */ `SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at`
    )
    appliedBefore = Array.isArray(rows) ? rows.length : 0
  } catch {
    // Table doesn't exist yet — first run, zero applied
    appliedBefore = 0
  }

  // Run Drizzle migrate (applies any pending, skips already-applied)
  await migrate(db, { migrationsFolder })

  // Count applied after
  let appliedAfter = 0
  try {
    const rows = await db.execute<{ created_at: number }>(
      /* sql */ `SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at`
    )
    appliedAfter = Array.isArray(rows) ? rows.length : 0
  } catch {
    appliedAfter = appliedBefore
  }

  const newCount = appliedAfter - appliedBefore
  if (newCount > 0) {
    // Log each newly applied migration by tag
    const newTags = journalEntries.slice(appliedBefore, appliedAfter)
    for (const entry of newTags) {
      log.info({ tag: entry.tag, appliedAt: new Date().toISOString() }, 'migration applied')
    }
    log.info({ count: newCount }, `${newCount} migration(s) applied`)

    // Newly applied → update the journal SHA in migrations_meta so the next
    // boot's drift check compares against the post-migration disk value.
    // Tolerated to fail (e.g., migrations_meta itself missing on a partial
    // 0003 apply) — the dedicated drift check that runs after this will
    // surface the mismatch.
    try {
      await updateJournalSha()
    } catch (err) {
      log.warn({ err }, 'failed to refresh migrations_meta journal sha')
    }
  } else {
    log.info('no pending migrations')
  }
}
