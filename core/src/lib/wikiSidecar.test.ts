import { describe, expect, it, vi } from 'vitest'
import { buildSidecar, type SidecarDeps } from './wikiSidecar.js'
import type {
  WikiCitation,
  WikiInfobox,
  WikiRef,
} from '@robin/shared/schemas/sidecar'

function makeDeps(overrides: Partial<SidecarDeps> = {}): SidecarDeps {
  return {
    resolveRef: vi.fn().mockResolvedValue(null),
    resolveCitation: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

function personRef(slug: string): WikiRef {
  return { kind: 'person', id: `person-${slug}`, slug, label: slug }
}

function wikiRef(slug: string): WikiRef {
  return { kind: 'wiki', id: `wiki-${slug}`, slug, label: slug, wikiType: 'project' }
}

function citation(fragmentId: string): WikiCitation {
  return {
    fragmentId,
    fragmentSlug: fragmentId,
    capturedAt: '2026-04-21T00:00:00Z',
  }
}

describe('buildSidecar', () => {
  it('returns empty outputs for empty content', async () => {
    const result = await buildSidecar({ content: '', deps: makeDeps() })
    expect(result).toEqual({ refs: {}, sections: [], infobox: null })
  })

  it('populates refs from a [[person:slug]] token', async () => {
    const deps = makeDeps({
      resolveRef: vi.fn(async (kind, slug) =>
        kind === 'person' && slug === 'sarah' ? personRef('sarah') : null
      ),
    })
    const result = await buildSidecar({
      content: 'Met with [[person:sarah]] about the launch.',
      deps,
    })
    expect(result.refs).toEqual({ 'person:sarah': personRef('sarah') })
    expect(deps.resolveRef).toHaveBeenCalledTimes(1)
  })

  it('deduplicates identical tokens so resolveRef fires once', async () => {
    const resolveRef = vi.fn(async () => wikiRef('foo'))
    const result = await buildSidecar({
      content: '[[wiki:foo]] and again [[wiki:foo]]',
      deps: makeDeps({ resolveRef }),
    })
    expect(result.refs).toEqual({ 'wiki:foo': wikiRef('foo') })
    expect(resolveRef).toHaveBeenCalledTimes(1)
  })

  it('drops unknown slugs silently', async () => {
    const result = await buildSidecar({
      content: '[[person:unknown]]',
      deps: makeDeps(), // resolver returns null
    })
    expect(result.refs).toEqual({})
  })

  it('parses multiple headings in order with correct slug anchors', async () => {
    const result = await buildSidecar({
      content: ['# Project Overview', 'body', '## Current Status', 'body'].join('\n'),
      deps: makeDeps(),
    })
    expect(result.sections.map((s) => s.anchor)).toEqual([
      'project-overview',
      'current-status',
    ])
    expect(result.sections[0].level).toBe(1)
    expect(result.sections[1].level).toBe(2)
  })

  it('suffixes duplicate headings with -1, -2', async () => {
    const result = await buildSidecar({
      content: ['## Notes', 'a', '## Notes', 'b', '## Notes', 'c'].join('\n'),
      deps: makeDeps(),
    })
    expect(result.sections.map((s) => s.anchor)).toEqual(['notes', 'notes-1', 'notes-2'])
  })

  it('attaches citations to the matching section, dropping unknown fragment ids', async () => {
    const deps = makeDeps({
      resolveCitation: vi.fn(async (id) => (id === 'frag-abc' ? citation('frag-abc') : null)),
    })
    const result = await buildSidecar({
      content: '## Progress\nsomething',
      deps,
      citationDeclarations: [
        { sectionAnchor: 'progress', fragmentIds: ['frag-abc', 'frag-missing'] },
      ],
    })
    expect(result.sections[0].citations).toEqual([citation('frag-abc')])
    expect(deps.resolveCitation).toHaveBeenCalledTimes(2)
  })

  it('drops a citation declaration whose sectionAnchor matches no heading', async () => {
    const resolveCitation = vi.fn(async () => citation('frag-abc'))
    const result = await buildSidecar({
      content: '## Progress\nsomething',
      deps: makeDeps({ resolveCitation }),
      citationDeclarations: [
        { sectionAnchor: 'nonexistent', fragmentIds: ['frag-abc'] },
      ],
    })
    expect(result.sections[0].citations).toEqual([])
    expect(resolveCitation).not.toHaveBeenCalled()
  })

  it('prefers derivedInfobox over metadata.infobox', async () => {
    const metadataInfobox: WikiInfobox = {
      rows: [{ label: 'A', value: '1', valueKind: 'text' }],
    }
    const derived: WikiInfobox = {
      rows: [{ label: 'B', value: '2', valueKind: 'text' }],
    }
    const result = await buildSidecar({
      content: '',
      deps: makeDeps(),
      metadata: { infobox: metadataInfobox },
      derivedInfobox: derived,
    })
    expect(result.infobox).toBe(derived)
  })

  it('falls back to metadata.infobox when no derivedInfobox is passed', async () => {
    const infobox: WikiInfobox = {
      rows: [{ label: 'Status', value: 'active', valueKind: 'status' }],
    }
    const result = await buildSidecar({
      content: '',
      deps: makeDeps(),
      metadata: { infobox },
    })
    expect(result.infobox).toBe(infobox)
  })

  it('returns null infobox when neither derived nor metadata is available', async () => {
    const result = await buildSidecar({
      content: '# Heading',
      deps: makeDeps(),
      metadata: { infobox: null },
    })
    expect(result.infobox).toBeNull()
  })

  it('resolves [[wiki:slug]] tokens that appear only inside infobox row values', async () => {
    // Regression: a wiki whose body never references a sibling wiki but whose
    // infobox does (e.g. a "Contradicts" row) used to render the raw token
    // because resolveRefs only walked input.content. The infobox tokens now
    // contribute to the refs map alongside body tokens.
    const deps = makeDeps({
      resolveRef: vi.fn(async (kind, slug) =>
        kind === 'wiki' && slug === 'other-belief' ? wikiRef('other-belief') : null
      ),
    })
    const infobox: WikiInfobox = {
      rows: [
        { label: 'Strength', value: 'provisional', valueKind: 'text' },
        {
          label: 'Contradicts',
          value: '[[wiki:other-belief]]',
          valueKind: 'ref',
        },
      ],
    }
    const result = await buildSidecar({
      content: '# Body with no cross-refs',
      deps,
      metadata: { infobox },
    })
    expect(result.refs).toEqual({ 'wiki:other-belief': wikiRef('other-belief') })
    expect(deps.resolveRef).toHaveBeenCalledWith('wiki', 'other-belief')
  })
})
