import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// QA Issue 6 (2026-05-08): regen_now is the explicit "ignore the debounce"
// affordance. Auth still applies; only the quiet-window heuristic is
// skipped. These tests pin both halves -- the auth gate AND the bypass.

const mockEnqueueWikiRegen = vi.fn()
const mockResolveWikiForRegen = vi.fn()
const mockEmitAuditEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../queue/regen-debounce.js', () => ({
  enqueueWikiRegen: (...args: unknown[]) => mockEnqueueWikiRegen(...args),
  resolveWikiForRegen: (...args: unknown[]) => mockResolveWikiForRegen(...args),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
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

const { handleRegenNow } = await import('./handlers.js')

const fakeDeps = {
  db: {} as never,
  producer: {} as never,
  spawnWriteWorker: () => {},
  entityExtractCall: async () => ({ people: [] }),
  loadUserPeople: async () => [],
}

describe('handleRegenNow - on-demand regen tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated callers BEFORE consulting the queue', async () => {
    const result = await handleRegenNow(fakeDeps, { wikiKey: 'wiki01abc' }, undefined)
    expect(result.isError).toBe(true)
    expect(mockEnqueueWikiRegen).not.toHaveBeenCalled()
    expect(mockResolveWikiForRegen).not.toHaveBeenCalled()
  })

  it('rejects an empty wikiKey', async () => {
    const result = await handleRegenNow(fakeDeps, { wikiKey: '   ' }, 'user-1')
    expect(result.isError).toBe(true)
    expect(mockEnqueueWikiRegen).not.toHaveBeenCalled()
  })

  it('returns a not-found error when the wiki does not resolve', async () => {
    mockResolveWikiForRegen.mockResolvedValueOnce(null)
    const result = await handleRegenNow(
      fakeDeps,
      { wikiKey: 'unknown-wiki' },
      'user-1'
    )
    expect(result.isError).toBe(true)
    expect(mockEnqueueWikiRegen).not.toHaveBeenCalled()
  })

  it('enqueues a manual regen via the shared helper and returns jobId/queuedAt', async () => {
    mockResolveWikiForRegen.mockResolvedValueOnce({
      lookupKey: 'wiki01abc',
      slug: 'my-wiki',
    })
    mockEnqueueWikiRegen.mockResolvedValueOnce({
      jobId: 'job-uuid-1',
      queuedAt: '2026-05-08T12:00:00.000Z',
    })

    const result = await handleRegenNow(
      fakeDeps,
      { wikiKey: 'my-wiki' },
      'user-1'
    )

    expect(result.isError).toBeUndefined()
    expect(mockEnqueueWikiRegen).toHaveBeenCalledTimes(1)
    const args = mockEnqueueWikiRegen.mock.calls[0]
    expect(args[0]).toBe('wiki01abc')
    expect(args[1]).toBe('manual')

    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    )
    expect(payload).toMatchObject({
      jobId: 'job-uuid-1',
      queuedAt: '2026-05-08T12:00:00.000Z',
      wikiKey: 'wiki01abc',
      wikiSlug: 'my-wiki',
    })
  })

  it('emits a regen_requested audit row keyed by wiki', async () => {
    mockResolveWikiForRegen.mockResolvedValueOnce({
      lookupKey: 'wiki01abc',
      slug: 'my-wiki',
    })
    mockEnqueueWikiRegen.mockResolvedValueOnce({
      jobId: 'job-uuid-2',
      queuedAt: '2026-05-08T12:01:00.000Z',
    })

    await handleRegenNow(fakeDeps, { wikiKey: 'my-wiki' }, 'user-1')

    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1)
    const params = mockEmitAuditEvent.mock.calls[0][1] as {
      entityType: string
      entityId: string
      eventType: string
      detail?: Record<string, unknown>
    }
    expect(params.entityType).toBe('wiki')
    expect(params.entityId).toBe('wiki01abc')
    expect(params.eventType).toBe('regen_requested')
    expect(params.detail).toMatchObject({
      jobId: 'job-uuid-2',
      triggeredBy: 'manual',
    })
  })
})
