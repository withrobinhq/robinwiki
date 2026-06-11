/**
 * Single source of truth for the server's allowed-origin set.
 *
 * Used by both the CORS middleware (core/src/index.ts) and the CSRF Origin
 * check in sessionMiddleware. Keeping them in sync here means adding a second
 * frontend origin to WIKI_ORIGIN is sufficient — both gates pick it up
 * automatically.
 *
 * Build order: WIKI_ORIGIN entries (comma-separated, defaults to the two local
 * dev ports) plus SERVER_PUBLIC_URL (defaults to the API's own dev port).
 */
export function getAllowedOrigins(): Set<string> {
  const origins = new Set(
    (process.env.WIKI_ORIGIN ?? 'http://localhost:8080,http://localhost:3001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  origins.add(process.env.SERVER_PUBLIC_URL ?? 'http://localhost:3000')
  return origins
}
