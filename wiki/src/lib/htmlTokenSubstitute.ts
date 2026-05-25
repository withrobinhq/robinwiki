/**
 * Post-render DOM walker that replaces `[[kind:slug]]` tokens embedded
 * in Tiptap-saved HTML with rendered chip markup. Operates on a live
 * container DOM subtree (typically the root returned by
 * `dangerouslySetInnerHTML`) after React has committed it.
 *
 * Why this exists: when a wiki body is saved via the Tiptap editor, the
 * stored content is HTML rather than markdown, so the `remarkWikiTokens`
 * plugin on the markdown render path never runs. This helper walks the
 * rendered HTML's text nodes and swaps token substrings for anchor
 * elements styled the same as `<WikiChip>` (class `wchip`), so both
 * paths surface chips with identical affordance and styling.
 *
 * Safety rules:
 *   - Only text nodes are visited — attribute values and comments are
 *     ignored.
 *   - Text inside an existing `<a>` element is skipped so we never
 *     nest anchors (would produce invalid HTML and break the `wchip`
 *     style's hover states).
 *   - Text inside `<code>` or `<pre>` is skipped so tokens appearing
 *     in code samples render as literal source rather than as chips.
 *   - Per product decision Q1, unresolved tokens are left as-is
 *     (rendered as their literal `[[kind:slug]]` text) rather than
 *     dropped or styled as broken links.
 *
 * Recommended use from the wiki-detail-page HTML branch:
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null)
 * useWikiTokenSubstitution(ref, wiki.wikiContent, wiki.refs)
 * return (
 *   <div ref={ref} className="wiki-richtext-rendered"
 *        dangerouslySetInnerHTML={{ __html: wiki.wikiContent }} />
 * )
 * ```
 */

import { useEffect, type RefObject } from 'react'
import type { WikiRef } from '@/lib/sidecarTypes'
import type { FragmentCitationMap } from '@/components/wiki/MarkdownContent'
import { ROUTES } from '@/lib/routes'
/** Matches `[[kind:slug]]` or `[[slug]]` wiki-link tokens. Kept in sync with @robin/shared/wiki-links. */
const WIKI_LINK_RE = /\[\[(?:([a-z]+):)?([a-z0-9-]+)\]\]/g

/** Map from `${kind}:${slug}` (or unqualified `${slug}`) to a `WikiRef`. */
export type RefsMap = Record<string, WikiRef>

/**
 * Compute the detail-page href for a ref. Kept in-sync with the routing
 * the remark plugin's render hook uses so both paths agree.
 */
export function refToHref(ref: WikiRef): string {
  switch (ref.kind) {
    case 'person':
      return ROUTES.person(ref.id)
    case 'fragment':
      return ROUTES.fragment(ref.id)
    case 'entry':
      return ROUTES.entry(ref.id)
    case 'wiki':
    default:
      return ROUTES.wiki(ref.id)
  }
}

function tokenReplacementFragment(
  value: string,
  refs: RefsMap,
  doc: Document,
  fragmentCitationMap?: FragmentCitationMap,
): DocumentFragment | null {
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags)
  const frag = doc.createDocumentFragment()
  let cursor = 0
  let match: RegExpExecArray | null
  let replaced = false

  while ((match = re.exec(value)) !== null) {
    const [rawToken, kindCapture, slug] = match
    const start = match.index
    const end = start + rawToken.length

    if (start > cursor) {
      frag.appendChild(doc.createTextNode(value.slice(cursor, start)))
    }

    const chipKey = kindCapture ? `${kindCapture}:${slug}` : slug
    const ref = refs[chipKey]

    if (ref) {
      // #351: fragment refs render as numbered superscript citations
      if (ref.kind === 'fragment' && fragmentCitationMap) {
        const citationNum = fragmentCitationMap.get(ref.id)
        const label = citationNum != null
          ? `[${citationNum}]`
          : `[${ref.slug?.charAt(0) ?? '?'}]`
        const sup = doc.createElement('sup')
        sup.setAttribute('data-slot', 'wiki-citation-inline')
        sup.setAttribute('data-fragment-slug', ref.slug ?? slug)
        sup.className = 'cite'
        const anchor = doc.createElement('a')
        anchor.setAttribute('href', `#fragment-${ref.id}`)
        anchor.setAttribute('title', ref.label)
        anchor.textContent = label
        sup.appendChild(anchor)
        frag.appendChild(sup)
      } else {
        const anchor = doc.createElement('a')
        anchor.className = 'wchip'
        anchor.setAttribute('data-slot', 'wiki-chip')
        // Round-trip data: edit-tab extraction reads these to
        // reconstruct `[[kind:slug]]` text tokens instead of
        // destroying the chip on a manual edit + save.
        anchor.setAttribute('data-token-kind', ref.kind)
        anchor.setAttribute('data-token-slug', ref.slug ?? slug)
        anchor.setAttribute('href', refToHref(ref))
        anchor.textContent = ref.label
        frag.appendChild(anchor)
      }
    } else {
      // Q1: unresolved tokens render as raw literal text, not dropped.
      frag.appendChild(doc.createTextNode(rawToken))
    }

    replaced = true
    cursor = end
  }

  if (!replaced) return null
  if (cursor < value.length) {
    frag.appendChild(doc.createTextNode(value.slice(cursor)))
  }
  return frag
}

/**
 * Walks the container's descendants and rewrites any text-node
 * substrings that match `WIKI_LINK_RE`. Idempotent: once a token has
 * been replaced with an anchor, subsequent calls skip it because the
 * token text now sits under an `<a>` whose descendants we ignore.
 */
export function substituteTokensInHtml(
  container: HTMLElement,
  refs: RefsMap,
  fragmentCitationMap?: FragmentCitationMap,
): void {
  if (!container || !refs) return
  const doc = container.ownerDocument
  if (!doc) return

  // Collect text nodes first so replacements don't invalidate the walker.
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // Skip text inside existing anchors — chips and any pre-existing
      // links must not be rewrapped. Also skip code/pre so token text
      // inside code samples renders as literal source.
      if (parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT
      const value = node.nodeValue
      if (!value || value.indexOf('[[') === -1) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const pending: Text[] = []
  let current = walker.nextNode()
  while (current) {
    pending.push(current as Text)
    current = walker.nextNode()
  }

  for (const textNode of pending) {
    const value = textNode.nodeValue ?? ''
    const replacement = tokenReplacementFragment(value, refs, doc, fragmentCitationMap)
    if (replacement) {
      textNode.replaceWith(replacement)
    }
  }
}

/**
 * React hook that runs `substituteTokensInHtml` against a container
 * ref whenever the raw HTML or the `refs` map changes. Intended for
 * callers that render wiki body content via `dangerouslySetInnerHTML`
 * (the Tiptap-saved branch).
 *
 * Re-running when the HTML string changes is what keeps the walker
 * stable across edit-mode save/cancel cycles: React commits the new
 * HTML, the effect fires, and the walker swaps tokens again.
 */
export function useWikiTokenSubstitution(
  containerRef: RefObject<HTMLElement | null>,
  html: string | null | undefined,
  refs: RefsMap | null | undefined,
  fragmentCitationMap?: FragmentCitationMap,
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container || !refs) return
    substituteTokensInHtml(container, refs, fragmentCitationMap)
  }, [containerRef, html, refs, fragmentCitationMap])
}
