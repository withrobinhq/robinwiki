import type { LinkingRecoveryJob, JobResult } from '@robin/queue'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { wikis } from '../db/schema.js'
import { recordJobRun } from '../lib/scheduled-jobs.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'linking-recovery' })

const JOB_NAME = 'linking_recovery'

/**
 * Stale-lock threshold. The CasLock TTL is 90s with autoRenew every ~72s,
 * so a legitimately in-progress regen will have locked_at refreshed
 * continuously. If locked_at is >15 minutes stale, the holder is dead.
 */
const STALE_THRESHOLD_MINUTES = 15

/**
 * Periodic scan for wikis stuck in LINKING state after a worker crash.
 *
 * When a regen worker is killed mid-Quill-call (e.g. SIGTERM during
 * deploy), the wiki's state column stays 'LINKING' indefinitely. This
 * blocks all auto-regen paths: the regen worker skips LINKING wikis,
 * the debounce filter treats LINKING as "in progress", and the midnight
 * cron skips LINKING wikis.
 *
 * The scan finds wikis where state='LINKING' and locked_at is older than
 * 15 minutes (stale lock from a dead worker), resets them to PENDING
 * with dirty_since=NOW() so the normal regen pipeline picks them up.
 *
 * Idempotent: running multiple times on the same stuck wiki is safe.
 * The first run resets to PENDING; subsequent runs see state='PENDING'
 * and the WHERE clause no longer matches.
 */
export async function processLinkingRecoveryJob(
  job: LinkingRecoveryJob
): Promise<JobResult> {
  log.info({ jobId: job.jobId }, 'scanning for stuck LINKING wikis')
  const t0 = performance.now()

  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000)

    const stuckWikis = await db
      .select({ lookupKey: wikis.lookupKey })
      .from(wikis)
      .where(
        and(
          eq(wikis.state, 'LINKING'),
          lt(wikis.lockedAt, cutoff),
          isNull(wikis.deletedAt),
        )
      )

    let recovered = 0
    for (const row of stuckWikis) {
      await db
        .update(wikis)
        .set({
          state: 'PENDING',
          dirtySince: new Date(),
          lockedBy: null,
          lockedAt: null,
        })
        .where(
          and(
            eq(wikis.lookupKey, row.lookupKey),
            eq(wikis.state, 'LINKING'),
          )
        )
      recovered++
      log.warn(
        { lookupKey: row.lookupKey },
        'unstuck wiki from LINKING to PENDING'
      )
    }

    const elapsed = Math.round(performance.now() - t0)
    log.info(
      { jobId: job.jobId, scanned: stuckWikis.length, recovered, ms: elapsed },
      'linking-recovery scan done'
    )

    await recordJobRun(
      db,
      JOB_NAME,
      'completed',
      { jobId: job.jobId, recovered },
      elapsed,
    )

    return {
      jobId: job.jobId,
      success: true,
      processedAt: new Date().toISOString(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const elapsed = Math.round(performance.now() - t0)
    log.error({ jobId: job.jobId, error: message }, 'linking-recovery scan failed')

    await recordJobRun(
      db,
      JOB_NAME,
      'failed',
      { jobId: job.jobId, error: message },
      elapsed,
    )

    throw err
  }
}
