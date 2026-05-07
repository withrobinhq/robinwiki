import type { Context } from 'hono'

/**
 * Best-effort client-IP derivation for audit logging and rate limiting.
 *
 * Reads x-forwarded-for first (taking the leftmost entry — that's the original
 * caller per RFC 7239), then x-real-ip, then 'unknown'. Trusts the upstream
 * proxy to set XFF — running outside a trusted reverse proxy makes this
 * spoofable. See DEPLOY.md for the deployment requirement.
 *
 * Both /auth/recover audit logging and the rate limiter MUST read IP through
 * this helper so they agree on identity.
 */
export function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  )
}
