/**
 * #239 — Default fragment naming: UTC YYMMDD prefix on every fragment title.
 *
 * Single source of truth for the title prefix rule applied at every
 * fragment-creation site (worker pipeline, MCP `log_fragment` handler,
 * HTTP `POST /fragments` route).
 *
 * Cluster 8's `wiki/src/lib/autoDatePrefix.ts` adds a `YYMMDD: ` prefix
 * to short capture *bodies* sent through AddEntry's send-direct path. That
 * helper lives in the wiki workspace (frontend) and operates on bodies.
 * #239 is about the *title* on the *server* side — and applies regardless
 * of body length. Different problem, different module, but same date
 * format and same idempotence rules.
 *
 * The format is `YYMMDD - <title>` (note the space-dash-space separator,
 * matching the issue spec). If a title already opens with a date-shaped
 * prefix the helper is a no-op so we never double-prefix when an LLM
 * already emitted a date.
 */

const HAS_DATE_PREFIX = new RegExp(
  [
    // YYYY-MM-DD or YYYY/MM/DD
    '^\\s*\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b',
    // YY-MM-DD or YY/MM/DD or YYMMDD
    '^\\s*\\d{2}[-/]?\\d{2}[-/]?\\d{2}\\b',
    // 4 May 2026, 4-May-2026, 4 May, 04 May
    '^\\s*\\d{1,2}[\\s-]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)',
    // ISO timestamps
    '^\\s*\\d{4}-\\d{2}-\\d{2}T',
  ].join('|'),
  'i',
)

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** UTC YYMMDD — matches the cluster-8 wiki helper. */
export function utcYymmdd(now: Date = new Date()): string {
  const yy = pad2(now.getUTCFullYear() % 100)
  const mm = pad2(now.getUTCMonth() + 1)
  const dd = pad2(now.getUTCDate())
  return `${yy}${mm}${dd}`
}

/**
 * Returns the (possibly prefixed) fragment title. No-op when:
 *  - the title is empty / whitespace-only
 *  - the title already opens with a date-shaped prefix
 *
 * Format: `YYMMDD - <title>` (space, hyphen, space — matches issue #239).
 */
export function applyFragmentTitleDatePrefix(
  title: string,
  now: Date = new Date()
): string {
  if (!title) return title
  const trimmed = title.trimStart()
  if (trimmed.length === 0) return title
  if (HAS_DATE_PREFIX.test(trimmed)) return title
  return `${utcYymmdd(now)} - ${trimmed}`
}
