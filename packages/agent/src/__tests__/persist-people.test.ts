import { describe, it, expect, vi, beforeEach } from 'vitest'
import { persist, matchMentionsToFragments } from '../stages/persist'
import type { PersistDeps, FragmentResult } from '../stages/types'

function makeMockDeps(overrides: Partial<PersistDeps> = {}): PersistDeps {
  return {
    insertEntry: vi.fn().mockResolvedValue(undefined),
    insertFragment: vi.fn().mockResolvedValue(undefined),
    insertEdge: vi.fn().mockResolvedValue(undefined),
    insertPerson: vi.fn().mockResolvedValue(undefined),
    updateFragmentEmbedding: vi.fn().mockResolvedValue(undefined),
    upsertPerson: vi
      .fn()
      .mockImplementation(async ({ personKey }: { personKey: string }) => ({
        personKey,
        isNew: true,
      })),
    mergePersonAliases: vi.fn().mockResolvedValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    openRouterConfig: {
      apiKey: 'test-key',
      models: {
        extraction: 'anthropic/claude-3-5-sonnet',
        classification: 'anthropic/claude-3-5-sonnet',
        wikiGeneration: 'anthropic/claude-3-5-sonnet',
        embedding: 'openai/text-embedding-3-small',
      },
    },
    ...overrides,
  }
}

function makeFragment(overrides: Partial<FragmentResult> = {}): FragmentResult {
  return {
    content: 'Had coffee with Sarah at the park',
    type: 'note',
    confidence: 0.9,
    sourceSpan: 'Had coffee with Sarah at the park',
    suggestedSlug: 'coffee-with-sarah',
    title: 'Coffee with Sarah',
    tags: [],
    wikiLinks: [],
    ...overrides,
  }
}

// vaultId was stripped from the persist pipeline in 096b835
// (refactor: strip vaultId from extraction/linking pipeline and agent factory).
const baseInput = {
  entryKey: 'entry01HTEST1234567890ABCDEF',
  entryContent: 'Had coffee with Sarah at the park. Bob said hello.',
  source: 'web',
  primaryTopic: 'Coffee meetup',
  jobId: 'job1',
}

// Block network calls to OpenRouter in embedText — return null gracefully.
// embedText calls res.text() on !res.ok responses (added alongside the
// EmbedFailure diagnostics), so the mock must include text() to avoid
// falling into the catch branch and noisy stderr output.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
      json: async () => ({}),
    })
  )
})

// ── matchMentionsToFragments ────────────────────────────────────────────────

describe('matchMentionsToFragments', () => {
  it('matches mention to fragment containing sourceSpan', () => {
    const fragments: FragmentResult[] = [
      makeFragment({
        content: 'Had coffee with Sarah at the park',
        sourceSpan: 'Had coffee with Sarah',
      }),
      makeFragment({ content: 'Bob said hello at the gate', sourceSpan: 'Bob said hello' }),
    ]
    const extractions = [
      { mention: 'Sarah', sourceSpan: 'with Sarah', confidence: 0.92 },
      { mention: 'Bob', sourceSpan: 'Bob said', confidence: 0.81 },
    ]
    const peopleMap = new Map([
      ['Sarah', 'personAAA'],
      ['Bob', 'personBBB'],
    ])

    const result = matchMentionsToFragments(extractions, fragments, peopleMap)

    expect(result.get(0)?.map((p) => p.personKey)).toContain('personAAA')
    expect(result.get(1)?.map((p) => p.personKey)).toContain('personBBB')
    expect(result.get(0)?.[0].attrs).toEqual({
      mention: 'Sarah',
      sourceSpan: 'with Sarah',
      confidence: 0.92,
    })
  })

  it('matches mention text fallback when sourceSpan is not found', () => {
    const fragments: FragmentResult[] = [
      makeFragment({ content: 'Sarah was here yesterday', sourceSpan: 'Sarah was here' }),
    ]
    const extractions = [{ mention: 'Sarah', sourceSpan: 'nonexistent span', confidence: 0.7 }]
    const peopleMap = new Map([['Sarah', 'personAAA']])

    const result = matchMentionsToFragments(extractions, fragments, peopleMap)

    expect(result.get(0)?.map((p) => p.personKey)).toContain('personAAA')
  })

  it('matches one mention to multiple fragments', () => {
    const fragments: FragmentResult[] = [
      makeFragment({
        content: 'Talked with Sarah in the morning',
        sourceSpan: 'Talked with Sarah',
      }),
      makeFragment({ content: 'Sarah joined us for lunch', sourceSpan: 'Sarah joined us' }),
    ]
    const extractions = [{ mention: 'Sarah', sourceSpan: 'with Sarah', confidence: 0.88 }]
    const peopleMap = new Map([['Sarah', 'personAAA']])

    const result = matchMentionsToFragments(extractions, fragments, peopleMap)

    expect(result.get(0)?.map((p) => p.personKey)).toContain('personAAA')
    expect(result.get(1)?.map((p) => p.personKey)).toContain('personAAA')
  })

  it('deduplicates person keys per fragment', () => {
    const fragments: FragmentResult[] = [
      makeFragment({ content: 'Sarah and Sarah met again', sourceSpan: 'Sarah and Sarah' }),
    ]
    const extractions = [
      { mention: 'Sarah', sourceSpan: 'Sarah and', confidence: 0.9 },
      { mention: 'Sarah O.', sourceSpan: 'Sarah met', confidence: 0.7 },
    ]
    const peopleMap = new Map([
      ['Sarah', 'personAAA'],
      ['Sarah O.', 'personAAA'],
    ])

    const result = matchMentionsToFragments(extractions, fragments, peopleMap)

    const keys = result.get(0)?.map((p) => p.personKey) ?? []
    expect(keys).toEqual(['personAAA'])
    // First-extraction-wins on attrs when the same person dedups inside one frag.
    expect(result.get(0)?.[0].attrs.mention).toBe('Sarah')
  })

  it('returns empty map when no fragments match', () => {
    const fragments: FragmentResult[] = [
      makeFragment({ content: 'Nice weather', sourceSpan: 'Nice weather' }),
    ]
    const extractions = [{ mention: 'Sarah', sourceSpan: 'with Sarah downtown', confidence: 0.9 }]
    const peopleMap = new Map([['Sarah', 'personAAA']])

    const result = matchMentionsToFragments(extractions, fragments, peopleMap)

    expect(result.has(0)).toBe(false)
  })
})

// ── persist — Postgres inserts ──────────────────────────────────────────────

describe('persist — Postgres inserts', () => {
  it('inserts entry with vaultId and basic fields', async () => {
    const deps = makeMockDeps()
    await persist(deps, { ...baseInput, fragments: [makeFragment()] })

    expect(deps.insertEntry).toHaveBeenCalledTimes(1)
    const entryRow = (deps.insertEntry as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(entryRow.lookupKey).toBe(baseInput.entryKey)
    // vaultId removed from entry row in 096b835
    expect(entryRow.state).toBe('PENDING')
    expect(entryRow.slug).toBeTruthy()
    expect(entryRow.title).toBe(baseInput.primaryTopic)
  })

  it('inserts each fragment with vaultId, entryId, state=PENDING', async () => {
    const deps = makeMockDeps()
    const fragments = [
      makeFragment({ title: 'Alpha', suggestedSlug: 'alpha' }),
      makeFragment({ title: 'Beta', suggestedSlug: 'beta' }),
    ]
    await persist(deps, { ...baseInput, fragments })

    expect(deps.insertFragment).toHaveBeenCalledTimes(2)
    const calls = (deps.insertFragment as ReturnType<typeof vi.fn>).mock.calls
    for (const [row] of calls) {
      // vaultId removed from fragment row in 096b835
      expect(row.entryId).toBe(baseInput.entryKey)
      expect(row.state).toBe('PENDING')
    }
  })

  it('calls upsertPerson for each new person', async () => {
    const deps = makeMockDeps()
    const fragments = [makeFragment()]

    await persist(deps, {
      ...baseInput,
      fragments,
      newPeople: [
        {
          personKey: 'person01HAAAABBBBCCCCDDDDEEEE',
          canonicalName: 'Sarah Ouma',
          verified: false,
        },
      ],
      peopleMap: new Map([['Sarah', 'person01HAAAABBBBCCCCDDDDEEEE']]),
      extractions: [{ mention: 'Sarah', sourceSpan: 'with Sarah', confidence: 0.91 }],
      entityExtractionStatus: 'completed' as const,
    })

    expect(deps.upsertPerson).toHaveBeenCalledTimes(1)
    const upsertArgs = (deps.upsertPerson as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(upsertArgs.canonicalName).toBe('Sarah Ouma')
    expect(upsertArgs.verified).toBe(false)
  })

  it('creates FRAGMENT_MENTIONS_PERSON edges with mention attrs (H2 #329)', async () => {
    const deps = makeMockDeps()
    const fragments = [makeFragment({ content: 'Had coffee with Sarah', sourceSpan: 'with Sarah' })]

    await persist(deps, {
      ...baseInput,
      fragments,
      newPeople: [
        { personKey: 'person01HAAAABBBBCCCCDDDDEEEE', canonicalName: 'Sarah', verified: false },
      ],
      peopleMap: new Map([['Sarah', 'person01HAAAABBBBCCCCDDDDEEEE']]),
      extractions: [{ mention: 'Sarah', sourceSpan: 'with Sarah', confidence: 0.93 }],
      entityExtractionStatus: 'completed' as const,
    })

    const edgeCalls = (deps.insertEdge as ReturnType<typeof vi.fn>).mock.calls
    const mentionEdges = edgeCalls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).edgeType === 'FRAGMENT_MENTIONS_PERSON'
    )

    expect(mentionEdges.length).toBeGreaterThan(0)
    expect(mentionEdges[0][0]).toMatchObject({
      srcType: 'fragment',
      dstType: 'person',
      dstId: 'person01HAAAABBBBCCCCDDDDEEEE',
      edgeType: 'FRAGMENT_MENTIONS_PERSON',
      attrs: {
        mention: 'Sarah',
        sourceSpan: 'with Sarah',
        confidence: 0.93,
      },
    })
  })

  it('calls mergePersonAliases for each newAliases entry', async () => {
    const deps = makeMockDeps()
    const fragments = [makeFragment()]

    await persist(deps, {
      ...baseInput,
      fragments,
      newPeople: [],
      peopleMap: new Map([['sarah', 'personEXIST']]),
      newAliases: new Map([['personEXIST', ['sarah', 'S. Ouma']]]),
      extractions: [{ mention: 'sarah', sourceSpan: 'with Sarah', confidence: 0.85 }],
      entityExtractionStatus: 'completed' as const,
    })

    expect(deps.mergePersonAliases).toHaveBeenCalledWith('personEXIST', ['sarah', 'S. Ouma'])
  })

  it('works without people fields (backwards compatible)', async () => {
    const deps = makeMockDeps()
    const fragments = [makeFragment()]

    const result = await persist(deps, { ...baseInput, fragments })

    expect(result.data.entryKey).toBe(baseInput.entryKey)
    expect(result.data.fragmentKeys).toHaveLength(1)
  })

  it('creates ENTRY_IN_VAULT and ENTRY_HAS_FRAGMENT edges', async () => {
    const deps = makeMockDeps()
    const fragments = [makeFragment(), makeFragment({ title: 'Second' })]

    await persist(deps, { ...baseInput, fragments })

    const edgeCalls = (deps.insertEdge as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    )
    // ENTRY_IN_VAULT and FRAGMENT_IN_VAULT were removed in 096b835
    // (refactor: strip vaultId from extraction/linking pipeline and agent factory).
    const entryHasFragment = edgeCalls.filter((e) => e.edgeType === 'ENTRY_HAS_FRAGMENT')

    expect(entryHasFragment).toHaveLength(2)
  })

  it("ENTRY_HAS_FRAGMENT edges write with src_type='raw_source'", async () => {
    const deps = makeMockDeps()
    const fragments = [makeFragment(), makeFragment({ title: 'Second' })]

    await persist(deps, { ...baseInput, fragments })

    const edgeCalls = (deps.insertEdge as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    )
    const entryHasFragment = edgeCalls.filter((e) => e.edgeType === 'ENTRY_HAS_FRAGMENT')

    // Migration 0016 canonicalised src_type. Persist must emit
    // 'raw_source', not the legacy 'entry' string. The CHECK
    // constraint added in 0016 will reject 'entry' if this ever
    // regresses.
    expect(entryHasFragment.length).toBeGreaterThan(0)
    for (const edge of entryHasFragment) {
      expect(edge.srcType).toBe('raw_source')
      expect(edge.srcId).toBe(baseInput.entryKey)
      expect(edge.dstType).toBe('fragment')
    }
  })
})
