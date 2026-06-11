import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

/**
 * CSRF Origin check in sessionMiddleware.
 *
 * sessionMiddleware now rejects POST/PUT/PATCH/DELETE requests whose Origin
 * header is present but not in the allowed-origins set (production only).
 * These tests cover the five cases from plan 004.
 *
 * Structural pattern: mock auth exactly as bull-board-auth.test.ts does so
 * the mock intercepts the same dynamic import of ../auth.js.
 */

let sessionResult: unknown = null
vi.mock('../auth.js', () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => sessionResult),
    },
  },
}))

function buildApp() {
  const app = new Hono()
  app.use('/*', sessionMiddleware)
  app.post('/', (c) => c.text('ok', 200))
  app.get('/', (c) => c.text('ok', 200))
  return app
}

const { sessionMiddleware } = await import('../middleware/session.js')

describe('sessionMiddleware — CSRF Origin check', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalWikiOrigin = process.env.WIKI_ORIGIN
  const originalServerUrl = process.env.SERVER_PUBLIC_URL

  beforeEach(() => {
    sessionResult = {
      user: { id: 'user-1', email: 'user@example.com' },
      session: { id: 'sess-1' },
    }
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.WIKI_ORIGIN = originalWikiOrigin
    process.env.SERVER_PUBLIC_URL = originalServerUrl
  })

  it('case 1: POST with evil Origin in production is rejected with 403', async () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKI_ORIGIN = 'https://wiki.example'
    process.env.SERVER_PUBLIC_URL = 'https://api.example'

    const app = buildApp()
    const res = await app.request('/', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('Forbidden — cross-origin request rejected')
  })

  it('case 2: POST with allowlisted Origin in production passes through', async () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKI_ORIGIN = 'https://wiki.example'
    process.env.SERVER_PUBLIC_URL = 'https://api.example'

    const app = buildApp()
    const res = await app.request('/', {
      method: 'POST',
      headers: { origin: 'https://wiki.example' },
    })
    expect(res.status).toBe(200)
  })

  it('case 3: POST with no Origin header passes through', async () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKI_ORIGIN = 'https://wiki.example'
    process.env.SERVER_PUBLIC_URL = 'https://api.example'

    const app = buildApp()
    const res = await app.request('/', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('case 4: GET with evil Origin passes through (reads unaffected)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.WIKI_ORIGIN = 'https://wiki.example'
    process.env.SERVER_PUBLIC_URL = 'https://api.example'

    const app = buildApp()
    const res = await app.request('/', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
  })

  it('case 5: non-prod — POST with arbitrary Origin passes through (dev-reflect parity)', async () => {
    process.env.NODE_ENV = 'development'
    process.env.WIKI_ORIGIN = 'https://wiki.example'
    process.env.SERVER_PUBLIC_URL = 'https://api.example'

    const app = buildApp()
    const res = await app.request('/', {
      method: 'POST',
      headers: { origin: 'https://totally-unknown.local' },
    })
    expect(res.status).toBe(200)
  })
})
