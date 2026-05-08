import { type Job, Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { signJob, verifyJob } from './job-signing.js'

export { Queue, Worker } from 'bullmq'
export { JobSignatureError, signJob, verifyJob } from './job-signing.js'

// ── Redis connection ──────────────────────────────────────────────────────────

export function createRedisConnection(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // required for BullMQ blocked commands
  })
}

// ── Queue names (single-user — no per-user fan-out) ───────────────────────────

export const QUEUE_NAMES = {
  extraction: 'extraction-queue',
  link: 'link-queue',
  reclassify: 'reclassify-queue',
  provision: 'provision-queue',
  regen: 'regen-queue',
  scheduler: 'regen-scheduler-queue',
  dlq: 'ingest-dlq',
} as const

// ── Retry config ──────────────────────────────────────────────────────────────

export const RETRY_CONFIG = {
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 1000, // 1s base → 1s, 2s, 4s, 8s, 16s
  },
} as const

export const LINK_RETRY_CONFIG = {
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 5000, // 5s base → 5s, 10s, 20s, 40s, 80s
  },
} as const

// ── Job types ─────────────────────────────────────────────────────────────────

export interface ProvisionJob {
  type: 'provision'
  jobId: string
  userId: string
  enqueuedAt: string
}

export interface ExtractionJob {
  type: 'extraction'
  jobId: string
  enqueuedAt: string
  content: string
  entryKey: string
  source: string
}

export interface LinkJob {
  type: 'link'
  jobId: string
  fragmentKey: string
  entryKey: string
  fragmentContent: string
  enqueuedAt: string
}

export interface ReclassifyJob {
  type: 'reclassify'
  jobId: string
  wikiKey: string
  enqueuedAt: string
}

export interface RegenJob {
  type: 'regen'
  jobId: string
  objectKey: string
  objectType: 'wiki' | 'person'
  triggeredBy: 'scheduler' | 'manual'
  enqueuedAt: string
}

export interface RegenBatchJob {
  type: 'regen-batch'
  jobId: string
  triggeredBy: 'scheduler'
  enqueuedAt: string
}

export interface EmbeddingRetryJob {
  type: 'embedding-retry'
  jobId: string
  triggeredBy: 'scheduler'
  enqueuedAt: string
}

export interface PrunePipelineEventsJob {
  type: 'prune-pipeline-events'
  jobId: string
  triggeredBy: 'scheduler'
  enqueuedAt: string
}

/**
 * Stream D / D5 — fragment-relationship backfill (#258). Computes
 * FRAGMENT_RELATED_TO_FRAGMENT edges for fragments that were embedded
 * before the related-edge logic landed. Runs nightly via cron and on
 * demand via POST /admin/backfill/fragment-relationships.
 */
export interface FragmentRelationshipBackfillJob {
  type: 'fragment-relationship-backfill'
  jobId: string
  triggeredBy: 'scheduler' | 'manual'
  enqueuedAt: string
}

/** Job payloads dispatched by the scheduler worker (cron-driven). */
export type SchedulerJob =
  | RegenBatchJob
  | EmbeddingRetryJob
  | PrunePipelineEventsJob
  | FragmentRelationshipBackfillJob

export type RobinJob =
  | ProvisionJob
  | ExtractionJob
  | LinkJob
  | ReclassifyJob
  | RegenJob
  | RegenBatchJob
  | EmbeddingRetryJob
  | PrunePipelineEventsJob
  | FragmentRelationshipBackfillJob

/** Producer wraps a job in this shape via signJob; worker strips it via verifyJob. */
export type Signed<T> = T & { __sig: string }

export interface JobResult {
  jobId: string
  success: boolean
  path?: string
  commitHash?: string
  error?: string
  processedAt: string
}

// ── QueueProducer interface ───────────────────────────────────────────────────

export interface QueueProducer {
  enqueueExtraction(job: ExtractionJob): Promise<string>
  enqueueLink(job: LinkJob): Promise<string>
  enqueueReclassify(job: ReclassifyJob): Promise<string>
  enqueueRegen(job: RegenJob): Promise<string>
  enqueueProvision(job: ProvisionJob): Promise<string>
  getQueue(name: string): Queue
  close(): Promise<void>
}

// ── QueueWorker interface ─────────────────────────────────────────────────────

export interface QueueWorker {
  startExtractionWorker(processor: (job: ExtractionJob) => Promise<JobResult>): Worker
  startLinkWorker(processor: (job: LinkJob) => Promise<JobResult>): Worker
  startReclassifyWorker(processor: (job: ReclassifyJob) => Promise<JobResult>): Worker
  startRegenWorker(processor: (job: RegenJob) => Promise<JobResult>): Worker
  startProvisionWorker(processor: (job: ProvisionJob) => Promise<JobResult>): Worker
  startSchedulerWorker(processor: (job: SchedulerJob) => Promise<JobResult>): Worker
}

// ── BullMQ implementation ─────────────────────────────────────────────────────

export class BullMQProducer implements QueueProducer {
  private readonly connection: Redis
  private readonly queues = new Map<string, Queue>()

  constructor(connection?: Redis) {
    this.connection = connection ?? createRedisConnection()
  }

  getQueue(name: string): Queue {
    let q = this.queues.get(name)
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          ...RETRY_CONFIG,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      })
      this.queues.set(name, q)
    }
    return q
  }

  async enqueueExtraction(job: ExtractionJob): Promise<string> {
    const queue = this.getQueue(QUEUE_NAMES.extraction)
    const bullJob = await queue.add('extraction', signJob(job), { jobId: job.jobId })
    return bullJob.id ?? job.jobId
  }

  async enqueueLink(job: LinkJob): Promise<string> {
    const queue = this.getQueue(QUEUE_NAMES.link)
    const bullJob = await queue.add('link', signJob(job), {
      jobId: job.jobId,
      ...LINK_RETRY_CONFIG,
    })
    return bullJob.id ?? job.jobId
  }

  async enqueueReclassify(job: ReclassifyJob): Promise<string> {
    const queue = this.getQueue(QUEUE_NAMES.reclassify)
    const bullJob = await queue.add('reclassify', signJob(job), { jobId: job.jobId })
    return bullJob.id ?? job.jobId
  }

  async enqueueRegen(job: RegenJob): Promise<string> {
    const queue = this.getQueue(QUEUE_NAMES.regen)
    // Use wiki key as jobId for deduplication — BullMQ skips if a job
    // with the same id is already waiting, so rapid fragment links to the
    // same wiki only produce one regen job.
    const dedupeId = `regen-${job.objectKey}`
    const bullJob = await queue.add('regen', signJob(job), { jobId: dedupeId })
    return bullJob.id ?? job.jobId
  }

  async enqueueProvision(job: ProvisionJob): Promise<string> {
    const queue = this.getQueue(QUEUE_NAMES.provision)
    const bullJob = await queue.add('provision', signJob(job), { jobId: job.jobId })
    return bullJob.id ?? job.jobId
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()))
    await this.connection.quit()
  }
}

export class BullMQWorker implements QueueWorker {
  private readonly connection: Redis

  constructor(connection?: Redis) {
    this.connection = connection ?? createRedisConnection()
  }

  startExtractionWorker(processor: (job: ExtractionJob) => Promise<JobResult>): Worker {
    return new Worker(
      QUEUE_NAMES.extraction,
      async (job: Job<Signed<ExtractionJob>>) => processor(verifyJob(job.data) as ExtractionJob),
      { connection: this.connection, concurrency: 1, autorun: true }
    )
  }

  startLinkWorker(processor: (job: LinkJob) => Promise<JobResult>): Worker {
    return new Worker(
      QUEUE_NAMES.link,
      async (job: Job<Signed<LinkJob>>) => processor(verifyJob(job.data) as LinkJob),
      { connection: this.connection, concurrency: 4, autorun: true }
    )
  }

  startReclassifyWorker(processor: (job: ReclassifyJob) => Promise<JobResult>): Worker {
    return new Worker(
      QUEUE_NAMES.reclassify,
      async (job: Job<Signed<ReclassifyJob>>) => processor(verifyJob(job.data) as ReclassifyJob),
      { connection: this.connection, concurrency: 1, autorun: true }
    )
  }

  startRegenWorker(processor: (job: RegenJob) => Promise<JobResult>): Worker {
    return new Worker(
      QUEUE_NAMES.regen,
      async (job: Job<Signed<RegenJob>>) => processor(verifyJob(job.data) as RegenJob),
      { connection: this.connection, concurrency: 1, autorun: true }
    )
  }

  startProvisionWorker(processor: (job: ProvisionJob) => Promise<JobResult>): Worker {
    return new Worker(
      QUEUE_NAMES.provision,
      async (job: Job<Signed<ProvisionJob>>) => processor(verifyJob(job.data) as ProvisionJob),
      { connection: this.connection, concurrency: 1, autorun: true }
    )
  }

  startSchedulerWorker(processor: (job: SchedulerJob) => Promise<JobResult>): Worker {
    return new Worker(
      QUEUE_NAMES.scheduler,
      async (job: Job<Signed<SchedulerJob>>) => processor(verifyJob(job.data) as SchedulerJob),
      { connection: this.connection, concurrency: 1, autorun: true }
    )
  }
}
