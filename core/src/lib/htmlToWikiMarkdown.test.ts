import { describe, expect, it } from 'vitest'
import { htmlToWikiMarkdown } from './htmlToWikiMarkdown.js'

describe('htmlToWikiMarkdown', () => {
  describe('passthrough', () => {
    it('returns empty string for empty input', () => {
      expect(htmlToWikiMarkdown('')).toBe('')
      expect(htmlToWikiMarkdown('   ')).toBe('')
    })

    it('returns markdown unchanged when input has no tags', () => {
      // Regen output round-tripping through the editor sometimes lands
      // here, and the converter must not corrupt already-canonical bodies.
      expect(htmlToWikiMarkdown('Plain markdown content.')).toBe(
        'Plain markdown content.\n',
      )
    })

    it('does not treat & as the start of HTML', () => {
      // URL query strings contain `&` but the input is still markdown,
      // so the parser shouldn't try to decode entities here.
      expect(htmlToWikiMarkdown('See https://x?a=1&b=2')).toBe(
        'See https://x?a=1&b=2\n',
      )
    })

    it('passthrough matches parser-path trailing-newline form', () => {
      // Idempotency: a save of identical content shouldn't log a spurious
      // edit row. The two output paths must agree on trailing whitespace.
      const md = '## Heading\n\nBody.\n'
      const out = htmlToWikiMarkdown(md)
      expect(out).toBe(md)
    })
  })

  describe('block structure', () => {
    it('converts headings h1-h6', () => {
      expect(htmlToWikiMarkdown('<h1>Top</h1>')).toBe('# Top\n')
      expect(htmlToWikiMarkdown('<h2>Mid</h2>')).toBe('## Mid\n')
      expect(htmlToWikiMarkdown('<h6>Tiny</h6>')).toBe('###### Tiny\n')
    })

    it('preserves inline emphasis inside headings', () => {
      // Mirrors the broken-Gatsby form `<h2><strong>The Position</strong></h2>`.
      expect(
        htmlToWikiMarkdown('<h2><strong>The Position</strong></h2>'),
      ).toBe('## **The Position**\n')
    })

    it('separates paragraphs with a blank line', () => {
      const html = '<p>First.</p><p>Second.</p>'
      expect(htmlToWikiMarkdown(html)).toBe('First.\n\nSecond.\n')
    })

    it('renders hr as a horizontal rule', () => {
      expect(htmlToWikiMarkdown('<p>A</p><hr><p>B</p>')).toBe(
        'A\n\n---\n\nB\n',
      )
    })

    it('drops empty paragraphs the editor inserts', () => {
      // Tiptap routinely appends a trailing <p></p> or <p><br></p> on
      // every transaction; they would round-trip as blank lines forever
      // if we didn't filter them.
      expect(htmlToWikiMarkdown('<p>real</p><p></p>')).toBe('real\n')
      expect(htmlToWikiMarkdown('<p>real</p><p><br></p>')).toBe('real\n')
    })

    it('drops empty headings', () => {
      // `<h2></h2>` has no semantic meaning and parseSections rejects it
      // anyway. Don't emit a stray `## ` line.
      expect(htmlToWikiMarkdown('<h2></h2><p>body</p>')).toBe('body\n')
    })
  })

  describe('inline marks', () => {
    it('wraps strong/em/strike correctly', () => {
      expect(
        htmlToWikiMarkdown('<p><strong>bold</strong> and <em>em</em></p>'),
      ).toBe('**bold** and *em*\n')
      expect(
        htmlToWikiMarkdown('<p>A <s>retracted</s> claim.</p>'),
      ).toBe('A ~~retracted~~ claim.\n')
    })

    it('renders inline code', () => {
      expect(htmlToWikiMarkdown('<p>Use <code>foo()</code>.</p>')).toBe(
        'Use `foo()`.\n',
      )
    })

    it('renders fenced code blocks', () => {
      const html = '<pre><code>line1\nline2</code></pre>'
      expect(htmlToWikiMarkdown(html)).toBe('```\nline1\nline2\n```\n')
    })

    it('converts links', () => {
      expect(
        htmlToWikiMarkdown('<p>See <a href="https://x">x</a>.</p>'),
      ).toBe('See [x](https://x).\n')
    })

    it('collapses bare URLs to autolinks', () => {
      // [https://x](https://x) is noisier than <https://x>, so emit
      // the CommonMark autolink form.
      expect(
        htmlToWikiMarkdown('<p><a href="https://x">https://x</a></p>'),
      ).toBe('<https://x>\n')
    })
  })

  describe('lists', () => {
    it('renders unordered lists', () => {
      expect(
        htmlToWikiMarkdown('<ul><li>one</li><li>two</li></ul>'),
      ).toBe('- one\n- two\n')
    })

    it('renders ordered lists with incremented numbers', () => {
      expect(
        htmlToWikiMarkdown('<ol><li>one</li><li>two</li></ol>'),
      ).toBe('1. one\n2. two\n')
    })

    it('nests sub-lists with two-space indent', () => {
      const html =
        '<ul><li>outer<ul><li>inner</li></ul></li><li>next</li></ul>'
      expect(htmlToWikiMarkdown(html)).toBe(
        '- outer\n  - inner\n- next\n',
      )
    })

    it('keeps inline formatting inside list items', () => {
      expect(
        htmlToWikiMarkdown(
          '<ul><li><strong>bold</strong> point</li></ul>',
        ),
      ).toBe('- **bold** point\n')
    })
  })

  describe('blockquote', () => {
    it('prefixes every line with > ', () => {
      const html = '<blockquote><p>First.</p><p>Second.</p></blockquote>'
      expect(htmlToWikiMarkdown(html)).toBe('> First.\n>\n> Second.\n')
    })
  })

  describe('token preservation (the load-bearing case)', () => {
    it('keeps inline [[fragment:slug]] text verbatim', () => {
      // Client-side extraction already replaces citation chips with this
      // text form before Tiptap sees the body. Round-trip must not mangle.
      const html =
        '<p>Some claim. [[fragment:my-frag]] More text.</p>'
      expect(htmlToWikiMarkdown(html)).toBe(
        'Some claim. [[fragment:my-frag]] More text.\n',
      )
    })

    it('keeps inline [[wiki:slug]] text verbatim', () => {
      const html = '<p>See [[wiki:related-belief]] for context.</p>'
      expect(htmlToWikiMarkdown(html)).toBe(
        'See [[wiki:related-belief]] for context.\n',
      )
    })

    it('round-trips a citation <sup> chip from its data-fragment-slug attr', () => {
      // If a chip survives to the server (edit extraction missed it, or
      // the chip was pasted from another rendered surface), recover the
      // token from the round-trip attribute so the canonical body still
      // points at the right fragment.
      const html =
        '<p>A claim.<sup data-slot="wiki-citation" data-fragment-slug="my-frag">[1]</sup></p>'
      expect(htmlToWikiMarkdown(html)).toBe(
        'A claim.[[fragment:my-frag]]\n',
      )
    })

    it('round-trips a cross-reference <a> chip from data-token-* attrs', () => {
      const html =
        '<p>See <a data-slot="wiki-chip" data-token-kind="wiki" data-token-slug="other" href="/wiki/other">Other</a>.</p>'
      expect(htmlToWikiMarkdown(html)).toBe('See [[wiki:other]].\n')
    })

    it('falls back to link text when chip is missing token attrs', () => {
      // Legacy rendered bodies don't carry data-token-*. Render as a
      // standard link rather than dropping it.
      const html =
        '<p>See <a data-slot="wiki-chip" href="/wiki/other">Other</a>.</p>'
      expect(htmlToWikiMarkdown(html)).toBe('See [Other](/wiki/other).\n')
    })
  })

  describe('the broken-Gatsby shape end-to-end', () => {
    it('converts a realistic Tiptap-saved wiki body into parseable markdown', () => {
      // Modeled on the rural-water-services wiki the user tested with on
      // 2026-05-24: HTML headings with bold inner text, paragraphs with
      // multiple inline fragment tokens, lists in the body.
      const html = [
        '<h2><strong>The Position</strong></h2>',
        '<p>Water utilities that demonstrate strong governance.</p>',
        '<h2><strong>Evidence and Reasoning</strong></h2>',
        '<p>Kenya loses $1.5B/year. [[fragment:kenya-water-loss]] Coverage is 57%. [[fragment:kenya-water-coverage]]</p>',
        '<ul><li>One model is affermage. [[fragment:rwanda-affermage]]</li><li>Another is co-management.</li></ul>',
      ].join('')

      const md = htmlToWikiMarkdown(html)
      expect(md).toContain('## **The Position**')
      expect(md).toContain('## **Evidence and Reasoning**')
      expect(md).toContain('[[fragment:kenya-water-loss]]')
      expect(md).toContain('[[fragment:kenya-water-coverage]]')
      expect(md).toContain('- One model is affermage. [[fragment:rwanda-affermage]]')
    })
  })
})
