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
vi.mock('../db/audit.js', () => ({ emitAuditEvent: vi.fn(async () => {}) }))
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
  people: {
    lookupKey: 'lookup_key',
    canonicalName: 'canonical_name',
    slug: 'slug',
    aliases: 'aliases',
    deletedAt: 'deleted_at',
    status: 'status',
    createdAt: 'created_at',
    createdVia: 'created_via',
    extractedFromFragmentId: 'extracted_from_fragment_id',
  },
  wikiTypes: {},
  edits: {},
  appSettings: { key: 'key', value: 'value', updatedAt: 'updated_at' },
}))
vi.mock('../db/client.js', () => ({ db: {} }))

const { handleListPendingPersons } = await import('../mcp/handlers.js')

function makeDb(rows: Record<string, unknown>[], total = rows.length) {
  let queryNum = 0
  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        queryNum += 1
        if (queryNum === 1) {
          return {
            orderBy: () => ({
              limit: () => ({
                offset: async () => rows,
              }),
            }),
          }
        }
        // Second select is the count query
        return Promise.resolve([{ count: total }])
      },
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
  } as unknown as Parameters<typeof handleListPendingPersons>[0]
}

beforeEach(() => {})

describe('handleListPendingPersons — Stream P', () => {
  it('returns the pending queue with a status marker', async () => {
    const created = new Date('2026-05-09T00:00:00Z')
    const rows = [
      {
        lookupKey: 'person01PND',
        slug: 'diana-patel',
        canonicalName: 'Diana Patel',
        aliases: [],
        createdAt: created,
        createdVia: 'extractor_pending',
        extractedFromFragmentId: 'frag01',
      },
    ]
    const db = makeDb(rows, 1)
    const deps = makeDeps(db)
    const res = await handleListPendingPersons(deps, {}, 'user-1')
    expect(res.isError).toBeUndefined()
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload.total).toBe(1)
    expect(payload.persons[0]).toMatchObject({
      lookupKey: 'person01PND',
      status: 'pending',
      createdVia: 'extractor_pending',
    })
  })

  it('rejects unauthenticated calls', async () => {
    const db = makeDb([])
    const deps = makeDeps(db)
    const res = await handleListPendingPersons(deps, {}, undefined)
    expect(res.isError).toBe(true)
  })
})
