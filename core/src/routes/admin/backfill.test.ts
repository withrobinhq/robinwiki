/**
 * Tests for the /admin/backfill HTTP endpoints (Stream U).
 *
 * Mocks the runner + audit at the lib boundary so the route logic stays
 * the unit under test (auth, body parsing, response shape, run recording).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must come before the dynamic import) ────────────────────────────

const mockAudit = vi.fn()
const mockRunner = vi.fn()
const mockRecordJobRun = vi.fn().mockResolvedValue(undefined)

vi.mock('../../db/client.js', () => ({ db: {} }))

vi.mock('../../lib/backfill-runner.js', () => ({
  auditWikiAgentSchema: (...args: unknown[]) => mockAudit(...args),
  runWikiAgentSchemaBackfill: (...args: unknown[]) => mockRunner(...args),
}))

vi.mock('../../lib/scheduled-jobs.js', () => ({
  recordJobRun: (...args: unknown[]) => mockRecordJobRun(...args),
}))

vi.mock('../../middleware/session.js', () => ({
  sessionMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'test-user')
    await next()
  }),
}))

// db.select chain stub. Both /audit and /runs use it; /audit reads at most
// one row and /runs reads up to 50. The chain shape is:
//   db.select(...).from(...).where(...).limit(...) => rows
//   db.select(...).from(...).where(...).orderBy(...).limit(...) => rows
const mockSelectChain: any = {
  from: () => mockSelectChain,
  where: () => mockSelectChain,
  orderBy: () => mockSelectChain,
  limit: () => mockSelectChain,
}
let mockSelectResolve: unknown[] = []
// biome-ignore lint/suspicious/noThenProperty: thenable test mock
mockSelectChain.then = (resolve: (v: unknown) => void) => {
  resolve(mockSelectResolve)
  return Promise.resolve(mockSelectResolve)
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => mockSelectChain,
  },
}))

// ── Import under test ──────────────────────────────────────────────────────

const { adminBackfillRoutes } = await import('./backfill.js')

// ── Helpers ────────────────────────────────────────────────────────────────

function get(path: string) {
  return adminBackfillRoutes.request(path, { method: 'GET' })
}

function post(path: string, body?: unknown) {
  return adminBackfillRoutes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  mockAudit.mockReset()
  mockRunner.mockReset()
  mockRecordJobRun.mockReset().mockResolvedValue(undefined)
  mockSelectResolve = []
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /admin/backfill/audit', () => {
  it('returns the gap report from auditWikiAgentSchema', async () => {
    mockAudit.mockResolvedValue({
      missingDescription: ['wiki1', 'wiki2'],
      missingHyde: ['wiki3'],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    mockSelectResolve = []

    const res = await get('/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wikiAgentSchema.missingDescription).toEqual(['wiki1', 'wiki2'])
    expect(body.wikiAgentSchema.missingHyde).toEqual(['wiki3'])
    expect(body.lastAuditAt).toBeNull()
  })

  it('surfaces lastAuditAt when a row exists', async () => {
    mockAudit.mockResolvedValue({
      missingDescription: [],
      missingHyde: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    const audited = new Date('2026-04-01T12:34:00.000Z')
    mockSelectResolve = [{ lastRunAt: audited }]

    const res = await get('/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lastAuditAt).toBe(audited.toISOString())
  })
})

describe('POST /admin/backfill/wiki-agent-schema', () => {
  it('runs the backfill and returns counts on success', async () => {
    mockRunner.mockResolvedValue({
      ok: 5,
      failed: 0,
      scanned: 5,
      dryRun: false,
      wikiKey: null,
      durationMs: 100,
    })

    const res = await post('/wiki-agent-schema', {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scope).toBe('all')
    expect(body.wikiKey).toBeNull()
    expect(body.ok).toBe(5)
    expect(body.failed).toBe(0)
    expect(body.scanned).toBe(5)
    expect(typeof body.jobId).toBe('string')
    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    const call = mockRecordJobRun.mock.calls[0]
    expect(call[1]).toBe('wiki-agent-schema-backfill')
    expect(call[2]).toBe('completed')
  })

  it('scopes to a single wiki when wikiKey is supplied', async () => {
    mockRunner.mockResolvedValue({
      ok: 1,
      failed: 0,
      scanned: 1,
      dryRun: false,
      wikiKey: 'wiki-abc',
      durationMs: 50,
    })

    const res = await post('/wiki-agent-schema', { wikiKey: 'wiki-abc' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scope).toBe('single')
    expect(body.wikiKey).toBe('wiki-abc')
    expect(body.ok).toBe(1)
    expect(mockRunner).toHaveBeenCalledWith(expect.anything(), { wikiKey: 'wiki-abc' })
  })

  it('records partial when some failed', async () => {
    mockRunner.mockResolvedValue({
      ok: 2,
      failed: 1,
      scanned: 3,
      dryRun: false,
      wikiKey: null,
      durationMs: 80,
    })

    const res = await post('/wiki-agent-schema', {})
    expect(res.status).toBe(200)
    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    expect(mockRecordJobRun.mock.calls[0][2]).toBe('partial')
  })

  it('returns 500 and records failed when the runner throws', async () => {
    mockRunner.mockRejectedValue(new Error('embed pool down'))

    const res = await post('/wiki-agent-schema', {})
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('embed pool down')
    expect(body.ok).toBe(0)
    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    expect(mockRecordJobRun.mock.calls[0][2]).toBe('failed')
  })
})

describe('GET /admin/backfill/runs', () => {
  it('returns the last-run rows from scheduled_jobs', async () => {
    const ranAt = new Date('2026-04-01T12:34:00.000Z')
    mockSelectResolve = [
      {
        jobName: 'wiki-agent-schema-backfill',
        lastRunAt: ranAt,
        lastRunStatus: 'completed',
        lastRunMeta: { ok: 5, failed: 0 },
        lastRunDurationMs: 100,
      },
    ]

    const res = await get('/runs')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runs.length).toBe(1)
    expect(body.runs[0].jobName).toBe('wiki-agent-schema-backfill')
    expect(body.runs[0].lastRunStatus).toBe('completed')
    expect(body.runs[0].lastRunAt).toBe(ranAt.toISOString())
  })

  it('returns empty list when no runs exist', async () => {
    mockSelectResolve = []
    const res = await get('/runs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [] })
  })
})
