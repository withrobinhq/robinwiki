/**
 * #235 — Auto-date-prefix for short captures sent directly to a wiki.
 *
 * When a user picks a target wiki and types a body shorter than 120 chars
 * with no leading date pattern, prepend `YYMMDD: ` (UTC). The format is
 * compact so it doesn't dominate the rendered chronological-table row, but
 * still gives Quill (the writer agent) a date anchor to slot the line by.
 *
 * The regex is intentionally generous: anything that already opens with a
 * date-shaped prefix (YYYY-MM-DD, YY-MM-DD, YYMMDD, "DD Mmm YYYY", etc.) is
 * left alone. We don't try to *correct* broken-but-date-shaped prefixes —
 * leave that to humans.
 */
const SHORT_BODY_THRESHOLD = 120;

const HAS_DATE_PREFIX = new RegExp(
  [
    // YYYY-MM-DD or YYYY/MM/DD
    "^\\s*\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b",
    // YY-MM-DD or YY/MM/DD or YYMMDD
    "^\\s*\\d{2}[-/]?\\d{2}[-/]?\\d{2}\\b",
    // 4 May 2026, 4-May-2026, 4 May, 04 May
    "^\\s*\\d{1,2}[\\s-]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)",
    // ISO timestamps
    "^\\s*\\d{4}-\\d{2}-\\d{2}T",
  ].join("|"),
  "i",
);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** UTC YYMMDD — matches what fork commit aca5853 ships. */
export function utcYymmdd(now: Date = new Date()): string {
  const yy = pad2(now.getUTCFullYear() % 100);
  const mm = pad2(now.getUTCMonth() + 1);
  const dd = pad2(now.getUTCDate());
  return `${yy}${mm}${dd}`;
}

/**
 * Returns the (possibly prefixed) capture text. No-op when:
 *  - the body is empty
 *  - the body is longer than the short-capture threshold
 *  - the body already opens with a date-shaped prefix
 */
export function autoDatePrefix(body: string, now: Date = new Date()): string {
  if (!body) return body;
  const trimmed = body.trimStart();
  if (trimmed.length === 0) return body;
  if (trimmed.length > SHORT_BODY_THRESHOLD) return body;
  if (HAS_DATE_PREFIX.test(trimmed)) return body;
  return `${utcYymmdd(now)}: ${trimmed}`;
}
