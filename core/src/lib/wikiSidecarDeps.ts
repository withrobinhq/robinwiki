/**
 * Database-backed factory for `SidecarDeps`. Used by wiki/entry/person read
 * handlers to satisfy the `deps` parameter of `buildSidecar`. Keeping this
 * out of `wikiSidecar.ts` preserves the purity of the builder itself.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { WikiCitation, WikiRef } from '@robin/shared/schemas/sidecar'
import type { SidecarDeps } from './wikiSidecar.js'
import type { DB } from '../db/client.js'
import { wikis, people, fragments, entries, edges } from '../db/schema.js'

function snippet(content: string): string {
  return content.length > 200 ? content.slice(0, 200) : content
}

interface CitationSpanShape {
  start: number
  end: number
  text: string
}

/**
 * Pull validated citationSpans off the FRAGMENT_IN_WIKI edge attrs for
 * the given fragment + wiki. Returns null when the edge is missing,
 * deleted, or carries no spans (legacy v0.2.0 edges, secondary matches,
 * or rows where Marcel emitted no spans). The caller falls back to the
 * snippet path when this returns null.
 */
async function loadCitationSpans(
  db: DB,
  fragmentKey: string,
  wikiKey: string
): Promise<CitationSpanShape[] | null> {
  const [row] = await db
    .select({ attrs: edges.attrs })
    .from(edges)
    .where(
      and(
        eq(edges.srcType, 'fragment'),
        eq(edges.srcId, fragmentKey),
        eq(edges.dstType, 'wiki'),
        eq(edges.dstId, wikiKey),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )
    .limit(1)
  if (!row || !row.attrs) return null
  const spans = (row.attrs as Record<string, unknown>).citationSpans
  if (!Array.isArray(spans) || spans.length === 0) return null
  const out: CitationSpanShape[] = []
  for (const s of spans) {
    if (
      s &&
      typeof s === 'object' &&
      typeof (s as CitationSpanShape).start === 'number' &&
      typeof (s as CitationSpanShape).end === 'number' &&
      typeof (s as CitationSpanShape).text === 'string'
    ) {
      out.push(s as CitationSpanShape)
    }
  }
  return out.length > 0 ? out : null
}

/**
 * Compose Marcel-emitted citation spans into a `quote` string for the
 * sidecar. Multiple spans get joined with " … " so the renderer can
 * surface every span the LLM pointed at. Truncated to the same 200-char
 * ceiling the snippet path uses, so the response shape stays bounded.
 */
function spansToQuote(spans: CitationSpanShape[]): string {
  const joined = spans.map((s) => s.text).join(' … ')
  return joined.length > 200 ? joined.slice(0, 200) : joined
}

/**
 * Build a SidecarDeps. When `wikiKey` is set, citation resolution
 * prefers Marcel-emitted spans on the FRAGMENT_IN_WIKI edge; legacy
 * edges (no spans in attrs) fall back to the first-200-chars snippet
 * of the fragment body. Wiki-less callers (entries, people, public
 * read paths that don't know the wiki context) skip the edge lookup
 * entirely and always use the snippet path.
 */
export function makeSidecarDeps(db: DB, wikiKey?: string): SidecarDeps {
  const resolveRef = async (kind: string, slug: string): Promise<WikiRef | null> => {
    if (kind === 'person') {
      const [row] = await db
        .select({
          lookupKey: people.lookupKey,
          slug: people.slug,
          name: people.name,
          relationship: people.relationship,
        })
        .from(people)
        .where(and(eq(people.slug, slug), isNull(people.deletedAt)))
        .limit(1)
      if (!row) return null
      return {
        kind: 'person',
        id: row.lookupKey,
        slug: row.slug,
        label: row.name,
        relationship: row.relationship || undefined,
      }
    }

    if (kind === 'wiki') {
      const [row] = await db
        .select({
          lookupKey: wikis.lookupKey,
          slug: wikis.slug,
          name: wikis.name,
          type: wikis.type,
        })
        .from(wikis)
        .where(and(eq(wikis.slug, slug), isNull(wikis.deletedAt)))
        .limit(1)
      if (!row) return null
      return {
        kind: 'wiki',
        id: row.lookupKey,
        slug: row.slug,
        label: row.name,
        wikiType: row.type,
      }
    }

    if (kind === 'fragment') {
      // Quill sometimes emits [[fragment:<lookupKey>]] instead of
      // [[fragment:<slug>]] — the prompt example `frag-abc123` looks
      // lookup-key-shaped and the model conflates them. Try slug first
      // (canonical), then fall back to lookupKey so both shapes resolve
      // until the prompt is tightened upstream.
      const [bySlug] = await db
        .select({
          lookupKey: fragments.lookupKey,
          slug: fragments.slug,
          title: fragments.title,
          content: fragments.content,
        })
        .from(fragments)
        .where(and(eq(fragments.slug, slug), isNull(fragments.deletedAt)))
        .limit(1)
      const row =
        bySlug ??
        (
          await db
            .select({
              lookupKey: fragments.lookupKey,
              slug: fragments.slug,
              title: fragments.title,
              content: fragments.content,
            })
            .from(fragments)
            .where(and(eq(fragments.lookupKey, slug), isNull(fragments.deletedAt)))
            .limit(1)
        )[0]
      if (!row) return null
      return {
        kind: 'fragment',
        id: row.lookupKey,
        slug: row.slug,
        label: row.title,
        snippet: snippet(row.content ?? ''),
      }
    }

    if (kind === 'entry') {
      const [row] = await db
        .select({
          lookupKey: entries.lookupKey,
          slug: entries.slug,
          title: entries.title,
          createdAt: entries.createdAt,
        })
        .from(entries)
        .where(and(eq(entries.slug, slug), isNull(entries.deletedAt)))
        .limit(1)
      if (!row) return null
      return {
        kind: 'entry',
        id: row.lookupKey,
        slug: row.slug,
        label: row.title || row.slug,
        createdAt: row.createdAt.toISOString(),
      }
    }

    return null
  }

  const resolveCitation = async (fragmentId: string): Promise<WikiCitation | null> => {
    const [row] = await db
      .select({
        lookupKey: fragments.lookupKey,
        slug: fragments.slug,
        content: fragments.content,
        createdAt: fragments.createdAt,
      })
      .from(fragments)
      .where(and(eq(fragments.lookupKey, fragmentId), isNull(fragments.deletedAt)))
      .limit(1)
    if (!row) return null

    // Prefer Marcel-emitted citationSpans when we know the wiki context
    // (#320). Legacy edges with no spans in attrs fall through to the
    // first-200-chars snippet path.
    let quote = snippet(row.content ?? '')
    if (wikiKey) {
      const spans = await loadCitationSpans(db, row.lookupKey, wikiKey)
      if (spans) quote = spansToQuote(spans)
    }

    return {
      fragmentId: row.lookupKey,
      fragmentSlug: row.slug,
      quote,
      capturedAt: row.createdAt.toISOString(),
    }
  }

  return { resolveRef, resolveCitation }
}
