import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// These tests cover the regen-enqueue swallow paths on /fragments/:id/accept
// (#271) and /fragments/:id/reject (#272). When producer.enqueueRegen rejects,
// the route catches the error and previously logged a warn with no audit
// surface — meaning a wiki could quietly fail to regenerate after the
// fragment was already accepted/rejected. The fix emits an audit row with
// event_type=regen_enqueue_failed so the failure is observable downstream.

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

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'test-user')
    await next()
  }),
}))

// MCP handlers pull a lot of agent imports we don't need here — stub.
vi.mock('../mcp/handlers.js', () => ({
  handleLogFragment: vi.fn(),
}))

// Stub the slug + dedup helpers — none of these tests exercise log-fragment.
vi.mock('../db/slug.js', () => ({ resolveFragmentSlug: vi.fn() }))
vi.mock('../db/dedup.js', () => ({
  computeContentHash: vi.fn(),
  findDuplicateFragment: vi.fn(),
}))
vi.mock('../lib/fragmentTitlePrefix.js', () => ({
  applyFragmentTitleDatePrefix: vi.fn(),
}))

// ── DB mock ────────────────────────────────────────────────────────────────
// Test scaffolding stages [fragment, wiki, edge] for the accept/reject flow.
// update().set().where() resolves to undefined (no return needed).

const dbResponseQueue: unknown[][] = []

function stageDbResponses(responses: unknown[][]) {
  dbResponseQueue.length = 0
  dbResponseQueue.push(...responses)
}

function popResponse(): unknown[] {
  return dbResponseQueue.shift() ?? []
}

vi.mock('../db/client.js', () => {
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(popResponse()),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  }
  return { db: fakeDb }
})

vi.mock('../db/schema.js', () => ({
  fragments: { lookupKey: 'fragments.lookupKey', deletedAt: 'fragments.deletedAt' },
  entries: {},
  edges: {
    id: 'edges.id',
    srcId: 'edges.srcId',
    dstId: 'edges.dstId',
    edgeType: 'edges.edgeType',
    deletedAt: 'edges.deletedAt',
  },
  wikis: { lookupKey: 'wikis.lookupKey' },
  people: {},
}))

// ── Import under test (after mocks) ────────────────────────────────────────

const { fragmentsRoutes } = await import('./fragments.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function post(path: string, body: unknown) {
  return fragmentsRoutes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function reviewWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki-1',
    name: 'Review Wiki',
    bouncerMode: 'review',
    ...overrides,
  }
}

function reviewFragment(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'frag-1',
    title: 't',
    slug: 's',
    ...overrides,
  }
}

function fragWikiEdge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'edge-1',
    srcId: 'frag-1',
    dstId: 'wiki-1',
    edgeType: 'FRAGMENT_IN_WIKI',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /fragments/:id/accept — regen enqueue failure (#271)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
  })

  it('emits a regen_enqueue_failed audit row when producer.enqueueRegen rejects', async () => {
    stageDbResponses([
      [reviewFragment()],   // fragment lookup
      [reviewWiki()],       // wiki lookup
      [fragWikiEdge()],     // FRAGMENT_IN_WIKI edge lookup
    ])
    // Also need a response for the audit-emit "accepted" event's update lookup,
    // but our mock resolves all .where() identically. The `accepted` audit emit
    // path goes through the mocked emitAuditEvent so no extra DB stage needed.
    mockEnqueueRegen.mockRejectedValueOnce(new Error('redis down'))

    const res = await post('/frag-1/accept', { wikiId: 'wiki-1' })

    expect(res.status).toBe(200)
    // Two audit emits: 'accepted' + 'regen_enqueue_failed'.
    const calls = mockEmitAuditEvent.mock.calls
    const failedCall = calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'regen_enqueue_failed',
    )
    expect(failedCall).toBeDefined()
    const params = failedCall![1] as {
      entityType: string
      entityId: string
      eventType: string
      detail?: Record<string, unknown>
    }
    expect(params.entityType).toBe('wiki')
    expect(params.entityId).toBe('wiki-1')
    expect(params.eventType).toBe('regen_enqueue_failed')
    expect(params.detail).toMatchObject({
      error: 'redis down',
      reason: 'acceptance',
      fragmentKey: 'frag-1',
    })
  })

  it('does NOT emit regen_enqueue_failed when enqueue succeeds', async () => {
    stageDbResponses([
      [reviewFragment()],
      [reviewWiki()],
      [fragWikiEdge()],
    ])
    mockEnqueueRegen.mockResolvedValueOnce(undefined)

    const res = await post('/frag-1/accept', { wikiId: 'wiki-1' })

    expect(res.status).toBe(200)
    const calls = mockEmitAuditEvent.mock.calls
    const failedCall = calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'regen_enqueue_failed',
    )
    expect(failedCall).toBeUndefined()
  })
})

describe('POST /fragments/:id/reject — regen enqueue failure (#272)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbResponseQueue.length = 0
  })

  it('emits a regen_enqueue_failed audit row tagged reason=rejection when enqueue rejects', async () => {
    stageDbResponses([
      [reviewFragment()],
      [reviewWiki()],
      [fragWikiEdge()],
    ])
    mockEnqueueRegen.mockRejectedValueOnce(new Error('redis down'))

    const res = await post('/frag-1/reject', { wikiId: 'wiki-1' })

    expect(res.status).toBe(200)
    const calls = mockEmitAuditEvent.mock.calls
    const failedCall = calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'regen_enqueue_failed',
    )
    expect(failedCall).toBeDefined()
    const params = failedCall![1] as {
      entityType: string
      entityId: string
      eventType: string
      detail?: Record<string, unknown>
    }
    expect(params.entityType).toBe('wiki')
    expect(params.entityId).toBe('wiki-1')
    expect(params.eventType).toBe('regen_enqueue_failed')
    // The 'reason' tag distinguishes #272 from #271 in the audit timeline.
    expect(params.detail).toMatchObject({
      error: 'redis down',
      reason: 'rejection',
      fragmentKey: 'frag-1',
    })
  })
})
