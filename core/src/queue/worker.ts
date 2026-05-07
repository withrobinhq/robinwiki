/**
 * BullMQ workers for the ingest + regen pipeline.
 *
 * Three long-lived workers run for the single user: extraction, link, and regen.
 * Extraction loads OpenRouter creds per-call, builds fresh Mastra agents,
 * and dispatches to runExtraction. Link does the same for runLinking.
 * Regen rebuilds wiki content when new fragments are linked.
 * Retries, backoff, and DLQ are handled by BullMQ via RETRY_CONFIG.
 */

import {
  BullMQWorker,
  createRedisConnection,
  type ExtractionJob,
  type LinkJob,
  type ProvisionJob,
  type JobResult,
} from '@robin/queue'
import {
  runExtraction,
  runLinking,
  createIngestAgents,
  embedText,
  DEFAULT_RESOLUTION_CONFIG,
  createTypedCaller,
  NoOpenRouterKeyError,
  type OpenRouterConfig,
  type ExtractionOrchestratorDeps,
  type LinkingOrchestratorDeps,
} from '@robin/agent'
import {
  makeLookupKey,
  generateSlug,
  fragmentationSchema,
  peopleExtractionSchema,
  wikiClassificationSchema,
  fragmentRelevanceSchema,
} from '@robin/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  fragments,
  entries,
  edges,
  people,
  users,
  wikis,
} from '../db/schema.js'
import { entryLock, fragmentLock } from '../db/locks.js'
import { resolveFragmentSlug } from '../db/slug.js'
import { computeContentHash } from '../db/dedup.js'
import { emitPipelineEvent } from '../db/pipeline-events.js'
import { emitAuditEvent } from '../db/audit.js'
import { producer } from './producer.js'
import { processRegenJob, processRegenBatchJob } from './regen-worker.js'
import { processEmbeddingRetryJob } from './embedding-retry-worker.js'
import type { SchedulerJob } from '@robin/queue'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { generateKeypair } from '../keypair.js'
import { logger } from '../lib/logger.js'
import { clearKidCache } from '../mcp/jwt.js'

const log = logger.child({ component: 'worker' })

const connection = createRedisConnection()
const bullWorker = new BullMQWorker(connection)

// ── Shared helpers ──────────────────────────────────────────────────────────

function emitEvent(event: {
  entryKey: string
  jobId: string
  stage: string
  status: 'started' | 'completed' | 'failed'
  fragmentKey?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  return emitPipelineEvent(db as never, event)
}

async function insertEdgeRow(edge: Record<string, unknown>): Promise<void> {
  // TOCTOU guard for FRAGMENT_IN_WIKI edges: the LLM classifier may
  // have decided to file a fragment into a wiki that got soft-
  // deleted while it was thinking. Re-check the dst wiki right
  // before the insert and drop the row if it's a tombstone.
  if (edge.edgeType === 'FRAGMENT_IN_WIKI' && typeof edge.dstId === 'string') {
    const [stillLive] = await db
      .select({ key: wikis.lookupKey })
      .from(wikis)
      .where(and(eq(wikis.lookupKey, edge.dstId), isNull(wikis.deletedAt)))
      .limit(1)
    if (!stillLive) {
      log.warn({ wikiKey: edge.dstId, srcId: edge.srcId }, 'skipping FRAGMENT_IN_WIKI insert: target wiki was soft-deleted')
      return
    }
  }
  await db
    .insert(edges)
    .values({
      id: crypto.randomUUID(),
      srcType: edge.srcType as string,
      srcId: edge.srcId as string,
      dstType: edge.dstType as string,
      dstId: edge.dstId as string,
      edgeType: edge.edgeType as string,
      attrs: (edge.attrs as Record<string, unknown> | undefined) ?? null,
    })
    .onConflictDoNothing()
}

// ── Extraction processor ────────────────────────────────────────────────────

async function processExtractionJob(job: ExtractionJob): Promise<JobResult> {
  log.info({ jobId: job.jobId, entryKey: job.entryKey }, 'processing extraction job')
  const t0 = performance.now()

  // 1. Per-call OpenRouter key fetch. Missing key → mark entry failed and rethrow.
  let openRouterConfig: OpenRouterConfig
  try {
    openRouterConfig = await loadOpenRouterConfig()
  } catch (err) {
    if (err instanceof NoOpenRouterKeyError) {
      await db
        .update(entries)
        .set({
          ingestStatus: 'failed',
          lastError: 'no_openrouter_key',
          lastAttemptAt: new Date(),
          attemptCount: sql`${entries.attemptCount} + 1`,
        })
        .where(eq(entries.lookupKey, job.entryKey))
    }
    throw err
  }

  // 2. Fresh Mastra agents per ingest run.
  const agents = createIngestAgents(openRouterConfig)

  const deps: ExtractionOrchestratorDeps = {
    entryLock,
    emitEvent,
    enqueueLinkJob: async (linkJobData) => {
      await producer.enqueueLink({
        type: 'link',
        jobId: crypto.randomUUID(),
        fragmentKey: linkJobData.fragmentKey,
        entryKey: linkJobData.entryKey,
        fragmentContent: linkJobData.fragmentContent,
        enqueuedAt: new Date().toISOString(),
      })
    },
    fragmentDeps: {
      llmCall: createTypedCaller(agents.fragmenter, fragmentationSchema),
      emitEvent,
    },
    entityExtractDeps: {
      loadAllPeople: async () => {
        const rows = await db
          .select({
            lookupKey: people.lookupKey,
            canonicalName: people.canonicalName,
            aliases: people.aliases,
          })
          .from(people)
        return rows.map((r) => ({
          lookupKey: r.lookupKey,
          canonicalName: r.canonicalName,
          aliases: r.aliases ?? [],
        }))
      },
      llmCall: createTypedCaller(agents.entityExtractor, peopleExtractionSchema),
      emitEvent,
      config: DEFAULT_RESOLUTION_CONFIG,
      makePeopleKey: () => makeLookupKey('person'),
    },
    persistDeps: {
      openRouterConfig,
      emitEvent,
      insertEntry: async (entry) => {
        const e = entry as Record<string, unknown>
        const content = (e.content as string) ?? ''
        const sourceLabel: Record<string, string> = {
          'mcp.claude': 'Claude conversation',
          'mcp.cursor': 'Cursor session',
          'mcp': 'MCP session',
          'api': 'API import',
          'web': 'Web capture',
        }
        const src = (e.source as string) ?? 'api'
        const displayName = `${sourceLabel[src] ?? src}, ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        const sourceMetadata = { displayName, channel: src }
        await db
          .insert(entries)
          .values({
            lookupKey: e.lookupKey as string,
            slug: e.slug as string,
            title: (e.title as string) ?? '',
            content,
            source: src,
            sourceMetadata,
            type: (e.type as string) ?? 'thought',
            state: (e.state as 'PENDING' | 'LINKING' | 'RESOLVED') ?? 'PENDING',
            dedupHash: content ? computeContentHash(content) : null,
          })
          .onConflictDoUpdate({
            target: entries.lookupKey,
            set: {
              title: (e.title as string) ?? '',
              content,
              sourceMetadata,
              updatedAt: new Date(),
            },
          })
      },
      insertFragment: async (fragment) => {
        const f = fragment as Record<string, unknown>
        const slug = await resolveFragmentSlug(db, f.slug as string)
        const content = (f.content as string) ?? ''
        await db.insert(fragments).values({
          lookupKey: f.lookupKey as string,
          slug,
          title: (f.title as string) ?? '',
          content,
          type: (f.type as string) ?? null,
          tags: ((f.tags as string[]) ?? []) as string[],
          confidence: (f.confidence as number | null) ?? null,
          entryId: (f.entryId as string | null) ?? null,
          state: (f.state as 'PENDING' | 'LINKING' | 'RESOLVED') ?? 'PENDING',
          dedupHash: content ? computeContentHash(content) : null,
        })
      },
      insertEdge: insertEdgeRow,
      insertPerson: async (person) => {
        const p = person as Record<string, unknown>
        await db
          .insert(people)
          .values({
            lookupKey: p.lookupKey as string,
            slug: (p.slug as string) ?? '',
            name: (p.name as string) ?? (p.canonicalName as string) ?? '',
            canonicalName: (p.canonicalName as string) ?? '',
            aliases: ((p.aliases as string[]) ?? []) as string[],
            verified: Boolean(p.verified),
            state: 'PENDING',
          })
          .onConflictDoNothing()
      },
      updateFragmentEmbedding: async (fragmentKey, embedding) => {
        await db
          .update(fragments)
          .set({ embedding })
          .where(eq(fragments.lookupKey, fragmentKey))
      },
      upsertPerson: async (input) => {
        const existing = await db
          .select({ lookupKey: people.lookupKey })
          .from(people)
          .where(sql`LOWER(${people.canonicalName}) = LOWER(${input.canonicalName})`)
          .limit(1)

        if (existing.length > 0) {
          return { personKey: existing[0].lookupKey, isNew: false }
        }

        const slug = generateSlug(input.canonicalName) || input.personKey

        await db.insert(people).values({
          lookupKey: input.personKey,
          slug,
          name: input.canonicalName,
          canonicalName: input.canonicalName,
          aliases: [],
          verified: input.verified,
          state: 'PENDING',
        })

        return { personKey: input.personKey, isNew: true }
      },
      onPersonCreated: (personKey, name) => {
        emitAuditEvent(db as never, {
          entityType: 'person',
          entityId: personKey,
          eventType: 'created',
          source: 'system',
          summary: `Person created: ${name}`,
          detail: { personKey, canonicalName: name },
        })
      },
      mergePersonAliases: async (personKey, newAliases) => {
        if (newAliases.length === 0) return
        const [row] = await db
          .select({ aliases: people.aliases })
          .from(people)
          .where(eq(people.lookupKey, personKey))
          .limit(1)
        if (!row) return

        const seen = new Set((row.aliases ?? []).map((a) => a.toLowerCase()))
        const merged = [...(row.aliases ?? [])]
        for (const alias of newAliases) {
          if (!seen.has(alias.toLowerCase())) {
            seen.add(alias.toLowerCase())
            merged.push(alias)
          }
        }
        await db.update(people).set({ aliases: merged }).where(eq(people.lookupKey, personKey))
      },
    },
  }

  try {
    const result = await runExtraction(deps, {
      entryKey: job.entryKey,
      content: job.content,
      source: job.source,
      jobId: job.jobId,
    })

    await db
      .update(entries)
      .set({
        ingestStatus: 'processed',
        lastAttemptAt: new Date(),
        attemptCount: sql`${entries.attemptCount} + 1`,
        lastError: null,
      })
      .where(eq(entries.lookupKey, job.entryKey))

    await emitAuditEvent(db as never, {
      entityType: 'raw_source',
      entityId: job.entryKey,
      eventType: 'processed',
      source: 'system',
      summary: `Entry processed: ${result.fragmentKeys.length} fragments`,
      detail: { entryKey: job.entryKey, jobId: job.jobId, fragmentCount: result.fragmentKeys.length },
    })

    for (const fk of result.fragmentKeys) {
      await emitAuditEvent(db as never, {
        entityType: 'fragment',
        entityId: fk,
        eventType: 'created',
        source: 'system',
        summary: 'Fragment created by extraction',
        detail: { fragmentKey: fk, entryKey: job.entryKey, jobId: job.jobId },
      })
    }

    const elapsed = (performance.now() - t0).toFixed(0)
    log.info(
      { jobId: job.jobId, ms: Number(elapsed), fragmentCount: result.fragmentKeys.length },
      'extraction job completed'
    )

    return { jobId: job.jobId, success: true, processedAt: new Date().toISOString() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(entries)
      .set({
        ingestStatus: 'failed',
        lastError: message,
        lastAttemptAt: new Date(),
        attemptCount: sql`${entries.attemptCount} + 1`,
      })
      .where(eq(entries.lookupKey, job.entryKey))

    await emitAuditEvent(db as never, {
      entityType: 'raw_source',
      entityId: job.entryKey,
      eventType: 'failed',
      source: 'system',
      summary: 'Entry processing failed',
      detail: { entryKey: job.entryKey, jobId: job.jobId, error: message },
    })

    throw err
  }
}

// ── Link processor ──────────────────────────────────────────────────────────

async function processLinkJob(job: LinkJob): Promise<JobResult> {
  log.info({ jobId: job.jobId, fragmentKey: job.fragmentKey }, 'processing link job')
  const t0 = performance.now()

  const openRouterConfig = await loadOpenRouterConfig()
  const agents = createIngestAgents(openRouterConfig)

  const deps: LinkingOrchestratorDeps = {
    fragmentLock,
    emitEvent,
    emitAuditEvent: async (params) => {
      await emitAuditEvent(db as never, params)
    },
    wikiClassifyDeps: {
      searchCandidates: async (_content, limit) => {
        const rows = await db
          .select({ lookupKey: wikis.lookupKey })
          .from(wikis)
          .where(isNull(wikis.deletedAt))
          .limit(limit)
        return rows.map((r) => ({ wikiKey: r.lookupKey, score: 0 }))
      },
      loadThreads: async (wikiKeys) => {
        if (wikiKeys.length === 0) return []
        const rows = await db
          .select({
            lookupKey: wikis.lookupKey,
            name: wikis.name,
            type: wikis.type,
            prompt: wikis.prompt,
            description: wikis.description,
          })
          .from(wikis)
          .where(
            and(
              isNull(wikis.deletedAt),
              sql`${wikis.lookupKey} = ANY(ARRAY[${sql.join(
                wikiKeys.map((k) => sql`${k}`),
                sql`, `
              )}])`,
            ),
          )
        return rows
      },
      loadOwnerName: async () => {
        // Owner-Person seed (#238). Returns null if no owner row exists
        // yet — the classifier loader falls back to "the owner" so the
        // [AUTHORSHIP] block still renders grammatically.
        const [row] = await db
          .select({ name: people.name })
          .from(people)
          .where(eq(people.isOwner, true))
          .limit(1)
        return row?.name ?? null
      },
      llmCall: createTypedCaller(agents.wikiClassifier, wikiClassificationSchema),
      emitEvent,
    },
    fragRelateDeps: {
      vectorSearch: async (content, limit) => {
        const vec = await embedText(content, {
          apiKey: openRouterConfig.apiKey,
          model: openRouterConfig.models.embedding,
        })
        if (!vec) return []
        const rows = await db
          .select({ lookupKey: fragments.lookupKey })
          .from(fragments)
          .where(sql`${fragments.embedding} IS NOT NULL`)
          .orderBy(sql`${fragments.embedding} <=> ${JSON.stringify(vec)}::vector`)
          .limit(limit)
        return rows.map((r) => ({ fragmentKey: r.lookupKey, score: 0 }))
      },
      loadFragmentContent: async (fragmentKey) => {
        const [row] = await db
          .select({ title: fragments.title })
          .from(fragments)
          .where(eq(fragments.lookupKey, fragmentKey))
          .limit(1)
        return row?.title ?? null
      },
      llmCall: createTypedCaller(agents.fragScorer, fragmentRelevanceSchema),
      emitEvent,
    },
    insertEdge: async (edge: Record<string, unknown>) => {
      await insertEdgeRow(edge)

      // After creating a FRAGMENT_IN_WIKI edge, enqueue a regen job for the
      // target wiki. BullMQ deduplicates by jobId (`regen-<wikiKey>`), so
      // rapid fragment links to the same wiki collapse into a single regen.
      if (edge.edgeType === 'FRAGMENT_IN_WIKI' && typeof edge.dstId === 'string') {
        try {
          await producer.enqueueRegen({
            type: 'regen',
            jobId: crypto.randomUUID(),
            objectKey: edge.dstId,
            objectType: 'wiki',
            triggeredBy: 'scheduler',
            enqueuedAt: new Date().toISOString(),
          })
          log.info({ wikiKey: edge.dstId }, 'regen job enqueued for wiki')
        } catch (err) {
          // Non-fatal: wiki will be picked up by the next batch scan
          log.warn({ wikiKey: edge.dstId, err }, 'failed to enqueue regen job')
        }
      }
    },
  }

  await runLinking(deps, {
    fragmentKey: job.fragmentKey,
    fragmentContent: job.fragmentContent,
    entryKey: job.entryKey,
    jobId: job.jobId,
  })

  await emitAuditEvent(db as never, {
    entityType: 'fragment',
    entityId: job.fragmentKey,
    eventType: 'classified',
    source: 'system',
    summary: 'Fragment classified into wiki(s)',
    detail: { fragmentKey: job.fragmentKey, entryKey: job.entryKey, jobId: job.jobId },
  })

  const elapsed = (performance.now() - t0).toFixed(0)
  log.info({ jobId: job.jobId, ms: Number(elapsed) }, 'link job completed')

  return { jobId: job.jobId, success: true, processedAt: new Date().toISOString() }
}

// ── Provision processor ─────────────────────────────────────────────────────

export async function processProvisionJob(job: ProvisionJob): Promise<JobResult> {
  log.info({ jobId: job.jobId, userId: job.userId }, 'processing provision job')

  const [user] = await db
    .select({
      id: users.id,
      publicKey: users.publicKey,
      encryptedPrivateKey: users.encryptedPrivateKey,
    })
    .from(users)
    .where(eq(users.id, job.userId))

  if (!user) {
    log.warn({ userId: job.userId }, 'provision: user not found')
    return { jobId: job.jobId, success: false, error: 'user not found', processedAt: new Date().toISOString() }
  }

  if (user.publicKey && user.publicKey !== '') {
    log.info({ userId: job.userId }, 'provision: keypair already exists, skipping keygen')
    return { jobId: job.jobId, success: true, processedAt: new Date().toISOString() }
  }

  const secret = process.env.KEY_ENCRYPTION_SECRET
  if (!secret) throw new Error('KEY_ENCRYPTION_SECRET env var is required')

  const { publicKey, encryptedPrivateKey } = generateKeypair(secret)

  await db
    .update(users)
    .set({ publicKey, encryptedPrivateKey })
    .where(eq(users.id, job.userId))

  // Evict any cached row so the next /mcp request rebuilds against
  // the freshly-written publicKey.
  clearKidCache(job.userId)

  log.info({ userId: job.userId }, 'provision: keypair generated and stored')
  return { jobId: job.jobId, success: true, processedAt: new Date().toISOString() }
}

// ── Worker lifecycle ────────────────────────────────────────────────────────

let extractionWorker: ReturnType<typeof bullWorker.startExtractionWorker> | null = null
let linkWorker: ReturnType<typeof bullWorker.startLinkWorker> | null = null
let regenWorker: ReturnType<typeof bullWorker.startRegenWorker> | null = null
let provisionWorker: ReturnType<typeof bullWorker.startProvisionWorker> | null = null
let schedulerWorker: ReturnType<typeof bullWorker.startSchedulerWorker> | null = null

/**
 * Route scheduled jobs by discriminated type. BullMQ delivers both
 * regen-batch (midnight cron) and embedding-retry (15-min cron) via the
 * same queue, so the worker picks by `type` and forwards to the right
 * processor.
 */
async function dispatchSchedulerJob(job: SchedulerJob): Promise<JobResult> {
  if (job.type === 'regen-batch') return processRegenBatchJob(job)
  if (job.type === 'embedding-retry') return processEmbeddingRetryJob(job)
  // Unreachable given the SchedulerJob union; keep a loud log for safety.
  const exhaustive: never = job
  log.error({ job: exhaustive }, 'unknown scheduler job type')
  return {
    jobId: (exhaustive as { jobId?: string }).jobId ?? 'unknown',
    success: false,
    error: 'unknown scheduler job type',
    processedAt: new Date().toISOString(),
  }
}

/**
 * Start global ingest workers. Single-user — one worker per queue, no per-user fan-out.
 * Extraction and link workers handle ingest; regen worker rebuilds wikis when
 * new fragments are linked via FRAGMENT_IN_WIKI edges. Provision worker generates
 * Ed25519 keypairs for newly created users.
 */
export function startWorkers(): void {
  if (extractionWorker || linkWorker) {
    log.warn('workers already started — skipping')
    return
  }

  extractionWorker = bullWorker.startExtractionWorker(processExtractionJob)
  extractionWorker.on('completed', (job) => log.info({ jobId: job.id }, 'extraction completed'))
  extractionWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err }, 'extraction failed')
  )

  linkWorker = bullWorker.startLinkWorker(processLinkJob)
  linkWorker.on('completed', (job) => log.info({ jobId: job.id }, 'link completed'))
  linkWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'link failed'))

  regenWorker = bullWorker.startRegenWorker(processRegenJob)
  regenWorker.on('completed', (job) => log.info({ jobId: job.id }, 'regen completed'))
  regenWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'regen failed'))

  provisionWorker = bullWorker.startProvisionWorker(processProvisionJob)
  provisionWorker.on('completed', (job) => log.info({ jobId: job.id }, 'provision completed'))
  provisionWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'provision failed'))

  schedulerWorker = bullWorker.startSchedulerWorker(dispatchSchedulerJob)
  schedulerWorker.on('completed', (job) =>
    log.info({ jobId: job.id, name: job.name }, 'scheduled job completed')
  )
  schedulerWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, name: job?.name, err }, 'scheduled job failed')
  )

  log.info('ingest workers started')
}
