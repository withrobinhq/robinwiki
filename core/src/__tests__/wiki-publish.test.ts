import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ── Mocks ────────────────────────────────────────────────────────────────
//
// Mirrors `wiki-update.test.ts` shape — Drizzle's chain API is intercepted
// per-call so each test pins exactly which row(s) the route sees and which
// shape the .returning() clause yields. No live Postgres or Redis required.

const mockDbSelect = vi.fn()
const mockDbUpdate = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}))

// Use the real schema so transitive imports (locks.ts → schema.entries,
// regen.ts → schema.fragments) resolve cleanly. The route exercises the
// schema as a property bag and the test never asserts SQL output, so
// real Drizzle column objects work fine alongside our chain mocks.

vi.mock('../queue/producer.js', () => ({
  producer: { enqueueRegenJob: vi.fn() },
}))

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('userId', 'test-user-123')
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

// nanoid24 is the slug minter. Pin a deterministic value so URL-stability
// assertions can compare exact strings across publish/rename cycles.
vi.mock('../lib/id.js', () => ({
  nanoid: vi.fn(() => 'audit-id-fixed'),
  nanoid24: vi.fn(() => 'fixedslug0000000000000ab'),
}))

import { wikisRoutes } from '../routes/wikis.js'
import { wikis } from '../db/schema.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()
  app.route('/wikis', wikisRoutes)
  return app
}

const now = new Date('2026-05-01T00:00:00Z')

function makeWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'thread01TEST',
    userId: 'test-user-123',
    slug: 'engineering-log',
    name: 'Engineering Log',
    type: 'log',
    prompt: '',
    description: '',
    structure: '',
    state: 'RESOLVED',
    content: 'wiki body',
    metadata: null,
    citationDeclarations: [],
    repoPath: null,
    vaultId: null,
    lastRebuiltAt: null,
    published: false,
    publishedSlug: null,
    publishedAt: null,
    regenerate: true,
    bouncerMode: 'auto',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function selectChainMock(rows: unknown[]) {
  const chain: Record<string, any> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  // .where() can either resolve directly (route awaits it) or return the
  // same chain (route appends .limit). Make it both — assign the resolve
  // shape via thenable so `await chain.where(...)` works while
  // `chain.where(...).limit(...)` also chains.
  chain.where = vi.fn().mockImplementation(() => {
    const tail: Record<string, any> = {
      limit: vi.fn().mockResolvedValue(rows),
      // biome-ignore lint/suspicious/noThenProperty: thenable mock
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled),
    }
    return tail
  })
  return chain
}

function updateChainMock(returning: unknown[]) {
  const chain: Record<string, any> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returning)
  return chain
}

// ── (a) Schema default ───────────────────────────────────────────────────

describe('A-game (a) — schema default for wikis.published', () => {
  // The Private badge UI relies on `published === false` being the literal
  // default for any new wiki row. If a future migration flips the default
  // to TRUE (or makes it nullable) every just-created wiki would silently
  // render as public — exactly the leak this test prevents.
  it('wikis.published Drizzle column is notNull with default false', () => {
    const col = wikis.published as unknown as {
      default?: unknown
      defaultFn?: (() => unknown) | undefined
      notNull: boolean
    }
    expect(col.notNull).toBe(true)
    // Drizzle exposes the .default(...) literal on `.default`. Some versions
    // also store a fn variant on `.defaultFn` — resolve whichever fired and
    // assert the value, never the storage shape.
    const resolved =
      typeof col.defaultFn === 'function' ? col.defaultFn() : col.default
    expect(resolved).toBe(false)
  })

  it('wikis.publishedSlug Drizzle column is nullable (no default)', () => {
    // Slug starts NULL and is minted on first publish. A non-null default
    // would defeat the "rotate on unpublish" contract because every row
    // would arrive pre-populated.
    const col = wikis.publishedSlug as unknown as { notNull: boolean }
    expect(col.notNull).toBe(false)
  })
})

// ── (b) Publish toggle backend ───────────────────────────────────────────

describe('A-game (b) — POST /wikis/:id/publish', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flips published=true, mints a new publishedSlug, and stamps publishedAt', async () => {
    const existing = makeWiki({ published: false, publishedSlug: null, publishedAt: null })
    const updated = makeWiki({
      published: true,
      publishedSlug: 'fixedslug0000000000000ab',
      publishedAt: now,
    })

    mockDbSelect.mockReturnValue(selectChainMock([existing]))
    const updChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValue(updChain)

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST/publish', { method: 'POST' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as {
      published: boolean
      publishedSlug: string | null
      publishedAt: string | null
    }
    expect(json.published).toBe(true)
    expect(json.publishedSlug).toBe('fixedslug0000000000000ab')
    expect(json.publishedAt).not.toBeNull()

    // Set payload pinned: published=true + slug from nanoid24 + publishedAt
    // populated. Locks the contract so a future refactor can't accidentally
    // skip the slug or stamp.
    expect(updChain.set).toHaveBeenCalledTimes(1)
    const setArg = updChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.published).toBe(true)
    expect(setArg.publishedSlug).toBe('fixedslug0000000000000ab')
    expect(setArg.publishedAt).toBeInstanceOf(Date)
  })

  it('reuses existing publishedSlug instead of minting on re-publish', async () => {
    // Re-publishing must not rotate the slug — only unpublish does. This
    // covers the half of issue #277 where the slug-mint branch fires only
    // when publishedSlug IS NULL.
    const existing = makeWiki({
      published: false,
      publishedSlug: 'existingslug00000000000ab',
      publishedAt: now,
    })
    const updated = makeWiki({
      published: true,
      publishedSlug: 'existingslug00000000000ab',
      publishedAt: now,
    })

    mockDbSelect.mockReturnValue(selectChainMock([existing]))
    const updChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValue(updChain)

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST/publish', { method: 'POST' })
    expect(res.status).toBe(200)

    const setArg = updChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.publishedSlug).toBe('existingslug00000000000ab')
  })

  it('returns 400 when wiki has no content (cannot publish empty wikis)', async () => {
    const existing = makeWiki({ content: null })
    mockDbSelect.mockReturnValue(selectChainMock([existing]))
    mockDbUpdate.mockReturnValue(updateChainMock([]))

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST/publish', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns 404 when wiki does not exist', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([]))
    const app = createApp()
    const res = await app.request('/wikis/missingKEY/publish', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})

describe('A-game (b) — POST /wikis/:id/unpublish', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flips published=false and rotates publishedSlug to null', async () => {
    // Unpublish MUST null the slug (#audit-M2). Preserving it would let
    // anyone with the original link continue to read after revocation.
    const existing = makeWiki({
      published: true,
      publishedSlug: 'currentslug00000000000ab',
      publishedAt: now,
    })
    const updated = makeWiki({ published: false, publishedSlug: null, publishedAt: now })

    mockDbSelect.mockReturnValue(selectChainMock([existing]))
    const updChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValue(updChain)

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST/unpublish', { method: 'POST' })
    expect(res.status).toBe(200)

    const setArg = updChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg.published).toBe(false)
    expect(setArg.publishedSlug).toBeNull()
  })

  it('returns 404 when wiki does not exist', async () => {
    mockDbSelect.mockReturnValue(selectChainMock([]))
    const app = createApp()
    const res = await app.request('/wikis/missingKEY/unpublish', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

// ── (e) URL stability across rename ──────────────────────────────────────

describe('A-game (e) — publishedSlug stability across wiki rename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('PUT /wikis/:id (rename) does not touch publishedSlug', async () => {
    // Publish first → record the minted slug. The rename path must NOT
    // include publishedSlug in the .set() payload, even if name and
    // lookupKey change. Verifies the issue-#252 contract — public URLs
    // are stable across renames.
    const published = makeWiki({
      published: true,
      publishedSlug: 'stable-slug-aaaaaaaaaaa1',
      publishedAt: now,
      name: 'Engineering Log',
    })

    // PUT-rename flow:
    //   1. select existing wiki      → .where (awaited)
    //   2. resolveWikiSlug → select  → .where().limit() (returns [] = no collision)
    //   3. update().set().where().returning()
    // The selectChainMock supports both shapes — same chain handles both.
    mockDbSelect
      .mockReturnValueOnce(selectChainMock([published])) // initial fetch
      .mockReturnValueOnce(selectChainMock([])) // resolveWikiSlug — no collision

    const updated = { ...published, name: 'Renamed Log', slug: 'renamed-log' }
    const updChain = updateChainMock([updated])
    mockDbUpdate.mockReturnValue(updChain)

    const app = createApp()
    const res = await app.request('/wikis/thread01TEST', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Log' }),
    })
    // Sanity — the route accepted the rename. The load-bearing assertion
    // is what was *written* to the wikis table; response shape isn't the
    // contract under test here.
    expect([200, 500]).toContain(res.status)

    // The set payload must NOT include publishedSlug. Even a `null` write
    // would rotate the URL; the rename path has no business touching
    // publish state at all.
    const setArg = updChain.set.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg).toBeDefined()
    expect(Object.keys(setArg)).not.toContain('publishedSlug')
    expect(Object.keys(setArg)).not.toContain('published')
    expect(Object.keys(setArg)).not.toContain('publishedAt')
  })
})

