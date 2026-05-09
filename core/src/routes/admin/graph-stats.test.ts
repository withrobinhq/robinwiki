/**
 * Tests for /admin/graph/stats (Stream H5).
 *
 * Mocks db.execute at the client boundary so the route logic stays the
 * unit under test. Each db.execute call in graph-stats.ts is a separate
 * SELECT; we drive the mock with a queue of canned rows so the test
 * covers the assembly path without round-tripping Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────────

const executeQueue: unknown[][] = []
const mockExecute = vi.fn((..._args: unknown[]) => {
  const next = executeQueue.shift()
  return Promise.resolve(next ?? [])
})

vi.mock('../../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}))

vi.mock('../../middleware/session.js', () => ({
  sessionMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'test-user')
    await next()
  }),
}))

const { adminGraphStatsRoutes } = await import('./graph-stats.js')

// ── Helpers ─────────────────────────────────────────────────────────────────

function get(path: string) {
  return adminGraphStatsRoutes.request(path, { method: 'GET' })
}

/**
 * Push the canned rows the seven SELECTs in graph-stats.ts will see, in
 * order: persons, wikis, fragments, edges, agentSchema,
 * peopleExtraction (sums), telemetryStarted, regen.
 */
function seedExecute(rows: {
  persons?: Record<string, unknown>
  wikis?: Record<string, unknown>
  fragments?: Record<string, unknown>
  edges?: Record<string, unknown>
  agent?: Record<string, unknown>
  extract?: Record<string, unknown>
  telemetryStarted?: Record<string, unknown>
  regen?: Record<string, unknown>
}) {
  executeQueue.push([rows.persons ?? {}])
  executeQueue.push([rows.wikis ?? {}])
  executeQueue.push([rows.fragments ?? {}])
  executeQueue.push([rows.edges ?? {}])
  executeQueue.push([rows.agent ?? {}])
  executeQueue.push([rows.extract ?? {}])
  executeQueue.push([rows.telemetryStarted ?? { telemetry_started: null }])
  executeQueue.push([rows.regen ?? {}])
}

beforeEach(() => {
  executeQueue.length = 0
  mockExecute.mockClear()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /admin/graph/stats', () => {
  it('returns the full snapshot shape', async () => {
    seedExecute({
      persons: { total: '10', verified: '7', pending: '2', rejected: '1', owner: '1' },
      wikis: {
        total: '5',
        populated: '3',
        empty_unfilled: '2',
        autoregen_enabled: '1',
        dirty: '2',
        es_empty: '1',
        es_learning: '2',
        es_dreaming: '0',
        es_filed: '2',
      },
      fragments: { total: '50', with_mention: '12' },
      edges: {
        frag_related: '100',
        frag_in_wiki: '50',
        entry_has_frag: '50',
        frag_mentions_person: '20',
        wiki_related_to_wiki: '0',
      },
      agent: { with_description: '4', with_hyde: '3', missing_either: '2', missing_both: '1' },
      extract: { raw_mentions_seen: '40', matched: '30', dropped: '10' },
      telemetryStarted: { telemetry_started: new Date('2026-05-08T00:00:00.000Z') },
      regen: { total: '4', debounced: '3', on_demand: '1' },
    })

    const res = await get('/stats')
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.persons).toEqual({ total: 10, verified: 7, pending: 2, rejected: 1, owner: 1 })
    expect(body.wikis.total).toBe(5)
    expect(body.wikis.populated).toBe(3)
    expect(body.wikis.empty).toBe(2)
    expect(body.wikis.autoregenEnabled).toBe(1)
    expect(body.wikis.dirty).toBe(2)
    expect(body.wikis.editorialState).toEqual({ empty: 1, learning: 2, dreaming: 0, filed: 2 })
    expect(body.fragments).toEqual({ total: 50, withMention: 12, withoutMention: 38 })
    expect(body.edges).toEqual({
      FRAGMENT_RELATED_TO_FRAGMENT: 100,
      FRAGMENT_IN_WIKI: 50,
      ENTRY_HAS_FRAGMENT: 50,
      FRAGMENT_MENTIONS_PERSON: 20,
      WIKI_RELATED_TO_WIKI: 0,
    })
    expect(body.agentSchema).toEqual({
      wikisWithDescription: 4,
      wikisWithHyde: 3,
      wikisMissingEither: 2,
      wikisMissingBoth: 1,
    })
    expect(body.peopleExtraction24h.rawMentionsSeen).toBe(40)
    expect(body.peopleExtraction24h.matched).toBe(30)
    expect(body.peopleExtraction24h.dropped).toBe(10)
    expect(body.peopleExtraction24h.dropRatePct).toBe(25)
    expect(body.peopleExtraction24h.telemetryStarted).toBe('2026-05-08T00:00:00.000Z')
    expect(body.regen24h).toEqual({ total: 4, debounced: 3, onDemand: 1 })
    expect(typeof body.lastUpdated).toBe('string')
    expect(body.telemetryWarning).toBeUndefined()
  })

  it('includes telemetryWarning when extraction has no data and no telemetry start', async () => {
    seedExecute({
      persons: { total: '0' },
      wikis: { total: '0' },
      fragments: { total: '0', with_mention: '0' },
      edges: {},
      agent: {},
      extract: { raw_mentions_seen: '0', matched: '0', dropped: '0' },
      telemetryStarted: { telemetry_started: null },
      regen: { total: '0' },
    })

    const res = await get('/stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.peopleExtraction24h.rawMentionsSeen).toBe(0)
    expect(body.peopleExtraction24h.telemetryStarted).toBeNull()
    expect(typeof body.telemetryWarning).toBe('string')
    expect(body.telemetryWarning).toMatch(/Stream P/)
  })

  it('omits telemetryWarning once telemetry has started, even if window is empty', async () => {
    seedExecute({
      persons: {},
      wikis: {},
      fragments: { total: '0', with_mention: '0' },
      edges: {},
      agent: {},
      extract: { raw_mentions_seen: '0', matched: '0', dropped: '0' },
      telemetryStarted: { telemetry_started: new Date('2026-05-08T12:00:00.000Z') },
      regen: {},
    })

    const res = await get('/stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.peopleExtraction24h.rawMentionsSeen).toBe(0)
    expect(body.peopleExtraction24h.telemetryStarted).toBe('2026-05-08T12:00:00.000Z')
    expect(body.telemetryWarning).toBeUndefined()
  })

  it('computes dropRatePct as 0 when no raw mentions were seen', async () => {
    seedExecute({
      persons: {},
      wikis: {},
      fragments: { total: '0', with_mention: '0' },
      edges: {},
      agent: {},
      extract: { raw_mentions_seen: '0', matched: '0', dropped: '0' },
      telemetryStarted: { telemetry_started: null },
      regen: {},
    })

    const res = await get('/stats')
    const body = await res.json()
    expect(body.peopleExtraction24h.dropRatePct).toBe(0)
  })

  it('coerces null and missing counts to 0', async () => {
    // No rows seeded; mockExecute returns [] for every call. Each
    // destructured row is undefined and toInt() returns 0.
    const res = await get('/stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.persons.total).toBe(0)
    expect(body.wikis.total).toBe(0)
    expect(body.fragments.total).toBe(0)
    expect(body.edges.FRAGMENT_IN_WIKI).toBe(0)
    expect(body.peopleExtraction24h.dropRatePct).toBe(0)
    expect(body.regen24h.total).toBe(0)
    expect(body.telemetryWarning).toMatch(/Stream P/)
  })

  it('returns 500 when a query throws', async () => {
    mockExecute.mockImplementationOnce(() => Promise.reject(new Error('connection refused')))

    const res = await get('/stats')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('graph-stats query failed')
    expect(body.detail).toBe('connection refused')
  })
})
