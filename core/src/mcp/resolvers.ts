/**
 * @module mcp/resolvers
 *
 * @summary Read-only resolvers for MCP tools and resources. Fuzzy
 * slug/name matching with Levenshtein scoring.
 *
 * @remarks
 * Resolvers never mutate state — all write operations live in
 * {@link module:mcp/handlers | handlers.ts}.
 *
 * **Slug resolution** uses Levenshtein-based fuzzy matching so MCP
 * clients don't need exact slugs. Threshold of 70 balances convenience
 * (LLMs paraphrase) against safety (don't auto-resolve wrong strings).
 *
 * **Person resolution** is more aggressive: checks canonical names,
 * aliases, then fuzzy. When multiple candidates score within 5 points,
 * the response includes `alternatives` for disambiguation.
 *
 * **Content from DB:** wiki/fragment/person content is read from the
 * `content` column on each domain table (populated by the ingest pipeline).
 *
 * @see {@link resolveSlug} — generic fuzzy slug matching (auto-resolve at 70+)
 * @see {@link resolveWikiBySlug} — strict exact-match for write paths
 * @see {@link listWikis} — wiki listing with fragment counts
 * @see {@link getWiki} — full wiki detail with wiki body
 * @see {@link getFragment} — full fragment with content + frontmatter
 * @see {@link findPersonById} — exact PK lookup
 * @see {@link findPersonByQuery} — fuzzy name/slug/alias search
 */

import { eq, and, isNull, sql, inArray, ne } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { wikis, fragments, people, edges, wikiTypes } from '../db/schema.js'
import { buildSidecar } from '../lib/wikiSidecar.js'
import { stripWikiContent } from '../lib/strip-wiki-content.js'
import { makeSidecarDeps } from '../lib/wikiSidecarDeps.js'
import type {
  WikiInfobox,
  WikiRef,
  WikiSection,
} from '@robin/shared/schemas/sidecar'

/***********************************************************************
 * ## Types
 *
 * @internal Resolver-specific interfaces. MCP layer consumes these
 * via the public resolver functions, not directly.
 ***********************************************************************/

/**
 * Injected dependencies for all resolvers.
 *
 * @remarks
 * Intentionally narrower than {@link McpServerDeps} — resolvers only
 * need read access to the database.
 */
export interface McpResolverDeps {
  db: DB
}

/**
 * Wiki list item with fragment count and wiki preview.
 *
 * Sidecar: list tools emit `refs` only (per CONTRACT §9 policy — no
 * infobox/sections on list rows). Keys are `${kind}:${slug}` matching
 * tokens inside `wikiPreview` / full content.
 */
interface WikiSummary {
  lookupKey: string
  slug: string
  name: string
  type: string
  state: string
  fragmentCount: number
  lastRebuiltAt: string | null
  wikiPreview: string
  shortDescriptor: string
  descriptor: string
  refs: Record<string, WikiRef>
}

/**
 * Full wiki detail with wiki body and member fragment snippets.
 *
 * Sidecar: detail tool emits `refs`, `infobox`, and `sections[].citations`
 * per CONTRACT §9. `infobox` is sourced from `wikis.metadata.infobox`.
 *
 * NOTE: the `thread` key is part of the MCP response shape and will be
 * renamed to `wiki` in Phase 2 with a deprecation window.
 */
interface WikiDetail {
  thread: {
    lookupKey: string
    slug: string
    name: string
    type: string
    state: string
    lastRebuiltAt: string | null
  }
  wikiBody: string
  fragments: FragmentSnippet[]
  refs: Record<string, WikiRef>
  infobox: WikiInfobox | null
  sections: WikiSection[]
}

/** Abbreviated fragment — used in wiki and person detail responses. */
interface FragmentSnippet {
  slug: string
  type: string | null
  title: string
  snippet: string
}

/**
 * Full fragment with content and frontmatter from git.
 *
 * Sidecar: fragments have no infobox (per CONTRACT §4); `refs` + `sections`
 * only. Sections come from any markdown headings inside the body.
 */
interface FragmentDetail {
  slug: string
  type: string | null
  title: string
  tags: string[]
  content: string
  frontmatter: string
  refs: Record<string, WikiRef>
  sections: WikiSection[]
}

/**
 * Person detail with profile body and linked fragments.
 *
 * Sidecar: `infobox` is server-derived from the person row (relationship,
 * aliases, first-mentioned date, mention count) — never LLM-authored.
 */
interface PersonDetail {
  person: {
    name: string
    slug: string
    aliases: string[]
    relationship: string
    /**
     * Stream P quarantine status. 'pending' rows render with a
     * full-width quarantine topbar in the frontend; consumers should
     * always carry this through so downstream UI can render the
     * indicator without a second fetch.
     */
    status: 'verified' | 'pending' | 'rejected'
  }
  body: string
  fragments: FragmentSnippet[]
  refs: Record<string, WikiRef>
  infobox: WikiInfobox | null
  sections: WikiSection[]
  alternatives?: string[]
}

/** Returned when slug/name resolution fails. */
interface ErrorResult {
  error: string
  suggestions: string[]
}

/***********************************************************************
 * ## Helpers
 *
 * @internal String utilities for markdown parsing and fuzzy matching.
 * Exported only for testing — not part of the public API.
 ***********************************************************************/

/**
 * Build a server-derived person infobox that matches the shape emitted
 * by the REST `/people/:id` route. Keeps MCP and REST in lockstep so
 * AI clients see the same structured facts the web wiki renders.
 *
 * Returns `null` when every row would be empty.
 */
function derivePersonInfobox(
  person: {
    relationship: string
    aliases: string[]
    createdAt: Date | null
  },
  mentionCount: number
): WikiInfobox | null {
  const firstMentionDate =
    person.createdAt instanceof Date
      ? person.createdAt.toISOString().slice(0, 10)
      : ''
  const rows = [
    { label: 'Relationship', value: person.relationship, valueKind: 'text' as const },
    { label: 'Aliases', value: (person.aliases ?? []).join(', '), valueKind: 'text' as const },
    { label: 'First mentioned', value: firstMentionDate, valueKind: 'date' as const },
    {
      label: 'Mentions',
      value: mentionCount > 0 ? String(mentionCount) : '',
      valueKind: 'text' as const,
    },
  ].filter((r) => r.value && r.value !== '0')
  if (rows.length === 0) return null
  return { rows }
}

/**
 * Strip YAML frontmatter from markdown content.
 *
 * @param content - Raw markdown string (may or may not have frontmatter)
 * @returns Body after the closing `---` fence
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!match) return content
  return content.slice(match[0].length)
}

/**
 * Extract the raw YAML block from between `---` fences.
 *
 * @param content - Raw markdown string
 * @returns YAML string (without fences), or empty string if none found
 */
function extractFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return match?.[1] ?? ''
}

/**
 * Levenshtein edit distance between two strings.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Edit distance (0 = identical)
 *
 * @see {@link ratio} — normalized similarity score built on this
 */
function levenshtein(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la

  let prev = Array.from({ length: lb + 1 }, (_, i) => i)
  let curr = new Array<number>(lb + 1)

  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[lb]
}

/**
 * Similarity ratio (0–100), comparable to Python's `fuzz.ratio`.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Score from 0 (completely different) to 100 (identical)
 */
function ratio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 100
  return Math.round(((maxLen - levenshtein(a, b)) / maxLen) * 100)
}

/**
 * Partial ratio: slides the shorter string across the longer one
 * and returns the best ratio found.
 *
 * @remarks
 * Useful when the input is a substring of the target
 * (e.g. `"fitness"` matching `"fitness-log"`).
 *
 * @param a - First string
 * @param b - Second string
 * @returns Best windowed ratio (0–100)
 */
function partialRatio(a: string, b: string): number {
  let short = a
  let long = b
  if (short.length > long.length) [short, long] = [long, short]
  if (short.length === 0) return 0
  let best = 0
  for (let i = 0; i <= long.length - short.length; i++) {
    best = Math.max(best, ratio(short, long.slice(i, i + short.length)))
  }
  return best
}

/***********************************************************************
 * ## Slug resolution
 *
 * @remarks Generic fuzzy matching used by read-only resolvers.
 * Write paths use {@link resolveWikiBySlug} (exact only).
 ***********************************************************************/

/** @internal */
interface SlugCandidate {
  slug: string
  name: string
}

/**
 * Resolve a user-provided slug against a list of candidates.
 *
 * @remarks
 * **Resolution strategy:**
 * 1. Exact match on slug (case-insensitive)
 * 2. Fuzzy match on slug and name — best score wins if >= 70
 * 3. If no match, return error with top 3 suggestions
 *
 * The 70-point threshold balances convenience (LLMs often paraphrase)
 * against safety (don't auto-resolve wildly different strings).
 *
 * @param input      - The slug string to resolve
 * @param candidates - All available slugs to match against
 * @returns Matched candidate or error with suggestions
 *
 * @example
 * ```ts
 * resolveSlug('fitnes', [{ slug: 'fitness', name: 'Fitness' }])
 * // → { match: { slug: 'fitness', name: 'Fitness' } }
 * ```
 */
export function resolveSlug(
  input: string,
  candidates: SlugCandidate[]
): { match: SlugCandidate } | { error: string; suggestions: string[] } {
  const lower = input.toLowerCase()

  const exact = candidates.find((c) => c.slug === lower || c.slug === input)
  if (exact) return { match: exact }

  const scored = candidates
    .map((c) => ({
      candidate: c,
      score: Math.max(
        ratio(lower, c.slug.toLowerCase()),
        partialRatio(lower, c.slug.toLowerCase()),
        ratio(lower, c.name.toLowerCase())
      ),
    }))
    .sort((a, b) => b.score - a.score)

  if (scored.length > 0 && scored[0].score >= 70) {
    return { match: scored[0].candidate }
  }

  return {
    error: `No match found for "${input}"`,
    suggestions: scored.slice(0, 3).map((s) => s.candidate.slug),
  }
}

/***********************************************************************
 * ## Person name resolution
 *
 * @remarks More aggressive than slug resolution — checks canonical
 * names, aliases, and fuzzy matches with ambiguity detection.
 *
 * @see {@link findPersonByQuery} — public resolver that uses this
 ***********************************************************************/

/**
 * Resolve a person name with alias-aware fuzzy matching.
 *
 * @remarks
 * **Resolution strategy:**
 * 1. Exact canonical name match (case-insensitive)
 * 2. Exact alias match (case-insensitive)
 * 3. Fuzzy match across names, aliases, AND slugs — best score wins if >= 70
 * 4. Ambiguity detection: multiple candidates within 5 points →
 *    `alternatives` returned so the MCP client can disambiguate
 *
 * @param nameInput  - The name to search for
 * @param candidates - All known people with their aliases
 * @returns Matched person (possibly with `alternatives`) or error
 */
function resolvePerson(
  nameInput: string,
  candidates: Array<{ name: string; slug: string; aliases: string[] }>
):
  | { match: (typeof candidates)[0]; alternatives?: string[] }
  | { error: string; suggestions: string[] } {
  const lower = nameInput.toLowerCase()

  const exact = candidates.find((c) => c.name.toLowerCase() === lower)
  if (exact) return { match: exact }

  const aliasMatch = candidates.find((c) => c.aliases.some((a) => a.toLowerCase() === lower))
  if (aliasMatch) return { match: aliasMatch }

  const scored = candidates
    .map((c) => {
      const nameScore = Math.max(
        ratio(lower, c.name.toLowerCase()),
        partialRatio(lower, c.name.toLowerCase())
      )
      const slugScore = Math.max(
        ratio(lower, c.slug.toLowerCase()),
        partialRatio(lower, c.slug.toLowerCase())
      )
      const aliasScores = c.aliases.map((a) =>
        Math.max(ratio(lower, a.toLowerCase()), partialRatio(lower, a.toLowerCase()))
      )
      const best = Math.max(nameScore, slugScore, ...aliasScores, 0)
      return { candidate: c, score: best }
    })
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    return { error: `No match found for "${nameInput}"`, suggestions: [] }
  }

  if (scored[0].score < 70) {
    return {
      error: `No match found for "${nameInput}"`,
      suggestions: scored.slice(0, 3).map((s) => s.candidate.name),
    }
  }

  // Ambiguity check: multiple candidates within 5 points
  const topScore = scored[0].score
  const close = scored.filter((s) => topScore - s.score <= 5)
  if (close.length > 1) {
    return {
      match: scored[0].candidate,
      alternatives: close.slice(1).map((s) => s.candidate.name),
    }
  }

  return { match: scored[0].candidate }
}

/***********************************************************************
 * ## Resolvers
 *
 * @remarks Public query functions consumed by MCP tool/resource
 * registrations in {@link module:mcp/server | server.ts}.
 ***********************************************************************/

/**
 * List all wikis with fragment counts and wiki previews.
 *
 * @remarks
 * Returns the 20 most recently updated wikis. Fragment counts are
 * computed via a LEFT JOIN on `FRAGMENT_IN_WIKI` edges. Wiki previews
 * are read from the `content` column (first 200 chars after frontmatter).
 *
 * Per CONTRACT §9 list policy, each row carries a `refs` map keyed by
 * `${kind}:${slug}` so AI clients can resolve tokens embedded in the
 * preview (or the full content body they might fetch next) without an
 * extra round-trip. `infobox` and `sections` are intentionally omitted
 * for list responses.
 *
 * @param deps - Database client
 * @returns Array of {@link WikiSummary} sorted by last update
 */
export async function listWikis(
  deps: McpResolverDeps,
  opts: { includeDescriptors?: boolean } = {}
): Promise<WikiSummary[]> {
  const includeDescriptors = opts.includeDescriptors ?? true

  const rows = await deps.db
    .select({
      lookupKey: wikis.lookupKey,
      slug: wikis.slug,
      name: wikis.name,
      type: wikis.type,
      state: wikis.state,
      content: wikis.content,
      lastRebuiltAt: wikis.lastRebuiltAt,
      fragmentCount: sql<number>`count(${edges.id})::int`,
      shortDescriptor: wikiTypes.shortDescriptor,
      descriptor: wikiTypes.descriptor,
    })
    .from(wikis)
    .leftJoin(wikiTypes, eq(wikis.type, wikiTypes.slug))
    .leftJoin(
      edges,
      and(
        eq(edges.dstId, wikis.lookupKey),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )
    .where(isNull(wikis.deletedAt))
    .groupBy(wikis.lookupKey, wikiTypes.shortDescriptor, wikiTypes.descriptor)
    .orderBy(sql`${wikis.updatedAt} DESC`)
    .limit(20)

  const sidecarDeps = makeSidecarDeps(deps.db)
  const summaries: WikiSummary[] = []
  for (const row of rows) {
    const body = stripFrontmatter(row.content || '')
    const wikiPreview = body.slice(0, 200).trim()
    // Scan the full content (not just the preview) so refs cover every
    // token in the document — the client may fetch the full body later.
    const sidecar = await buildSidecar({
      content: row.content ?? '',
      deps: sidecarDeps,
    })
    summaries.push({
      lookupKey: row.lookupKey,
      slug: row.slug,
      name: row.name,
      type: row.type,
      state: row.state,
      fragmentCount: row.fragmentCount,
      lastRebuiltAt: row.lastRebuiltAt?.toISOString() ?? null,
      wikiPreview,
      shortDescriptor: includeDescriptors ? (row.shortDescriptor ?? '') : '',
      descriptor: includeDescriptors ? (row.descriptor ?? '') : '',
      refs: sidecar.refs,
    })
  }
  return summaries
}

/**
 * Get full wiki detail by slug with fuzzy matching.
 *
 * @remarks
 * Reads the wiki body from the `content` column and fetches
 * all member fragments via `FRAGMENT_IN_WIKI` edges with 300-char snippets.
 *
 * @param deps      - Database client
 * @param slugInput - Wiki slug (exact or fuzzy)
 * @returns {@link WikiDetail} with wiki body and fragments, or {@link ErrorResult}
 */
export async function getWiki(
  deps: McpResolverDeps,
  slugInput: string
): Promise<WikiDetail | ErrorResult> {
  const allWikis = await deps.db
    .select({
      lookupKey: wikis.lookupKey,
      slug: wikis.slug,
      name: wikis.name,
      type: wikis.type,
      state: wikis.state,
      content: wikis.content,
      metadata: wikis.metadata,
      citationDeclarations: wikis.citationDeclarations,
      lastRebuiltAt: wikis.lastRebuiltAt,
    })
    .from(wikis)
    .where(isNull(wikis.deletedAt))

  const resolved = resolveSlug(
    slugInput,
    allWikis.map((t) => ({ slug: t.slug, name: t.name }))
  )
  if ('error' in resolved) return resolved

  const wiki = allWikis.find((t) => t.slug === resolved.match.slug)
  if (!wiki) return { error: 'Wiki not found', suggestions: [] }

  const wikiBody = stripFrontmatter(wiki.content || '')

  // Fetch member fragments via edge graph
  const fragEdges = await deps.db
    .select({ srcId: edges.srcId })
    .from(edges)
    .where(
      and(
        eq(edges.dstId, wiki.lookupKey),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )

  const fragKeys = fragEdges.map((e) => e.srcId)
  const frags =
    fragKeys.length > 0
      ? await deps.db
          .select({
            slug: fragments.slug,
            type: fragments.type,
            title: fragments.title,
            content: fragments.content,
          })
          .from(fragments)
          .where(and(inArray(fragments.lookupKey, fragKeys), isNull(fragments.deletedAt)))
      : []

  const fragmentSnippets: FragmentSnippet[] = frags.map((f) => {
    const snippet = stripFrontmatter(f.content || '').slice(0, 300).trim()
    return { slug: f.slug, type: f.type, title: f.title, snippet }
  })

  // Build sidecar from the *full* stored content so section anchors and
  // token refs line up with what the REST /wikis/:id route emits.
  const sidecar = await buildSidecar({
    content: wiki.content ?? '',
    metadata: wiki.metadata ?? null,
    citationDeclarations: wiki.citationDeclarations ?? [],
    deps: makeSidecarDeps(deps.db),
  })

  // MCP consumers are always LLMs — strip tokens for efficiency
  const strippedBody = stripWikiContent(wikiBody, sidecar.refs)

  return {
    thread: {
      lookupKey: wiki.lookupKey,
      slug: wiki.slug,
      name: wiki.name,
      type: wiki.type,
      state: wiki.state,
      lastRebuiltAt: wiki.lastRebuiltAt?.toISOString() ?? null,
    },
    wikiBody: strippedBody,
    fragments: fragmentSnippets,
    refs: sidecar.refs,
    infobox: sidecar.infobox,
    sections: sidecar.sections,
  }
}

/**
 * Get full fragment detail by slug with fuzzy matching.
 *
 * @remarks
 * Returns the complete markdown content and raw frontmatter from the
 * `content` column. The `content` field has frontmatter stripped; the
 * `frontmatter` field has just the YAML block for structured parsing.
 *
 * @param deps      - Database client
 * @param slugInput - Fragment slug (exact or fuzzy)
 * @returns {@link FragmentDetail} with content and frontmatter, or {@link ErrorResult}
 */
export async function getFragment(
  deps: McpResolverDeps,
  slugInput: string
): Promise<FragmentDetail | ErrorResult> {
  const allFrags = await deps.db
    .select({
      slug: fragments.slug,
      type: fragments.type,
      title: fragments.title,
      tags: fragments.tags,
      content: fragments.content,
    })
    .from(fragments)
    .where(isNull(fragments.deletedAt))

  const resolved = resolveSlug(
    slugInput,
    allFrags.map((f) => ({ slug: f.slug, name: f.title }))
  )
  if ('error' in resolved) return resolved

  const frag = allFrags.find((f) => f.slug === resolved.match.slug)
  if (!frag) return { error: 'Fragment not found', suggestions: [] }

  const content = stripFrontmatter(frag.content || '')
  const frontmatter = extractFrontmatter(frag.content || '')

  // Fragments have no infobox per CONTRACT §4; sidecar contributes
  // refs (any `[[kind:slug]]` tokens in the body) and sections (any
  // headings). Source scan uses the raw content to match REST behavior.
  const sidecar = await buildSidecar({
    content: frag.content ?? '',
    metadata: null,
    deps: makeSidecarDeps(deps.db),
    derivedInfobox: null,
  })

  return {
    slug: frag.slug,
    type: frag.type,
    title: frag.title,
    tags: frag.tags as string[],
    content,
    frontmatter,
    refs: sidecar.refs,
    sections: sidecar.sections,
  }
}

/**
 * Find a person by exact lookupKey (PK lookup).
 *
 * @param deps - Database client
 * @param id   - Exact lookupKey (e.g. "person01ABCDEFGHIJKLMNOPQRSTUV")
 * @returns {@link PersonDetail} with body and linked fragments, or {@link ErrorResult}
 */
export async function findPersonById(
  deps: McpResolverDeps,
  id: string
): Promise<PersonDetail | ErrorResult> {
  const [person] = await deps.db
    .select({
      lookupKey: people.lookupKey,
      slug: people.slug,
      name: people.name,
      relationship: people.relationship,
      aliases: people.aliases,
      content: people.content,
      createdAt: people.createdAt,
      status: people.status,
    })
    .from(people)
    .where(and(eq(people.lookupKey, id), isNull(people.deletedAt)))
    .limit(1)

  if (!person) return { error: 'Person not found', suggestions: [] }

  const body = stripFrontmatter(person.content || '')

  // Fetch linked fragments via FRAGMENT_MENTIONS_PERSON edges
  const fragEdges = await deps.db
    .select({ srcId: edges.srcId })
    .from(edges)
    .where(
      and(
        eq(edges.dstId, person.lookupKey),
        eq(edges.edgeType, 'FRAGMENT_MENTIONS_PERSON'),
        isNull(edges.deletedAt)
      )
    )

  const fragKeys = fragEdges.map((e) => e.srcId)
  const frags =
    fragKeys.length > 0
      ? await deps.db
          .select({
            slug: fragments.slug,
            type: fragments.type,
            title: fragments.title,
            content: fragments.content,
          })
          .from(fragments)
          .where(and(inArray(fragments.lookupKey, fragKeys), isNull(fragments.deletedAt)))
      : []

  const fragmentSnippets: FragmentSnippet[] = frags.map((f) => {
    const snippet = stripFrontmatter(f.content || '').slice(0, 300).trim()
    return { slug: f.slug, type: f.type, title: f.title, snippet }
  })

  const derivedInfobox = derivePersonInfobox(
    {
      relationship: person.relationship,
      aliases: person.aliases ?? [],
      createdAt: person.createdAt,
    },
    fragmentSnippets.length
  )
  const sidecar = await buildSidecar({
    content: person.content ?? '',
    metadata: null, // people table has no metadata column
    deps: makeSidecarDeps(deps.db),
    derivedInfobox,
  })

  return {
    person: {
      name: person.name,
      slug: person.slug,
      aliases: person.aliases ?? [],
      relationship: person.relationship,
      status: (person.status ?? 'verified') as 'verified' | 'pending' | 'rejected',
    },
    body,
    fragments: fragmentSnippets,
    refs: sidecar.refs,
    infobox: sidecar.infobox,
    sections: sidecar.sections,
  }
}

/**
 * Find a person by fuzzy name/slug/alias search.
 *
 * @remarks
 * Reads all non-deleted people, scores against name, slug, and aliases
 * using Levenshtein fuzzy matching. Returns the best match with optional
 * alternatives when multiple candidates score within 5 points.
 * Max 5 results.
 *
 * @param deps  - Database client
 * @param query - Person name, slug, or alias to search for
 * @returns {@link PersonDetail} with body and linked fragments, or {@link ErrorResult}
 */
export async function findPersonByQuery(
  deps: McpResolverDeps,
  query: string
): Promise<PersonDetail | ErrorResult> {
  const allPeople = await deps.db
    .select({
      lookupKey: people.lookupKey,
      slug: people.slug,
      name: people.name,
      relationship: people.relationship,
      aliases: people.aliases,
      content: people.content,
      createdAt: people.createdAt,
      status: people.status,
    })
    .from(people)
    .where(isNull(people.deletedAt))

  const candidates = allPeople.map((p) => ({
    name: p.name,
    slug: p.slug,
    aliases: p.aliases ?? [],
  }))

  const resolved = resolvePerson(query, candidates)
  if ('error' in resolved) return resolved

  const person = allPeople.find((p) => p.slug === resolved.match.slug)
  if (!person) return { error: 'Person not found', suggestions: [] }

  const body = stripFrontmatter(person.content || '')

  // Fetch linked fragments via FRAGMENT_MENTIONS_PERSON edges
  const fragEdges = await deps.db
    .select({ srcId: edges.srcId })
    .from(edges)
    .where(
      and(
        eq(edges.dstId, person.lookupKey),
        eq(edges.edgeType, 'FRAGMENT_MENTIONS_PERSON'),
        isNull(edges.deletedAt)
      )
    )

  const fragKeys = fragEdges.map((e) => e.srcId)
  const frags =
    fragKeys.length > 0
      ? await deps.db
          .select({
            slug: fragments.slug,
            type: fragments.type,
            title: fragments.title,
            content: fragments.content,
          })
          .from(fragments)
          .where(and(inArray(fragments.lookupKey, fragKeys), isNull(fragments.deletedAt)))
      : []

  const fragmentSnippets: FragmentSnippet[] = frags.map((f) => {
    const snippet = stripFrontmatter(f.content || '').slice(0, 300).trim()
    return { slug: f.slug, type: f.type, title: f.title, snippet }
  })

  const derivedInfobox = derivePersonInfobox(
    {
      relationship: person.relationship,
      aliases: person.aliases ?? [],
      createdAt: person.createdAt,
    },
    fragmentSnippets.length
  )
  const sidecar = await buildSidecar({
    content: person.content ?? '',
    metadata: null,
    deps: makeSidecarDeps(deps.db),
    derivedInfobox,
  })

  const result: PersonDetail = {
    person: {
      name: person.name,
      slug: person.slug,
      aliases: resolved.match.aliases,
      relationship: person.relationship,
      status: (person.status ?? 'verified') as 'verified' | 'pending' | 'rejected',
    },
    body,
    fragments: fragmentSnippets,
    refs: sidecar.refs,
    infobox: sidecar.infobox,
    sections: sidecar.sections,
  }

  if ('alternatives' in resolved && resolved.alternatives) {
    result.alternatives = resolved.alternatives
  }

  return result
}

/***********************************************************************
 * ## Wiki slug resolution (strict)
 *
 * @remarks Exact-match only — used by write paths where precision
 * matters more than convenience. Compare with {@link resolveSlug}.
 ***********************************************************************/

/**
 * Resolve a wiki by exact slug match — no fuzzy auto-resolution.
 *
 * @remarks
 * Used by {@link handleLogFragment} where precision is critical. When
 * writing a fragment to a wiki, we can't afford to fuzzy-match and
 * accidentally file content to the wrong wiki.
 *
 * On miss, returns scored suggestions so the MCP client can present
 * "did you mean?" options without auto-resolving.
 *
 * @param deps      - Database client
 * @param slugInput - Exact wiki slug to match
 * @returns Wiki metadata or {@link ErrorResult} with suggestions
 */
export async function resolveWikiBySlug(
  deps: McpResolverDeps,
  slugInput: string
): Promise<
  | { lookupKey: string; slug: string; name: string; state: string }
  | { error: string; suggestions: string[] }
> {
  const allWikis = await deps.db
    .select({
      lookupKey: wikis.lookupKey,
      slug: wikis.slug,
      name: wikis.name,
      state: wikis.state,
    })
    .from(wikis)
    .where(isNull(wikis.deletedAt))

  // Exact match only — log_fragment requires precision
  const exact = allWikis.find((t) => t.slug === slugInput)
  if (exact) return exact

  // No fuzzy auto-resolution — just provide ranked suggestions
  const scored = allWikis
    .map((t) => ({
      slug: t.slug,
      score: Math.max(
        ratio(slugInput.toLowerCase(), t.slug.toLowerCase()),
        partialRatio(slugInput.toLowerCase(), t.slug.toLowerCase()),
        ratio(slugInput.toLowerCase(), t.name.toLowerCase())
      ),
    }))
    .sort((a, b) => b.score - a.score)

  return {
    error: `Wiki not found: "${slugInput}"`,
    suggestions: scored.slice(0, 3).map((s) => s.slug),
  }
}

/***********************************************************************
 * ## Brief person
 *
 * @remarks Template-based briefing — no LLM call. Assembles a markdown
 * summary from person metadata, linked wikis, and fragment mentions.
 ***********************************************************************/

/**
 * Generate a formatted markdown briefing for a person.
 *
 * @param deps  - Database client
 * @param query - Person name, slug, or lookupKey
 * @returns Markdown string with person summary, wikis, and fragment mentions
 */
export async function briefPerson(
  deps: McpResolverDeps,
  query: string
): Promise<string> {
  const isLookupKey = /^person[0-9A-Z]{26}$/i.test(query)

  const personResult = isLookupKey
    ? await findPersonById(deps, query)
    : await findPersonByQuery(deps, query)

  if ('error' in personResult) {
    throw new Error(personResult.error)
  }

  const { person, fragments: fragSnippets } = personResult

  // Fetch person row for summary
  const [personRow] = await deps.db
    .select({ lookupKey: people.lookupKey, summary: people.summary })
    .from(people)
    .where(eq(people.slug, person.slug))
    .limit(1)

  const summary = personRow?.summary || ''

  // Fetch linked wikis via fragment mentions -> FRAGMENT_IN_WIKI
  const fragEdges = personRow
    ? await deps.db
        .select({ srcId: edges.srcId })
        .from(edges)
        .where(
          and(
            eq(edges.dstId, personRow.lookupKey),
            eq(edges.edgeType, 'FRAGMENT_MENTIONS_PERSON'),
            isNull(edges.deletedAt)
          )
        )
    : []

  const fragKeys = fragEdges.map((e) => e.srcId)
  const wikiEdges = fragKeys.length > 0
    ? await deps.db
        .select({ dstId: edges.dstId })
        .from(edges)
        .where(
          and(
            inArray(edges.srcId, fragKeys),
            eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
            isNull(edges.deletedAt)
          )
        )
    : []

  const wikiKeys = [...new Set(wikiEdges.map((e) => e.dstId))]
  const wikiRows = wikiKeys.length > 0
    ? await deps.db
        .select({ lookupKey: wikis.lookupKey, name: wikis.name, slug: wikis.slug, type: wikis.type })
        .from(wikis)
        .where(inArray(wikis.lookupKey, wikiKeys))
    : []

  // Assemble markdown
  const lines: string[] = []
  lines.push(`# ${person.name}`)
  if (person.status === 'pending') {
    // Stream P quarantine: brief_person shows the same banner the
    // frontend renders so AI agents see the "not yet approved" state
    // without having to re-fetch /admin/people.
    lines.push('> Quarantine: this person is awaiting operator approval (status=pending).')
  }
  if (summary) lines.push(summary)
  if (person.relationship) lines.push(`Relationship: ${person.relationship}`)
  if (person.aliases.length > 0) lines.push(`Aliases: ${person.aliases.join(', ')}`)
  lines.push('')

  if (wikiRows.length > 0) {
    lines.push(`## Appears in ${wikiRows.length} wikis`)
    for (const w of wikiRows) {
      lines.push(`- [[${w.slug}]] (${w.type}): ${w.name}`)
    }
    lines.push('')
  }

  if (fragSnippets.length > 0) {
    lines.push(`## ${fragSnippets.length} fragment mentions`)
    for (const f of fragSnippets) {
      lines.push(`- ${f.title}: ${f.snippet.slice(0, 200)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/***********************************************************************
 * ## Wiki type resolvers
 ***********************************************************************/

export interface WikiTypeSummary {
  slug: string
  name: string
  shortDescriptor: string
  descriptor: string
  isDefault: boolean
  userModified: boolean
}

/**
 * List all wiki types ordered by name.
 * Global config -- no userId scoping needed.
 */
export async function listWikiTypes(deps: McpResolverDeps): Promise<WikiTypeSummary[]> {
  const rows = await deps.db
    .select({
      slug: wikiTypes.slug,
      name: wikiTypes.name,
      shortDescriptor: wikiTypes.shortDescriptor,
      descriptor: wikiTypes.descriptor,
      isDefault: wikiTypes.isDefault,
      userModified: wikiTypes.userModified,
    })
    .from(wikiTypes)
    .orderBy(wikiTypes.name)

  return rows
}
