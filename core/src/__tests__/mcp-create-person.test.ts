import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ─────────────────────────────────────────────────────

vi.mock('../db/slug.js', () => ({
  resolvePersonSlug: vi.fn(async (_db: unknown, slug: string) => slug),
  resolveWikiSlug: vi.fn(),
  resolveFragmentSlug: vi.fn(),
  resolveEntrySlug: vi.fn(),
}))

vi.mock('../db/dedup.js', () => ({
  computeContentHash: vi.fn(),
  findDuplicateEntry: vi.fn(),
  findDuplicateFragment: vi.fn(),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn(async () => {}),
}))

vi.mock('../lib/people/relationship-resolver.js', () => ({
  resolveAndWriteRelationship: vi.fn(async (_db: unknown, _src: string, rel: { type: string; target: string }) => ({
    resolved: { type: rel.type, target: rel.target, edgeId: 'edge-x', edgeType: 'PERSON_KNOWS_PERSON' },
  })),
}))

vi.mock('@robin/agent', () => ({
  DEFAULT_RESOLUTION_CONFIG: {},
  embedText: vi.fn(),
}))

vi.mock('../db/schema.js', () => ({
  entries: {},
  fragments: {},
  wikis: {},
  edges: {},
  people: { lookupKey: 'lookup_key', canonicalName: 'canonical_name', deletedAt: 'deleted_at', slug: 'slug' },
  wikiTypes: {},
  edits: {},
}))

vi.mock('../db/client.js', () => ({ db: {} }))

const { handleCreatePerson } = await import('../mcp/handlers.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(existingPerson: { lookupKey: string; slug: string } | null = null) {
  const insertCaptured: { values?: Record<string, unknown> } = {}
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => (existingPerson ? [existingPerson] : []),
      }),
    }),
  }))
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
    entityExtractCall: vi.fn(),
    loadUserPeople: vi.fn(),
  } as unknown as Parameters<typeof handleCreatePerson>[0]
}

beforeEach(() => {})

describe('handleCreatePerson — Stream P', () => {
  it('inserts a verified person with status=verified and createdVia=mcp_create', async () => {
    const { db, insertCaptured } = makeDb(null)
    const deps = makeDeps(db)
    const res = await handleCreatePerson(
      deps,
      { canonicalName: 'Alice Yang', aliases: ['Alice'], relationship: 'colleague' },
      'user-1'
    )
    expect(res.isError).toBeUndefined()
    expect(insertCaptured.values).toMatchObject({
      canonicalName: 'Alice Yang',
      status: 'verified',
      createdVia: 'mcp_create',
    })
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.status).toBe('verified')
    expect(payload.lookupKey).toMatch(/^person/)
  })

  it('rejects empty canonicalName', async () => {
    const { db } = makeDb(null)
    const deps = makeDeps(db)
    const res = await handleCreatePerson(deps, { canonicalName: '   ' }, 'user-1')
    expect(res.isError).toBe(true)
  })

  it('rejects unauthenticated calls', async () => {
    const { db } = makeDb(null)
    const deps = makeDeps(db)
    const res = await handleCreatePerson(deps, { canonicalName: 'Sam' }, undefined)
    expect(res.isError).toBe(true)
  })

  it('returns idempotent response when canonical name already exists', async () => {
    const { db } = makeDb({ lookupKey: 'person01EXIST', slug: 'sam' })
    const deps = makeDeps(db)
    const res = await handleCreatePerson(deps, { canonicalName: 'Sam' }, 'user-1')
    expect(res.isError).toBeUndefined()
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.lookupKey).toBe('person01EXIST')
    expect(payload.alreadyExists).toBe(true)
  })
})
