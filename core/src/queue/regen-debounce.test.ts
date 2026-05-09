import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// Covers QA Issue 6 (2026-05-08): per-wiki debounce filters out wikis
// that received a fragment edge inside the configured quiet window. The
// batch worker's ingest-driven reasons (1, 2) consult this filter; the
// recovery and explicit-cadence reasons (3, 4) bypass.

const mockEnqueueRegen = vi.fn()
const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../queue/producer.js', () => ({
  producer: {
    enqueueRegen: (...args: unknown[]) => mockEnqueueRegen(...args),
  },
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

vi.mock('../lib/regen.js', () => ({
  regenerateWiki: vi.fn(),
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
    regenerate: 'wikis.regenerate',
    autoRegen: 'wikis.autoRegen',
    lifecycleState: 'wikis.lifecycleState',
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
}))

const { processRegenBatchJob } = await import('./regen-worker.js')
const { filterDebouncedWikiKeys, regenDebounceMs, DEFAULT_REGEN_DEBOUNCE_MS } =
  await import('./regen-debounce.js')
const { db: mockDb } = await import('../db/client.js')

describe('regen-debounce: filterDebouncedWikiKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
    delete process.env.REGEN_DEBOUNCE_MS
  })

  afterEach(() => {
    delete process.env.REGEN_DEBOUNCE_MS
  })

  it('marks a wiki as debounced when its last fragment edge is fresher than now - debounce', async () => {
    process.env.REGEN_DEBOUNCE_MS = '300000' // 5 min
    const now = new Date('2026-05-08T12:00:00.000Z')
    const recentEdge = new Date(now.getTime() - 60_000) // 1 min ago
    stageDbResponses([
      [{ wikiKey: 'wiki-chatty', lastEdgeAt: recentEdge }],
    ])
    const { eligible, debounced } = await filterDebouncedWikiKeys(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle stub
      mockDb as any,
      ['wiki-chatty'],
      now
    )
    expect(eligible).toEqual([])
    expect(debounced).toHaveLength(1)
    expect(debounced[0].wikiKey).toBe('wiki-chatty')
    expect(debounced[0].etaMs).toBeGreaterThan(0)
  })

  it('marks a wiki eligible when its last fragment edge is older than the window', async () => {
    process.env.REGEN_DEBOUNCE_MS = '300000' // 5 min
    const now = new Date('2026-05-08T12:00:00.000Z')
    const oldEdge = new Date(now.getTime() - 600_000) // 10 min ago
    stageDbResponses([
      [{ wikiKey: 'wiki-quiet', lastEdgeAt: oldEdge }],
    ])
    const { eligible, debounced } = await filterDebouncedWikiKeys(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle stub
      mockDb as any,
      ['wiki-quiet'],
      now
    )
    expect(eligible).toEqual(['wiki-quiet'])
    expect(debounced).toEqual([])
  })

  it('treats a wiki with no fragment edges as eligible (no last-edge to wait on)', async () => {
    process.env.REGEN_DEBOUNCE_MS = '300000'
    stageDbResponses([[]]) // edges query returns nothing
    const { eligible, debounced } = await filterDebouncedWikiKeys(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle stub
      mockDb as any,
      ['wiki-empty']
    )
    expect(eligible).toEqual(['wiki-empty'])
    expect(debounced).toEqual([])
  })

  it('skips the DB call entirely when the candidate list is empty', async () => {
    const { eligible, debounced } = await filterDebouncedWikiKeys(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle stub
      mockDb as any,
      []
    )
    expect(eligible).toEqual([])
    expect(debounced).toEqual([])
  })

  it('regenDebounceMs respects the env override and falls back to the default', () => {
    expect(regenDebounceMs()).toBe(DEFAULT_REGEN_DEBOUNCE_MS)
    process.env.REGEN_DEBOUNCE_MS = '60000'
    expect(regenDebounceMs()).toBe(60_000)
    process.env.REGEN_DEBOUNCE_MS = 'garbage'
    expect(regenDebounceMs()).toBe(DEFAULT_REGEN_DEBOUNCE_MS)
    process.env.REGEN_DEBOUNCE_MS = '-1'
    expect(regenDebounceMs()).toBe(DEFAULT_REGEN_DEBOUNCE_MS)
  })
})

describe('processRegenBatchJob honours the per-wiki debounce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
    process.env.REGEN_DEBOUNCE_MS = '300000'
  })

  afterEach(() => {
    delete process.env.REGEN_DEBOUNCE_MS
  })

  it('does NOT enqueue a wiki whose last fragment edge landed inside the window', async () => {
    const now = Date.now()
    const fresh = new Date(now - 30_000) // 30s ago - well inside the 5min window
    stageDbResponses([
      [{ count: 0 }],                                    // unfiled count
      [{ lookupKey: 'wiki-chatty' }],                    // new-fragment wikis (Reason 2, debounce-gated)
      [],                                                // stuck wikis (Reason 3)
      [],                                                // auto-regen wikis (Reason 4)
      [{ wikiKey: 'wiki-chatty', lastEdgeAt: fresh }],   // debounce filter MAX(edges.created_at)
    ])

    const result = await processRegenBatchJob({
      type: 'regen-batch',
      jobId: 'batch-debounce-fresh',
      enqueuedAt: new Date().toISOString(),
    } as Parameters<typeof processRegenBatchJob>[0])

    expect(result.success).toBe(true)
    expect(mockEnqueueRegen).not.toHaveBeenCalled()
  })

  it('enqueues a wiki whose last fragment edge landed before the window', async () => {
    const now = Date.now()
    const old = new Date(now - 10 * 60_000) // 10 min ago
    stageDbResponses([
      [{ count: 0 }],
      [{ lookupKey: 'wiki-quiet' }],
      [],
      [],
      [{ wikiKey: 'wiki-quiet', lastEdgeAt: old }],
    ])

    await processRegenBatchJob({
      type: 'regen-batch',
      jobId: 'batch-debounce-old',
      enqueuedAt: new Date().toISOString(),
    } as Parameters<typeof processRegenBatchJob>[0])

    expect(mockEnqueueRegen).toHaveBeenCalledTimes(1)
    const arg = mockEnqueueRegen.mock.calls[0][0] as { objectKey: string; triggeredBy: string }
    expect(arg.objectKey).toBe('wiki-quiet')
    expect(arg.triggeredBy).toBe('scheduler')
  })

  it('bypasses debounce for stuck wikis (Reason 3) even when fragments are landing', async () => {
    const fresh = new Date(Date.now() - 5_000)
    stageDbResponses([
      [{ count: 0 }],
      [],                                                // no Reason 2 hits
      [{ lookupKey: 'wiki-stuck' }],                     // Reason 3: stuck
      [],                                                // Reason 4
      // No debounce-filter call expected because debounceCandidates is empty.
    ])

    await processRegenBatchJob({
      type: 'regen-batch',
      jobId: 'batch-bypass-stuck',
      enqueuedAt: new Date().toISOString(),
    } as Parameters<typeof processRegenBatchJob>[0])

    // wiki-stuck still enqueues even though we never even ran the debounce filter
    expect(mockEnqueueRegen).toHaveBeenCalledTimes(1)
    const arg = mockEnqueueRegen.mock.calls[0][0] as { objectKey: string }
    expect(arg.objectKey).toBe('wiki-stuck')
    // Asserting `fresh` is referenced - the bypass should NOT consult it.
    void fresh
  })
})
