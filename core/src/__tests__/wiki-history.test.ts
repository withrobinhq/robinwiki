import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

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
  wikis: {
    lookupKey: 'wikis.lookup_key',
    slug: 'wikis.slug',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    state: 'wikis.state',
    content: 'wikis.content',
    deletedAt: 'wikis.deleted_at',
    updatedAt: 'wikis.updated_at',
    vaultId: 'wikis.vault_id',
  },
  edges: {
    id: 'edges.id',
    srcType: 'edges.src_type',
    srcId: 'edges.src_id',
    dstType: 'edges.dst_type',
    dstId: 'edges.dst_id',
    edgeType: 'edges.edge_type',
    deletedAt: 'edges.deleted_at',
  },
  wikiTypes: {
    slug: 'wiki_types.slug',
    shortDescriptor: 'wiki_types.short_descriptor',
    descriptor: 'wiki_types.descriptor',
  },
  fragments: {
    lookupKey: 'fragments.lookup_key',
    slug: 'fragments.slug',
    title: 'fragments.title',
    content: 'fragments.content',
    state: 'fragments.state',
    lockedBy: 'fragments.locked_by',
    lockedAt: 'fragments.locked_at',
  },
  people: {
    lookupKey: 'people.lookup_key',
    name: 'people.name',
  },
  auditLog: {
    entityId: 'audit_log.entity_id',
    createdAt: 'audit_log.created_at',
  },
  edits: {
    id: 'edits.id',
    objectType: 'edits.object_type',
    objectId: 'edits.object_id',
    timestamp: 'edits.timestamp',
    type: 'edits.type',
    content: 'edits.content',
    source: 'edits.source',
    diff: 'edits.diff',
  },
  // db/locks.js imports these at module load — required for vitest to collect.
  entries: {
    lookupKey: 'entries.lookup_key',
    state: 'entries.state',
    lockedBy: 'entries.locked_by',
    lockedAt: 'entries.locked_at',
  },
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('userId', 'test-user-123')
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
  emitAuditEvent: vi.fn(),
}))

vi.mock('../db/slug.js', () => ({
  resolveWikiSlug: vi.fn(async (_db: any, slug: string) => slug),
}))

vi.mock('@robin/shared', () => ({
  generateSlug: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  makeLookupKey: (prefix: string) => `${prefix}-test-key`,
  // openrouter-config.js (imported transitively via wikis.ts) reads these at
  // module load — required for vitest to collect (f500031).
  DEFAULT_MODEL: 'anthropic/claude-sonnet-4.6',
  FRAGMENT_MODEL: 'google/gemini-2.5-pro',
  FAST_MODEL: 'google/gemini-flash-2.5',
}))

vi.mock('@robin/agent', () => ({
  NoOpenRouterKeyError: class extends Error {},
}))

vi.mock('../lib/regen.js', () => ({
  regenerateWiki: vi.fn(),
}))

vi.mock('../lib/id.js', () => ({
  nanoid24: () => 'test-id-24',
}))

vi.mock('../lib/validation.js', () => ({
  validationHook: (_result: any, _c: any) => {},
}))

import { wikisRoutes } from '../routes/wikis.js'

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

function chainMock(finalValue: unknown) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.offset = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.groupBy = vi.fn().mockReturnValue(chain)
  // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
  chain.then = (resolve: any) => resolve(finalValue)
  return chain
}

describe('Wiki History API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 when wiki does not exist', async () => {
    mockDbSelect.mockReturnValueOnce(chainMock([]))
    const app = createApp()
    const res = await app.request('/wikis/nonexistent/history')
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Not found')
  })

  it('returns empty edits array when wiki has no edits', async () => {
    mockDbSelect.mockReturnValueOnce(chainMock([{ lookupKey: 'wiki-1' }]))
    mockDbSelect.mockReturnValueOnce(chainMock([{ count: 0 }]))
    mockDbSelect.mockReturnValueOnce(chainMock([]))
    const app = createApp()
    const res = await app.request('/wikis/wiki-1/history')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.edits).toEqual([])
    expect(json.total).toBe(0)
  })

  it('returns edit records with correct shape', async () => {
    const editRow = {
      id: 'e1',
      timestamp: new Date('2025-01-15T10:00:00Z'),
      type: 'addition',
      source: 'user',
      content: 'previous content',
      objectType: 'wiki',
      objectId: 'wiki-1',
      diff: '',
    }
    mockDbSelect.mockReturnValueOnce(chainMock([{ lookupKey: 'wiki-1' }]))
    mockDbSelect.mockReturnValueOnce(chainMock([{ count: 1 }]))
    mockDbSelect.mockReturnValueOnce(chainMock([editRow]))
    const app = createApp()
    const res = await app.request('/wikis/wiki-1/history')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.total).toBe(1)
    expect(json.edits).toHaveLength(1)
    const edit = json.edits[0]
    expect(edit.id).toBe('e1')
    expect(edit.timestamp).toBe('2025-01-15T10:00:00.000Z')
    expect(edit.type).toBe('addition')
    expect(edit.source).toBe('user')
    expect(edit.contentSnippet).toBe('previous content')
  })

  it('truncates contentSnippet to 200 characters', async () => {
    const longContent = 'a'.repeat(300)
    const editRow = {
      id: 'e2',
      timestamp: new Date('2025-01-15T10:00:00Z'),
      type: 'addition',
      source: 'user',
      content: longContent,
      objectType: 'wiki',
      objectId: 'wiki-1',
      diff: '',
    }
    mockDbSelect.mockReturnValueOnce(chainMock([{ lookupKey: 'wiki-1' }]))
    mockDbSelect.mockReturnValueOnce(chainMock([{ count: 1 }]))
    mockDbSelect.mockReturnValueOnce(chainMock([editRow]))
    const app = createApp()
    const res = await app.request('/wikis/wiki-1/history')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.edits[0].contentSnippet).toHaveLength(200)
  })

  it('respects limit and offset query params', async () => {
    mockDbSelect.mockReturnValueOnce(chainMock([{ lookupKey: 'wiki-1' }]))
    mockDbSelect.mockReturnValueOnce(chainMock([{ count: 20 }]))
    const rowsChain = chainMock([])
    mockDbSelect.mockReturnValueOnce(rowsChain)
    const app = createApp()
    const res = await app.request('/wikis/wiki-1/history?limit=10&offset=5')
    expect(res.status).toBe(200)
    expect(rowsChain.limit).toHaveBeenCalledWith(10)
    expect(rowsChain.offset).toHaveBeenCalledWith(5)
  })
})
