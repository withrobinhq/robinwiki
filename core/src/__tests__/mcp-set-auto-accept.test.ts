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

const writeMock = vi.fn(async (_db: unknown, value: boolean) => ({
  previous: !value,
  current: value,
}))
vi.mock('../lib/people-settings.js', () => ({
  loadAutoAcceptPersons: vi.fn(async () => false),
  setAutoAcceptPersons: writeMock,
  loadVerifiedPeople: vi.fn(),
  loadPendingPeople: vi.fn(),
  insertExtractedPerson: vi.fn(),
}))
vi.mock('../db/schema.js', () => ({
  entries: {},
  fragments: {},
  wikis: {},
  edges: {},
  people: {},
  wikiTypes: {},
  edits: {},
  appSettings: { key: 'key', value: 'value', updatedAt: 'updated_at' },
}))
vi.mock('../db/client.js', () => ({ db: {} }))

const { handleSetAutoAcceptPersons } = await import('../mcp/handlers.js')

function makeDeps() {
  return {
    db: {},
    producer: {} as unknown,
    spawnWriteWorker: vi.fn(),
    entityExtractCall: vi.fn(),
    loadUserPeople: vi.fn(),
  } as unknown as Parameters<typeof handleSetAutoAcceptPersons>[0]
}

beforeEach(() => {
  writeMock.mockClear()
})

describe('handleSetAutoAcceptPersons — Stream P', () => {
  it('flips the toggle and returns previous + current', async () => {
    const res = await handleSetAutoAcceptPersons(makeDeps(), { value: true }, 'user-1')
    expect(res.isError).toBeUndefined()
    const payload = JSON.parse((res.content[0] as { text: string }).text)
    expect(payload).toEqual({ previous: false, current: true })
    expect(writeMock).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('rejects unauthenticated calls', async () => {
    const res = await handleSetAutoAcceptPersons(makeDeps(), { value: true }, undefined)
    expect(res.isError).toBe(true)
  })

  it('rejects non-boolean value', async () => {
    const res = await handleSetAutoAcceptPersons(
      makeDeps(),
      { value: 'true' as unknown as boolean },
      'user-1'
    )
    expect(res.isError).toBe(true)
  })
})
