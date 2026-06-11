/**
 * Wiki-link parsing and resolution.
 * Parses [[slug]] and [[type:slug]] patterns from markdown body text,
 * then resolves them against a DB lookup function.
 */

/** Regex for [[slug]] and [[type:slug]] wiki-link patterns */
export const WIKI_LINK_RE = /\[\[(?:([a-z]+):)?([a-z0-9-]+)\]\]/g

/** A parsed wiki-link before resolution */
export interface WikiLinkParsed {
  slug: string
  typeHint?: string
  raw: string
}

/** A resolved wiki-link with its DB identity */
export interface WikiLinkResolved {
  slug: string
  type: string
  key: string
}

/** Result of wiki-link resolution: resolved links + broken (unresolved) slugs */
export interface WikiLinkResult {
  resolved: WikiLinkResolved[]
  broken: string[]
}

/** Priority order for unqualified wiki-link resolution */
const RESOLUTION_PRIORITY = ['wiki', 'person', 'fragment', 'entry'] as const

/** Legacy type aliases: maps old qualified-link prefixes to current type names */
const TYPE_ALIASES: Record<string, string> = {
  thread: 'wiki',
}

/**
 * Parse wiki-links from body text. Pure function, no DB access.
 * Deduplicates by slug+typeHint combination.
 * Legacy qualifiers (e.g. [[thread:x]]) are mapped to their current type via TYPE_ALIASES.
 */
export function parseWikiLinks(text: string): WikiLinkParsed[] {
  const seen = new Set<string>()
  const results: WikiLinkParsed[] = []

  for (const match of text.matchAll(WIKI_LINK_RE)) {
    const rawType = match[1] || undefined
    const typeHint = rawType !== undefined ? (TYPE_ALIASES[rawType] ?? rawType) : undefined
    const slug = match[2]
    const dedupKey = `${typeHint ?? ''}:${slug}`

    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    results.push({ slug, typeHint, raw: match[0] })
  }

  return results
}

/**
 * Resolve parsed wiki-links against a lookup function.
 * For unqualified links, tries types in priority order: wiki > person > fragment > entry.
 * For qualified links ([[type:slug]]), tries only the specified type.
 */
export async function resolveWikiLinks(
  parsed: WikiLinkParsed[],
  lookupFn: (slug: string, type?: string) => Promise<{ type: string; key: string } | null>
): Promise<WikiLinkResult> {
  const resolved: WikiLinkResolved[] = []
  const broken: string[] = []

  for (const link of parsed) {
    if (link.typeHint) {
      // Qualified: try only the specified (possibly aliased) type
      const result = await lookupFn(link.slug, link.typeHint)
      if (result) {
        resolved.push({ slug: link.slug, type: result.type, key: result.key })
      } else {
        // Preserve the original raw qualifier in the broken label (e.g. "thread:x" not "wiki:x")
        broken.push(link.raw.slice(2, -2))
      }
    } else {
      // Unqualified: try types in priority order
      let found = false
      for (const type of RESOLUTION_PRIORITY) {
        const result = await lookupFn(link.slug, type)
        if (result) {
          resolved.push({ slug: link.slug, type: result.type, key: result.key })
          found = true
          break
        }
      }
      if (!found) {
        broken.push(link.slug)
      }
    }
  }

  return { resolved, broken }
}
