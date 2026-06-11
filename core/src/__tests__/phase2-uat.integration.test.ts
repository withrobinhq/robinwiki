import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createRedisConnection } from '@robin/queue'
import { validEnvStub } from './helpers/validEnvStub.js'

/**
 * Phase 2 UAT integration tests. One file per the task brief; each `describe`
 * block maps 1:1 to a UAT criterion in PR #304.
 *
 * UAT 1 — boot fails when SERVER_PUBLIC_URL is http:// in production. Already
 *   covered by `bootstrap/__tests__/cookie-gate.test.ts`. We import
 *   `assertProdEnv` here and re-assert the FATAL message so a future refactor
 *   that loses the cookie-gate file still trips this guard.
 *
 * UAT 2 — POST /auth/recover with body { secretKey, newPassword } and a valid
 *   RECOVERY_SECRET returns 200 and writes the new (hashed) password into the
 *   `accounts` table. Full sign-in round-trip requires a live test Postgres; we
 *   `it.todo` that in environments without one.
 *
 * UAT 3 — minute-bucket rate-limit is shared across Redis connections. We
 *   open a fresh ioredis client (NOT the one cached in the rate-limit module),
 *   pre-INCR the minute key to drain the budget, then HTTP into the route.
 *   The 6th call hits the same key via a different connection and 429s.
 *
 * UAT 4 — Redis transport failure on /auth/recover returns 503 (fail-closed).
 *   Achieved by swapping the rate-limit client with a stub whose multi().exec()
 *   throws.
 *
 * UAT 5 — every recover.* audit row carries detail.ip taken from the request's
 *   x-forwarded-for header. We mock the emitAuditEvent seam and assert each
 *   call contains a `detail.ip` field with the expected value.
 *
 * UAT 6 — GET /admin/queues without a session returns 401. Already covered by
 *   `bull-board-auth.test.ts`. We re-import the same handler and pin the
 *   contract here so a future refactor that drops the gate trips this file.
 */

// ── Mocks (declared before dynamic imports) ────────────────────────────────

// `db.execute()` is the single sink for SELECT/UPDATE in auth-recover.ts. The
// mock records every invocation so tests can introspect the SQL fragments.
//
// drizzle's sql`...` template puts string fragments in `queryChunks` as
// `{ value: [literal] }` objects and parameters as bare values interleaved
// between them. To assert "the UPDATE bound the new hashed password", we
// pull every non-StringChunk entry out as a parameter.
const dbExecuteCalls: Array<{ literal: string; params: unknown[] }> = []
const dbExecuteImpl = vi.fn(async (q: unknown) => {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? []
  let literal = ''
  const params: unknown[] = []
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown[] })?.value
    if (Array.isArray(value)) literal += value.join('')
    else params.push(chunk)
  }
  dbExecuteCalls.push({ literal, params })
  // SELECT returns the credential account row. UPDATE ignores the return value.
  return [{ id: 'acct-test-1', user_id: 'user-test-1' }] as never
})

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecuteImpl },
}))

// emitAuditEvent fires from inside the route. We capture every call so UAT 5
// can read off the `detail` payload.
const auditCalls: Array<{ params: Record<string, unknown> }> = []
const emitAuditEventImpl = vi.fn(async (_db: unknown, params: Record<string, unknown>) => {
  auditCalls.push({ params })
})
vi.mock('../db/audit.js', () => ({
  emitAuditEvent: (db: unknown, params: Record<string, unknown>) => emitAuditEventImpl(db, params),
}))

// ── Imports under test (after mocks) ───────────────────────────────────────

const { authRecoverRoutes } = await import('../routes/auth-recover.js')
const { __setRateLimitClient } = await import('../lib/rate-limit.js')
const { sessionMiddleware } = await import('../middleware/session.js')
// NOTE: assertProdEnv is exported from bootstrap/env.ts. Phase 6/04 dropped
// the module-load invocation — the aggregator (assertProdSafety) now owns
// the call site, so plain imports of env.js do not trigger the gate. UAT 1
// invokes assertProdEnv directly to verify the throw contract.

// Mock auth.api.getSession so we don't hit better-auth+postgres for the
// BullBoard 401 check.
vi.mock('../auth.js', () => ({
  auth: { api: { getSession: vi.fn(async () => null) } },
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function buildRecoverApp() {
  const app = new Hono()
  app.route('/auth', authRecoverRoutes)
  return app
}

function buildBullBoardApp() {
  // Stub the bull-board route — we're only locking the 401 contract, not
  // exercising the real dashboard.
  const stub = new Hono()
  stub.get('/', (c) => c.text('ok', 200))
  stub.get('/*', (c) => c.text('ok', 200))

  const app = new Hono()
  app.use('/admin/queues/*', sessionMiddleware)
  app.route('/admin/queues', stub)
  return app
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const RECOVERY_SECRET = 'r'.repeat(48)

// Each test takes a fresh IP so the Redis-backed minute bucket can't bleed
// across cases when the suite runs alongside others (vitest is singleFork —
// the rate-limit module's cached client + Redis keys persist across test
// boundaries within a file run).
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter % 250 + 1}`
}

async function isRedisLive(): Promise<boolean> {
  // createRedisConnection reads REDIS_URL from process.env. Set it explicitly
  // so the probe doesn't accidentally hit a different host than the rest of
  // the suite.
  process.env.REDIS_URL = REDIS_URL
  const probe = createRedisConnection()
  try {
    const reply = await probe.ping()
    return reply === 'PONG'
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
}

let redisLive = false
beforeAll(async () => {
  redisLive = await isRedisLive()
})

beforeEach(() => {
  dbExecuteCalls.length = 0
  auditCalls.length = 0
  emitAuditEventImpl.mockClear()
  dbExecuteImpl.mockClear()
})

afterEach(() => {
  __setRateLimitClient(null)
})

// ───────────────────────────────────────────────────────────────────────────
// UAT 1 — prod + http://SERVER_PUBLIC_URL must FATAL on boot
// ───────────────────────────────────────────────────────────────────────────

describe('UAT 1: assertProdEnv refuses prod + http SERVER_PUBLIC_URL', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
  })

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, originalEnv)
  })

  it('throws ProdSafetyError with the documented message when SERVER_PUBLIC_URL is http://', async () => {
    Object.assign(
      process.env,
      validEnvStub({ SERVER_PUBLIC_URL: 'http://api.example.com' }),
    )

    vi.resetModules()
    const { assertProdEnv, ProdSafetyError } = await import('../bootstrap/env.js')

    expect(() => assertProdEnv()).toThrow(ProdSafetyError)
    expect(() => assertProdEnv()).toThrow(/SERVER_PUBLIC_URL must start with https:\/\//)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// UAT 2 — POST /auth/recover with new body shape updates the password
// ───────────────────────────────────────────────────────────────────────────

describe('UAT 2: POST /auth/recover { secretKey, newPassword }', () => {
  beforeEach(() => {
    process.env.RECOVERY_SECRET = RECOVERY_SECRET
  })
  afterEach(() => {
    delete process.env.RECOVERY_SECRET
  })

  it('returns 200 and writes a hashed newPassword into accounts when secretKey matches', async () => {
    const app = buildRecoverApp()
    const newPassword = 'CorrectHorse9Battery'
    const ip = freshIp()

    const res = await app.request('/auth/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ secretKey: RECOVERY_SECRET, newPassword }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean }
    expect(body.ok).toBe(true)

    // Two execute() calls: SELECT, UPDATE accounts.
    expect(dbExecuteImpl).toHaveBeenCalledTimes(2)
    const selectCall = dbExecuteCalls[0]
    const updateAccountsCall = dbExecuteCalls[1]
    expect(selectCall?.literal).toMatch(/SELECT id, user_id FROM accounts/i)
    expect(updateAccountsCall?.literal).toMatch(/UPDATE accounts SET password/i)

    // The UPDATE binds the hashed password as a parameter, never the cleartext.
    const updateParams = updateAccountsCall!.params.filter(
      (v): v is string => typeof v === 'string',
    )
    expect(updateParams.some((v) => v.length > 0)).toBe(true)
    expect(updateParams.some((v) => v === newPassword)).toBe(false)
    // Account id from the SELECT round-trip is bound in the UPDATE WHERE clause.
    expect(updateParams).toContain('acct-test-1')

    // recover.success audit event fired.
    const successAudit = auditCalls.find(
      (c) => (c.params as { eventType?: string }).eventType === 'recover.success',
    )
    expect(successAudit).toBeDefined()
  })

  it.todo(
    'sign-in with newPassword succeeds end-to-end (requires live Postgres + better-auth)',
  )
})

// ───────────────────────────────────────────────────────────────────────────
// UAT 3 — Redis-backed rate-limit, cross-connection counter
// ───────────────────────────────────────────────────────────────────────────

describe('UAT 3: rate limit shares state across Redis connections', () => {
  beforeEach(() => {
    process.env.RECOVERY_SECRET = RECOVERY_SECRET
  })
  afterEach(() => {
    delete process.env.RECOVERY_SECRET
  })

  it('returns 429 with Retry-After on the 6th request when a separate ioredis client pre-INCRs the minute key', async () => {
    if (!redisLive) {
      // Skip rather than fake — see task constraint.
      return
    }

    // Connection A: drain the minute budget (5 INCRs).
    process.env.REDIS_URL = REDIS_URL
    const clientA = createRedisConnection()
    const minute = Math.floor(Date.now() / 60_000)
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`
    const minuteKey = `rl:recover:${ip}:m:${minute}`
    const dayKey = `rl:recover:${ip}:d:${Math.floor(Date.now() / 86_400_000)}`

    try {
      // Wipe in case a stale key from a prior run lingers.
      await clientA.del(minuteKey, dayKey)
      // 5 INCRs over connection A — enough that the 6th lands over budget.
      const pipeline = clientA.multi()
      for (let i = 0; i < 5; i++) pipeline.incr(minuteKey)
      pipeline.expire(minuteKey, 65)
      await pipeline.exec()

      // Force the rate-limit module to allocate a fresh connection (B). The
      // singleton is reset in the outer afterEach, but reset here to prove the
      // route's connection is not the same object as clientA.
      __setRateLimitClient(null)

      const app = buildRecoverApp()
      const res = await app.request('/auth/recover', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ secretKey: RECOVERY_SECRET, newPassword: 'whatever12abcd' }),
      })

      expect(res.status).toBe(429)
      const retryAfter = res.headers.get('Retry-After')
      expect(retryAfter).not.toBeNull()
      expect(Number(retryAfter)).toBeGreaterThan(0)
    } finally {
      await clientA.del(minuteKey, dayKey)
      clientA.disconnect()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// UAT 4 — Redis transport failure → 503 fail-closed
// ───────────────────────────────────────────────────────────────────────────

describe('UAT 4: Redis down on /auth/recover returns 503', () => {
  beforeEach(() => {
    process.env.RECOVERY_SECRET = RECOVERY_SECRET
  })
  afterEach(() => {
    delete process.env.RECOVERY_SECRET
  })

  it('returns 503 when the rate-limiter Redis client throws on multi().exec()', async () => {
    // Stub client whose multi().exec() rejects — same shape that bullmq sees
    // when the Redis socket drops mid-request.
    const failingClient = {
      multi() {
        return {
          incr() {
            return this
          },
          expire() {
            return this
          },
          async exec(): Promise<never> {
            throw new Error('CONN refused (simulated)')
          },
        }
      },
      async ttl(): Promise<number> {
        return -2
      },
    } as never
    __setRateLimitClient(failingClient)

    const app = buildRecoverApp()
    const ip = freshIp()
    const res = await app.request('/auth/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ secretKey: RECOVERY_SECRET, newPassword: 'whatever12abcd' }),
    })

    expect(res.status).toBe(503)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// UAT 5 — audit_log rows for recover.* carry detail.ip
// ───────────────────────────────────────────────────────────────────────────

describe('UAT 5: recover.* audit rows include detail.ip', () => {
  beforeEach(() => {
    process.env.RECOVERY_SECRET = RECOVERY_SECRET
  })
  afterEach(() => {
    delete process.env.RECOVERY_SECRET
  })

  it('emits recover.bad-secret with detail.ip from x-forwarded-for', async () => {
    const app = buildRecoverApp()
    const ip = freshIp()
    const res = await app.request('/auth/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ secretKey: 'wrong-secret-totally', newPassword: 'whatever12abcd' }),
    })

    expect(res.status).toBe(403)

    const badSecret = auditCalls.find(
      (c) => (c.params as { eventType?: string }).eventType === 'recover.bad-secret',
    )
    expect(badSecret).toBeDefined()
    expect(badSecret!.params.entityType).toBe('auth')
    const detail = badSecret!.params.detail as Record<string, unknown> | undefined
    expect(detail).toBeDefined()
    expect(detail!.ip).toBe(ip)
  })

  it('emits recover.success with detail.ip on a valid recovery', async () => {
    const app = buildRecoverApp()
    const ip = freshIp()
    await app.request('/auth/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ secretKey: RECOVERY_SECRET, newPassword: 'CorrectHorse9Battery' }),
    })

    const success = auditCalls.find(
      (c) => (c.params as { eventType?: string }).eventType === 'recover.success',
    )
    expect(success).toBeDefined()
    const detail = success!.params.detail as Record<string, unknown> | undefined
    expect(detail).toBeDefined()
    expect(detail!.ip).toBe(ip)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// UAT 6 — GET /admin/queues unauthenticated → 401
// ───────────────────────────────────────────────────────────────────────────

describe('UAT 6: BullBoard auth gate', () => {
  it('returns 401 on GET /admin/queues without a session', async () => {
    const app = buildBullBoardApp()
    const res = await app.request('/admin/queues')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('Unauthorized')
  })
})

afterAll(() => {
  // Ensure no leaked rate-limit client across files.
  __setRateLimitClient(null)
})
