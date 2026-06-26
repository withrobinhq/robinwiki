import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// Covers #69 D6 follow-up + Stream S decouple: POST /wikis seeds the
// description agent_schema row at create time via ensureAgentSchema with
// mode='create', and PUT /wikis/:id refreshes it via mode='refresh' with
// alsoStaleHyde=true when the description changes. Both happen on the
// request path, so the assertions are on the helper invocation and the
// option shape rather than DB chains.

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

// Stub ensureAgentSchema so the route's calls are observable without a
// real DB. Tests assert on the (db, wikiKey, options) invocation shape.
const ensureMock = vi.fn().mockResolvedValue({
  wikiKey: 'wiki01TEST',
  mode: 'create',
  written: { description: true, hyde_synthetic: false },
  staled: { hyde_synthetic: false },
  shortCircuited: false,
})
vi.mock('../lib/wiki-agent-schema.js', () => ({
  ensureAgentSchema: (...args: unknown[]) => ensureMock(...args),
}))

vi.mock('../lib/backfill-runner.js', () => ({
  loadAgentSchemaStatusByWiki: vi.fn().mockResolvedValue(new Map()),
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
  // biome-ignore lint/suspicious/noThenProperty: thenable test mock
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

describe('POST /wikis — agent_schema description bootstrap (#69 D6, Stream S)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embedTextMock.mockReset()
    ensureMock.mockReset().mockResolvedValue({
      wikiKey: 'wiki01TEST',
      mode: 'create',
      written: { description: true, hyde_synthetic: false },
      staled: { hyde_synthetic: false },
      shortCircuited: false,
    })
  })

  it("invokes ensureAgentSchema with mode='create' and the precomputed embedding", async () => {
    const created = makeWiki({ name: 'New Wiki', description: 'a fresh description' })
    mockDbInsert.mockReturnValueOnce(insertChainMock([created]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([created]))
    embedTextMock.mockResolvedValueOnce([0.1, 0.2, 0.3])
    mockDbSelect.mockReturnValueOnce(selectChainMock([]))

    const app = createApp()
    const res = await app.request('/wikis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Wiki', description: 'a fresh description' }),
    })
    expect(res.status).toBe(201)

    expect(ensureMock).toHaveBeenCalledTimes(1)
    const [, wikiKeyArg, optionsArg] = ensureMock.mock.calls[0]
    expect(typeof wikiKeyArg).toBe('string')
    expect(optionsArg.mode).toBe('create')
    expect(optionsArg.description).toBe('a fresh description')
    expect(optionsArg.precomputedEmbedding).toEqual([0.1, 0.2, 0.3])
    expect(optionsArg.context.source).toBe('api')
  })

  it('does not blow up the create when the helper throws', async () => {
    const created = makeWiki()
    mockDbInsert.mockReturnValueOnce(insertChainMock([created]))
    mockDbUpdate.mockReturnValueOnce(updateChainMock([created]))
    embedTextMock.mockResolvedValueOnce([0.1, 0.2, 0.3])
    mockDbSelect.mockReturnValueOnce(selectChainMock([]))
    ensureMock.mockRejectedValueOnce(new Error('db down'))

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
    expect(ensureMock).not.toHaveBeenCalled()
  })
})

// ── PUT /wikis/:id ─────────────────────────────────────────────────────────

describe('PUT /wikis/:id — agent_schema refresh on description change (#69 D6, Stream S)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embedTextMock.mockReset()
    ensureMock.mockReset().mockResolvedValue({
      wikiKey: 'wiki01TEST',
      mode: 'refresh',
      written: { description: true, hyde_synthetic: false },
      staled: { hyde_synthetic: true },
      shortCircuited: false,
    })
  })

  it("invokes ensureAgentSchema with mode='refresh' and alsoStaleHyde=true", async () => {
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

    expect(ensureMock).toHaveBeenCalledTimes(1)
    const [, wikiKeyArg, optionsArg] = ensureMock.mock.calls[0]
    expect(wikiKeyArg).toBe('wiki01TEST')
    expect(optionsArg.mode).toBe('refresh')
    expect(optionsArg.description).toBe('fresh new description')
    expect(optionsArg.precomputedEmbedding).toEqual([0.9, 0.9, 0.9])
    expect(optionsArg.alsoStaleHyde).toBe(true)
    expect(optionsArg.context.source).toBe('api')
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
    expect(ensureMock).not.toHaveBeenCalled()
  })

  it('still routes through ensureAgentSchema when the new description is empty', async () => {
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
    expect(ensureMock).toHaveBeenCalledTimes(1)
    const [, , optionsArg] = ensureMock.mock.calls[0]
    expect(optionsArg.mode).toBe('refresh')
    expect(optionsArg.description).toBe('')
    expect(optionsArg.alsoStaleHyde).toBe(true)
  })
})

// ── PUT /wikis/:id — type/prompt/structure changes reset lastRebuiltAt ─────
//
// A type/prompt/structure change marks the wiki PENDING so the next regen
// rebuilds it. Without also clearing lastRebuiltAt, that regen would still
// take the cached-partition path (regen.ts) and short-circuit on an empty
// diff, leaving the old type's content in place. Clearing lastRebuiltAt
// routes the next regen through the first-regen full-synthesis path instead.
// dirtySince is stamped alongside it so editorialStateOf reads 'learning'
// (new content awaiting regen) rather than 'empty' (never regenned) while
// the old content is still on display.

describe('PUT /wikis/:id — type/prompt/structure changes reset lastRebuiltAt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks PENDING and clears lastRebuiltAt when type changes', async () => {
    const existing = makeWiki({ type: 'decision', lastRebuiltAt: new Date() })
    const updated = makeWiki({ type: 'log', state: 'PENDING', lastRebuiltAt: null })
    mockDbSelect
      .mockReturnValueOnce(selectChainMock([existing]))
      .mockReturnValueOnce(selectChainMock([{ slug: 'log' }]))
    const updateChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'log' }),
    })

    expect(res.status).toBe(200)
    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.type).toBe('log')
    expect(setArg.state).toBe('PENDING')
    expect(setArg.lastRebuiltAt).toBeNull()
    expect(setArg.dirtySince).toBeInstanceOf(Date)
  })

  it('marks PENDING and clears lastRebuiltAt when prompt changes', async () => {
    const existing = makeWiki({ prompt: 'old prompt', lastRebuiltAt: new Date() })
    const updated = makeWiki({ prompt: 'new prompt', state: 'PENDING', lastRebuiltAt: null })
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    const updateChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'new prompt' }),
    })

    expect(res.status).toBe(200)
    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.state).toBe('PENDING')
    expect(setArg.lastRebuiltAt).toBeNull()
    expect(setArg.dirtySince).toBeInstanceOf(Date)
  })

  it('marks PENDING and clears lastRebuiltAt when structure changes', async () => {
    const existing = makeWiki({ structure: 'old skeleton', lastRebuiltAt: new Date() })
    const updated = makeWiki({ structure: 'new skeleton', state: 'PENDING', lastRebuiltAt: null })
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    const updateChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structure: 'new skeleton' }),
    })

    expect(res.status).toBe(200)
    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.state).toBe('PENDING')
    expect(setArg.lastRebuiltAt).toBeNull()
    expect(setArg.dirtySince).toBeInstanceOf(Date)
  })

  it('does not touch state, lastRebuiltAt, or dirtySince when type is set to its current value', async () => {
    const existing = makeWiki({ type: 'log', lastRebuiltAt: new Date() })
    const updated = makeWiki({ type: 'log' })
    mockDbSelect
      .mockReturnValueOnce(selectChainMock([existing]))
      .mockReturnValueOnce(selectChainMock([{ slug: 'log' }]))
    const updateChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValueOnce(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'log' }),
    })

    expect(res.status).toBe(200)
    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.state).toBeUndefined()
    expect(setArg.lastRebuiltAt).toBeUndefined()
    expect(setArg.dirtySince).toBeUndefined()
  })
})
