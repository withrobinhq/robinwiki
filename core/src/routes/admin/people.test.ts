import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ─────────────────────────────────────────────────────

vi.mock('../../db/audit.js', () => ({
  emitAuditEvent: vi.fn(async () => {}),
}))

vi.mock('../../middleware/session.js', () => ({
  sessionMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('../../db/schema.js', () => ({
  people: {
    lookupKey: 'lookup_key',
    slug: 'slug',
    canonicalName: 'canonical_name',
    name: 'name',
    aliases: 'aliases',
    status: 'status',
    deletedAt: 'deleted_at',
    createdAt: 'created_at',
    createdVia: 'created_via',
    extractedFromFragmentId: 'extracted_from_fragment_id',
    relationship: 'relationship',
    updatedAt: 'updated_at',
  },
  edges: { dstId: 'dst_id', dstType: 'dst_type', deletedAt: 'deleted_at' },
}))

const dbState: {
  selectRows: Record<string, unknown[]>
  updateCaptured: Array<Record<string, unknown>>
  selectIndex: number
} = {
  selectRows: { person: [], count: [{ count: 0 }] },
  updateCaptured: [],
  selectIndex: 0,
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => {
      const idx = dbState.selectIndex++
      return {
        from: () => ({
          where: () => {
            const cur = idx
            const out =
              cur === 0
                ? dbState.selectRows.person
                : dbState.selectRows.count
            return {
              orderBy: () => ({
                limit: () => ({ offset: async () => out }),
              }),
              limit: async () => out,
              [Symbol.iterator]: undefined,
              // biome-ignore lint/suspicious/noThenProperty: thenable test mock
              then: (resolve: (v: unknown) => void) => resolve(out),
            }
          },
        }),
      }
    }),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          dbState.updateCaptured.push(vals)
        },
      }),
    })),
  },
}))

const { adminPeopleRoutes } = await import('./people.js')

beforeEach(() => {
  dbState.selectRows = { person: [], count: [{ count: 0 }] }
  dbState.updateCaptured = []
  dbState.selectIndex = 0
})

describe('admin /people endpoints — Stream P', () => {
  it('GET /admin/people defaults to status=pending', async () => {
    dbState.selectRows.person = [
      {
        lookupKey: 'person01PND',
        slug: 'eric-tan',
        canonicalName: 'Eric Tan',
        name: 'Eric Tan',
        aliases: [],
        status: 'pending',
        createdAt: new Date('2026-05-09'),
        createdVia: 'extractor_pending',
        extractedFromFragmentId: 'frag01',
        relationship: '',
      },
    ]
    dbState.selectRows.count = [{ count: 1 }]
    const res = await adminPeopleRoutes.request('/')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { persons: unknown[]; total: number }
    expect(json.total).toBe(1)
    expect((json.persons[0] as { status: string }).status).toBe('pending')
  })

  it('POST /:lookupKey/approve flips pending -> verified', async () => {
    dbState.selectRows.person = [
      {
        lookupKey: 'person01PND',
        status: 'pending',
        canonicalName: 'Eric',
        createdVia: 'extractor_pending',
      },
    ]
    const res = await adminPeopleRoutes.request('/person01PND/approve', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; promotedAt: string | null }
    expect(json.status).toBe('verified')
    expect(json.promotedAt).toBeTruthy()
    expect(dbState.updateCaptured).toContainEqual(
      expect.objectContaining({ status: 'verified', verified: true })
    )
  })

  it('POST /:lookupKey/approve is idempotent on already-verified', async () => {
    dbState.selectRows.person = [
      {
        lookupKey: 'person01OK',
        status: 'verified',
        canonicalName: 'Sam',
        createdVia: 'mcp_create',
      },
    ]
    const res = await adminPeopleRoutes.request('/person01OK/approve', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { alreadyVerified: boolean }
    expect(json.alreadyVerified).toBe(true)
    expect(dbState.updateCaptured).toHaveLength(0)
  })

  it('POST /:lookupKey/approve returns 404 for missing person', async () => {
    dbState.selectRows.person = []
    const res = await adminPeopleRoutes.request('/person01MISS/approve', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  it('POST /:lookupKey/reject defaults to soft reject (status=rejected)', async () => {
    dbState.selectRows.person = [
      { lookupKey: 'person01PND', status: 'pending', canonicalName: 'Eric' },
    ]
    const res = await adminPeopleRoutes.request('/person01PND/reject', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string }
    expect(json.status).toBe('rejected')
    expect(dbState.updateCaptured).toContainEqual(
      expect.objectContaining({ status: 'rejected' })
    )
  })

  it('POST /:lookupKey/reject with hardDelete=true cascades edges', async () => {
    dbState.selectRows.person = [
      { lookupKey: 'person01PND', status: 'pending', canonicalName: 'Eric' },
    ]
    const res = await adminPeopleRoutes.request('/person01PND/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hardDelete: true }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string }
    expect(json.status).toBe('deleted')
    // The handler should have set deletedAt on both the edges and the
    // person row (two update calls).
    expect(dbState.updateCaptured.length).toBeGreaterThanOrEqual(2)
  })
})
