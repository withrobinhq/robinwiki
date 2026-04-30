import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// Covers #274: the catch+log.warn at regen.ts:354-357 that wraps the
// createRelatedToEdges call inside classifyUnfiledFragments. PR #261 shipped
// UAT plans that depend on RELATED_TO edges materializing — silent drops here
// mean the worker quietly produces incomplete graphs and tests pass. Fix:
// emit a related_edge_create_failed audit row AND extend the classify return
// shape with an edgesFailed counter (Tier-2 bubble).

const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)

// LLM caller — by default returns one wikiEdge so the inner code path runs.
const fakeWikiClassify = vi.fn(async () => ({
  data: {
    wikiEdges: [{ wikiKey: 'wiki-target', score: 0.9, reasoning: 'fits' }],
    rawAssignments: [],
  },
}))

vi.mock('@robin/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@robin/agent')>()
  return {
    ...original,
    createIngestAgents: vi.fn(() => ({
      wikiClassifier: {},
      fragmenter: {},
      entityExtractor: {},
      fragScorer: {},
      wikiWriter: {},
    })),
    createTypedCaller: vi.fn(() => fakeWikiClassify),
    embedText: vi.fn(async () => null),
    wikiClassify: vi.fn(async (_deps: unknown, _input: unknown) => ({
      data: {
        wikiEdges: [{ wikiKey: 'wiki-target', score: 0.9, reasoning: 'fits' }],
        rawAssignments: [],
      },
    })),
  }
})

vi.mock('./openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn(async () => ({
    apiKey: 'test-key',
    models: {
      extraction: 'test/model',
      classification: 'test/model',
      wikiGeneration: 'test/model',
      embedding: 'test/model',
    },
  })),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

// hybridSearch returns one candidate so classifyUnfiledFragments enters the
// LLM-review branch.
vi.mock('./search.js', () => ({
  hybridSearch: vi.fn(async () => [
    { id: 'frag-source', score: 0.6, snippet: 'source content' },
  ]),
}))

// ── DB mock ────────────────────────────────────────────────────────────────
// Carefully ordered: we want the FRAGMENT_IN_WIKI insert path to succeed,
// but the inner createRelatedToEdges call to THROW so the catch+log.warn
// at regen.ts:354-357 fires.
const dbResponseQueue: unknown[][] = []
let throwOnLimitCallNumber = -1
let limitCallCount = 0

function stageDbResponses(responses: unknown[][]) {
  dbResponseQueue.length = 0
  dbResponseQueue.push(...responses)
}

function popResponse(): unknown[] {
  return dbResponseQueue.shift() ?? []
}

vi.mock('../db/client.js', () => {
  function selectChain() {
    return {
      from: () => ({
        where: (..._args: unknown[]) => {
          let deferred: Promise<unknown[]> | null = null
          const ensureDeferred = () => {
            if (!deferred) deferred = Promise.resolve(popResponse())
            return deferred
          }
          return {
            // biome-ignore lint/suspicious/noThenProperty: drizzle thenable mock
            then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (r: unknown) => unknown) =>
              ensureDeferred().then(onFulfilled, onRejected),
            limit: async () => {
              limitCallCount++
              if (limitCallCount === throwOnLimitCallNumber) {
                throw new Error('embedding select boom')
              }
              return popResponse()
            },
            orderBy: () => ({ limit: async () => popResponse() }),
            groupBy: () => ({
              // biome-ignore lint/suspicious/noThenProperty: drizzle thenable mock
              then: (onFulfilled: (v: unknown[]) => unknown) =>
                Promise.resolve(popResponse()).then(onFulfilled),
            }),
          }
        },
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => popResponse() }),
          }),
        }),
      }),
    }
  }
  return {
    db: {
      select: () => selectChain(),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: 'edge-id' }],
          }),
        }),
      }),
    },
  }
})

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookupKey',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    description: 'wikis.description',
    deletedAt: 'wikis.deletedAt',
  },
  wikiTypes: { slug: 'wikiTypes.slug', prompt: 'wikiTypes.prompt' },
  edges: {
    srcId: 'edges.srcId',
    dstId: 'edges.dstId',
    edgeType: 'edges.edgeType',
    deletedAt: 'edges.deletedAt',
  },
  fragments: {
    lookupKey: 'fragments.lookupKey',
    embedding: 'fragments.embedding',
    deletedAt: 'fragments.deletedAt',
    content: 'fragments.content',
  },
  edits: {},
}))

const { classifyUnfiledFragments } = await import('./regen.js')
const { db: mockDb } = await import('../db/client.js')

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyUnfiledFragments — RELATED_TO edge failure (#274)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
    throwOnLimitCallNumber = -1
    limitCallCount = 0
  })

  it('emits a related_edge_create_failed audit row when createRelatedToEdges throws', async () => {
    // Stage queue:
    //   1. wiki lookup (.where().limit(1))           → return one wiki
    //   2. fragments select for content (.where())   → return content row
    //   3. filed-frag-keys select (.where())         → empty so all are unfiled
    //   4. wikis-still-live check (.where().limit(1)) → return live row
    //   5. createRelatedToEdges → first .where().limit(1) call throws.
    //
    // In practice the mock pops one queue entry per terminal-call. The order
    // of internal queries inside classifyUnfiledFragments:
    //   - wiki lookup: select().from(wikis).where().limit(1) → stage 1
    //   - filedFragKeys: select(srcId).from(edges).where() → stage 2
    //   - candidate frag content: select.from(fragments).where() → stage 3
    //   - wiki-still-live: select.from(wikis).where().limit(1) → stage 4
    // The createRelatedToEdges path then runs and throws on its own first
    // select call (the embedding lookup) — we trip that with the throw flag.
    stageDbResponses([
      [{ lookupKey: 'wiki-target', name: 'Target', type: 'log', prompt: null, description: 'desc' }], // .where().limit(1) #1 — wiki lookup
      [],                                                                                              // .where() thenable — filedFragKeys
      [{ lookupKey: 'frag-source', content: 'source content' }],                                      // .where() thenable — candidate frag content
      [{ key: 'wiki-target' }],                                                                       // .where().limit(1) #2 — wiki-still-live
      // .where().limit(1) #3 — createRelatedToEdges embedding lookup → throws
    ])
    // Trip the throw on the 3rd .where().limit(1) call — the embedding
    // select inside createRelatedToEdges.
    throwOnLimitCallNumber = 3

    const result = await classifyUnfiledFragments(mockDb, 'wiki-target')

    // The function must NOT throw — the catch swallows internally.
    expect(result).toBeDefined()

    // The audit row must be emitted.
    const calls = mockEmitAuditEvent.mock.calls
    const failedCall = calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'related_edge_create_failed',
    )
    expect(failedCall).toBeDefined()
    const params = failedCall![1] as {
      entityType: string
      entityId: string
      eventType: string
      detail?: Record<string, unknown>
    }
    expect(params.entityType).toBe('fragment')
    expect(params.entityId).toBe('frag-source')
    expect(params.eventType).toBe('related_edge_create_failed')
    expect(params.detail).toMatchObject({
      error: 'embedding select boom',
      wikiKey: 'wiki-target',
    })

    // Tier-2 bubble: classify return shape now exposes edgesFailed.
    const r = result as unknown as { edgesFailed?: number }
    expect(r.edgesFailed).toBe(1)
  })
})
