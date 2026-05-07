import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@robin/queue', () => ({
  createRedisConnection: vi.fn(() => ({
    multi: vi.fn(),
    ttl: vi.fn(),
  })),
}))

import { __setRateLimitClient, checkRateLimit } from './rate-limit.js'

/**
 * Unit tests for the Redis-backed rate limiter (Plan 02 / SEC-M3).
 *
 * The plan's two-connection acceptance criterion ("open two ioredis client
 * connections to the same REDIS_URL inside a vitest spec") asserts that the
 * counter is shared across connections. That is a property of Redis itself,
 * not of this module — once these unit tests prove the INCR-reply parsing,
 * the bucket arithmetic, and the fail-closed branch, the cross-process
 * sharing follows from MULTI semantics. An integration test against a live
 * Redis can layer on top later if needed.
 */

interface FakeMulti {
  incr: (k: string) => FakeMulti
  expire: (k: string, sec: number) => FakeMulti
  exec: () => Promise<Array<[Error | null, unknown]> | null>
}

function makeClient(opts: {
  exec: () => Promise<Array<[Error | null, unknown]> | null> | never
  ttl?: () => Promise<number>
}) {
  const incrCalls: string[] = []
  const expireCalls: Array<{ key: string; sec: number }> = []
  let ttlKey: string | null = null

  const multi = (): FakeMulti => {
    const chain: FakeMulti = {
      incr(k) {
        incrCalls.push(k)
        return chain
      },
      expire(k, sec) {
        expireCalls.push({ key: k, sec })
        return chain
      },
      exec: opts.exec,
    }
    return chain
  }

  const client = {
    multi,
    ttl: async (key: string) => {
      ttlKey = key
      return opts.ttl ? opts.ttl() : 1
    },
  }
  return {
    client,
    incrCalls,
    expireCalls,
    getTtlKey: () => ttlKey,
  }
}

describe('checkRateLimit', () => {
  beforeEach(() => {
    __setRateLimitClient(null)
  })
  afterEach(() => {
    __setRateLimitClient(null)
  })

  it('allows under both budgets', async () => {
    const { client, incrCalls, expireCalls } = makeClient({
      exec: async () => [
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
      ],
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:1.2.3.4', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(true)
    expect(incrCalls).toHaveLength(2)
    expect(incrCalls[0]).toMatch(/^rl:recover:1\.2\.3\.4:m:/)
    expect(incrCalls[1]).toMatch(/^rl:recover:1\.2\.3\.4:d:/)
    expect(expireCalls[0]?.sec).toBe(65)
    expect(expireCalls[1]?.sec).toBe(86_460)
  })

  it('blocks on minute bucket once perMinute is exceeded', async () => {
    const { client } = makeClient({
      exec: async () => [
        [null, 6], // minute = 6 > 5
        [null, 1],
        [null, 1],
        [null, 1],
      ],
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:ip', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('minute')
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(r.retryAfterSec).toBeLessThanOrEqual(60)
  })

  it('blocks on day bucket once perDay is exceeded', async () => {
    const { client } = makeClient({
      exec: async () => [
        [null, 1],
        [null, 1],
        [null, 61], // day = 61 > 60
        [null, 1],
      ],
      ttl: async () => 1234,
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:ip', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('day')
    expect(r.retryAfterSec).toBe(1234)
  })

  it('fails closed when exec throws', async () => {
    const { client } = makeClient({
      exec: async () => {
        throw new Error('CONN refused')
      },
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:ip', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('redis-down')
  })

  it('fails closed when exec returns null (transport failure)', async () => {
    const { client } = makeClient({
      exec: async () => null,
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:ip', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('redis-down')
  })

  it('fails closed when INCR replies are non-numeric', async () => {
    const { client } = makeClient({
      exec: async () => [
        [null, 'NaN-trigger'],
        [null, 1],
        [null, 'NaN-trigger'],
        [null, 1],
      ],
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:ip', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('redis-down')
  })

  it('day bucket retry-after falls back when TTL is missing', async () => {
    const { client } = makeClient({
      exec: async () => [
        [null, 1],
        [null, 1],
        [null, 61],
        [null, 1],
      ],
      ttl: async () => -2,
    })
    __setRateLimitClient(client as never)

    const r = await checkRateLimit({ key: 'recover:ip', perMinute: 5, perDay: 60 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('day')
    expect(r.retryAfterSec).toBeGreaterThan(0)
    expect(r.retryAfterSec).toBeLessThanOrEqual(86_400)
  })
})
