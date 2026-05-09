import { describe, it, expect, vi, beforeEach } from 'vitest'

// QA Issue 6: regen_status is the "regen happening now" surface.
// Auth check + delegation to getRegenStatus -- the snapshot logic is
// covered separately in regen-debounce-status.test.ts.

const mockGetRegenStatus = vi.fn()

vi.mock('../queue/regen-debounce.js', () => ({
  getRegenStatus: (...args: unknown[]) => mockGetRegenStatus(...args),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@robin/shared', () => ({
  makeLookupKey: vi.fn(),
  parseLookupKey: vi.fn(),
  generateSlug: vi.fn(),
  loadPeopleExtractionSpec: vi.fn(),
}))

vi.mock('@robin/agent', () => ({
  resolvePerson: vi.fn(),
  DEFAULT_RESOLUTION_CONFIG: {},
  embedText: vi.fn(),
}))

vi.mock('../db/slug.js', () => ({
  resolveEntrySlug: vi.fn(),
  resolveFragmentSlug: vi.fn(),
  resolveWikiSlug: vi.fn(),
}))

vi.mock('../db/dedup.js', () => ({
  computeContentHash: vi.fn(),
  findDuplicateEntry: vi.fn(),
  findDuplicateFragment: vi.fn(),
}))

vi.mock('../db/schema.js', () => ({
  entries: {},
  fragments: {},
  wikis: {},
  edges: {},
  people: {},
  wikiTypes: {},
  edits: {},
}))

vi.mock('./resolvers.js', () => ({
  resolveWikiBySlug: vi.fn(),
}))

vi.mock('../services/publish.js', () => ({
  publishWiki: vi.fn(),
  unpublishWiki: vi.fn(),
}))

vi.mock('../lib/openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn(),
}))

const { handleRegenStatus } = await import('./handlers.js')

const fakeDeps = {
  db: {} as never,
  producer: {} as never,
  spawnWriteWorker: () => {},
  entityExtractCall: async () => ({ people: [] }),
  loadUserPeople: async () => [],
}

describe('handleRegenStatus — observability tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated callers BEFORE consulting the queue', async () => {
    const result = await handleRegenStatus(fakeDeps, {}, undefined)
    expect(result.isError).toBe(true)
    expect(mockGetRegenStatus).not.toHaveBeenCalled()
  })

  it('returns the snapshot from getRegenStatus on the happy path', async () => {
    mockGetRegenStatus.mockResolvedValueOnce({
      inFlight: [{ jobId: 'j1', wikiKey: 'wiki01abc', startedAt: '2026-05-08T12:00:00.000Z', triggeredBy: 'manual' }],
      debounced: [{ wikiKey: 'wiki01xyz', lastEdgeAt: '2026-05-08T11:58:00.000Z', etaToEligibleMs: 180_000 }],
      recent: [{ wikiKey: 'wiki01abc', jobId: 'j0', status: 'completed', startedAt: '2026-05-08T11:50:00.000Z', durationMs: 92_000 }],
      debounceMs: 300_000,
    })

    const result = await handleRegenStatus(fakeDeps, { recentLimit: 5 }, 'user-1')

    expect(result.isError).toBeUndefined()
    expect(mockGetRegenStatus).toHaveBeenCalledTimes(1)
    expect(mockGetRegenStatus.mock.calls[0][1]).toEqual({ recentLimit: 5 })

    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    )
    expect(payload.inFlight).toHaveLength(1)
    expect(payload.debounced).toHaveLength(1)
    expect(payload.recent).toHaveLength(1)
    expect(payload.debounceMs).toBe(300_000)
  })

  it('surfaces snapshot errors as MCP-shaped errors instead of throwing', async () => {
    mockGetRegenStatus.mockRejectedValueOnce(new Error('redis down'))
    const result = await handleRegenStatus(fakeDeps, {}, 'user-1')
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('redis down')
  })
})
