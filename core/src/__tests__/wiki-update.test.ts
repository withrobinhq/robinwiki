import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks ────────────────────────────────────────────────────────────────

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
    userId: 'wikis.user_id',
    slug: 'wikis.slug',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    state: 'wikis.state',
    repoPath: 'wikis.repo_path',
    vaultId: 'wikis.vault_id',
    lastRebuiltAt: 'wikis.last_rebuilt_at',
    createdAt: 'wikis.created_at',
    updatedAt: 'wikis.updated_at',
  },
  // db/locks.js + other transitive wikis.ts imports need these at module load.
  entries: {
    lookupKey: 'entries.lookup_key',
    state: 'entries.state',
    lockedBy: 'entries.locked_by',
    lockedAt: 'entries.locked_at',
  },
  fragments: {
    lookupKey: 'fragments.lookup_key',
    state: 'fragments.state',
    lockedBy: 'fragments.locked_by',
    lockedAt: 'fragments.locked_at',
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
    prompt: 'wiki_types.prompt',
    userModified: 'wiki_types.user_modified',
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
  groupWikis: {
    wikiId: 'group_wikis.wiki_id',
    groupId: 'group_wikis.group_id',
  },
  groups: {
    id: 'groups.id',
    name: 'groups.name',
  },
}))

vi.mock('../queue/producer.js', () => ({
  producer: { enqueueRegenJob: vi.fn() },
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
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

import { wikisRoutes } from '../routes/wikis.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

const now = new Date()

function makeWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'thread01TEST',
    userId: 'test-user-123',
    slug: 'engineering-log',
    name: 'Engineering Log',
    type: 'log',
    prompt: 'Summarize engineering work',
    state: 'RESOLVED',
    repoPath: 'wikis/20260323-engineering-log.thread01TEST.md',
    vaultId: 'vault-1',
    lastRebuiltAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
  chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve)
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  return chain
}

function updateChainMock(returning: unknown[]) {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returning)
  return chain
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PUT /wikis/:id — DB update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('syncs name change to DB', async () => {
    const existing = makeWiki()
    const updated = makeWiki({ name: 'New Name', slug: 'new-name', updatedAt: new Date() })

    // First select: wiki lookup. Subsequent selects: slug collision check → empty = no collision.
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    mockDbSelect.mockReturnValue(selectChainMock([]))
    mockDbUpdate.mockReturnValue(updateChainMock([updated]))

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })

    expect(res.status).toBe(200)
    expect(mockDbUpdate).toHaveBeenCalled()
  })

  it('marks wiki PENDING when prompt changes', async () => {
    const existing = makeWiki()
    const updated = makeWiki({ prompt: 'new prompt', state: 'PENDING', updatedAt: new Date() })

    mockDbSelect.mockReturnValue(selectChainMock([existing]))
    const updateChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValue(updateChain)

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'new prompt' }),
    })

    expect(res.status).toBe(200)
    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.state).toBe('PENDING')
  })

  it('does NOT change state when only name changes', async () => {
    const existing = makeWiki()
    const updated = makeWiki({ name: 'Renamed', slug: 'renamed', updatedAt: new Date() })

    // First select: wiki lookup. Subsequent: slug collision check → no collision.
    mockDbSelect.mockReturnValueOnce(selectChainMock([existing]))
    mockDbSelect.mockReturnValue(selectChainMock([]))
    const updateChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValue(updateChain)

    const app = createApp()
    await app.request('/wikis/thread01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })

    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.state).toBeUndefined()
  })
})
