import Handlebars from 'handlebars'
import { describe, expect, it } from 'vitest'
import { escapeHandlebarsDelimiters, renderTemplate } from '../../prompts/index'
import { loadFragmentationSpec } from '../../prompts/loaders/fragmentation'
import { loadWikiGenerationSpec } from '../../prompts/loaders/wiki-generation'

const ZWSP = '\u200B'

describe('escapeHandlebarsDelimiters — round-trip lock', () => {
  it('survives Handlebars compile and emits the literal {{evil}} to the LLM', () => {
    const escaped = escapeHandlebarsDelimiters('{{evil}}')
    const compiled = Handlebars.compile('{{x}}', { noEscape: true })
    const rendered = compiled({ x: escaped })
    // The LLM consumer sees the ZWSP-stripped text — that is the actual
    // glyph sequence that lands in the prompt over the wire.
    const visible = rendered.replaceAll(ZWSP, '')
    expect(visible).toBe('{{evil}}')
  })

  it('survives a two-pass render (mirrors the wiki-generation structure -> template flow)', () => {
    const escaped = escapeHandlebarsDelimiters('{{evil}}')
    const pass1 = Handlebars.compile('Title: {{title}}', { noEscape: true })
    const intermediate = pass1({ title: escaped })

    const pass2 = Handlebars.compile('Out: {{structure}}', { noEscape: true })
    const final = pass2({ structure: intermediate })

    expect(final.replaceAll(ZWSP, '')).toBe('Out: Title: {{evil}}')
  })

  it('renderTemplate with userControlled escapes string values', () => {
    const out = renderTemplate('hi {{name}}', { name: '{{evil}}' }, { userControlled: ['name'] })
    expect(out.replaceAll(ZWSP, '')).toBe('hi {{evil}}')
    // The raw output keeps the ZWSP chars — Handlebars never re-evaluated.
    expect(out).toContain(`{${ZWSP}{`)
  })

  it('renderTemplate without options leaves user values raw', () => {
    // Handlebars does not re-template variable values regardless of escape;
    // the value lands in the output as-written.
    const out = renderTemplate('hi {{name}}', { name: '{{evil}}' })
    expect(out).toBe('hi {{evil}}')
  })

  it('non-string values pass through unchanged when userControlled is set', () => {
    const out = renderTemplate('count={{n}}', { n: 5 }, { userControlled: ['n'] })
    expect(out).toBe('count=5')
  })

  it('arrays are recursed into and string leaves escaped', () => {
    const out = renderTemplate(
      '{{#each items}}- {{this}}\n{{/each}}',
      { items: ['{{a}}', '{{b}}'] },
      { userControlled: ['items'] }
    )
    expect(out.replaceAll(ZWSP, '')).toContain('- {{a}}')
    expect(out.replaceAll(ZWSP, '')).toContain('- {{b}}')
  })
})

describe('loader integration — user content with delimiters survives', () => {
  it('fragmentation: literal {{...}} fragment text reaches the rendered prompt', () => {
    const result = loadFragmentationSpec({
      content: '{{#each context}}{{this}}{{/each}}',
    })
    expect(result.user.replaceAll(ZWSP, '')).toContain('{{#each context}}')
  })

  it('wiki-generation: literal delimiters in title survive into the user prompt', () => {
    const result = loadWikiGenerationSpec('log', {
      fragments: 'no fragments',
      title: 'Hi {{name}}',
      date: '2026-04-20',
      count: 1,
    })
    expect(result.user.replaceAll(ZWSP, '')).toContain('Hi {{name}}')
  })

  it('no delimiters → output identical with or without escape', () => {
    const out = renderTemplate('hi {{name}}', { name: 'plain text' }, { userControlled: ['name'] })
    expect(out).toBe('hi plain text')
  })
})
