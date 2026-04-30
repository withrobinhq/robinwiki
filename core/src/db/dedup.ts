import { createHash } from 'node:crypto'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { processedJobs, entries, fragments } from './schema.js'
import type { DB } from './client.js'

// ─── computeContentHash ───

/**
 * @summary Normalise content then return its SHA-256 hex digest.
 *
 * @remarks
 * Normalisation: trim outer whitespace, collapse runs of whitespace to a
 * single space. This means "Hello  world\n" and " Hello world " hash to
 * the same value, preventing near-duplicate re-submissions.
 */
export function computeContentHash(content: string): string {
  const normalised = content.trim().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalised).digest('hex')
}

// ─── Content-level dedup ───

/**
 * @summary Check if an entry with identical content already exists.
 *
 * @returns The existing entry row if duplicate, or null if content is new.
 */
export async function findDuplicateEntry(db: DB, dedupHash: string) {
  const [existing] = await db
    .select()
    .from(entries)
    .where(eq(entries.dedupHash, dedupHash))
    .limit(1)
  return existing ?? null
}

/**
 * @summary Check if a fragment with identical content already exists.
 *
 * @returns The existing fragment row if duplicate, or null if content is new.
 *
 * @remarks
 * The `deleted_at IS NULL` predicate is required for the planner to use the
 * partial index `fragments_dedup_hash_idx` (defined `WHERE deleted_at IS NULL`
 * in `schema.ts`). Without it the hot-path falls back to a Seq Scan even when
 * the index exists. Soft-deleted fragments are not eligible duplicates anyway,
 * so the predicate also matches the intended semantics.
 */
export async function findDuplicateFragment(db: DB, dedupHash: string) {
  const [existing] = await db
    .select()
    .from(fragments)
    .where(and(eq(fragments.dedupHash, dedupHash), isNull(fragments.deletedAt)))
    .limit(1)
  return existing ?? null
}

// ─── Job-level dedup (pipeline) ───

/**
 * Checks if a job has already been processed, by jobId or contentHash match.
 * Returns true if a matching record exists in processedJobs.
 */
export async function isDuplicate(
  db: DB,
  jobId: string,
  contentHash: string | null
): Promise<boolean> {
  const conditions = [eq(processedJobs.jobId, jobId)]

  if (contentHash != null) {
    conditions.push(eq(processedJobs.contentHash, contentHash))
  }

  const result = await db
    .select({ jobId: processedJobs.jobId })
    .from(processedJobs)
    .where(or(...conditions))
    .limit(1)

  return result.length > 0
}

// ─── recordJob ───

/**
 * Records a processed job and prunes entries older than 7 days,
 * both in a single transaction.
 */
export async function recordJob(db: DB, jobId: string, contentHash: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(processedJobs).values({
      jobId,
      contentHash,
    })

    await tx.execute(
      sql`DELETE FROM processed_jobs
          WHERE processed_at < NOW() - INTERVAL '7 days'`
    )
  })
}
