import * as fuzz from 'fuzzball'

/**
 * Stream P helper — fuzzy dedup against existing people regardless of
 * status. The extractor surfaces every person-like mention as either
 * a matched (verified KNOWN) or candidate (unknown) entry. Before we
 * mint a new pending row for a candidate, we check whether the
 * mention already maps to an existing verified or pending person via
 * canonical name or alias. This keeps the pending tray free of
 * duplicates when the same name shows up in multiple fragments.
 *
 * Different from `resolvePerson` in entity-extract.ts: that helper
 * loads only verified persons (via `loadAllPeople`) and is tuned for
 * the matcher pass. This helper takes both verified and pending
 * candidates and is the second-chance dedup before a candidate
 * becomes a new pending row.
 */

export interface DedupCandidate {
  lookupKey: string
  canonicalName: string
  aliases: string[]
  status: 'verified' | 'pending'
}

export interface DedupHit {
  lookupKey: string
  status: 'verified' | 'pending'
  /** Score on the canonical-name match, 0..100 */
  score: number
}

const DEFAULT_FLOOR = 90

/**
 * Try to dedup `mention` against any of `candidates`. Returns the
 * best match above the floor or `null` when no candidate is close
 * enough. Floor defaults to 90 (token-set ratio scale) so we only
 * dedup obvious matches and let the new-pending path mint a row when
 * the names diverge meaningfully (e.g. "Sarah" vs "Sarah Ouma" still
 * dedup; "Sarah" vs "Samantha" do not).
 */
export function dedupCandidate(
  mention: string,
  candidates: DedupCandidate[],
  options: { floor?: number } = {}
): DedupHit | null {
  if (candidates.length === 0) return null
  const floor = options.floor ?? DEFAULT_FLOOR
  type Scored = { row: DedupCandidate; score: number }
  const scored: Scored[] = candidates.map((row) => {
    const canonicalScore = fuzz.token_set_ratio(mention, row.canonicalName)
    const aliasScores = row.aliases.map((a) => fuzz.token_set_ratio(mention, a))
    const score = Math.max(canonicalScore, ...(aliasScores.length > 0 ? aliasScores : [0]))
    return { row, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top || top.score < floor) return null
  return {
    lookupKey: top.row.lookupKey,
    status: top.row.status,
    score: top.score,
  }
}
