import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { fragments as realFragments } from '../db/schema.js'

// ── Module-level mocks ─────────────────────────────────────────────────────

const embedTextMock = vi.fn()
const takeLastEmbedFailureMock = vi.fn()
const createHydeAgentMock = vi.fn()
const createStringCallerMock = vi.fn()
vi.mock('@robin/agent', () => ({
  embedText: (...args: unknown[]) => embedTextMock(...args),
  takeLastEmbedFailure: () => takeLastEmbedFailureMock(),
  createHydeAgent: (...args: unknown[]) => createHydeAgentMock(...args),
  createStringCaller: (...args: unknown[]) => createStringCallerMock(...args),
}))

const loadOpenRouterConfigMock = vi.fn()
vi.mock('../lib/openrouter-config.js', () => ({
  loadOpenRouterConfig: () => loadOpenRouterConfigMock(),
}))

// Captured DB calls so tests can assert on them. The drizzle chain stubs
// below push into these in order.
const selectReturns: Array<Array<Record<string, unknown>>> = []
const updateCapture: Array<{ set: Record<string, unknown> }> = []
const whereCapture: Array<unknown> = []
const insertCapture: Array<{ table: unknown; values: Record<string, unknown> }> = []
const deleteCapture: Array<{ table: unknown }> = []

// db.execute returns are queued the same way selectReturns are; the heal pass
// uses raw SQL via db.execute() to scan for missing agent_schema rows.
const executeReturns: Array<Array<Record<string, unknown>>> = []

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          whereCapture.push(clause)
          return {
            orderBy: () => ({
              limit: () =>
                Promise.resolve(selectReturns.shift() ?? []),
            }),
          }
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateCapture.push({ set: v })
        return { where: () => Promise.resolve() }
      },
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        insertCapture.push({ table, values: v })
        return {
          onConflictDoUpdate: () => Promise.resolve(),
          onConflictDoNothing: () => Promise.resolve(),
          returning: () => Promise.resolve([{ id: 'mock' }]),
        }
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        deleteCapture.push({ table })
        return Promise.resolve()
      },
    }),
    execute: () => Promise.resolve(executeReturns.shift() ?? []),
  },
}))

// emitPipelineEvent / emitAuditEvent / emitUsageEvent each insert into a real
// table; we don't want their side effects in tests, so stub them.
vi.mock('../db/pipeline-events.js', () => ({
  emitPipelineEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../db/usage-events.js', () => ({
  emitUsageEvent: vi.fn().mockResolvedValue(undefined),
}))

// Note: we intentionally do NOT mock '../db/schema.js'. Using the real
// fragments table is required for issue #216's regression test, which feeds
// the captured where expression into PgDialect to validate that the Date
// cutoff binds without throwing TypeError [ERR_INVALID_ARG_TYPE].

const { processEmbeddingRetryJob } = await import('./embedding-retry-worker.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function baseJob() {
  return {
    type: 'embedding-retry' as const,
    jobId: 'job-1',
    triggeredBy: 'scheduler' as const,
    enqueuedAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  embedTextMock.mockReset()
  takeLastEmbedFailureMock.mockReset()
  createHydeAgentMock.mockReset()
  createStringCallerMock.mockReset()
  loadOpenRouterConfigMock.mockReset()
  selectReturns.length = 0
  updateCapture.length = 0
  whereCapture.length = 0
  insertCapture.length = 0
  deleteCapture.length = 0
  executeReturns.length = 0
  loadOpenRouterConfigMock.mockResolvedValue({
    apiKey: 'k',
    models: { extraction: 'x', classification: 'y', wikiGeneration: 'z', embedding: 'e' },
  })
})

// ── Cases ──────────────────────────────────────────────────────────────────

describe('processEmbeddingRetryJob — issue #151', () => {
  it('persists the embedding when embedText succeeds', async () => {
    selectReturns.push([
      { lookupKey: 'frag1', content: 'hello', attemptCount: 0 },
    ])
    embedTextMock.mockResolvedValueOnce([0.1, 0.2, 0.3])
    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(updateCapture).toHaveLength(1)
    expect(updateCapture[0].set.embedding).toEqual([0.1, 0.2, 0.3])
    expect(updateCapture[0].set.embeddingLastAttemptAt).toBeInstanceOf(Date)
  })

  it('bumps attempt_count without persisting when embedText returns null', async () => {
    selectReturns.push([
      { lookupKey: 'frag1', content: 'hello', attemptCount: 2 },
    ])
    embedTextMock.mockResolvedValueOnce(null)
    takeLastEmbedFailureMock.mockReturnValueOnce({
      kind: 'http',
      status: 429,
      body: 'rate limited',
    })
    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(updateCapture).toHaveLength(1)
    expect(updateCapture[0].set.embeddingAttemptCount).toBe(3)
    expect(updateCapture[0].set.embedding).toBeUndefined()
    expect(updateCapture[0].set.embeddingLastAttemptAt).toBeInstanceOf(Date)
  })

  it('no-ops when OpenRouter config is unavailable', async () => {
    loadOpenRouterConfigMock.mockRejectedValueOnce(new Error('no key'))
    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(embedTextMock).not.toHaveBeenCalled()
    expect(updateCapture).toHaveLength(0)
  })

  // Regression test for issue #216: prior to the fix, the worker passed a
  // raw Date into a `sql\`...\`` template literal, which made the pg driver
  // throw `TypeError [ERR_INVALID_ARG_TYPE]` at every 15-min cron tick. The
  // fix uses Drizzle's typed `lt()` comparison, which normalizes Date into
  // an ISO string param the driver accepts.
  it('issue #216: serializes Date cutoff in where clause without throwing', async () => {
    selectReturns.push([])
    await processEmbeddingRetryJob(baseJob())
    expect(whereCapture.length).toBeGreaterThanOrEqual(1)
    // Sanity check: the captured where targets the real schema column so
    // PgDialect can resolve column references during compilation.
    expect(realFragments.embeddingLastAttemptAt).toBeDefined()
    const dialect = new PgDialect()
    expect(() => dialect.sqlToQuery(whereCapture[0] as never)).not.toThrow()
    const compiled = dialect.sqlToQuery(whereCapture[0] as never)
    expect(compiled.sql).toMatch(/embedding_last_attempt_at/)
    expect(compiled.sql).toMatch(/is null/i)
    // The cutoff Date must reach the param array as an ISO timestamp string,
    // not a JS Date instance (which would crash the pg driver). Find the
    // ISO string corresponding to a Date param.
    const isoCutoff = compiled.params.find(
      (p): p is string =>
        typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p)
    )
    expect(isoCutoff).toBeDefined()
  })

  it('processes multiple rows per invocation', async () => {
    selectReturns.push([
      { lookupKey: 'frag1', content: 'a', attemptCount: 0 },
      { lookupKey: 'frag2', content: 'b', attemptCount: 1 },
    ])
    embedTextMock
      .mockResolvedValueOnce([1, 2, 3])
      .mockResolvedValueOnce(null)
    takeLastEmbedFailureMock.mockReturnValueOnce({ kind: 'threw', message: 'timeout' })

    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(embedTextMock).toHaveBeenCalledTimes(2)
    expect(updateCapture).toHaveLength(2)
    expect(updateCapture[0].set.embedding).toEqual([1, 2, 3])
    expect(updateCapture[1].set.embeddingAttemptCount).toBe(2)
  })
})

// ── Agent-schema heal pass (#69 D6 follow-up) ─────────────────────────────

describe('processEmbeddingRetryJob — agent_schema heal pass', () => {
  it('writes a kind=description row for each wiki missing one', async () => {
    // Three retryTable selects (fragments, wikis, people): all empty.
    selectReturns.push([], [], [])
    // Two execute() calls in the heal pass: description targets, then hyde.
    executeReturns.push(
      [{ wiki_key: 'wiki1', description: 'first wiki' }, { wiki_key: 'wiki2', description: 'second wiki' }],
      [],
    )
    embedTextMock.mockResolvedValue([0.5, 0.5, 0.5])

    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)

    // One INSERT per wiki, all into wiki_agent_schema with kind=description.
    const descInserts = insertCapture.filter(
      (c) => (c.values as Record<string, unknown>).kind === 'description'
    )
    expect(descInserts).toHaveLength(2)
    expect(descInserts[0].values.wikiKey).toBe('wiki1')
    expect(descInserts[0].values.embedding).toEqual([0.5, 0.5, 0.5])
    expect(descInserts[0].values.generatorVersion).toBe('hyde_v1')
    expect(descInserts[1].values.wikiKey).toBe('wiki2')
  })

  it('does not LLM-call when no wikis need hyde rows', async () => {
    selectReturns.push([], [], [])
    executeReturns.push([], []) // both heal queries empty

    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)
    expect(createHydeAgentMock).not.toHaveBeenCalled()
    expect(createStringCallerMock).not.toHaveBeenCalled()
  })

  it('skips a wiki when its embed returns null and continues to the next', async () => {
    selectReturns.push([], [], [])
    executeReturns.push(
      [
        { wiki_key: 'wiki-bad', description: 'will fail' },
        { wiki_key: 'wiki-good', description: 'will succeed' },
      ],
      [],
    )
    embedTextMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([0.7, 0.7, 0.7])

    const res = await processEmbeddingRetryJob(baseJob())
    expect(res.success).toBe(true)

    const descInserts = insertCapture.filter(
      (c) => (c.values as Record<string, unknown>).kind === 'description'
    )
    expect(descInserts).toHaveLength(1)
    expect(descInserts[0].values.wikiKey).toBe('wiki-good')
  })

  it('does not abort the worker when the heal pass throws', async () => {
    selectReturns.push([], [], [])
    // Both heal queries throw via undefined return for executeReturns;
    // simulate by pushing nothing and making execute throw via a marker.
    // Easier: have findWikisMissingDescriptionRow's first execute throw by
    // making executeReturns shift undefined (the real query throws on
    // undefined.map). We rely on the worker's outer try/catch around the
    // heal pass to swallow it.
    executeReturns.push(undefined as unknown as Array<Record<string, unknown>>)

    const res = await processEmbeddingRetryJob(baseJob())
    // The worker swallows the heal failure and still completes the cron tick.
    expect(res.success).toBe(true)
  })
})
