import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// Covers #273: the per-wiki batch loop in processRegenBatchJob silently
// swallows enqueue failures with log.warn — a single bad wiki could fail
// silently and the batch reports success. Fix: emit a regen_batch_item_failed
// audit row per failed wiki AND surface a failure count in the JobResult so
// the orchestrator/observer sees aggregated failures (Tier-2 bubble).

const mockEnqueueRegen = vi.fn()
const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)
const mockRegenerateWiki = vi.fn()

vi.mock('../queue/producer.js', () => ({
  producer: {
    enqueueRegen: (...args: unknown[]) => mockEnqueueRegen(...args),
  },
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

vi.mock('../lib/regen.js', () => ({
  regenerateWiki: (...args: unknown[]) => mockRegenerateWiki(...args),
}))

// DB mock — the batch job runs three queries (unfiled count, wikis-with-new-
// fragments, stuck wikis). All resolve to whatever stage we push.
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
          // The debounce helper appends `.groupBy(...)` after `.where(...)`.
          groupBy: () => thenable(),
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

// Spread the real schema so every table export is present for transitive
// imports (db/locks.ts needs entries + fragments, lib/search.ts needs people).
// Only the tables actively queried by the regen batch worker need sentinels.
vi.mock('../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema.js')>()
  return {
    ...actual,
    wikis: {
      lookupKey: 'wikis.lookupKey',
      deletedAt: 'wikis.deletedAt',
      autoregen: 'wikis.autoregen',
      dirtySince: 'wikis.dirtySince',
      state: 'wikis.state',
      updatedAt: 'wikis.updatedAt',
      lastRebuiltAt: 'wikis.lastRebuiltAt',
    },
    edges: {
      dstId: 'edges.dstId',
      edgeType: 'edges.edgeType',
      deletedAt: 'edges.deletedAt',
      createdAt: 'edges.createdAt',
    },
    fragments: {
      lookupKey: 'fragments.lookupKey',
      deletedAt: 'fragments.deletedAt',
      embedding: 'fragments.embedding',
    },
  }
})

const { processRegenBatchJob } = await import('./regen-worker.js')

// ── Tests ──────────────────────────────────────────────────────────────────

describe('processRegenBatchJob — per-item enqueue failure (#273)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
  })

  it('emits a regen_batch_item_failed audit row when a single wiki enqueue rejects', async () => {
    // Stage: unfiled count to 0 (no unfiled, Reason 1 skipped), Reason 2
    // returns two candidates, Reason 3 + Reason 4 return zero, debounce
    // filter returns both eligible (dirty_since older than 5min window).
    const oldDirty = new Date(Date.now() - 10 * 60_000)
    stageDbResponses([
      [{ count: 0 }],                                                  // unfiled count
      [{ lookupKey: 'wiki-good' }, { lookupKey: 'wiki-bad' }],         // Reason 2: autoregen+dirty wikis
      [],                                                              // Reason 3: stuck wikis
      [],                                                              // Reason 4: autoregen+learning wikis
      [
        { wikiKey: 'wiki-good', dirtySince: oldDirty },
        { wikiKey: 'wiki-bad', dirtySince: oldDirty },
      ],                                                               // filterDebouncedWikiKeys (reads wikis.dirty_since)
    ])

    // First wiki succeeds, second one fails.
    mockEnqueueRegen
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis EOF'))

    const result = await processRegenBatchJob({
      type: 'regen-batch',
      jobId: 'batch-1',
      enqueuedAt: new Date().toISOString(),
    } as Parameters<typeof processRegenBatchJob>[0])

    // Exactly one audit row for the failed wiki.
    const calls = mockEmitAuditEvent.mock.calls
    const failedCalls = calls.filter(
      (c) => (c[1] as { eventType?: string }).eventType === 'regen_batch_item_failed',
    )
    expect(failedCalls).toHaveLength(1)
    const params = failedCalls[0]![1] as {
      entityType: string
      entityId: string
      eventType: string
      detail?: Record<string, unknown>
    }
    expect(params.entityType).toBe('wiki')
    expect(params.entityId).toBe('wiki-bad')
    expect(params.eventType).toBe('regen_batch_item_failed')
    expect(params.detail).toMatchObject({ error: 'redis EOF' })

    // The batch still reports success — the failure count is bubbled via
    // the per-item audit row (above) and the `regen batch completed` log
    // line, NOT via the JobResult shape (the JobResult type lives in
    // @robin/queue and would require a cross-package change). Audit row
    // count is the load-bearing contract here.
    expect(result.success).toBe(true)
  })

  it('does NOT emit any regen_batch_item_failed audit when every enqueue succeeds', async () => {
    const oldDirty = new Date(Date.now() - 10 * 60_000)
    stageDbResponses([
      [{ count: 0 }],
      [{ lookupKey: 'wiki-good' }],
      [],
      [],
      [{ wikiKey: 'wiki-good', dirtySince: oldDirty }],
    ])
    mockEnqueueRegen.mockResolvedValue(undefined)

    await processRegenBatchJob({
      type: 'regen-batch',
      jobId: 'batch-2',
      enqueuedAt: new Date().toISOString(),
    } as Parameters<typeof processRegenBatchJob>[0])

    const calls = mockEmitAuditEvent.mock.calls
    const failedCalls = calls.filter(
      (c) => (c[1] as { eventType?: string }).eventType === 'regen_batch_item_failed',
    )
    expect(failedCalls).toHaveLength(0)
  })
})
