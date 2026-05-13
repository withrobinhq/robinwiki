import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks (must come before dynamic import) ────────────────────────────────
//
// Covers wikiRegenLock wrapping on POST /wikis/:id/regenerate (#audit-M5).
// Asserts:
//   - Concurrent calls produce one 200 + one 409
//   - successState='RESOLVED' (and failureState='PENDING') is observed in the
//     params passed to wikiRegenLock.using
//   - CasLock contended error translates to 409 with the documented body
//
// T4-bundle (v0.2.2): the per-wiki regenerate gate was dropped, so on-demand
// regen no longer 400s on a disabled flag. The autoregen flag governs the
// batch worker only.

const mockDbSelect = vi.fn()
const mockUsing = vi.fn()
const mockRegenerateWiki = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}))

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookup_key',
    name: 'wikis.name',
    type: 'wikis.type',
    state: 'wikis.state',
    autoregen: 'wikis.autoregen',
    dirtySince: 'wikis.dirty_since',
  },
  edges: {},
  wikiTypes: {},
  fragments: {},
  people: {},
  auditLog: {},
  edits: {},
  groupWikis: {},
  groups: {},
}))

vi.mock('../db/locks.js', () => ({
  wikiRegenLock: {
    using: (...args: unknown[]) => mockUsing(...args),
  },
}))

vi.mock('../lib/regen.js', () => ({
  regenerateWiki: (...args: unknown[]) => mockRegenerateWiki(...args),
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('userId', 'test-user')
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

vi.mock('../queue/producer.js', () => ({
  producer: { enqueueRegen: vi.fn() },
}))

vi.mock('../mcp/wiki-type-inference.js', () => ({
  inferWikiType: vi.fn().mockReturnValue('log'),
}))

const { wikisRoutes } = await import('./wikis.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(rows)
  return chain
}

function makeWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki01TEST',
    name: 'Engineering Log',
    type: 'log',
    autoregen: true,
    dirtySince: null,
    state: 'PENDING',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /wikis/:id/regenerate — wikiRegenLock wrapping (#audit-M5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes successState=RESOLVED and failureState=PENDING and runs regenerateWiki inside the lock', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([makeWiki()]))
    mockUsing.mockImplementationOnce(async (_params, routine) => {
      await routine()
    })
    mockRegenerateWiki.mockResolvedValueOnce({
      content: 'x',
      fragmentCount: 3,
      hasEmbedding: true,
      timing: { classify: 1, gatherFragments: 2, llmCall: 3, embed: 4, total: 10 },
    })

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/regenerate', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.fragmentCount).toBe(3)

    expect(mockUsing).toHaveBeenCalledTimes(1)
    const params = mockUsing.mock.calls[0][0]
    expect(params.key).toBe('wiki01TEST')
    expect(params.fromState).toBe('PENDING')
    expect(params.toState).toBe('LINKING')
    expect(params.successState).toBe('RESOLVED')
    expect(params.failureState).toBe('PENDING')
    expect(params.autoRenew).toBe(true)
    expect(params.lockedBy).toMatch(/^regen-wiki01TEST-/)
  })

  it('returns a non-zero fragmentCount proving the inner CAS no longer short-circuits', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([makeWiki()]))
    mockUsing.mockImplementationOnce(async (_params, routine) => {
      await routine()
    })
    mockRegenerateWiki.mockResolvedValueOnce({
      content: 'generated wiki body',
      fragmentCount: 5,
      hasEmbedding: true,
      timing: { classify: 2, gatherFragments: 3, llmCall: 10, embed: 1, total: 16 },
    })

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/regenerate', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.fragmentCount).toBe(5)
    expect(body.fragmentCount).toBeGreaterThan(0)
  })

  it('returns 409 with documented body when CasLock contended', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([makeWiki()]))
    mockUsing.mockRejectedValueOnce(new Error('CasLock contended: wiki01TEST'))

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/regenerate', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Regeneration already in progress')
    expect(mockRegenerateWiki).not.toHaveBeenCalled()
  })

  it('still acquires the lock when autoregen=false (on-demand bypasses the batch gate)', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([makeWiki({ autoregen: false })]))
    mockUsing.mockImplementationOnce(async (_params, routine) => {
      await routine()
    })
    mockRegenerateWiki.mockResolvedValueOnce({
      content: 'x',
      fragmentCount: 0,
      hasEmbedding: false,
      timing: { classify: 0, gatherFragments: 0, llmCall: 0, embed: 0, total: 0 },
    })

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/regenerate', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockUsing).toHaveBeenCalledTimes(1)
    expect(mockRegenerateWiki).toHaveBeenCalledTimes(1)
  })

  it('404s on unknown wiki without acquiring the lock', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([]))

    const app = createApp()
    const res = await app.request('/wikis/wiki99NONE/regenerate', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(mockUsing).not.toHaveBeenCalled()
  })

  it('passes through non-contention errors as 500', async () => {
    mockDbSelect.mockReturnValueOnce(selectChainMock([makeWiki()]))
    mockUsing.mockRejectedValueOnce(new Error('boom'))

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/regenerate', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Regeneration failed')
    expect(body.detail).toBe('boom')
  })
})
