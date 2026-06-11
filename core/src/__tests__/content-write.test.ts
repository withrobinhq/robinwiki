import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks ────────────────────────────────────────────────────────────────

const mockDbSelect = vi.fn()
const mockDbUpdate = vi.fn()
const mockDbInsert = vi.fn()
const mockDbExecute = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
}))

vi.mock('../db/schema.js', () => ({
  entries: {
    lookupKey: 'entries.lookup_key',
    repoPath: 'entries.repo_path',
    userId: 'entries.user_id',
    deletedAt: 'entries.deleted_at',
    title: 'entries.title',
  },
  fragments: {
    lookupKey: 'fragments.lookup_key',
    repoPath: 'fragments.repo_path',
    userId: 'fragments.user_id',
    deletedAt: 'fragments.deleted_at',
    title: 'fragments.title',
    tags: 'fragments.tags',
  },
  wikis: {
    lookupKey: 'wikis.lookup_key',
    repoPath: 'wikis.repo_path',
    userId: 'wikis.user_id',
    deletedAt: 'wikis.deleted_at',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    content: 'wikis.content',
  },
  people: {
    lookupKey: 'people.lookup_key',
    repoPath: 'people.repo_path',
    userId: 'people.user_id',
    deletedAt: 'people.deleted_at',
    name: 'people.name',
    relationship: 'people.relationship',
  },
  edges: {
    srcType: 'edges.src_type',
    srcId: 'edges.src_id',
    dstType: 'edges.dst_type',
    dstId: 'edges.dst_id',
    edgeType: 'edges.edge_type',
    deletedAt: 'edges.deleted_at',
  },
  edits: {
    id: 'thread_edits.id',
    threadId: 'thread_edits.thread_id',
    userId: 'thread_edits.user_id',
    type: 'thread_edits.type',
    content: 'thread_edits.content',
    objectType: 'edits.object_type',
    objectId: 'edits.object_id',
  },
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('userId', 'test-user-123')
    await next()
  }),
}))

vi.mock('../lib/wiki-lookup.js', () => ({
  createWikiLookupFn: () => async () => null,
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

vi.mock('../lib/id.js', () => ({
  nanoid: () => 'mock-nanoid',
}))

import { contentRoutes } from '../routes/content.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/api/content', contentRoutes)
  return app
}

function chainMock(finalValue: unknown) {
  const chain: Record<string, any> = {}
  // Make the chain itself thenable so callers that await it directly
  // (e.g. the innerJoin path that ends with .where()) get finalValue,
  // while callers that chain .limit() afterwards still resolve correctly.
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(finalValue).then(resolve)
  chain.from = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(finalValue)
  chain.set = vi.fn().mockReturnValue(chain)
  return chain
}

function updateChainMock() {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(undefined)
  return chain
}

function insertChainMock() {
  const chain: Record<string, any> = {}
  chain.values = vi.fn().mockResolvedValue(undefined)
  return chain
}

describe('Content Write API (EDIT-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setupDb(type = 'wiki') {
    const selectChain = chainMock([
      { lookupKey: 'key-123', deletedAt: null, content: 'existing content' },
    ])
    mockDbSelect.mockReturnValue(selectChain)
    const uChain = updateChainMock()
    mockDbUpdate.mockReturnValue(uChain)
    const iChain = insertChainMock()
    mockDbInsert.mockReturnValue(iChain)
    mockDbExecute.mockResolvedValue(undefined)
    return { selectChain, uChain, iChain }
  }

  describe('PUT /api/content/:type/:key', () => {
    it('returns 400 for invalid content type', async () => {
      const app = createApp()
      const res = await app.request('/api/content/invalid/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter: { name: 'test' }, body: 'body' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 when object does not exist', async () => {
      const selectChain = chainMock([])
      mockDbSelect.mockReturnValue(selectChain)
      const app = createApp()
      const res = await app.request('/api/content/wiki/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter: { name: 'test' }, body: 'body' }),
      })
      expect(res.status).toBe(404)
    })

    it('validates frontmatter with type-specific Zod schema', async () => {
      setupDb()
      const app = createApp()
      const res = await app.request('/api/content/wiki/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frontmatter: { name: 'Updated Wiki' },
          body: 'New body',
        }),
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.ok).toBe(true)
    })

    it('returns field-level validation errors on failure', async () => {
      setupDb()
      const app = createApp()
      const res = await app.request('/api/content/wiki/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter: {}, body: 'body' }),
      })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Validation failed')
      expect(json.fields).toBeDefined()
    })

    it('updates DB row after successful write', async () => {
      setupDb()
      const app = createApp()
      await app.request('/api/content/wiki/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frontmatter: { name: 'Updated' },
          body: 'body',
        }),
      })
      expect(mockDbUpdate).toHaveBeenCalled()
    })

    it('returns { ok: true } on success', async () => {
      setupDb()
      const app = createApp()
      const res = await app.request('/api/content/wiki/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter: { name: 'Test' }, body: 'body' }),
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.ok).toBe(true)
    })

    it('requires authenticated session', async () => {
      setupDb()
      const app = createApp()
      const res = await app.request('/api/content/wiki/key-123', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter: { name: 'Test' }, body: 'body' }),
      })
      expect(res.status).toBe(200)
    })
  })
})
