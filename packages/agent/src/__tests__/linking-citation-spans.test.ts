import { describe, it, expect, vi } from 'vitest'
import type { CasLock } from '@robin/caslock'
import type { PgTable } from 'drizzle-orm/pg-core'
import { runLinking } from '../stages/index.js'
import type {
  LinkingOrchestratorDeps,
  WikiClassifyDeps,
  FragRelateDeps,
} from '../stages/types.js'

/**
 * Fake CasLock that just runs the wrapped function. We're testing the
 * orchestrator's edge-attr behaviour, not the locking mechanics.
 */
function makeFakeLock(): CasLock<PgTable> {
  return {
    using: async (_params: unknown, fn: () => Promise<unknown>) => fn(),
  } as unknown as CasLock<PgTable>
}

function makeWikiClassifyDeps(
  assignments: Array<{
    wikiKey: string
    wikiName: string
    confidence: number
    reasoning: string
    citationSpans?: Array<{ start: number; end: number; text: string }>
  }>
): WikiClassifyDeps {
  return {
    searchCandidates: vi
      .fn()
      .mockResolvedValue(assignments.map((a) => ({ wikiKey: a.wikiKey, score: 1 }))),
    loadThreads: vi.fn().mockResolvedValue(
      assignments.map((a) => ({
        lookupKey: a.wikiKey,
        name: a.wikiName,
        type: null,
        prompt: null,
        description: null,
      }))
    ),
    llmCall: vi.fn().mockResolvedValue({ assignments }),
    emitEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeFragRelateDeps(): FragRelateDeps {
  return {
    vectorSearch: vi.fn().mockResolvedValue([]),
    loadFragmentContent: vi.fn().mockResolvedValue(null),
    llmCall: vi.fn().mockResolvedValue({ scores: [] }),
    emitEvent: vi.fn().mockResolvedValue(undefined),
  }
}

const FRAGMENT_CONTENT =
  'Author thinks they should use GraphQL instead of REST for the API'
const VALID_SPAN = {
  start: 19,
  end: 65,
  text: 'should use GraphQL instead of REST for the API',
}

describe('runLinking edge-attr citation spans', () => {
  it('persists citationSpans on the top-1 FRAGMENT_IN_WIKI edge when Marcel emits valid spans', async () => {
    const insertEdge = vi.fn().mockResolvedValue(undefined)
    const deps: LinkingOrchestratorDeps = {
      wikiClassifyDeps: makeWikiClassifyDeps([
        {
          wikiKey: 'wiki-top',
          wikiName: 'API Architecture Decisions',
          confidence: 0.92,
          reasoning: 'fits',
          citationSpans: [VALID_SPAN],
        },
      ]),
      fragRelateDeps: makeFragRelateDeps(),
      fragmentLock: makeFakeLock(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      insertEdge,
    }

    await runLinking(deps, {
      fragmentKey: 'frag-1',
      fragmentContent: FRAGMENT_CONTENT,
      entryKey: 'entry-1',
      jobId: 'job-1',
    })

    expect(insertEdge).toHaveBeenCalledTimes(1)
    const call = insertEdge.mock.calls[0][0]
    expect(call.edgeType).toBe('FRAGMENT_IN_WIKI')
    expect(call.dstId).toBe('wiki-top')
    expect(call.attrs).toEqual({
      score: 0.92,
      citationSpans: [VALID_SPAN],
    })
  })

  it('drops spans whose text does not round-trip against the fragment', async () => {
    const insertEdge = vi.fn().mockResolvedValue(undefined)
    const deps: LinkingOrchestratorDeps = {
      wikiClassifyDeps: makeWikiClassifyDeps([
        {
          wikiKey: 'wiki-top',
          wikiName: 'X',
          confidence: 0.9,
          reasoning: 'fits',
          // text does NOT match fragmentContent.slice(0, 5)
          citationSpans: [{ start: 0, end: 5, text: 'WRONG' }],
        },
      ]),
      fragRelateDeps: makeFragRelateDeps(),
      fragmentLock: makeFakeLock(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      insertEdge,
    }

    await runLinking(deps, {
      fragmentKey: 'frag-1',
      fragmentContent: FRAGMENT_CONTENT,
      entryKey: 'entry-1',
      jobId: 'job-1',
    })

    expect(insertEdge).toHaveBeenCalledTimes(1)
    const call = insertEdge.mock.calls[0][0]
    expect(call.edgeType).toBe('FRAGMENT_IN_WIKI')
    expect(call.attrs).toEqual({ score: 0.9 })
    expect(call.attrs).not.toHaveProperty('citationSpans')
  })

  it('only writes citationSpans on the top-1 edge when multiple wikis match', async () => {
    const insertEdge = vi.fn().mockResolvedValue(undefined)
    const deps: LinkingOrchestratorDeps = {
      wikiClassifyDeps: makeWikiClassifyDeps([
        {
          wikiKey: 'wiki-secondary',
          wikiName: 'Secondary',
          confidence: 0.7,
          reasoning: 'partial',
          citationSpans: [VALID_SPAN],
        },
        {
          wikiKey: 'wiki-top',
          wikiName: 'Top',
          confidence: 0.95,
          reasoning: 'strong',
          citationSpans: [VALID_SPAN],
        },
      ]),
      fragRelateDeps: makeFragRelateDeps(),
      fragmentLock: makeFakeLock(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      insertEdge,
    }

    await runLinking(deps, {
      fragmentKey: 'frag-1',
      fragmentContent: FRAGMENT_CONTENT,
      entryKey: 'entry-1',
      jobId: 'job-1',
    })

    // dfc33d7 (feat(edges): write WIKI_RELATED_TO_WIKI edges from Marcel secondary
    // candidates above 0.4) added a third insertEdge call for the secondary
    // wiki above RELATED_THRESHOLD. Two FRAGMENT_IN_WIKI + one WIKI_RELATED_TO_WIKI.
    expect(insertEdge).toHaveBeenCalledTimes(3)
    const byWiki = new Map(
      insertEdge.mock.calls
        .filter((c) => c[0].edgeType === 'FRAGMENT_IN_WIKI')
        .map((c) => [c[0].dstId, c[0].attrs])
    )
    expect(byWiki.get('wiki-top')).toEqual({
      score: 0.95,
      citationSpans: [VALID_SPAN],
    })
    expect(byWiki.get('wiki-secondary')).toEqual({ score: 0.7 })
    expect(byWiki.get('wiki-secondary')).not.toHaveProperty('citationSpans')
  })

  it('omits citationSpans when Marcel emits none (legacy v3 shape)', async () => {
    const insertEdge = vi.fn().mockResolvedValue(undefined)
    const deps: LinkingOrchestratorDeps = {
      wikiClassifyDeps: makeWikiClassifyDeps([
        {
          wikiKey: 'wiki-top',
          wikiName: 'X',
          confidence: 0.9,
          reasoning: 'fits',
          // no citationSpans field at all
        },
      ]),
      fragRelateDeps: makeFragRelateDeps(),
      fragmentLock: makeFakeLock(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      insertEdge,
    }

    await runLinking(deps, {
      fragmentKey: 'frag-1',
      fragmentContent: FRAGMENT_CONTENT,
      entryKey: 'entry-1',
      jobId: 'job-1',
    })

    expect(insertEdge).toHaveBeenCalledTimes(1)
    const call = insertEdge.mock.calls[0][0]
    expect(call.attrs).toEqual({ score: 0.9 })
    expect(call.attrs).not.toHaveProperty('citationSpans')
  })
})
