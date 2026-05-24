import { type Queue, signJob } from '@robin/queue'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'scheduler' })

/**
 * Set up the regen batch scheduler using BullMQ's upsertJobScheduler.
 * Fires every 12 hours (midnight and noon UTC). The scheduler name
 * 'midnight-regen' is retained for back-compat with existing BullMQ
 * persistence: renaming would orphan the previously-registered job.
 * If ENABLE_BATCH_REGEN is explicitly 'false', this is a no-op.
 */
export async function setupRegenScheduler(queue: Queue): Promise<void> {
  if (process.env.ENABLE_BATCH_REGEN === 'false') {
    log.info('ENABLE_BATCH_REGEN=false, skipping scheduler setup')
    return
  }

  await queue.upsertJobScheduler(
    'midnight-regen',
    { pattern: '0 */12 * * *' },
    {
      name: 'regen-batch',
      // SEC-H6: scheduler-emitted jobs flow through the same signed-payload
      // contract as producer-emitted jobs. `enqueuedAt` is fixed at scheduler
      // registration so the HMAC stays stable across cron firings — BullMQ
      // re-uses the upserted data for every scheduled run.
      data: signJob({
        type: 'regen-batch',
        jobId: 'midnight-regen-scheduled',
        triggeredBy: 'scheduler',
        enqueuedAt: new Date().toISOString(),
      }),
    }
  )

  log.info('regen batch scheduler registered (every 12 hours)')
}

/**
 * Register the embedding-retry scheduler. Runs every 15 minutes, retries a
 * bounded batch of fragments whose embedding column is still NULL. Rides on
 * the same BullMQ queue as the regen scheduler — the scheduler worker
 * dispatches by job.type.
 */
export async function setupEmbeddingRetryScheduler(queue: Queue): Promise<void> {
  if (process.env.ENABLE_EMBEDDING_RETRY === 'false') {
    log.info('ENABLE_EMBEDDING_RETRY=false, skipping scheduler setup')
    return
  }

  await queue.upsertJobScheduler(
    'embedding-retry',
    { pattern: '*/15 * * * *' },
    {
      name: 'embedding-retry',
      // SEC-H6 — see scheduler.ts above for the signed-payload rationale.
      data: signJob({
        type: 'embedding-retry',
        jobId: 'embedding-retry-scheduled',
        triggeredBy: 'scheduler',
        enqueuedAt: new Date().toISOString(),
      }),
    }
  )

  log.info('embedding retry scheduler registered')
}

/**
 * Register the daily prune-pipeline-events scheduler (#A1). prunePipelineEvents
 * trims completed rows older than 30 days and failed rows older than 90 days
 * (defaults inside core/src/db/pipeline-events.ts). Without this, the table
 * grows unbounded and operator queries against /admin/diagnose slow down at
 * the ~6-month mark.
 *
 * Runs once a day at 03:00 UTC — well clear of the midnight regen batch so
 * the two crons don't both wake up at the same minute.
 */
export async function setupPrunePipelineEventsScheduler(queue: Queue): Promise<void> {
  if (process.env.ENABLE_PIPELINE_EVENT_PRUNE === 'false') {
    log.info('ENABLE_PIPELINE_EVENT_PRUNE=false, skipping scheduler setup')
    return
  }

  await queue.upsertJobScheduler(
    'prune-pipeline-events',
    { pattern: '0 3 * * *' },
    {
      name: 'prune-pipeline-events',
      // SEC-H6 — same signed-payload contract as the other scheduled jobs.
      data: signJob({
        type: 'prune-pipeline-events',
        jobId: 'prune-pipeline-events-scheduled',
        triggeredBy: 'scheduler',
        enqueuedAt: new Date().toISOString(),
      }),
    }
  )

  log.info('prune-pipeline-events scheduler registered')
}

/**
 * Stream D / D5 — fragment-relationship backfill scheduler (#258). Runs at
 * midnight, walks fragments embedded before the related-edge logic landed
 * and creates RELATED_TO edges in batches. Idempotent — safe to re-run.
 *
 * Set ENABLE_FRAGMENT_RELATIONSHIP_BACKFILL=false to disable the cron; the
 * admin endpoint POST /admin/backfill/fragment-relationships still works.
 */
export async function setupFragmentRelationshipBackfillScheduler(
  queue: Queue,
): Promise<void> {
  if (process.env.ENABLE_FRAGMENT_RELATIONSHIP_BACKFILL === 'false') {
    log.info('ENABLE_FRAGMENT_RELATIONSHIP_BACKFILL=false, skipping scheduler setup')
    return
  }

  // Pattern: midnight, but offset by 5 minutes so it doesn't collide with
  // the regen batch cron at 0 0 * * *. Splitting reduces lock contention on
  // the fragments table at the top of the hour.
  await queue.upsertJobScheduler(
    'fragment-relationship-backfill',
    { pattern: '5 0 * * *' },
    {
      name: 'fragment-relationship-backfill',
      data: signJob({
        type: 'fragment-relationship-backfill',
        jobId: 'fragment-relationship-backfill-scheduled',
        triggeredBy: 'scheduler',
        enqueuedAt: new Date().toISOString(),
      }),
    },
  )

  log.info('fragment-relationship-backfill scheduler registered')
}

/**
 * LINKING recovery scan. Every 20 minutes, finds wikis stuck in LINKING
 * state with a stale locked_at (>15 min) and resets them to PENDING. This
 * handles the case where a regen worker is killed mid-Quill-call (SIGTERM
 * during deploy) and the wiki's state column stays LINKING indefinitely,
 * blocking all auto-regen paths.
 *
 * Set ENABLE_LINKING_RECOVERY=false to disable.
 */
export async function setupLinkingRecoveryScheduler(queue: Queue): Promise<void> {
  if (process.env.ENABLE_LINKING_RECOVERY === 'false') {
    log.info('ENABLE_LINKING_RECOVERY=false, skipping scheduler setup')
    return
  }

  await queue.upsertJobScheduler(
    'linking-recovery',
    { pattern: '*/20 * * * *' },
    {
      name: 'linking-recovery',
      data: signJob({
        type: 'linking-recovery',
        jobId: 'linking-recovery-scheduled',
        triggeredBy: 'scheduler',
        enqueuedAt: new Date().toISOString(),
      }),
    }
  )

  log.info('linking-recovery scheduler registered')
}
