import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stream D / D1' — PUT /fragments/:id is the data spine for the fragment
// evolution timeline. Each PUT must:
//   1. Update the fragment row in place.
//   2. Snapshot the prior content into `edits` (objectType='fragment').
//   3. Emit an audit_log row with eventType='fragment.updated'.
//
// These tests pin (2) and (3) — Stream A5's history endpoint reads from
// `edits`, Stream F4's timeline reads from both sides.

const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)
const mockInsertEdit = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'test-user')
    await next()
  }),
}))

vi.mock('../mcp/handlers.js', () => ({
  handleLogFragment: vi.fn(),
}))

vi.mock('../db/slug.js', () => ({ resolveFragmentSlug: vi.fn() }))
vi.mock('../db/dedup.js', () => ({
  computeContentHash: vi.fn().mockReturnValue('hash'),
  findDuplicateFragment: vi.fn(),
}))
vi.mock('../lib/fragmentTitlePrefix.js', () => ({
  applyFragmentTitleDatePrefix: vi.fn(),
}))

vi.mock('../queue/producer.js', () => ({
  producer: { enqueueRegen: vi.fn() },
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
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(popDb()),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(popDb()),
        }),
      }),
    }),
    insert: (table: { _name?: string }) => ({
      values: (vals: Record<string, unknown>) => {
        if (table?._name === 'edits') return mockInsertEdit(vals)
        return Promise.resolve(undefined)
      },
    }),
  }
  return { db: fakeDb }
})

vi.mock('../db/schema.js', () => ({
  fragments: {
    lookupKey: 'fragments.lookupKey',
    deletedAt: 'fragments.deletedAt',
    content: 'fragments.content',
  },
  entries: {},
  edges: {},
  wikis: {},
  people: {},
  edits: { _name: 'edits' },
}))

const { fragmentsRoutes } = await import('./fragments.js')

function fragRow(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'frag',
    slug: 's',
    title: 't',
    type: 'thought',
    content: '',
    state: 'PENDING' as const,
    tags: [],
    entryId: 'entry-1',
    confidence: null,
    embedding: null,
    embeddingAttemptCount: 0,
    embeddingLastAttemptAt: null,
    dedupHash: null,
    deletedAt: null,
    lockedBy: null,
    lockedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function put(path: string, body: unknown) {
  return fragmentsRoutes.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PUT /fragments/:id — D1\' edit audit emission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
  })

  it('writes one edits row and emits fragment.updated audit when content changes', async () => {
    stageDb([
      [fragRow({ lookupKey: 'frag-1', content: 'first version' })],
      [fragRow({ lookupKey: 'frag-1', content: 'second version' })],
    ])

    const res = await put('/frag-1', { content: 'second version' })

    expect(res.status).toBe(200)
    expect(mockInsertEdit).toHaveBeenCalledTimes(1)
    const editVals = mockInsertEdit.mock.calls[0]![0] as Record<string, unknown>
    expect(editVals.objectType).toBe('fragment')
    expect(editVals.objectId).toBe('frag-1')
    expect(editVals.contentBefore).toBe('first version')
    expect(editVals.contentAfter).toBe('second version')
    expect(editVals.content).toBe('first version')
    expect(editVals.source).toBe('api')

    const auditCall = mockEmitAuditEvent.mock.calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'fragment.updated',
    )
    expect(auditCall).toBeDefined()
    const params = auditCall![1] as {
      entityType: string
      entityId: string
      eventType: string
      detail?: Record<string, unknown>
    }
    expect(params.entityType).toBe('fragment')
    expect(params.entityId).toBe('frag-1')
    expect(params.detail).toMatchObject({
      fragmentKey: 'frag-1',
      editId: editVals.id,
    })
  })

  it('does NOT write an edits row when content is unchanged (title-only edit)', async () => {
    stageDb([
      [fragRow({ lookupKey: 'frag-2', content: 'same', title: 'old' })],
      [fragRow({ lookupKey: 'frag-2', content: 'same', title: 'new' })],
    ])

    const res = await put('/frag-2', { title: 'new' })

    expect(res.status).toBe(200)
    expect(mockInsertEdit).not.toHaveBeenCalled()
    // Audit still fires for the title change.
    const auditCall = mockEmitAuditEvent.mock.calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'fragment.updated',
    )
    expect(auditCall).toBeDefined()
    const params = auditCall![1] as { detail?: Record<string, unknown> }
    expect(params.detail?.editId).toBeNull()
  })
})
