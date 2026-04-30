import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ─────────────────────────────────────────────────────
// The handler imports a handful of side-effectful helpers at module scope.
// Stub them so we can exercise just the explicit-type / inference branching
// without hitting a real DB or pulling postgres client side effects.

vi.mock('../db/slug.js', () => ({
  resolveWikiSlug: vi.fn(async (_db: unknown, slug: string) => slug),
  resolveEntrySlug: vi.fn(async (_db: unknown, slug: string) => slug),
}))

vi.mock('../db/dedup.js', () => ({
  computeContentHash: vi.fn(() => 'hash'),
  findDuplicateEntry: vi.fn(async () => null),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn(async () => {}),
}))

const inferWikiTypeMock = vi.fn((_desc: string) => 'log')
vi.mock('../mcp/wiki-type-inference.js', () => ({
  inferWikiType: (desc: string) => inferWikiTypeMock(desc),
}))

vi.mock('@robin/agent', () => ({
  resolvePerson: vi.fn(),
  DEFAULT_RESOLUTION_CONFIG: {},
}))

vi.mock('../db/schema.js', () => ({
  entries: {},
  fragments: {},
  wikis: {},
  edges: {},
  people: {},
  wikiTypes: { slug: 'slug' },
  edits: {},
  groupWikis: {},
}))

vi.mock('../db/client.js', () => ({ db: {} }))

const { handleCreateWiki } = await import('../mcp/handlers.js')

// ── Helpers ────────────────────────────────────────────────────────────────

type DbLookupResult = { slug: string } | undefined

function makeDb(wikiTypeLookup: DbLookupResult) {
  // drizzle chain stubs: select(...).from(...).where(...).limit(...) → rows
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => (wikiTypeLookup ? [wikiTypeLookup] : []),
      }),
    }),
  }))
  const insertCaptured: { values?: Record<string, unknown> } = {}
  const insert = vi.fn(() => ({
    values: async (vals: Record<string, unknown>) => {
      insertCaptured.values = vals
    },
  }))
  return { db: { select, insert }, insertCaptured }
}

function makeDeps(db: unknown) {
  return {
    db,
    producer: {} as unknown,
    spawnWriteWorker: vi.fn(),
    resolveDefaultVaultId: vi.fn(),
    entityExtractCall: vi.fn(),
    loadUserPeople: vi.fn(),
  } as unknown as Parameters<typeof handleCreateWiki>[0]
}

beforeEach(() => {
  inferWikiTypeMock.mockClear()
  inferWikiTypeMock.mockImplementation(() => 'log')
})

// ── Cases ──────────────────────────────────────────────────────────────────

describe('handleCreateWiki — issue #154', () => {
  it('uses an explicit `type` when it exists in wiki_types and skips inference', async () => {
    const { db, insertCaptured } = makeDb({ slug: 'decision' })
    const deps = makeDeps(db)
    const res = await handleCreateWiki(
      deps,
      {
        title: 'Foo',
        description: 'a curated library of related items',
        type: 'decision',
      },
      'user-1'
    )
    expect(res.isError).toBeUndefined()
    expect(insertCaptured.values?.type).toBe('decision')
    expect(inferWikiTypeMock).not.toHaveBeenCalled()
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.type).toBe('decision')
    expect(payload.inferredType).toBeUndefined()
  })

  it('rejects an unknown type with a pointer to get_wiki_types', async () => {
    const { db, insertCaptured } = makeDb(undefined)
    const deps = makeDeps(db)
    const res = await handleCreateWiki(
      deps,
      { title: 'Foo', description: 'something', type: 'nonsense' },
      'user-1'
    )
    expect(res.isError).toBe(true)
    expect((res.content[0] as { text: string }).text).toMatch(
      /unknown wiki type/
    )
    expect((res.content[0] as { text: string }).text).toMatch(/get_wiki_types/)
    expect(insertCaptured.values).toBeUndefined()
    expect(inferWikiTypeMock).not.toHaveBeenCalled()
  })

  it('rejects a missing `description` (#232 — strict, no inference)', async () => {
    const { db, insertCaptured } = makeDb(undefined)
    const deps = makeDeps(db)
    const res = await handleCreateWiki(
      deps,
      { title: 'Foo', type: 'decision' },
      'user-1'
    )
    expect(res.isError).toBe(true)
    expect((res.content[0] as { text: string }).text).toMatch(
      /description is required/
    )
    expect(insertCaptured.values).toBeUndefined()
    expect(inferWikiTypeMock).not.toHaveBeenCalled()
  })

  it('rejects a missing `type` with a pointer to get_wiki_types (#232)', async () => {
    const { db, insertCaptured } = makeDb(undefined)
    const deps = makeDeps(db)
    const res = await handleCreateWiki(
      deps,
      { title: 'Foo', description: 'a curated library of references and findings on a topic' },
      'user-1'
    )
    expect(res.isError).toBe(true)
    expect((res.content[0] as { text: string }).text).toMatch(
      /type is required/
    )
    expect((res.content[0] as { text: string }).text).toMatch(/get_wiki_types/)
    expect(insertCaptured.values).toBeUndefined()
    expect(inferWikiTypeMock).not.toHaveBeenCalled()
  })
})
