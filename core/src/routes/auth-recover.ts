import { timingSafeEqual } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { emitAuditEvent } from '../db/audit.js'
import { db } from '../db/client.js'
import { getClientIp } from '../lib/getClientIp.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ component: 'auth-recover' })

// In-memory rate limiter (sufficient for single-tenant). Plan 02 replaces
// this with a Redis-backed counter — do not extend this here.
const attempts: { ts: number }[] = []
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5

function isRateLimited(): boolean {
  const now = Date.now()
  // Purge expired entries
  while (attempts.length > 0 && now - attempts[0].ts > WINDOW_MS) {
    attempts.shift()
  }
  if (attempts.length >= MAX_ATTEMPTS) return true
  attempts.push({ ts: now })
  return false
}

/** Constant-time comparison of two strings (prevents timing attacks on secret). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Server-side password policy. Mirror of the wiki client-side guard, but the
 * server is the only enforced check. Generic — failures return a single 400
 * shape so an attacker cannot distinguish bad-secret from bad-password.
 */
function validateNewPassword(p: string): boolean {
  if (p.length < 12) return false
  if (!/[A-Za-z]/.test(p)) return false
  if (!/[0-9]/.test(p)) return false
  return true
}

export const authRecoverRoutes = new Hono()

authRecoverRoutes.post('/recover', async (c) => {
  const ip = getClientIp(c)
  const ts = new Date().toISOString()

  if (isRateLimited()) {
    log.warn({ ip }, 'rate limit exceeded on /auth/recover')
    await emitAuditEvent(db, {
      entityType: 'auth',
      entityId: 'unknown',
      eventType: 'recover.rate-limited',
      source: 'http',
      summary: 'Recovery rate-limited',
      detail: { ip, ts },
    })
    return c.json({ error: 'Too many attempts. Try again in 1 minute.' }, 429)
  }

  let body: { secretKey?: string; newPassword?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (!body.secretKey || !body.newPassword) {
    log.warn({ ip }, 'missing field in /auth/recover request')
    await emitAuditEvent(db, {
      entityType: 'auth',
      entityId: 'unknown',
      eventType: 'recover.bad-password',
      source: 'http',
      summary: 'Recovery rejected: missing field',
      detail: { ip, ts },
    })
    return c.json({ error: 'Invalid request' }, 400)
  }

  const serverSecret = process.env.RECOVERY_SECRET
  if (!serverSecret) {
    log.error('RECOVERY_SECRET not set — cannot process recovery')
    return c.json({ error: 'Server misconfigured' }, 500)
  }

  if (!safeEqual(body.secretKey, serverSecret)) {
    log.warn({ ip }, 'invalid secret key attempt on /auth/recover')
    await emitAuditEvent(db, {
      entityType: 'auth',
      entityId: 'unknown',
      eventType: 'recover.bad-secret',
      source: 'http',
      summary: 'Recovery rejected: bad secret',
      detail: { ip, ts },
    })
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (!validateNewPassword(body.newPassword)) {
    log.warn({ ip }, 'newPassword failed policy on /auth/recover')
    await emitAuditEvent(db, {
      entityType: 'auth',
      entityId: 'unknown',
      eventType: 'recover.bad-password',
      source: 'http',
      summary: 'Recovery rejected: password policy',
      detail: { ip, ts },
    })
    return c.json({ error: 'Invalid request' }, 400)
  }

  const hashed = await hashPassword(body.newPassword)

  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM accounts WHERE provider_id = 'credential' LIMIT 1`
  )
  const account = rows[0]
  if (!account) {
    log.error({ ip }, 'no credential account found for password reset')
    await emitAuditEvent(db, {
      entityType: 'auth',
      entityId: 'unknown',
      eventType: 'recover.no-account',
      source: 'http',
      summary: 'Recovery rejected: no credential account',
      detail: { ip, ts },
    })
    return c.json({ error: 'No account found' }, 404)
  }

  await db.execute(
    sql`UPDATE accounts SET password = ${hashed} WHERE id = ${account.id}`
  )

  log.info({ accountId: account.id, ip }, 'password recovery succeeded')
  await emitAuditEvent(db, {
    entityType: 'auth',
    entityId: account.id,
    eventType: 'recover.success',
    source: 'http',
    summary: 'Password recovery succeeded',
    detail: { ip, ts },
  })

  return c.json({ ok: true, message: 'Password reset' })
})
