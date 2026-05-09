import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../db/slug.js', () => ({
  resolvePersonSlug: vi.fn(),
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

const resolveMock = vi.fn()
vi.mock('../lib/people/relationship-resolver.js', () => ({
  resolveAndWriteRelationship: (...args: unknown[]) => resolveMock(...args),
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
  people: { lookupKey: 'lookup_key', deletedAt: 'deleted_at' },
  wikiTypes: {},
  edits: {},
}))

vi.mock('../db/client.js', () => ({ db: {} }))

const { handleAddRelationship } = await import('../mcp/handlers.js')

function makeDb(sourceFound: boolean) {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => (sourceFound ? [{ lookupKey: 'person01SRC' }] : []),
      }),
    }),
  }))
  return { select }
}

function makeDeps(db: unknown) {
  return {
    db,
    producer: {} as unknown,
    spawnWriteWorker: vi.fn(),
    entityExtractCall: vi.fn(),
    loadUserPeople: vi.fn(),
  } as unknown as Parameters<typeof handleAddRelationship>[0]
}

beforeEach(() => {
  resolveMock.mockReset()
})

describe('handleAddRelationship — Stream P', () => {
  it('writes a person->person KNOWS edge', async () => {
    resolveMock.mockResolvedValue({
      resolved: {
        type: 'KNOWS',
        target: 'person:person01DST',
        edgeId: 'edge1',
        edgeType: 'PERSON_KNOWS_PERSON',
      },
    })
    const db = makeDb(true)
    const deps = makeDeps(db)
    const res = await handleAddRelationship(
      deps,
      { source: 'person:person01SRC', target: 'person:person01DST', type: 'KNOWS' },
      'user-1'
    )
    expect(res.isError).toBeUndefined()
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.edgeType).toBe('PERSON_KNOWS_PERSON')
  })

  it('returns error when source is not in person:<key> form', async () => {
    const db = makeDb(true)
    const deps = makeDeps(db)
    const res = await handleAddRelationship(
      deps,
      { source: 'wiki:foo', target: 'wiki:bar', type: 'WORKS_AT' },
      'user-1'
    )
    expect(res.isError).toBe(true)
  })

  it('returns 404 when source person does not exist', async () => {
    const db = makeDb(false)
    const deps = makeDeps(db)
    const res = await handleAddRelationship(
      deps,
      { source: 'person:person01MISSING', target: 'person:person01DST', type: 'KNOWS' },
      'user-1'
    )
    expect(res.isError).toBe(true)
  })

  it('surfaces resolver pending as error response', async () => {
    resolveMock.mockResolvedValue({
      pending: { type: 'KNOWS', target: 'person:person01MISSING', reason: 'target-not-found' },
    })
    const db = makeDb(true)
    const deps = makeDeps(db)
    const res = await handleAddRelationship(
      deps,
      { source: 'person:person01SRC', target: 'person:person01MISSING', type: 'KNOWS' },
      'user-1'
    )
    expect(res.isError).toBe(true)
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.reason).toBe('target-not-found')
  })
})
