import { createRedisConnection } from '@robin/queue'
import { logger } from './logger.js'

type RedisClient = ReturnType<typeof createRedisConnection>

const log = logger.child({ component: 'rate-limit' })

/**
 * Redis-backed per-key rate limiter for /auth/recover (Plan 02 / SEC-M3).
 *
 * Uses fixed-window counters via INCR + EXPIRE inside a single MULTI so the
 * counter survives process restarts and is shared across the gateway/worker
 * split. Returns fail-closed on any Redis transport error so a Redis outage
 * cannot widen the budget.
 *
 * Trust model: the caller-supplied `key` typically embeds an IP derived from
 * `x-forwarded-for`. Running outside a trusted reverse proxy makes this
 * spoofable — see DEPLOY.md for the deployment requirement.
 */

export interface RateLimitResult {
  allowed: boolean
  reason?: 'minute' | 'day' | 'redis-down'
  retryAfterSec?: number
}

let client: RedisClient | null = null

function getClient(): RedisClient {
  if (!client) {
    client = createRedisConnection()
  }
  return client
}

/** Test-only: replace the cached client (used by single-process tests). */
export function __setRateLimitClient(c: RedisClient | null): void {
  client = c
}

export async function checkRateLimit(opts: {
  key: string
  perMinute: number
  perDay: number
}): Promise<RateLimitResult> {
  const { key, perMinute, perDay } = opts
  const minuteKey = `rl:${key}:m:${Math.floor(Date.now() / 60_000)}`
  const dayKey = `rl:${key}:d:${Math.floor(Date.now() / 86_400_000)}`

  const c = getClient()
  let replies: Array<[Error | null, unknown]> | null
  try {
    // 4 queued commands -> 4 reply tuples. INCR replies are at indices 0
    // (minute) and 2 (day); EXPIRE replies at 1 and 3 are ignored. The 60s
    // grace on each TTL keeps a clock-skew increment from orphaning a key.
    replies = (await c
      .multi()
      .incr(minuteKey)
      .expire(minuteKey, 65)
      .incr(dayKey)
      .expire(dayKey, 86_400 + 60)
      .exec()) as Array<[Error | null, unknown]> | null
  } catch (err) {
    log.error({ err, key }, 'rate-limit redis error — failing closed')
    return { allowed: false, reason: 'redis-down' }
  }

  if (replies === null) {
    log.error({ key }, 'rate-limit redis pipeline returned null — failing closed')
    return { allowed: false, reason: 'redis-down' }
  }

  const minuteCount = Number(replies[0]?.[1])
  const dayCount = Number(replies[2]?.[1])

  if (Number.isNaN(minuteCount) || Number.isNaN(dayCount)) {
    log.error({ key, replies }, 'rate-limit got non-numeric INCR reply — failing closed')
    return { allowed: false, reason: 'redis-down' }
  }

  if (minuteCount > perMinute) {
    const retryAfterSec = Math.max(1, 60 - Math.floor((Date.now() % 60_000) / 1000))
    return { allowed: false, reason: 'minute', retryAfterSec }
  }

  if (dayCount > perDay) {
    let ttlSec = await c.ttl(dayKey).catch(() => -2)
    if (ttlSec < 1) {
      ttlSec = Math.max(1, 86_400 - Math.floor((Date.now() % 86_400_000) / 1000))
    }
    return { allowed: false, reason: 'day', retryAfterSec: ttlSec }
  }

  return { allowed: true }
}
