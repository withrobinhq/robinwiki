/**
 * Server-side citation derivation from inline [[fragment:slug]] tokens.
 *
 * Walks the wiki markdown, tracks the current heading anchor, and collects
 * every [[fragment:slug]] token grouped by the section it appears in.
 * Resolves slugs to fragment lookupKeys via a caller-supplied map, then
 * returns WikiCitationDeclaration[] matching the shape stored in
 * wikis.citationDeclarations.
 *
 * The heading slugification replicates core/src/lib/wikiSidecar.ts and
 * wiki/src/lib/sectionEdit.ts exactly so anchors are consistent across
 * the server read path and the frontend renderer.
 */

import type { WikiCitationDeclaration } from '@robin/shared/schemas/sidecar'

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const FRAGMENT_TOKEN_RE = /\[\[fragment:([a-z0-9-]+)\]\]/g

/**
 * Slugify a heading string identically to wikiSidecar.ts and sectionEdit.ts:
 * lowercase, replace non-alphanumeric runs with hyphens, trim leading/trailing hyphens.
 */
function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface FragmentSlugMap {
  /** Map from fragment slug to fragment lookupKey. */
  slugToKey: Map<string, string>
  /** Map from fragment lookupKey to itself (identity, for lookupKey-shaped references). */
  keySet: Set<string>
}

/**
 * Derive citation declarations by walking the markdown body.
 *
 * Scans for ATX headings (building disambiguated anchors) and collects
 * [[fragment:slug]] tokens under each heading. Tokens appearing before the
 * first heading are grouped under a synthetic `_preamble` anchor that will
 * not match any real section; buildSidecar's attachCitations silently
 * drops unmatched anchors, so preamble citations are harmless.
 *
 * The `fragmentMap` resolves slug strings (and, as a fallback, lookupKey
 * strings) to the canonical lookupKey stored in citationDeclarations.
 * This handles both slug-referenced tokens (the normal case) and
 * lookupKey-shaped references from older wikis.
 */
export function deriveCitationDeclarations(
  markdown: string,
  fragmentMap: FragmentSlugMap
): WikiCitationDeclaration[] {
  const lines = markdown.split('\n')
  const anchorCount = new Map<string, number>()

  // Current section anchor. Tokens before the first heading land here.
  let currentAnchor = '_preamble'

  // Accumulator: anchor -> ordered unique fragmentIds (lookupKeys)
  const sectionFragments = new Map<string, string[]>()
  const sectionFragmentSeen = new Map<string, Set<string>>()

  for (const line of lines) {
    // Check for heading
    const headingMatch = line.match(HEADING_RE)
    if (headingMatch) {
      const heading = headingMatch[2].trim()
      const base = slugifyHeading(heading)
      if (base) {
        const prev = anchorCount.get(base) ?? 0
        anchorCount.set(base, prev + 1)
        currentAnchor = prev === 0 ? base : `${base}-${prev}`
      }
    }

    // Collect fragment tokens from this line
    for (const match of line.matchAll(FRAGMENT_TOKEN_RE)) {
      const slug = match[1]

      // Resolve slug to lookupKey. Try slug map first, then check if
      // the token itself is a lookupKey (older wikis may reference by key).
      let lookupKey = fragmentMap.slugToKey.get(slug)
      if (!lookupKey && fragmentMap.keySet.has(slug)) {
        lookupKey = slug
      }
      if (!lookupKey) continue

      // Add to section, preserving order and deduplicating
      let list = sectionFragments.get(currentAnchor)
      let seen = sectionFragmentSeen.get(currentAnchor)
      if (!list || !seen) {
        list = []
        seen = new Set()
        sectionFragments.set(currentAnchor, list)
        sectionFragmentSeen.set(currentAnchor, seen)
      }
      if (!seen.has(lookupKey)) {
        seen.add(lookupKey)
        list.push(lookupKey)
      }
    }
  }

  // Build the declarations array, skipping the synthetic preamble anchor
  // and sections with no fragment references.
  const declarations: WikiCitationDeclaration[] = []
  for (const [anchor, fragmentIds] of sectionFragments) {
    if (anchor === '_preamble') continue
    if (fragmentIds.length === 0) continue
    declarations.push({ sectionAnchor: anchor, fragmentIds })
  }

  return declarations
}
