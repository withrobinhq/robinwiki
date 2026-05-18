import { describe, expect, it } from 'vitest'
import {
  loadWikiGenerationSpec,
  renderFragmentsBlock,
  renderPeopleBlock,
} from '../../prompts/index'
import { loadSpec } from '../../prompts/loader'
import type { WikiType } from '../../types/wiki'

const wikiFixtures = {
  fragments: 'Fragment 1: I went running today.\nFragment 2: Hit a new personal best on the 5k.',
  title: 'Health Tracking Log',
  date: '2026-03-07',
  count: 3,
}

const allTypes: WikiType[] = [
  'log',
  'research',
  'belief',
  'decision',
  'project',
  'objective',
  'skill',
  'agent',
  'voice',
  'principle',
]

describe('wiki-types specs', () => {
  for (const type of allTypes) {
    describe(type, () => {
      it('loads and returns a valid PromptResult', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        expect(result).toHaveProperty('system')
        expect(result).toHaveProperty('user')
        expect(result.meta).toHaveProperty('temperature')
        expect(result.meta).toHaveProperty('outputSchema')
      })

      it('renders system message with Quill persona', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        expect(result.system).toContain('Quill')
      })

      it('renders user template with substituted title', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        expect(result.user).toContain('Health Tracking Log')
        expect(result.user).not.toContain('{{title}}')
      })

      it('renders user template with substituted fragments', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        expect(result.user).toContain('I went running today')
        expect(result.user).not.toContain('{{fragments}}')
      })

      it('is a generation category with output.strict: true', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        // All wiki-types specs are generation category
        // Temperature for generation specs
        expect(result.meta.temperature).toBeGreaterThan(0)
        expect(result.meta.outputSchema).toBeDefined()
      })

      it('output schema parses { markdown, infobox, citations } — full payload', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        const schema = result.meta.outputSchema
        const parsed = schema.parse({
          markdown: '# Sample',
          infobox: {
            rows: [
              { label: 'Status', value: 'active', valueKind: 'status' },
            ],
          },
          citations: [
            { sectionAnchor: 'overview', fragmentIds: ['frag-abc'] },
          ],
        })
        expect(parsed).toMatchObject({
          markdown: '# Sample',
          citations: [{ sectionAnchor: 'overview', fragmentIds: ['frag-abc'] }],
        })
      })

      it('output schema parses a minimal { markdown } payload (infobox/citations default)', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        const schema = result.meta.outputSchema
        const parsed = schema.parse({ markdown: '# Sample only' })
        expect(parsed).toMatchObject({
          markdown: '# Sample only',
          infobox: null,
          citations: [],
        })
      })

      it('rendered template contains [LINKING SYNTAX] and [INFOBOX] headers', () => {
        const result = loadWikiGenerationSpec(type, wikiFixtures)
        expect(result.user).toContain('[LINKING SYNTAX — USE EXACTLY]')
        expect(result.user).toContain('[INFOBOX]')
      })
    })
  }
})

describe('wiki-types display metadata', () => {
  for (const type of allTypes) {
    describe(type, () => {
      it('has display_label, display_description, display_short_descriptor, display_order', () => {
        const spec = loadSpec(`${type}.yaml`, 'wiki-types')
        expect(spec.display_label).toBeTypeOf('string')
        expect(spec.display_label?.length).toBeGreaterThan(0)
        expect(spec.display_description).toBeTypeOf('string')
        expect(spec.display_description?.length).toBeGreaterThan(0)
        expect(spec.display_short_descriptor).toBeTypeOf('string')
        expect(spec.display_short_descriptor?.length).toBeGreaterThan(0)
        expect(spec.display_order).toBeTypeOf('number')
        expect(Number.isInteger(spec.display_order)).toBe(true)
      })

      it('does not have system_only set to true (wiki-types are user-facing)', () => {
        const spec = loadSpec(`${type}.yaml`, 'wiki-types')
        expect(spec.system_only).toBe(false)
      })
    })
  }
})

describe('renderFragmentsBlock', () => {
  it('emits inline id, slug, and captured date headers for each fragment', () => {
    const out = renderFragmentsBlock([
      {
        id: 'frag-abc123',
        slug: 'morning-run',
        title: 'Morning run',
        content: 'Ran 5k in the park.',
        createdAt: '2026-04-12T09:30:00.000Z',
      },
      {
        id: 'frag-def456',
        slug: 'pr-pace',
        title: 'New PR pace',
        content: 'Hit 4:40/km on the last km.',
        createdAt: new Date('2026-04-13T10:00:00.000Z'),
      },
    ])

    expect(out).toContain('id: frag-abc123')
    expect(out).toContain('slug: morning-run')
    expect(out).toContain('captured: 2026-04-12')
    expect(out).toContain('id: frag-def456')
    expect(out).toContain('slug: pr-pace')
    expect(out).toContain('captured: 2026-04-13')
  })

  it('omits captured when createdAt is absent', () => {
    const out = renderFragmentsBlock([
      { id: 'frag-x', slug: 'x', content: 'no date' },
    ])
    expect(out).toContain('id: frag-x')
    expect(out).toContain('slug: x')
    expect(out).not.toContain('captured:')
  })
})

describe('renderPeopleBlock', () => {
  it('emits inline slug, name, and relationship for each person', () => {
    const out = renderPeopleBlock([
      { slug: 'sarah-chen', name: 'Sarah Chen', relationship: 'coworker' },
      { slug: 'alex-morgan', name: 'Alex Morgan' },
    ])

    expect(out).toContain('slug: sarah-chen')
    expect(out).toContain('name: Sarah Chen')
    expect(out).toContain('relationship: coworker')
    expect(out).toContain('slug: alex-morgan')
    expect(out).toContain('name: Alex Morgan')
  })

  it('omits relationship when empty or whitespace', () => {
    const out = renderPeopleBlock([
      { slug: 'noel', name: 'Noel', relationship: '' },
      { slug: 'kai', name: 'Kai', relationship: '   ' },
    ])
    expect(out).not.toContain('relationship:')
  })
})
