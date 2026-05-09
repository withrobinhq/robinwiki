import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// Covers the publish/unpublish slug-rotation flow (#audit-M2). The unpublish
// handler must null `publishedSlug` so the next publish mints a fresh slug;
// `publishedAt` must be preserved.

const mockDbSelect = vi.fn()
const mockDbUpdate = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}))

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookup_key',
    slug: 'wikis.slug',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    state: 'wikis.state',
    publishedSlug: 'wikis.published_slug',
    publishedAt: 'wikis.published_at',
    published: 'wikis.published',
    updatedAt: 'wikis.updated_at',
  },
  entries: {},
  edges: {},
  wikiTypes: {},
  fragments: {},
  people: {},
  auditLog: {},
  edits: {},
  groupWikis: {},
  groups: {},
}))

// db/locks.ts pulls drizzle tables at module load — stub to avoid
// running the real CasLock constructor against the test schema mocks.
vi.mock('../db/locks.js', () => ({
  wikiRegenLock: { using: vi.fn() },
  entryLock: { using: vi.fn() },
  fragmentLock: { using: vi.fn() },
}))

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
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../queue/producer.js', () => ({
  producer: { enqueueRegen: vi.fn() },
}))

vi.mock('../mcp/wiki-type-inference.js', () => ({
  inferWikiType: vi.fn().mockReturnValue('log'),
}))

const { wikisRoutes } = await import('./wikis.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

const fixedNow = new Date('2026-04-20T12:00:00Z')

function makeWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki01TEST',
    slug: 'engineering-log',
    name: 'Engineering Log',
    type: 'log',
    prompt: '',
    state: 'RESOLVED',
    description: '',
    structure: '',
    content: 'some published content',
    published: false,
    publishedSlug: null,
    publishedAt: null,
    autoregen: true,
    dirtySince: null,
    bouncerMode: 'auto',
    lastRebuiltAt: null,
    embedding: null,
    embeddingAttemptCount: 0,
    embeddingLastAttemptAt: null,
    progress: null,
    metadata: null,
    citationDeclarations: [],
    deletedAt: null,
    dedupHash: null,
    lockedBy: null,
    lockedAt: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    searchVector: null,
    ...overrides,
  }
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(rows)
  return chain
}

function updateChainMock(returning: unknown[]) {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returning)
  return chain
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /wikis/:id/publish — slug minting (#audit-M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mints a fresh 24-char slug when publishedSlug is null', async () => {
    const wiki = makeWiki({ publishedSlug: null, publishedAt: null })
    mockDbSelect.mockReturnValueOnce(selectChainMock([wiki]))

    const updateChain = updateChainMock([
      makeWiki({ published: true, publishedSlug: 'PLACEHOLDER', publishedAt: fixedNow }),
    ])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/publish', { method: 'POST' })
    expect(res.status).toBe(200)

    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>
    expect(setArg.published).toBe(true)
    expect(typeof setArg.publishedSlug).toBe('string')
    expect((setArg.publishedSlug as string).length).toBe(24)
  })

  it('reuses existing publishedSlug when present (idempotent re-publish)', async () => {
    const existingSlug = 'abcdefghijklmnopqrstuvwx'
    const wiki = makeWiki({ publishedSlug: existingSlug, publishedAt: fixedNow })
    mockDbSelect.mockReturnValueOnce(selectChainMock([wiki]))

    const updateChain = updateChainMock([
      makeWiki({ published: true, publishedSlug: existingSlug, publishedAt: fixedNow }),
    ])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/publish', { method: 'POST' })
    expect(res.status).toBe(200)

    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>
    expect(setArg.publishedSlug).toBe(existingSlug)
  })
})

describe('POST /wikis/:id/unpublish — slug rotation (#audit-M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('nulls publishedSlug AND preserves publishedAt', async () => {
    const wiki = makeWiki({
      published: true,
      publishedSlug: 'abcdefghijklmnopqrstuvwx',
      publishedAt: fixedNow,
    })
    mockDbSelect.mockReturnValueOnce(selectChainMock([wiki]))

    const updateChain = updateChainMock([
      makeWiki({ published: false, publishedSlug: null, publishedAt: fixedNow }),
    ])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/unpublish', { method: 'POST' })
    expect(res.status).toBe(200)

    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>
    expect(setArg.published).toBe(false)
    expect(setArg.publishedSlug).toBeNull()
    // publishedAt MUST NOT be in the SET clause — it stays as-is in the row.
    expect('publishedAt' in setArg).toBe(false)
  })
})

describe('publish → unpublish → publish round-trip mints a NEW slug', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('second publish (after unpublish nulled the slug) generates a different slug', async () => {
    // First publish: starts with publishedSlug=null, mints slug A.
    const initialWiki = makeWiki({ publishedSlug: null, publishedAt: null })
    mockDbSelect.mockReturnValueOnce(selectChainMock([initialWiki]))
    const firstUpdateChain = updateChainMock([
      makeWiki({ published: true, publishedSlug: 'first-slug-recorded', publishedAt: fixedNow }),
    ])
    mockDbUpdate.mockReturnValueOnce(firstUpdateChain)

    const app = createApp()
    await app.request('/wikis/wiki01TEST/publish', { method: 'POST' })
    const slugA = firstUpdateChain.set.mock.calls[0][0].publishedSlug as string

    // Unpublish: nulls publishedSlug.
    const publishedWiki = makeWiki({
      published: true,
      publishedSlug: slugA,
      publishedAt: fixedNow,
    })
    mockDbSelect.mockReturnValueOnce(selectChainMock([publishedWiki]))
    const unpublishUpdateChain = updateChainMock([
      makeWiki({ published: false, publishedSlug: null, publishedAt: fixedNow }),
    ])
    mockDbUpdate.mockReturnValueOnce(unpublishUpdateChain)
    await app.request('/wikis/wiki01TEST/unpublish', { method: 'POST' })
    expect(unpublishUpdateChain.set.mock.calls[0][0].publishedSlug).toBeNull()

    // Second publish: row now has publishedSlug=null again. Mint slug B.
    const reUnpublishedWiki = makeWiki({
      published: false,
      publishedSlug: null,
      publishedAt: fixedNow,
    })
    mockDbSelect.mockReturnValueOnce(selectChainMock([reUnpublishedWiki]))
    const secondPublishChain = updateChainMock([
      makeWiki({ published: true, publishedSlug: 'second-slug-recorded', publishedAt: fixedNow }),
    ])
    mockDbUpdate.mockReturnValueOnce(secondPublishChain)
    await app.request('/wikis/wiki01TEST/publish', { method: 'POST' })
    const slugB = secondPublishChain.set.mock.calls[0][0].publishedSlug as string

    expect(slugA).not.toBe(slugB)
    expect(typeof slugA).toBe('string')
    expect(typeof slugB).toBe('string')
    expect(slugA.length).toBe(24)
    expect(slugB.length).toBe(24)

    // Round-trip: the second publish preserves publishedAt from the original row.
    const secondPublishSetArg = secondPublishChain.set.mock.calls[0][0] as Record<string, unknown>
    expect(secondPublishSetArg.publishedAt).toEqual(fixedNow)
  })
})
