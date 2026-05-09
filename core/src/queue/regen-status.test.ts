import { describe, it, expect, vi, beforeEach } from 'vitest'

// QA Issue 6: getRegenStatus assembles the snapshot from BullMQ +
// pipeline_events + the debounce filter. This test pins the wiring
// shape -- not the BullMQ internals.

const mockGetJobs = vi.fn()
const mockGetQueue = vi.fn(() => ({ getJobs: mockGetJobs }))

vi.mock('../queue/producer.js', () => ({
  producer: {
    getQueue: (...args: unknown[]) => mockGetQueue(...args),
  },
}))

vi.mock('@robin/queue', () => ({
  QUEUE_NAMES: {
    regen: 'regen-queue',
  },
}))

const dbResponseQueue: unknown[][] = []

function stageDbResponses(responses: unknown[][]) {
  dbResponseQueue.length = 0
  dbResponseQueue.push(...responses)
}

function popResponse(): unknown[] {
  return dbResponseQueue.shift() ?? []
}

vi.mock('../db/client.js', () => {
  function thenable() {
    return {
      // biome-ignore lint/suspicious/noThenProperty: drizzle thenable mock
      then: (onFulfilled: (v: unknown[]) => unknown) =>
        Promise.resolve(popResponse()).then(onFulfilled),
    }
  }
  function selectChain() {
    return {
      from: () => ({
        where: () => ({
          ...thenable(),
          groupBy: () => thenable(),
          orderBy: () => ({
            limit: () => thenable(),
          }),
          limit: () => thenable(),
        }),
        innerJoin: () => ({
          where: () => ({
            groupBy: () => thenable(),
          }),
        }),
      }),
    }
  }
  return {
    db: {
      select: () => selectChain(),
    },
  }
})

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookupKey',
    slug: 'wikis.slug',
    deletedAt: 'wikis.deletedAt',
    autoregen: 'wikis.autoregen',
    dirtySince: 'wikis.dirtySince',
    state: 'wikis.state',
    updatedAt: 'wikis.updatedAt',
    lastRebuiltAt: 'wikis.lastRebuiltAt',
  },
  edges: {
    dstId: 'edges.dstId',
    srcId: 'edges.srcId',
    edgeType: 'edges.edgeType',
    deletedAt: 'edges.deletedAt',
    createdAt: 'edges.createdAt',
  },
  fragments: {
    lookupKey: 'fragments.lookupKey',
    deletedAt: 'fragments.deletedAt',
    embedding: 'fragments.embedding',
  },
  pipelineEvents: {
    jobId: 'pipeline_events.job_id',
    status: 'pipeline_events.status',
    stage: 'pipeline_events.stage',
    createdAt: 'pipeline_events.created_at',
    metadata: 'pipeline_events.metadata',
  },
}))

const { getRegenStatus } = await import('./regen-debounce.js')
const { db: mockDb } = await import('../db/client.js')

describe('getRegenStatus - snapshot assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
    delete process.env.REGEN_DEBOUNCE_MS
  })

  it('returns inFlight, debounced, and recent in the documented shape', async () => {
    process.env.REGEN_DEBOUNCE_MS = '300000'

    // Active BullMQ regen jobs.
    mockGetJobs.mockResolvedValueOnce([
      {
        id: 'regen-wiki01abc',
        data: { type: 'regen', jobId: 'j-1', objectKey: 'wiki01abc', triggeredBy: 'manual' },
        processedOn: 1_700_000_000_000,
      },
    ])

    const now = Date.now()
    const fresh = new Date(now - 30_000) // inside 5min window
    stageDbResponses([
      // unfiled count
      [{ count: 0 }],
      // wikis with dirty_since set (Reason 2 candidates)
      [{ lookupKey: 'wiki-debounced' }],
      // filterDebouncedWikiKeys reads wikis.dirty_since
      [{ wikiKey: 'wiki-debounced', dirtySince: fresh }],
      // pipelineEvents.recent
      [
        {
          jobId: 'past-1',
          status: 'completed',
          createdAt: new Date('2026-05-08T11:50:00.000Z'),
          metadata: { wikiKey: 'wiki-recent', durationMs: 92_000 },
        },
      ],
    ])

    // biome-ignore lint/suspicious/noExplicitAny: drizzle stub
    const snap = await getRegenStatus(mockDb as any, { recentLimit: 5 })

    expect(snap.debounceMs).toBe(300_000)
    expect(snap.inFlight).toHaveLength(1)
    expect(snap.inFlight[0].wikiKey).toBe('wiki01abc')
    expect(snap.inFlight[0].triggeredBy).toBe('manual')
    expect(snap.inFlight[0].startedAt).toBe(new Date(1_700_000_000_000).toISOString())

    expect(snap.debounced).toHaveLength(1)
    expect(snap.debounced[0].wikiKey).toBe('wiki-debounced')
    expect(snap.debounced[0].etaToEligibleMs).toBeGreaterThan(0)

    expect(snap.recent).toHaveLength(1)
    expect(snap.recent[0]).toMatchObject({
      jobId: 'past-1',
      status: 'completed',
      wikiKey: 'wiki-recent',
      durationMs: 92_000,
    })
  })

  it('degrades gracefully when redis is unreachable (inFlight empty, others still populated)', async () => {
    process.env.REGEN_DEBOUNCE_MS = '300000'
    mockGetJobs.mockRejectedValueOnce(new Error('redis EOF'))

    stageDbResponses([
      [{ count: 0 }],
      [],
      [],
    ])

    // biome-ignore lint/suspicious/noExplicitAny: drizzle stub
    const snap = await getRegenStatus(mockDb as any)
    expect(snap.inFlight).toEqual([])
    expect(Array.isArray(snap.debounced)).toBe(true)
    expect(Array.isArray(snap.recent)).toBe(true)
  })
})
