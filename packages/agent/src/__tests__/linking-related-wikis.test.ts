import { describe, it, expect, vi } from 'vitest'
import type { CasLock } from '@robin/caslock'
import type { PgTable } from 'drizzle-orm/pg-core'
import { runLinking } from '../stages/index'
import type {
  LinkingOrchestratorDeps,
  WikiClassifyDeps,
  FragRelateDeps,
} from '../stages/index'

/**
 * H4 (#328): WIKI_RELATED_TO_WIKI edges from Marcel secondary
 * candidates. Verifies the linking orchestrator writes the edges
 * correctly, with confidence threshold enforcement and direction
 * sourced at the top-1 winner.
 *
 * The spec's filename (`persist.related-wikis.test.ts`) named persist
 * because the orchestrator initially assumed the FRAGMENT_IN_WIKI
 * write lived there. It actually lives in `runLinking` inside
 * stages/index.ts, so the tests follow the code.
 */

// ── Test scaffolding ────────────────────────────────────────────────────────

function makeFragmentLock(): CasLock<PgTable> {
  // CasLock<PgTable>['using'] runs the body inline; for unit tests we
  // bypass the database lock and call the body directly. The other
  // CasLock methods exist on the type but runLinking only uses
  // `using`.
  return {
    using: async <T,>(_opts: unknown, body: () => Promise<T>): Promise<T> => body(),
  } as unknown as CasLock<PgTable>
}

function makeWikiClassifyDeps(
  rawAssignments: Array<{ wikiKey: string; confidence: number; reasoning: string }>
): WikiClassifyDeps {
  return {
    searchCandidates: vi
      .fn()
      .mockResolvedValue(rawAssignments.map((a) => ({ wikiKey: a.wikiKey, score: 0.5 }))),
    loadThreads: vi.fn().mockResolvedValue(
      rawAssignments.map((a) => ({
        lookupKey: a.wikiKey,
        name: a.wikiKey,
        type: 'log',
        prompt: null,
        description: null,
      }))
    ),
    llmCall: vi.fn().mockResolvedValue({
      assignments: rawAssignments,
    }),
    emitEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeFragRelateDeps(): FragRelateDeps {
  return {
    vectorSearch: vi.fn().mockResolvedValue([]),
    loadFragmentContent: vi.fn().mockResolvedValue(null),
    llmCall: vi.fn().mockResolvedValue({ relevantFragments: [] }),
    emitEvent: vi.fn().mockResolvedValue(undefined),
  }
}

function makeOrchestratorDeps(
  rawAssignments: Array<{ wikiKey: string; confidence: number; reasoning: string }>
): {
  deps: LinkingOrchestratorDeps
  insertEdge: ReturnType<typeof vi.fn>
} {
  const insertEdge = vi.fn().mockResolvedValue(undefined)
  return {
    insertEdge,
    deps: {
      wikiClassifyDeps: makeWikiClassifyDeps(rawAssignments),
      fragRelateDeps: makeFragRelateDeps(),
      fragmentLock: makeFragmentLock(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      insertEdge,
    },
  }
}

const linkingInput = {
  fragmentKey: 'frag01HTEST00000000000000001',
  fragmentContent: 'thoughts about wiki A and wiki B',
  entryKey: 'entry01HTEST0000000000000001',
  jobId: 'job-1',
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runLinking — WIKI_RELATED_TO_WIKI from Marcel secondaries (H4 #328)', () => {
  it('writes FRAGMENT_IN_WIKI to the top-1 winner', async () => {
    const { deps, insertEdge } = makeOrchestratorDeps([
      { wikiKey: 'wikiA', confidence: 0.9, reasoning: 'top' },
      { wikiKey: 'wikiB', confidence: 0.5, reasoning: 'second' },
    ])

    await runLinking(deps, linkingInput)

    const fragmentInWiki = insertEdge.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.edgeType === 'FRAGMENT_IN_WIKI')

    expect(fragmentInWiki.length).toBeGreaterThan(0)
    expect(fragmentInWiki[0]).toMatchObject({
      srcType: 'fragment',
      srcId: linkingInput.fragmentKey,
      dstType: 'wiki',
      dstId: 'wikiA',
      edgeType: 'FRAGMENT_IN_WIKI',
    })
  })

  it('writes WIKI_RELATED_TO_WIKI when secondary confidence > 0.4', async () => {
    const { deps, insertEdge } = makeOrchestratorDeps([
      { wikiKey: 'wikiA', confidence: 0.9, reasoning: 'top' },
      { wikiKey: 'wikiB', confidence: 0.5, reasoning: 'second' },
    ])

    await runLinking(deps, linkingInput)

    const related = insertEdge.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.edgeType === 'WIKI_RELATED_TO_WIKI')

    expect(related).toHaveLength(1)
    expect(related[0]).toMatchObject({
      srcType: 'wiki',
      srcId: 'wikiA',
      dstType: 'wiki',
      dstId: 'wikiB',
      edgeType: 'WIKI_RELATED_TO_WIKI',
      attrs: {
        sourceFragmentId: linkingInput.fragmentKey,
        marcelConfidence: 0.5,
      },
    })
  })

  it('does NOT write WIKI_RELATED_TO_WIKI when secondary confidence <= 0.4', async () => {
    const { deps, insertEdge } = makeOrchestratorDeps([
      { wikiKey: 'wikiA', confidence: 0.9, reasoning: 'top' },
      { wikiKey: 'wikiC', confidence: 0.3, reasoning: 'weak' },
      { wikiKey: 'wikiD', confidence: 0.4, reasoning: 'exact-threshold' },
    ])

    await runLinking(deps, linkingInput)

    const related = insertEdge.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.edgeType === 'WIKI_RELATED_TO_WIKI')

    // 0.3 is below the 0.4 threshold; 0.4 is at the threshold (strict >).
    expect(related).toHaveLength(0)
  })

  it('writes one WIKI_RELATED_TO_WIKI per qualifying secondary', async () => {
    const { deps, insertEdge } = makeOrchestratorDeps([
      { wikiKey: 'wikiA', confidence: 0.9, reasoning: 'top' },
      { wikiKey: 'wikiB', confidence: 0.7, reasoning: 'second' },
      { wikiKey: 'wikiC', confidence: 0.55, reasoning: 'third' },
      { wikiKey: 'wikiD', confidence: 0.41, reasoning: 'fourth' },
      { wikiKey: 'wikiE', confidence: 0.2, reasoning: 'noise' },
    ])

    await runLinking(deps, linkingInput)

    const related = insertEdge.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.edgeType === 'WIKI_RELATED_TO_WIKI')

    expect(related).toHaveLength(3)
    const dsts = related.map((e) => e.dstId)
    expect(dsts).toContain('wikiB')
    expect(dsts).toContain('wikiC')
    expect(dsts).toContain('wikiD')
    expect(dsts).not.toContain('wikiE')
    // Source must always be the top-1 winner.
    expect(related.every((e) => e.srcId === 'wikiA')).toBe(true)
  })

  it('does NOT write WIKI_RELATED_TO_WIKI when no winner clears the FRAGMENT_IN_WIKI threshold', async () => {
    // Marcel scored a few candidates but none above 0.65 (the wiki-classify
    // THRESHOLD). wikiEdges is empty; runLinking should skip the related
    // writes entirely because there's no top-1 to anchor on.
    const { deps, insertEdge } = makeOrchestratorDeps([
      { wikiKey: 'wikiA', confidence: 0.5, reasoning: 'weak top' },
      { wikiKey: 'wikiB', confidence: 0.45, reasoning: 'weak second' },
    ])

    await runLinking(deps, linkingInput)

    const related = insertEdge.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.edgeType === 'WIKI_RELATED_TO_WIKI')

    expect(related).toHaveLength(0)
  })

  it('does NOT write a self-loop when the top-1 wiki appears in rawAssignments', async () => {
    // Defensive guard: Marcel returns the top-1 wiki inside rawAssignments
    // alongside the secondaries. The dedup filter must skip it.
    const { deps, insertEdge } = makeOrchestratorDeps([
      { wikiKey: 'wikiA', confidence: 0.9, reasoning: 'top' },
      { wikiKey: 'wikiB', confidence: 0.7, reasoning: 'second' },
    ])

    await runLinking(deps, linkingInput)

    const related = insertEdge.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.edgeType === 'WIKI_RELATED_TO_WIKI')

    expect(related).toHaveLength(1)
    expect(related[0].srcId).toBe('wikiA')
    expect(related[0].dstId).toBe('wikiB')
    // No self-loop: srcId !== dstId.
    expect(related[0].srcId).not.toBe(related[0].dstId)
  })
})
