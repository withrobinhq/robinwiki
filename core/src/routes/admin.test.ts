import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks ───────────────────────────────────────────────────────────────────

// Capture every queue.add() call so we can assert payload + options.
const mockQueueAdd = vi
  .fn<(name: string, data: unknown, opts?: unknown) => Promise<{ id: string }>>()
  .mockImplementation(async (_name, _data, opts) => ({
    id: (opts as { jobId?: string } | undefined)?.jobId ?? 'mock-bull-job-id',
  }))

const mockGetQueue = vi.fn().mockReturnValue({ add: mockQueueAdd })

vi.mock('../queue/producer.js', () => ({
  producer: {
    getQueue: (...args: unknown[]) => mockGetQueue(...args),
  },
}))

// admin.ts imports db + schemas, but the scheduler endpoint never touches them.
// Stub minimally so module import succeeds.
vi.mock('../db/client.js', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('../db/schema.js', () => ({
  fragments: {},
  entries: {},
}))

vi.mock('../schemas/admin.schema.js', () => ({
  retryStuckDryRunResponseSchema: { parse: (x: unknown) => x },
  retryStuckResponseSchema: { parse: (x: unknown) => x },
}))

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * admin.ts registers the scheduler route at module-load time, gated by
 * NODE_ENV. Each test resets modules + sets the env, then imports a fresh
 * copy of the router so registration evaluates against the current env.
 */
async function loadAdminApp(nodeEnv: string) {
  vi.resetModules()
  process.env.NODE_ENV = nodeEnv
  const { adminRoutes } = await import('./admin.js')
  const app = new Hono()
  app.route('/admin', adminRoutes)
  return app
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /admin/scheduler/run-now/:jobName', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  beforeEach(() => {
    mockQueueAdd.mockClear()
    mockGetQueue.mockClear()
  })

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
  })

  it('happy path — embedding-retry: enqueues job and returns ok + jobId', async () => {
    const app = await loadAdminApp('development')

    const res = await app.request('/admin/scheduler/run-now/embedding-retry', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; jobId: string }
    expect(body.ok).toBe(true)
    expect(typeof body.jobId).toBe('string')
    expect(body.jobId.length).toBeGreaterThan(0)

    // Queue resolved by canonical scheduler queue name.
    expect(mockGetQueue).toHaveBeenCalledTimes(1)
    expect(mockGetQueue).toHaveBeenCalledWith('regen-scheduler-queue')

    // Bull job enqueued with the discriminated SchedulerJob payload the
    // existing worker dispatches by job.type.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1)
    const firstCall = mockQueueAdd.mock.calls[0]
    if (!firstCall) throw new Error('expected queue.add to have been called')
    const [bullName, payload, options] = firstCall
    expect(bullName).toBe('embedding-retry')
    expect(payload).toMatchObject({
      type: 'embedding-retry',
      triggeredBy: 'scheduler',
    })
    expect(payload).toHaveProperty('jobId')
    expect(payload).toHaveProperty('enqueuedAt')
    expect(options).toMatchObject({ jobId: (payload as { jobId: string }).jobId })
  })

  it('happy path — regen-batch: enqueues with regen-batch type', async () => {
    const app = await loadAdminApp('development')

    const res = await app.request('/admin/scheduler/run-now/regen-batch', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; jobId: string }
    expect(body.ok).toBe(true)

    const firstCall = mockQueueAdd.mock.calls[0]
    if (!firstCall) throw new Error('expected queue.add to have been called')
    const [bullName, payload] = firstCall
    expect(bullName).toBe('regen-batch')
    expect(payload).toMatchObject({
      type: 'regen-batch',
      triggeredBy: 'scheduler',
    })
  })

  it('rejects unknown job names with 400 + structured error', async () => {
    const app = await loadAdminApp('development')

    const res = await app.request('/admin/scheduler/run-now/totally-bogus', {
      method: 'POST',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unknown job 'totally-bogus'" })
    expect(mockQueueAdd).not.toHaveBeenCalled()
    expect(mockGetQueue).not.toHaveBeenCalled()
  })

  it('returns 404 in production (route not registered at all)', async () => {
    const app = await loadAdminApp('production')

    const res = await app.request('/admin/scheduler/run-now/embedding-retry', {
      method: 'POST',
    })

    // Hono's default 404 fires because the route does not exist when
    // NODE_ENV === 'production' at module-load time.
    expect(res.status).toBe(404)
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })
})
