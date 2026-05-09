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
  resolveAndWriteRelationship: vi.fn(),
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

const { handleUpdatePerson } = await import('../mcp/handlers.js')

function makeDb(person: Record<string, unknown> | null) {
  const updateCaptured: { values?: Record<string, unknown> } = {}
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => (person ? [person] : []),
      }),
    }),
  }))
  const update = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => ({
      where: async () => {
        updateCaptured.values = vals
      },
    }),
  }))
  return { db: { select, update }, updateCaptured }
}

function makeDeps(db: unknown) {
  return {
    db,
    producer: {} as unknown,
    spawnWriteWorker: vi.fn(),
    entityExtractCall: vi.fn(),
    loadUserPeople: vi.fn(),
  } as unknown as Parameters<typeof handleUpdatePerson>[0]
}

beforeEach(() => {})

describe('handleUpdatePerson — Stream P', () => {
  it('appends aliases by default (no replaceAliases)', async () => {
    const { db, updateCaptured } = makeDb({
      lookupKey: 'person01XYZ',
      canonicalName: 'Sam',
      aliases: ['Samuel'],
      status: 'verified',
      contextNotes: null,
    })
    const deps = makeDeps(db)
    const res = await handleUpdatePerson(
      deps,
      {
        personLookupKey: 'person01XYZ',
        updates: { aliases: ['Sammy'] },
      },
      'user-1'
    )
    expect(res.isError).toBeUndefined()
    expect(updateCaptured.values).toMatchObject({ aliases: ['Samuel', 'Sammy'] })
  })

  it('promotes pending -> verified when promoteFromQuarantine=true', async () => {
    const { db, updateCaptured } = makeDb({
      lookupKey: 'person01PND',
      canonicalName: 'Diana',
      aliases: [],
      status: 'pending',
      contextNotes: null,
      createdVia: 'extractor_pending',
    })
    const deps = makeDeps(db)
    const res = await handleUpdatePerson(
      deps,
      {
        personLookupKey: 'person01PND',
        updates: { notes: 'works on platform team' },
        options: { promoteFromQuarantine: true },
      },
      'user-1'
    )
    expect(res.isError).toBeUndefined()
    expect(updateCaptured.values).toMatchObject({ status: 'verified', verified: true })
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.promoted).toBe(true)
    expect(payload.status).toBe('verified')
  })

  it('does NOT promote without the flag, even when notes are appended', async () => {
    const { db, updateCaptured } = makeDb({
      lookupKey: 'person01PND',
      canonicalName: 'Diana',
      aliases: [],
      status: 'pending',
      contextNotes: null,
    })
    const deps = makeDeps(db)
    const res = await handleUpdatePerson(
      deps,
      {
        personLookupKey: 'person01PND',
        updates: { notes: 'works on platform team' },
      },
      'user-1'
    )
    expect(res.isError).toBeUndefined()
    expect(updateCaptured.values).not.toHaveProperty('status')
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.promoted).toBe(false)
    expect(payload.status).toBe('pending')
  })

  it('returns 404 when person does not exist', async () => {
    const { db } = makeDb(null)
    const deps = makeDeps(db)
    const res = await handleUpdatePerson(
      deps,
      { personLookupKey: 'person01MISSING', updates: {} },
      'user-1'
    )
    expect(res.isError).toBe(true)
  })

  it('rejects unauthenticated calls', async () => {
    const { db } = makeDb(null)
    const deps = makeDeps(db)
    const res = await handleUpdatePerson(
      deps,
      { personLookupKey: 'person01XYZ', updates: {} },
      undefined
    )
    expect(res.isError).toBe(true)
  })
})
