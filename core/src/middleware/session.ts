import type { MiddlewareHandler } from 'hono'
import { auth } from '../auth.js'
import { getAllowedOrigins } from '../lib/allowed-origins.js'

// Attach better-auth session to Hono context.
// Note: post-M2 single-user collapse, route handlers no longer use `userId`
// for filtering domain queries — it remains on context only for auth checks
// (e.g. mutating the user row, signing MCP tokens, crypto envelope reads).
//
// CSRF defence: session cookies are issued SameSite=None; Secure in production
// (cross-origin Railway deployment). The browser therefore attaches them to
// *any* cross-site request — including "simple" POSTs that bypass CORS
// preflight. Reject state-changing requests (POST/PUT/PATCH/DELETE) whose
// Origin header is present but not in the allowlist. Absent Origin is allowed
// so non-browser clients (MCP bearer, CLI, server-side fetches) are unaffected.
// In non-production, any present Origin passes (dev-reflect parity with CORS).
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const sessionMiddleware: MiddlewareHandler = async (c, next) => {
  const isProd = process.env.NODE_ENV === 'production'

  if (STATE_CHANGING_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin')
    if (origin !== undefined && isProd && !getAllowedOrigins().has(origin)) {
      return c.json({ error: 'Forbidden — cross-origin request rejected' }, 403)
    }
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  c.set('userId', session.user.id)
  c.set('user', session.user)
  await next()
}
