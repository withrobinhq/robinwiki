import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// Covers #69 D6 follow-up: POST /wikis seeds the description agent_schema
// row at create time, and PUT /wikis/:id refreshes it (and deletes the
// hyde row) when the description changes. Both happen on the request path,
// so the assertions are on the helper calls rather than DB chains.

const mockDbSelect = vi.fn()
const mockDbUpdate = vi.fn()
const mockDbInsert = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookup_key',
    slug: 'wikis.slug',
    name: 'wikis.name',
    description: 'wikis.description',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    state: 'wikis.state',
    embedding: 'wikis.embedding',
    updatedAt: 'wikis.updated_at',
    deletedAt: 'wikis.deleted_at',
  },
  entries: {},
  edges: {},
  wikiTypes: { slug: 'wiki_types.slug' },
  fragments: {},
  people: {},
  auditLog: {},
  edits: {},
  groupWikis: {},
  groups: {},
}))

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

const embedTextMock = vi.fn()
vi.mock('@robin/agent', () => ({
  embedText: (...args: unknown[]) => embedTextMock(...args),
  NoOpenRouterKeyError: class NoOpenRouterKeyError extends Error {},
}))

vi.mock('../lib/openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn().mockResolvedValue({
    apiKey: 'k',
    models: {
      extraction: 'x',
      classification: 'y',
      wikiGeneration: 'z',
      embedding: 'e',
    },
  }),
}))

// The two helpers we want to assert against. Stub them so the routes' calls
// are observable without a real DB.
const upsertDescMock = vi.fn().mockResolvedValue(undefined)
const deleteHydeMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../lib/wiki-agent-schema.js', () => ({
  upsertDescriptionAgentSchemaRow: (...args: unknown[]) => upsertDescMock(...args),
  deleteHydeAgentSchemaRow: (...args: unknown[]) => deleteHydeMock(...args),
}))

vi.mock('../db/slug.js', () => ({
  resolveWikiSlug: vi.fn().mockImplementation((_db: unknown, slug: string) => slug),
}))

vi.mock('../lib/regen.js', () => ({
  regenerateWiki: vi.fn(),
}))

vi.mock('../lib/wikiSidecar.js', () => ({
  buildSidecar: vi.fn().mockResolvedValue({ refs: [], infobox: null, sections: [] }),
}))
vi.mock('../lib/wikiSidecarDeps.js', () => ({
  makeSidecarDeps: vi.fn(),
}))
vi.mock('../lib/strip-wiki-content.js', () => ({
  stripWikiContent: vi.fn().mockReturnValue(''),
}))

const { wikisRoutes } = await import('./wikis.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  // Also satisfy await without limit() for the bare select().from().where()
  chain.then = (resolve: (v: unknown) => void) => resolve(rows)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  return chain
}

function updateChainMock(returning: unknown[]) {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returning)
  return chain
}

function insertChainMock(returning: unknown[]) {
  const chain: Record<string, any> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returning)
  chain.onConflictDoNothing = vi.fn().mockReturnValue(chain)
  return chain
}

function makeWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki01TEST',
    slug: 'engineering-log',
    name: 'Engineering Log',
    type: 'log',
    prompt: '',
    state: 'PENDING',
    description: 'original description text',
    structure: '',
    content: '',
    published: false,
    publishedSlug: null,
    publishedAt: null,
    regenerate: true,
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
    createdAt: new Date(),
    updatedAt: new Date(),
    searchVector: null,
    ...overrides,
  }
}

// ── POST /wikis ────────────────────────────────────────────────────────────

describe('POST /wikis — agent_schema description bootstrap (#69 D6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embedTextMock.mockReset()
    upsertDescMock.mockReset().mockResolvedValue(undefined)
    deleteHydeMock.mockReset().mockResolvedValue(undefined)
  })

  it('seeds kind=description row using the wikiVec from the legacy embed step', async () => {
    const created = makeWiki({ name: 'New Wiki', description: 'a fresh description' })
    mockDbInsert.mockReturnValueOnce(insertChainMock([created]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([created]))
    embedTextMock.mockResolvedValueOnce([0.1, 0.2, 0.3])

    // After the legacy update, the candidate-fragments select is called.
    // Return empty so no fragment-attach path runs.
    mockDbSelect.mockReturnValueOnce(selectChainMock([]))

    const app = createApp()
    const res = await app.request('/wikis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Wiki', description: 'a fresh description' }),
    })
    expect(res.status).toBe(201)

    expect(upsertDescMock).toHaveBeenCalledTimes(1)
    const [, wikiKeyArg, descArg, vecArg] = upsertDescMock.mock.calls[0]
    expect(typeof wikiKeyArg).toBe('string')
    expect(descArg).toBe('a fresh description')
    expect(vecArg).toEqual([0.1, 0.2, 0.3])
  })

  it('does not blow up the create when the helper throws', async () => {
    const created = makeWiki()
    mockDbInsert.mockReturnValueOnce(insertChainMock([created]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([created]))
    embedTextMock.mockResolvedValueOnce([0.1, 0.2, 0.3])
    mockDbSelect.mockReturnValueOnce(selectChainMock([]))
    upsertDescMock.mockRejectedValueOnce(new Error('db down'))

    const app = createApp()
    const res = await app.request('/wikis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Wiki', description: 'd' }),
    })
    expect(res.status).toBe(201)
  })

  it('skips the description seed when embedText returns null', async () => {
    const created = makeWiki()
    mockDbInsert.mockReturnValueOnce(insertChainMock([created]))
    embedTextMock.mockResolvedValueOnce(null)

    const app = createApp()
    const res = await app.request('/wikis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Wiki', description: 'd' }),
    })
    expect(res.status).toBe(201)
    expect(upsertDescMock).not.toHaveBeenCalled()
  })
})

// ── PUT /wikis/:id ─────────────────────────────────────────────────────────

describe('PUT /wikis/:id — agent_schema refresh on description change (#69 D6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embedTextMock.mockReset()
    upsertDescMock.mockReset().mockResolvedValue(undefined)
    deleteHydeMock.mockReset().mockResolvedValue(undefined)
  })

  it('upserts kind=description with the new embedding and deletes the hyde row', async () => {
    const existing = makeWiki({ description: 'old description' })
    const updated = makeWiki({ description: 'fresh new description' })
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([updated]))
    embedTextMock.mockResolvedValueOnce([0.9, 0.9, 0.9])

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'fresh new description' }),
    })
    expect(res.status).toBe(200)

    expect(upsertDescMock).toHaveBeenCalledTimes(1)
    const [, wikiKeyArg, descArg, vecArg] = upsertDescMock.mock.calls[0]
    expect(wikiKeyArg).toBe('wiki01TEST')
    expect(descArg).toBe('fresh new description')
    expect(vecArg).toEqual([0.9, 0.9, 0.9])

    expect(deleteHydeMock).toHaveBeenCalledTimes(1)
    expect(deleteHydeMock.mock.calls[0][1]).toBe('wiki01TEST')
  })

  it('skips the refresh when description is unchanged', async () => {
    const existing = makeWiki({ description: 'same' })
    const updated = makeWiki({ description: 'same' })
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([updated]))

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Only' }),
    })
    expect(res.status).toBe(200)
    expect(upsertDescMock).not.toHaveBeenCalled()
    expect(deleteHydeMock).not.toHaveBeenCalled()
  })

  it('still deletes the hyde row even when the new description is empty', async () => {
    const existing = makeWiki({ description: 'something' })
    const updated = makeWiki({ description: '' })
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([updated]))

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '' }),
    })
    expect(res.status).toBe(200)
    expect(upsertDescMock).not.toHaveBeenCalled()
    expect(deleteHydeMock).toHaveBeenCalledTimes(1)
  })
})
