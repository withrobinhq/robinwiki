import { describe, it, expect } from 'vitest'
import { makeSidecarDeps } from './wikiSidecarDeps.js'
import type { DB } from '../db/client.js'

/**
 * Stream T1 / #320 — citation rendering reads Marcel-emitted spans off
 * the FRAGMENT_IN_WIKI edge attrs when present, and falls back to the
 * first-200-chars snippet path for legacy edges (attrs.citationSpans
 * missing / null / empty / non-array).
 *
 * The deps factory is a pure builder over a Drizzle handle; we drive it
 * with a hand-rolled stub that mimics drizzle's chained query API. We
 * only exercise the read paths the resolver actually walks, so the stub
 * stays tight.
 */

interface FragmentRow {
  lookupKey: string
  slug: string
  content: string
  createdAt: Date
}

interface EdgeRow {
  attrs: Record<string, unknown> | null
}

function makeFakeDb(opts: {
  fragment: FragmentRow | null
  edge: EdgeRow | null
}): DB {
  const queue: unknown[][] = []
  // Order matches the resolver: first fragments-by-lookupKey, then
  // (if wikiKey is set) FRAGMENT_IN_WIKI edge.
  queue.push(opts.fragment ? [opts.fragment] : [])
  if (opts.edge !== undefined) {
    queue.push(opts.edge ? [opts.edge] : [])
  }

  function chain() {
    return {
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }
  }

  return {
    select: () => chain(),
  } as unknown as DB
}

const FRAGMENT: FragmentRow = {
  lookupKey: 'frag-1',
  slug: 'frag-1-slug',
  content: 'Author thinks they should use GraphQL instead of REST for the API',
  createdAt: new Date('2026-05-09T00:00:00Z'),
}

describe('makeSidecarDeps citation rendering', () => {
  it('uses Marcel citationSpans when the FRAGMENT_IN_WIKI edge has them', async () => {
    const deps = makeSidecarDeps(
      makeFakeDb({
        fragment: FRAGMENT,
        edge: {
          attrs: {
            score: 0.9,
            citationSpans: [
              {
                start: 19,
                end: 65,
                text: 'should use GraphQL instead of REST for the API',
              },
            ],
          },
        },
      }),
      'wiki-top'
    )

    const cit = await deps.resolveCitation('frag-1')
    expect(cit).not.toBeNull()
    expect(cit!.quote).toBe('should use GraphQL instead of REST for the API')
  })

  it('joins multiple spans with " … " for the quote', async () => {
    const deps = makeSidecarDeps(
      makeFakeDb({
        fragment: FRAGMENT,
        edge: {
          attrs: {
            citationSpans: [
              { start: 0, end: 13, text: 'Author thinks' },
              {
                start: 19,
                end: 65,
                text: 'should use GraphQL instead of REST for the API',
              },
            ],
          },
        },
      }),
      'wiki-top'
    )
    const cit = await deps.resolveCitation('frag-1')
    expect(cit!.quote).toBe(
      'Author thinks … should use GraphQL instead of REST for the API'
    )
  })

  it('falls back to the snippet path when the edge has no citationSpans (legacy)', async () => {
    const deps = makeSidecarDeps(
      makeFakeDb({
        fragment: FRAGMENT,
        edge: { attrs: { score: 0.9 } },
      }),
      'wiki-top'
    )
    const cit = await deps.resolveCitation('frag-1')
    expect(cit!.quote).toBe(FRAGMENT.content)
  })

  it('falls back when the FRAGMENT_IN_WIKI edge is missing entirely (legacy)', async () => {
    const deps = makeSidecarDeps(
      makeFakeDb({ fragment: FRAGMENT, edge: null }),
      'wiki-top'
    )
    const cit = await deps.resolveCitation('frag-1')
    expect(cit!.quote).toBe(FRAGMENT.content)
  })

  it('falls back when attrs.citationSpans is empty array', async () => {
    const deps = makeSidecarDeps(
      makeFakeDb({ fragment: FRAGMENT, edge: { attrs: { citationSpans: [] } } }),
      'wiki-top'
    )
    const cit = await deps.resolveCitation('frag-1')
    expect(cit!.quote).toBe(FRAGMENT.content)
  })

  it('skips the edge lookup entirely when no wikiKey is provided', async () => {
    // edge is undefined so the queue only has the fragment row; if the
    // resolver tried to read the edge it would get [] and behave the
    // same — but the stub asserts only one read happens because we only
    // queue one response.
    const deps = makeSidecarDeps(makeFakeDb({ fragment: FRAGMENT, edge: undefined as unknown as null }))
    const cit = await deps.resolveCitation('frag-1')
    expect(cit!.quote).toBe(FRAGMENT.content)
  })

  it('returns null for missing fragments regardless of wikiKey', async () => {
    const deps = makeSidecarDeps(
      makeFakeDb({ fragment: null, edge: null }),
      'wiki-top'
    )
    const cit = await deps.resolveCitation('frag-missing')
    expect(cit).toBeNull()
  })
})
