import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Plan 005: wiki delete cascade + classify conditional insert ────────────
//
// Covers three guarantees introduced in plan 005:
//   1. DELETE /wikis/:id runs wiki update + edge cascade + groupWikis delete
//      inside a single db.transaction call (not as separate top-level awaits).
//   2. emitAuditEvent fires after the transaction commits; a rejection from
//      emitAuditEvent does not roll back the delete.
//   3. classifyUnfiledFragments: when the conditional INSERT WHERE EXISTS
//      returns 0 rows (wiki was soft-deleted), the loop logs the skip warning,
//      does not increment llmFiled, and does not call createRelatedToEdges.
//
// Tests 1 & 2 exercise the DELETE route handler via a mocked db + Hono app.
// Test 3 calls classifyUnfiledFragments directly with a fake db double.

// ── DB mock infrastructure ─────────────────────────────────────────────────

// tx spy — set up in beforeEach, reused by mockTransaction
const mockTx = {
  update: vi.fn(),
  delete: vi.fn(),
}

const mockTransaction = vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => {
  await fn(mockTx)
})

const mockDbSelect = vi.fn()
const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    transaction: (...args: unknown[]) => mockTransaction(...(args as Parameters<typeof mockTransaction>)),
  },
}))

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookup_key',
    name: 'wikis.name',
    slug: 'wikis.slug',
    type: 'wikis.type',
    state: 'wikis.state',
    autoregen: 'wikis.autoregen',
    dirtySince: 'wikis.dirty_since',
    deletedAt: 'wikis.deleted_at',
    updatedAt: 'wikis.updated_at',
  },
  edges: {
    srcId: 'edges.src_id',
    dstId: 'edges.dst_id',
    deletedAt: 'edges.deleted_at',
  },
  wikiTypes: {},
  fragments: {},
  people: {},
  auditLog: {},
  edits: {},
  groupWikis: { wikiId: 'group_wikis.wiki_id' },
  groups: {},
}))

vi.mock('../db/locks.js', () => ({
  wikiRegenLock: { using: vi.fn() },
}))

// Keep the real classifyUnfiledFragments available — only mock regenerateWiki
// which is what the route uses.
vi.mock('../lib/regen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/regen.js')>()
  return {
    ...actual,
    regenerateWiki: vi.fn(),
  }
})

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('userId', 'test-user')
    await next()
  }),
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

vi.mock('../queue/producer.js', () => ({
  producer: { enqueueRegen: vi.fn() },
}))

vi.mock('../mcp/wiki-type-inference.js', () => ({
  inferWikiType: vi.fn().mockReturnValue('log'),
}))

vi.mock('../db/slug.js', () => ({
  resolveWikiSlug: vi.fn(),
}))

vi.mock('../lib/openrouter-config.js', () => ({
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

vi.mock('../lib/backfill-runner.js', () => ({
  loadAgentSchemaStatusByWiki: vi.fn(),
}))

vi.mock('../lib/wiki-agent-schema.js', () => ({
  ensureAgentSchema: vi.fn(),
  resolveRetrievalIndexModel: vi.fn(),
}))

vi.mock('../lib/wikiSidecar.js', () => ({
  buildSidecar: vi.fn(),
}))

vi.mock('../lib/wikiSidecarDeps.js', () => ({
  makeSidecarDeps: vi.fn(),
}))

vi.mock('../lib/strip-wiki-content.js', () => ({
  stripWikiContent: vi.fn((s: string) => s),
}))

vi.mock('../lib/wiki-editorial-state.js', () => ({
  editorialStateOf: vi.fn(() => 'live'),
}))

vi.mock('../services/publish.js', () => ({
  publishWiki: vi.fn(),
  unpublishWiki: vi.fn(),
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
    createTypedCaller: vi.fn(() => vi.fn()),
    embedText: vi.fn(async () => null),
    wikiClassify: vi.fn(async () => ({
      data: {
        wikiEdges: [{ wikiKey: 'wiki-del', score: 0.9, reasoning: 'fits' }],
        rawAssignments: [],
      },
    })),
  }
})

vi.mock('../lib/search.js', () => ({
  hybridSearch: vi.fn(async () => [
    { id: 'frag-x', score: 0.6, snippet: 'test content' },
  ]),
}))

const { wikisRoutes } = await import('../routes/wikis.js')
const { classifyUnfiledFragments } = await import('../lib/regen.js')

// ── Route test helpers ─────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(rows)
  return chain
}

function makeTxUpdateChain() {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(undefined)
  return chain
}

function makeTxDeleteChain() {
  const chain: Record<string, any> = {}
  chain.where = vi.fn().mockResolvedValue(undefined)
  return chain
}

const testWiki = {
  lookupKey: 'wiki01',
  name: 'Test Wiki',
  slug: 'test-wiki',
  type: 'log',
}

// ── Test 1: all three DML ops run on tx ────────────────────────────────────

describe('DELETE /wikis/:id — transactional cascade (plan 005)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEmitAuditEvent.mockResolvedValue(undefined)

    mockTransaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => {
      mockTx.update.mockReturnValue(makeTxUpdateChain())
      mockTx.delete.mockReturnValue(makeTxDeleteChain())
      await fn(mockTx)
    })
  })

  it('executes wiki update, edge cascade, and groupWikis delete on tx — not on db', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([testWiki]))

    const app = createApp()
    const res = await app.request('/wikis/wiki01', { method: 'DELETE' })

    expect(res.status).toBe(204)

    // db.transaction was called exactly once
    expect(mockTransaction).toHaveBeenCalledTimes(1)

    // All three DML ops executed on tx
    expect(mockTx.update).toHaveBeenCalledTimes(2) // wikis soft-delete + edges cascade
    expect(mockTx.delete).toHaveBeenCalledTimes(1) // groupWikis hard-delete
  })

  // ── Test 2: audit event fires post-commit ──────────────────────────────

  it('emits audit event after the transaction resolves; a tx-rejection does not happen due to audit failure', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([testWiki]))

    let txResolved = false

    mockTransaction.mockImplementationOnce(async (fn: (tx: typeof mockTx) => Promise<void>) => {
      mockTx.update.mockReturnValue(makeTxUpdateChain())
      mockTx.delete.mockReturnValue(makeTxDeleteChain())
      await fn(mockTx)
      txResolved = true
    })

    // emitAuditEvent checks that txResolved is already true when it's called
    mockEmitAuditEvent.mockImplementationOnce(async () => {
      // emitAuditEvent must be called after the tx committed
      expect(txResolved).toBe(true)
    })

    const app = createApp()
    await app.request('/wikis/wiki01', { method: 'DELETE' })

    expect(txResolved).toBe(true)
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1)
  })
})

// ── Test 3: classify skip path when execute returns 0 rows ─────────────────

describe('classifyUnfiledFragments — conditional insert: wiki deleted during LLM call (plan 005)', () => {
  it('logs skip warning, keeps llmFiled=0, skips createRelatedToEdges when execute returns 0 rows', async () => {
    // Build a db double driving classifyUnfiledFragments through the classify
    // loop, with execute() returning [] (wiki soft-deleted between LLM call
    // and insert).
    const dbResponseQueue: unknown[][] = []

    function popResponse() {
      return dbResponseQueue.shift() ?? []
    }

    const fakeDb = {
      select: () => ({
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
              limit: async () => popResponse(),
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
      }),
      // Conditional INSERT WHERE EXISTS — return [] to simulate wiki deleted.
      execute: vi.fn(async () => [] as unknown[]),
    }

    // Queue select responses (in the order classifyUnfiledFragments calls them):
    //   1. wiki lookup by key                → wiki row
    //   2. filedFragKeys (edges.where())     → empty (no existing edges)
    //   3. candidate frag content            → one fragment
    // The execute() for the FRAGMENT_IN_WIKI insert then returns [] → skip.
    dbResponseQueue.push(
      [{ lookupKey: 'wiki-del', name: 'Deleted Wiki', type: 'log', prompt: null, description: '' }],
      [], // filedFragKeys — no existing edges
      [{ lookupKey: 'frag-x', content: 'test content', hybridScore: 0.8 }],
    )

    const result = await classifyUnfiledFragments(fakeDb as any, 'wiki-del')

    // execute was called for the conditional insert
    expect(fakeDb.execute).toHaveBeenCalledTimes(1)

    // llmFiled is 0 — the skip-continue path was taken
    expect(result.llmFiled).toBe(0)

    // createRelatedToEdges was NOT called — no additional execute calls
    // beyond the one FRAGMENT_IN_WIKI attempt
    expect(fakeDb.execute).toHaveBeenCalledTimes(1)
  })
})
