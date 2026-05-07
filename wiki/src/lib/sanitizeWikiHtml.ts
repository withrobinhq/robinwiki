import DOMPurify from 'isomorphic-dompurify'

/**
 * Single chokepoint for rendering wiki body HTML via React's
 * dangerouslySetInnerHTML. Allows the rich-text vocabulary that Tiptap
 * saves emit and the LLM markdown-to-HTML pipeline produces, but strips
 * script tags, event-handler attributes, and javascript:/data: URLs
 * (except data:image/* in <img src>).
 *
 * If the editor schema gains a new HTML attribute, add it to ALLOWED_ATTR
 * AND to the round-trip fixture in sanitizeWikiHtml.test.ts so the
 * regression is caught the next time the test suite runs.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'sup',
  'sub',
]

const ALLOWED_ATTR = [
  // Tiptap StarterKit + the wiki-link / chip pipeline.
  'href',
  'name',
  'target',
  'rel',
  'src',
  'alt',
  'title',
  'class',
  'id',
  // Wiki-specific data hooks (chip anchor → htmlTokenSubstitute,
  // body-scoped editor styling, citation pipeline).
  'data-slot',
  'data-wiki-body',
  'data-citation-id',
  // Tables.
  'colspan',
  'rowspan',
  // Images.
  'loading',
  'width',
  'height',
  'decoding',
  // Ordered lists.
  'start',
  'type',
]

export function sanitizeWikiHtml(input: string | null | undefined): string {
  if (!input) return ''
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // DOMPurify drops data-* attrs entirely when this is false, even for
    // names listed in ALLOWED_ATTR. Leave it enabled so the wiki-chip
    // hooks (`data-slot`, `data-wiki-body`, `data-citation-id`) survive;
    // DOMPurify still strips data-* values that look like script URIs.
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    // style is forbidden to prevent CSS-based exfiltration (e.g.
    // background:url(javascript:...)) and DOM-clobbering.
    FORBID_ATTR: ['style'],
    // DOMPurify applies this regex to EVERY non-URI-safe attribute value
    // (target, rel, width, etc.) — not just URI-bearing ones. The default
    // (`IS_ALLOWED_URI` in purify.es.mjs) accepts http(s)/mailto/etc. AND
    // any value that doesn't look like a URI (so `_blank`, `lazy`, `noopener`
    // pass). We mirror that envelope but explicitly bar javascript:, vbscript:,
    // and non-image data: URIs. Combined with FORBID_ATTR['style'] above,
    // that closes the CSS-exfil and inline-script vectors targeted by
    // SEC-C4 without dropping legitimate Tiptap attributes.
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
  })
}
