/**
 * Server-side sidecar builder for wiki / entry / person read responses.
 *
 * Scans content for `[[kind:slug]]` tokens, parses markdown headings into
 * stable-anchored sections, attaches LLM-declared citations, and resolves
 * the infobox source (server-derived > metadata column > null).
 *
 * Pure — all database reads flow through `deps`. Tests drive this by
 * stubbing `resolveRef` and `resolveCitation`; production callers build
 * `deps` from the drizzle client. See CONTRACT §8 for the shape contract.
 */

import { parseWikiLinks } from '@robin/shared'
import type {
  WikiCitation,
  WikiCitationDeclaration,
  WikiInfobox,
  WikiMetadata,
  WikiRef,
  WikiSection,
} from '@robin/shared/schemas/sidecar'

export interface SidecarDeps {
  resolveRef: (kind: string, slug: string) => Promise<WikiRef | null>
  resolveCitation: (fragmentId: string) => Promise<WikiCitation | null>
}

export interface SidecarInputs {
  content: string
  /** Value of `wikis.metadata` JSONB column (null for entries/people). */
  metadata?: WikiMetadata | null
  deps: SidecarDeps
  /** LLM-emitted per-section citation declarations. */
  citationDeclarations?: WikiCitationDeclaration[]
  /** Server-derived infobox (person read path). Overrides metadata.infobox. */
  derivedInfobox?: WikiInfobox | null
}

export interface SidecarOutputs {
  refs: Record<string, WikiRef>
  sections: WikiSection[]
  infobox: WikiInfobox | null
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/

/**
 * Lowercase, strip to alphanumerics/hyphens, collapse runs, trim hyphens.
 * Stable across regenerations so URL fragments survive rewrites.
 */
function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Produce an ordered list of sections from a markdown body. Duplicate
 * headings get suffixes in order of appearance (`-1`, `-2`, ...).
 */
function parseSections(content: string): WikiSection[] {
  const sections: WikiSection[] = []
  const anchorCount = new Map<string, number>()

  for (const line of content.split('\n')) {
    const match = line.match(HEADING_RE)
    if (!match) continue
    const level = match[1].length
    const heading = match[2].trim()
    const base = slugifyHeading(heading)
    if (!base) continue

    const prev = anchorCount.get(base) ?? 0
    anchorCount.set(base, prev + 1)
    const anchor = prev === 0 ? base : `${base}-${prev}`

    sections.push({
      id: anchor,
      anchor,
      heading,
      level,
      citations: [],
    })
  }

  return sections
}

/**
 * Resolve every parsed token to a WikiRef, deduplicated on `${kind}:${slug}`.
 * Unknown slugs drop silently — render-side falls back to raw token text.
 *
 * Scans both the wiki body content and any infobox row values, so an
 * infobox-only ref (e.g. a `Contradicts: [[wiki:other-belief]]` row whose
 * token never appears in the body) still resolves into the refs map. Without
 * this, the renderer's fallback prints the raw `[[wiki:slug]]` token to
 * users.
 */
async function resolveRefs(
  content: string,
  infobox: WikiInfobox | null,
  deps: SidecarDeps
): Promise<Record<string, WikiRef>> {
  const infoboxText = infobox
    ? '\n' + infobox.rows.map((row) => row.value).join('\n')
    : ''
  const parsed = parseWikiLinks(content + infoboxText)
  const refs: Record<string, WikiRef> = {}
  const seen = new Set<string>()

  for (const link of parsed) {
    // Unqualified tokens have no typeHint; we skip them here because the
    // resolver is kind-scoped. Callers that want priority-order resolution
    // should route through wiki-links.ts#resolveWikiLinks.
    if (!link.typeHint) continue
    const key = `${link.typeHint}:${link.slug}`
    if (seen.has(key)) continue
    seen.add(key)

    const ref = await deps.resolveRef(link.typeHint, link.slug)
    if (ref) refs[key] = ref
  }

  return refs
}

/**
 * Attach LLM-declared citations onto matching sections. Drops declarations
 * whose `sectionAnchor` doesn't correspond to any parsed heading, and drops
 * individual fragment ids that the resolver can't find.
 */
async function attachCitations(
  sections: WikiSection[],
  declarations: WikiCitationDeclaration[] | undefined,
  deps: SidecarDeps
): Promise<WikiSection[]> {
  if (!declarations || declarations.length === 0) return sections

  const byAnchor = new Map(sections.map((s) => [s.anchor, s]))

  for (const decl of declarations) {
    const section = byAnchor.get(decl.sectionAnchor)
    if (!section) continue
    const resolved: WikiCitation[] = []
    for (const fragmentId of decl.fragmentIds) {
      const citation = await deps.resolveCitation(fragmentId)
      if (citation) resolved.push(citation)
    }
    section.citations = [...section.citations, ...resolved]
  }

  return sections
}

function pickInfobox(input: SidecarInputs): WikiInfobox | null {
  if (input.derivedInfobox !== undefined) {
    return input.derivedInfobox
  }
  return input.metadata?.infobox ?? null
}

export async function buildSidecar(input: SidecarInputs): Promise<SidecarOutputs> {
  const infobox = pickInfobox(input)
  const refs = await resolveRefs(input.content, infobox, input.deps)
  const sections = await attachCitations(
    parseSections(input.content),
    input.citationDeclarations,
    input.deps
  )
  return { refs, sections, infobox }
}
