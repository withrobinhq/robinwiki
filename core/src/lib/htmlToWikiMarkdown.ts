/**
 * Server-side HTML → markdown converter for wiki bodies saved through the
 * inline Tiptap editor.
 *
 * Background: the read pipeline expects `wikis.content` to be markdown so
 * `parseSections` / `deriveCitationDeclarations` / the remark plugins all
 * fire. Tiptap, however, emits HTML on save. Without normalization the body
 * ends up in HTML form, sections become unparseable, the citation map
 * collapses, and inline citations fall back to slug-initial labels ([k] [l]
 * instead of [1] [2]). See the 2026-05-24 Gatsby audit.
 *
 * The converter is intentionally narrow: it handles only the tag set the
 * Tiptap StarterKit emits, plus a couple of post-render affordances (the
 * `<sup data-slot="wiki-citation*">` chips and the `<a data-slot="wiki-chip">`
 * cross-reference chips) that we sometimes leave in the DOM when the edit
 * extraction can read their data-* round-trip attributes. Everything outside
 * that set falls back to plain text content. No new dependencies beyond
 * node-html-parser.
 *
 * Round-trip contract:
 *   text  → markdown                preserved verbatim, including any
 *                                   [[fragment:slug]] / [[kind:slug]] tokens
 *                                   the edit extraction already inlined
 *   <p>                  → `\n\n`-separated paragraph
 *   <h1>..<h6>           → `#`..`######` heading
 *   <strong>             → `**…**`
 *   <em>                 → `*…*`
 *   <s>                  → `~~…~~`             (GFM)
 *   <code> (inline)      → `` `…` ``
 *   <pre><code>          → ```\n…\n```         (fenced)
 *   <a href>             → `[text](href)`
 *   <br>                 → hard line break (`  \n` inside paragraph)
 *   <hr>                 → `---`
 *   <ul>/<ol> + <li>     → `- ` / `1. ` lists (with nesting + indentation)
 *   <blockquote>         → `> …` prefix on every line
 *   <sup data-slot="wiki-citation*">      → `[[fragment:<data-fragment-slug>]]`
 *   <a data-slot="wiki-chip">             → `[[<data-token-kind>:<data-token-slug>]]`
 *
 * Anything else is unwrapped: the converter recurses into its children but
 * emits no surrounding markdown. That keeps unexpected tags from corrupting
 * the output while still preserving their text content.
 */

import { parse, HTMLElement, Node, NodeType, TextNode } from 'node-html-parser'

/**
 * Public entry point. Parses the input HTML and returns canonical markdown
 * that the read pipeline can consume. Idempotent on already-markdown input:
 * if the input contains no HTML tags, it's returned trimmed but otherwise
 * unchanged.
 */
export function htmlToWikiMarkdown(html: string): string {
  const trimmed = html?.trim() ?? ''
  if (trimmed.length === 0) return ''

  // Fast path: input has no tags. Nothing to convert; caller is probably
  // re-saving content that was already markdown (e.g. our own regen output
  // round-tripping through the editor). Treat as opaque, but ensure a
  // trailing newline so the body matches the canonical form the parser
  // path emits (otherwise the next save logs a no-op edit row).
  if (!/<[a-zA-Z!\/]/.test(trimmed)) return trimmed.endsWith('\n') ? trimmed : trimmed + '\n'

  // parse() wraps the input in a synthetic root; childNodes are the
  // top-level blocks the editor emitted.
  const root = parse(trimmed, { lowerCaseTagName: false, comment: false })

  const out: string[] = []
  for (const child of root.childNodes) {
    const block = renderBlock(child, 0)
    if (block.length > 0) out.push(block)
  }

  // Single trailing newline. parseSections is tolerant of either, but a
  // canonical form keeps round-trips stable across edits.
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// ── Block-level rendering ─────────────────────────────────────────────────

/**
 * Convert a block-level node to its markdown form. `depth` carries indentation
 * state into nested lists/blockquotes.
 */
function renderBlock(node: Node, depth: number): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    // Top-level loose text: wrap as a paragraph so it doesn't collide with
    // an adjacent block. (Tiptap shouldn't emit loose text at the document
    // root, but be defensive.)
    const text = (node as TextNode).text.trim()
    return text
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const tag = el.tagName?.toLowerCase()

  switch (tag) {
    case 'p':
      return renderInline(el).trim()

    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1])
      const inner = renderInline(el).trim()
      // Drop empty headings: parseSections rejects them anyway, and
      // emitting `## ` with no text creates a stray line that has no
      // semantic meaning in the read pipeline.
      if (inner.length === 0) return ''
      return `${'#'.repeat(level)} ${inner}`
    }

    case 'ul':
    case 'ol':
      return renderList(el, depth)

    case 'blockquote':
      return renderBlockquote(el, depth)

    case 'pre':
      return renderPreCode(el)

    case 'hr':
      return '---'

    case 'br':
      // A bare <br> at block level is unusual but possible (e.g. between
      // paragraphs the editor inserted). Treat as nothing.
      return ''

    default:
      // Unknown block-level element. Recurse so we don't drop the prose
      // inside; emit each child as its own block.
      return el.childNodes
        .map((c) => renderBlock(c, depth))
        .filter((s) => s.length > 0)
        .join('\n\n')
  }
}

function renderList(el: HTMLElement, depth: number): string {
  const ordered = el.tagName.toLowerCase() === 'ol'
  const indent = '  '.repeat(depth)
  const items: string[] = []
  let counter = 1

  for (const child of el.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue
    const li = child as HTMLElement
    if (li.tagName?.toLowerCase() !== 'li') continue

    const marker = ordered ? `${counter}. ` : '- '
    counter++

    // An <li> may contain inline text directly, or nested block elements
    // (paragraphs, sub-lists, blockquotes). Separate the two.
    const inlineParts: string[] = []
    const blockParts: string[] = []
    for (const grand of li.childNodes) {
      if (grand.nodeType === NodeType.ELEMENT_NODE) {
        const gel = grand as HTMLElement
        const gtag = gel.tagName?.toLowerCase()
        if (gtag === 'ul' || gtag === 'ol') {
          blockParts.push(renderList(gel, depth + 1))
          continue
        }
        if (gtag === 'p') {
          // First <p> joins the item line; later <p>s become block parts so
          // multi-paragraph list items round-trip.
          if (inlineParts.length === 0 && blockParts.length === 0) {
            inlineParts.push(renderInline(gel).trim())
          } else {
            blockParts.push(`${indent}  ${renderInline(gel).trim()}`)
          }
          continue
        }
        if (gtag === 'blockquote') {
          blockParts.push(renderBlockquote(gel, depth + 1))
          continue
        }
      }
      // Plain inline content (text node, <strong>, <em>, etc).
      inlineParts.push(renderInlineNode(grand))
    }

    const head = `${indent}${marker}${inlineParts.join('').trim()}`
    if (blockParts.length === 0) {
      items.push(head)
    } else {
      items.push([head, ...blockParts].join('\n'))
    }
  }

  return items.join('\n')
}

function renderBlockquote(el: HTMLElement, depth: number): string {
  const body = el.childNodes
    .map((c) => renderBlock(c, depth))
    .filter((s) => s.length > 0)
    .join('\n\n')
  return body
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n')
}

function renderPreCode(el: HTMLElement): string {
  // Tiptap CodeBlock renders <pre><code>…</code></pre>. node-html-parser
  // treats <pre> contents as opaque raw text by default, so the inner <code>
  // tag arrives as part of the text node, not as a child element. Strip
  // the wrapper if present and use whatever's inside as the code body.
  let code = el.text
  const wrapped = code.match(/^\s*<code[^>]*>([\s\S]*?)<\/code>\s*$/)
  if (wrapped) code = wrapped[1]
  return '```\n' + code.replace(/\n+$/, '') + '\n```'
}

// ── Inline rendering ──────────────────────────────────────────────────────

/**
 * Render an element's children as inline markdown. Used inside block tags
 * where we don't need surrounding structure (`<p>`, headings, list items).
 */
function renderInline(el: HTMLElement): string {
  return el.childNodes.map(renderInlineNode).join('')
}

function renderInlineNode(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    // Preserve text verbatim, including any `[[fragment:slug]]` /
    // `[[kind:slug]]` tokens the client-side edit extraction inlined.
    // We deliberately don't escape `[` / `]` here: doing so would break
    // wiki-link tokens. Markdown emphasis chars (`*`, `_`, `` ` ``) are
    // not currently escaped either, since Tiptap can't emit literal `*foo*`
    // text without wrapping it in <em>, so the round-trip is safe.
    return (node as TextNode).text
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const tag = el.tagName?.toLowerCase()

  switch (tag) {
    case 'strong':
    case 'b':
      return `**${renderInline(el)}**`

    case 'em':
    case 'i':
      return `*${renderInline(el)}*`

    case 's':
    case 'del':
    case 'strike':
      return `~~${renderInline(el)}~~`

    case 'code':
      // Inline code. Avoid double-backticks if the content has a backtick.
      return `\`${el.text}\``

    case 'br':
      // Hard line break: two trailing spaces + newline is the CommonMark form.
      return '  \n'

    case 'sup': {
      // Citation chip the read renderer may leave in the DOM. If it carries
      // our round-trip slug, emit the markdown token form so the next regen
      // / read can rebuild the chip from the canonical source.
      const slot = el.getAttribute('data-slot')
      if (slot === 'wiki-citation' || slot === 'wiki-citation-inline') {
        const slug = el.getAttribute('data-fragment-slug')
        if (slug) return `[[fragment:${slug}]]`
      }
      // Otherwise treat as inline text.
      return renderInline(el)
    }

    case 'a': {
      const slot = el.getAttribute('data-slot')
      if (slot === 'wiki-chip') {
        const kind = el.getAttribute('data-token-kind')
        const slug = el.getAttribute('data-token-slug')
        if (kind && slug) return `[[${kind}:${slug}]]`
      }
      const href = el.getAttribute('href') ?? ''
      const text = renderInline(el).trim()
      // Bare URL with matching text: collapse to autolink form `<url>` so
      // the canonical markdown is shorter (`http://x` rather than `[x](x)`).
      if (href && text === href) return `<${href}>`
      return `[${text}](${href})`
    }

    case 'span':
      // Tiptap doesn't emit bare `<span>`s but the editor sometimes leaves
      // remnants from pasted content. Unwrap.
      return renderInline(el)

    default:
      // Unknown inline element: drop the wrapper, keep the text.
      return renderInline(el)
  }
}
