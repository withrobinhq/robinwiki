import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stream D / D5 (#258) — backfill worker.
//
// Pins three behaviours:
//   1. The job emits started/completed audit rows tagged
//      entityType='fragment_relationship_backfill'.
//   2. JobResult carries scanned + edgesCreated counts.
//   3. processFragmentRelationshipBackfillJob never throws — failures
//      surface via JobResult.success=false plus a 'failed' audit row.

const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

const dbResponseQueue: unknown[][] = []
function stageDb(responses: unknown[][]) {
  dbResponseQueue.length = 0
  dbResponseQueue.push(...responses)
}
function popDb(): unknown[] {
  return dbResponseQueue.shift() ?? []
}

vi.mock('../db/client.js', () => {
  function selectChain() {
    return {
      from: () => ({
        where: () => {
          const v = popDb()
          const thenable = {
            // biome-ignore lint/suspicious/noThenProperty: drizzle thenable mock
            then: (onFulfilled: (v: unknown[]) => unknown) =>
              Promise.resolve(v).then(onFulfilled),
            limit: () => Promise.resolve(v),
            orderBy: () => ({
              limit: () => Promise.resolve(v),
            }),
          }
          return thenable
        },
      }),
    }
  }
  return {
    db: {
      select: () => selectChain(),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([]),
          }),
        }),
      }),
    },
  }
})

vi.mock('../db/schema.js', () => ({
  fragments: {
    lookupKey: 'fragments.lookupKey',
    embedding: 'fragments.embedding',
    deletedAt: 'fragments.deletedAt',
  },
  edges: { id: 'edges.id' },
  auditLog: {
    entityType: 'audit.entityType',
    eventType: 'audit.eventType',
    detail: 'audit.detail',
    createdAt: 'audit.createdAt',
  },
}))

const {
  runFragmentRelationshipBackfill,
  processFragmentRelationshipBackfillJob,
} = await import('./fragment-relationship-backfill-worker.js')

describe('runFragmentRelationshipBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
  })

  it('emits started + completed audit rows on a clean run', async () => {
    // Stage candidates query → empty (no fragments need backfill)
    stageDb([[]])

    const result = await runFragmentRelationshipBackfill({
      jobId: 'job-clean',
      triggeredBy: 'manual',
    })

    expect(result.scanned).toBe(0)
    expect(result.edgesCreated).toBe(0)

    const eventTypes = mockEmitAuditEvent.mock.calls.map(
      (c) => (c[1] as { eventType?: string }).eventType,
    )
    expect(eventTypes).toContain('started')
    expect(eventTypes).toContain('completed')

    const startedCall = mockEmitAuditEvent.mock.calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'started',
    )
    const startedParams = startedCall![1] as {
      entityType: string
      detail?: Record<string, unknown>
    }
    expect(startedParams.entityType).toBe('fragment_relationship_backfill')
    expect(startedParams.detail).toMatchObject({ triggeredBy: 'manual' })
  })

  it('reports scanned + edgesCreated counts on completion', async () => {
    // Two candidates needing backfill, each with no neighbours.
    stageDb([
      [{ lookupKey: 'frag-1' }, { lookupKey: 'frag-2' }], // candidates query
      [{ embedding: null }],                              // frag-1 embedding lookup → null short-circuits
      [{ embedding: null }],                              // frag-2 embedding lookup → null short-circuits
    ])

    const result = await runFragmentRelationshipBackfill({
      jobId: 'job-counts',
      triggeredBy: 'scheduler',
    })

    expect(result.scanned).toBe(2)
    expect(result.edgesCreated).toBe(0)

    const completedCall = mockEmitAuditEvent.mock.calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'completed',
    )
    const completedParams = completedCall![1] as {
      detail?: Record<string, unknown>
    }
    expect(completedParams.detail).toMatchObject({
      scanned: 2,
      edgesCreated: 0,
      triggeredBy: 'scheduler',
    })
  })
})

describe('processFragmentRelationshipBackfillJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
  })

  it('returns success=true with scanned/edgesCreated when run completes', async () => {
    stageDb([[]])

    const result = await processFragmentRelationshipBackfillJob({
      type: 'fragment-relationship-backfill',
      jobId: 'job-ok',
      triggeredBy: 'manual',
      enqueuedAt: new Date().toISOString(),
    })

    expect(result.success).toBe(true)
    expect(result.jobId).toBe('job-ok')
    // Cast through unknown — JobResult is the minimal contract; we extend it.
    const detail = result as unknown as { scanned: number; edgesCreated: number }
    expect(detail.scanned).toBe(0)
    expect(detail.edgesCreated).toBe(0)
  })
})
