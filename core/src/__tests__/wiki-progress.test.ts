import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  wikiMilestoneSchema,
  wikiProgressSchema,
  updateProgressBodySchema,
} from '../schemas/wikis.schema.js'

// ── Schema unit tests ──────────────────────────────────────────────────────

describe('wikiMilestoneSchema', () => {
  it('accepts a valid milestone', () => {
    const result = wikiMilestoneSchema.safeParse({ label: 'Scope defined', completed: true })
    expect(result.success).toBe(true)
  })

  it('rejects empty label', () => {
    const result = wikiMilestoneSchema.safeParse({ label: '', completed: false })
    expect(result.success).toBe(false)
  })

  it('rejects missing completed', () => {
    const result = wikiMilestoneSchema.safeParse({ label: 'Draft' })
    expect(result.success).toBe(false)
  })
})

describe('wikiProgressSchema', () => {
  it('accepts valid progress', () => {
    const result = wikiProgressSchema.safeParse({
      milestones: [{ label: 'Scope', completed: true }],
      percentage: 100,
    })
    expect(result.success).toBe(true)
  })

  it('rejects percentage below 0', () => {
    const result = wikiProgressSchema.safeParse({
      milestones: [{ label: 'A', completed: false }],
      percentage: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects percentage above 100', () => {
    const result = wikiProgressSchema.safeParse({
      milestones: [{ label: 'A', completed: true }],
      percentage: 101,
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty milestones array', () => {
    const result = wikiProgressSchema.safeParse({
      milestones: [],
      percentage: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects milestones array with more than 50 items', () => {
    const milestones = Array.from({ length: 51 }, (_, i) => ({
      label: `M${i}`,
      completed: false,
    }))
    const result = wikiProgressSchema.safeParse({ milestones, percentage: 0 })
    expect(result.success).toBe(false)
  })
})

describe('updateProgressBodySchema', () => {
  it('accepts milestones without percentage', () => {
    const result = updateProgressBodySchema.safeParse({
      milestones: [
        { label: 'Scope', completed: true },
        { label: 'Draft', completed: false },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty milestones', () => {
    const result = updateProgressBodySchema.safeParse({ milestones: [] })
    expect(result.success).toBe(false)
  })

  it('strips unknown fields', () => {
    const result = updateProgressBodySchema.safeParse({
      milestones: [{ label: 'A', completed: true }],
      percentage: 100,
    })
    expect(result.success).toBe(true)
    expect((result as any).data.percentage).toBeUndefined()
  })

  it('rejects milestones with empty label', () => {
    const result = updateProgressBodySchema.safeParse({
      milestones: [{ label: '', completed: false }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 50 milestones', () => {
    const milestones = Array.from({ length: 51 }, (_, i) => ({
      label: `Step ${i}`,
      completed: false,
    }))
    const result = updateProgressBodySchema.safeParse({ milestones })
    expect(result.success).toBe(false)
  })
})

// ── Route tests ────────────────────────────────────────────────────────────

const mockDbSelect = vi.fn()
const mockDbUpdate = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}))

// Spread the real schema so every table export (entries, fragments, people, etc.)
// is present for transitive imports (db/locks.ts, lib/search.ts, lib/regen.ts).
// Only the wikis stub needs overriding — the query chains in this test use
// plain string sentinels so the drizzle table shape doesn't matter.
vi.mock('../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema.js')>()
  return {
    ...actual,
    wikis: {
      lookupKey: 'wikis.lookup_key',
      name: 'wikis.name',
      type: 'wikis.type',
      prompt: 'wikis.prompt',
      state: 'wikis.state',
      vaultId: 'wikis.vault_id',
      lastRebuiltAt: 'wikis.last_rebuilt_at',
      createdAt: 'wikis.created_at',
      updatedAt: 'wikis.updated_at',
      progress: 'wikis.progress',
    },
  }
})

const mockEmitAuditEvent = vi.fn()
vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (...args: unknown[]) => mockEmitAuditEvent(...args),
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (_c: any, next: any) => {
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

vi.mock('../lib/validation.js', () => ({
  validationHook: (result: any, c: any) => {
    if (!result.success) {
      return c.json({ error: 'Validation failed', fields: result.error.flatten() }, 400)
    }
  },
}))

import { wikisRoutes } from '../routes/wikis.js'

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

const now = new Date()

function makeWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki01TEST',
    slug: 'test-wiki',
    name: 'Test Wiki',
    type: 'objective',
    prompt: '',
    state: 'RESOLVED',
    content: '',
    vaultId: null,
    lastRebuiltAt: null,
    published: false,
    publishedSlug: null,
    publishedAt: null,
    regenerate: true,
    bouncerMode: 'auto',
    dedupHash: null,
    lockedBy: null,
    lockedAt: null,
    deletedAt: null,
    progress: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(rows)
  return chain
}

function updateChainMock() {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(undefined)
  return chain
}

describe('PUT /wikis/:id/progress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEmitAuditEvent.mockResolvedValue(undefined)
  })

  it('returns 200 with correct percentage for mixed milestones', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([makeWiki()]))
    mockDbUpdate.mockReturnValue(updateChainMock())

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestones: [
          { label: 'Scope', completed: true },
          { label: 'Draft', completed: true },
          { label: 'Review', completed: false },
          { label: 'Ship', completed: false },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.progress.percentage).toBe(50)
    expect(body.progress.milestones).toHaveLength(4)
  })

  it('returns 404 for nonexistent wiki', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([]))

    const app = createApp()
    const res = await app.request('/wikis/nonexistent/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestones: [{ label: 'A', completed: true }],
      }),
    })

    expect(res.status).toBe(404)
  })

  it('returns 400 for empty milestones array', async () => {
    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestones: [] }),
    })

    expect(res.status).toBe(400)
  })

  it('computes 100% when all milestones completed', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([makeWiki()]))
    mockDbUpdate.mockReturnValue(updateChainMock())

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestones: [
          { label: 'A', completed: true },
          { label: 'B', completed: true },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.progress.percentage).toBe(100)
  })

  it('computes 0% when no milestones completed', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([makeWiki()]))
    mockDbUpdate.mockReturnValue(updateChainMock())

    const app = createApp()
    const res = await app.request('/wikis/wiki01TEST/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestones: [
          { label: 'A', completed: false },
          { label: 'B', completed: false },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.progress.percentage).toBe(0)
  })

  it('emits audit event with correct params', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([makeWiki()]))
    mockDbUpdate.mockReturnValue(updateChainMock())

    const app = createApp()
    await app.request('/wikis/wiki01TEST/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestones: [
          { label: 'Scope', completed: true },
          { label: 'Draft', completed: false },
        ],
      }),
    })

    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1)
    const [, params] = mockEmitAuditEvent.mock.calls[0]
    expect(params.entityType).toBe('wiki')
    expect(params.entityId).toBe('wiki01TEST')
    expect(params.eventType).toBe('progress_updated')
    expect(params.detail.percentage).toBe(50)
    expect(params.detail.totalMilestones).toBe(2)
    expect(params.detail.completedMilestones).toBe(1)
  })
})
