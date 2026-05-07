import { describe, it, expect } from 'vitest'
import { sanitizeWikiHtml } from './sanitizeWikiHtml'

describe('sanitizeWikiHtml', () => {
  it('strips <script> tags', () => {
    const out = sanitizeWikiHtml('<p>hi</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('<p>hi</p>')
  })

  it('strips on* event handlers', () => {
    const out = sanitizeWikiHtml('<img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/onerror/i)
  })

  it('strips javascript: hrefs', () => {
    const out = sanitizeWikiHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toMatch(/javascript:/i)
  })

  it('strips style attributes', () => {
    const out = sanitizeWikiHtml(
      '<p style="background:url(javascript:alert(1))">x</p>',
    )
    expect(out).not.toMatch(/style=/i)
  })

  it('preserves wiki chip anchor attributes', () => {
    const out = sanitizeWikiHtml(
      '<a class="wchip" data-slot="wiki-chip" href="/wiki/foo">Foo</a>',
    )
    expect(out).toContain('data-slot="wiki-chip"')
    expect(out).toContain('class="wchip"')
  })

  it('preserves headings and lists', () => {
    const out = sanitizeWikiHtml('<h2>Title</h2><ul><li>one</li></ul>')
    expect(out).toContain('<h2>Title</h2>')
    expect(out).toContain('<li>one</li>')
  })

  it('returns empty string for null/undefined', () => {
    expect(sanitizeWikiHtml(null)).toBe('')
    expect(sanitizeWikiHtml(undefined)).toBe('')
  })

  it('round-trips a Tiptap-saved fragment without attribute loss', () => {
    // Representative fixture covering every attribute the editor + wiki
    // pipeline emit today. Add to BOTH this fixture and ALLOWED_ATTR in
    // lockstep when a new attribute joins the editor schema.
    const tiptapFixture =
      '<h2 id="sec-1">Title</h2>' +
      '<p class="para"><a href="/wiki/foo" target="_blank" rel="noopener" data-slot="wiki-chip">link</a></p>' +
      '<ul><li>one</li></ul>' +
      '<ol start="3" type="1"><li>three</li></ol>' +
      '<img src="/img/a.png" alt="a" width="80" height="60" loading="lazy" decoding="async">'
    const out = sanitizeWikiHtml(tiptapFixture)
    expect(out).toBe(tiptapFixture)
  })
})
