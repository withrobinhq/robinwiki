import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── LLM capture ───────────────────────────────────────────────────────────
// fakeCallLlm records (system, user) pairs and returns a structured object
// matching the wiki-generation output contract (markdown + infobox + citations).
// Tests assert against llmCalls[i].system / .user to prove which override the
// pipeline actually took. llmResponse is mutable so individual tests can
// override the fake response to exercise infobox/citations persistence.
const llmCalls: Array<{ system: string; user: string }> = []
let llmResponse: {
  markdown: string
  infobox: unknown
  citations: unknown[]
} = {
  markdown: '# Fake regenerated markdown',
  infobox: null,
  citations: [],
}
const fakeCallLlm = vi.fn(async (system: string, user: string) => {
  llmCalls.push({ system, user })
  return llmResponse
})

vi.mock('@robin/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@robin/agent')>()
  return {
    ...original,
    createIngestAgents: vi.fn(() => ({
      wikiClassifier: {},
      fragmenter: {},
      entityExtractor: {},
      fragScorer: {},
      wikiWriter: {},
    })),
    createTypedCaller: vi.fn(() => fakeCallLlm),
    // Phase A3: regen.ts switched from createTypedCaller to withTypedUsage
    // for the wikiWriter call so cost telemetry can attach. Mock returns
    // the same fakeCallLlm so existing assertions keep working; the usage
    // record callback is never invoked in this mock path because the
    // fake bypasses agent.generate() entirely.
    withTypedUsage: vi.fn(() => fakeCallLlm),
    embedText: vi.fn(async () => null),
  }
})

vi.mock('./openrouter-config.js', () => ({
  loadOpenRouterConfig: vi.fn(async () => ({
    apiKey: 'test-key',
    models: {
      extraction: 'test/model',
      classification: 'test/model',
      wikiGeneration: 'test/model',
      embedding: 'test/model',
    },
  })),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

// ── DB mock ───────────────────────────────────────────────────────────────
// Each test calls stageDbResponses([...]) to queue the responses that terminal
// awaits (.where(), .orderBy().limit(), .groupBy()) will pop in order.
// Updates and inserts are recorded for inspection but do NOT pop the queue.
const dbResponseQueue: unknown[][] = []
const dbUpdates: Array<Record<string, unknown>> = []
const dbInserts: Array<Record<string, unknown>> = []

function stageDbResponses(responses: unknown[][]) {
  dbResponseQueue.length = 0
  dbResponseQueue.push(...responses)
}

function popResponse(): unknown[] {
  // If the suite under-stages, we return [] instead of throwing — it keeps the
  // happy path working while making mis-staged tests fail via assertion mismatch
  // rather than a cryptic TypeError.
  return dbResponseQueue.shift() ?? []
}

vi.mock('../db/client.js', () => {
  function selectChain() {
    return {
      from: () => ({
        where: (..._args: unknown[]) => {
          // .where() is thenable — await it or chain .orderBy()/.groupBy()/.limit().
          // The terminal `.limit()` is the hot path used by classifyUnfiledFragments
          // (regen.ts:201-211 wiki lookup) and other fixed-row reads. Without it,
          // every classify call throws TypeError and the regen.ts catch (issue #222)
          // silently swallowed it, hiding a real test-fidelity bug.
          let deferred: Promise<unknown[]> | null = null
          const ensureDeferred = () => {
            if (!deferred) deferred = Promise.resolve(popResponse())
            return deferred
          }
          return {
            // Terminal awaits: the test queue pops one entry.
            // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
            then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (r: unknown) => unknown) =>
              ensureDeferred().then(onFulfilled, onRejected),
            limit: async () => popResponse(),
            orderBy: () => ({
              limit: async () => popResponse(),
            }),
            groupBy: () => ({
              // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
              then: (onFulfilled: (v: unknown[]) => unknown) =>
                Promise.resolve(popResponse()).then(onFulfilled),
            }),
          }
        },
      }),
    }
  }
  const fakeDb = {
    select: (..._args: unknown[]) => selectChain(),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: (..._args: unknown[]) => {
          dbUpdates.push(data)
          return {
            // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
            then: (onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
              Promise.resolve(undefined).then(onFulfilled, onRejected),
            returning: async () => [{ lookupKey: 'wiki-key-1', state: 'LINKING' }],
          }
        },
      }),
    }),
    insert: () => ({
      values: async (data: Record<string, unknown>) => {
        dbInserts.push(data)
      },
    }),
  }
  return { db: fakeDb }
})

vi.mock('../db/schema.js', () => ({
  wikis: {
    lookupKey: 'wikis.lookupKey',
    name: 'wikis.name',
    type: 'wikis.type',
    prompt: 'wikis.prompt',
    description: 'wikis.description',
    slug: 'wikis.slug',
    state: 'wikis.state',
    content: 'wikis.content',
    metadata: 'wikis.metadata',
    citationDeclarations: 'wikis.citationDeclarations',
    embedding: 'wikis.embedding',
    searchVector: 'wikis.searchVector',
    updatedAt: 'wikis.updatedAt',
    deletedAt: 'wikis.deletedAt',
  },
  wikiTypes: {
    slug: 'wikiTypes.slug',
    prompt: 'wikiTypes.prompt',
    userModified: 'wikiTypes.userModified',
  },
  edges: {
    srcId: 'edges.srcId',
    dstId: 'edges.dstId',
    edgeType: 'edges.edgeType',
    attrs: 'edges.attrs',
    deletedAt: 'edges.deletedAt',
  },
  fragments: {
    lookupKey: 'fragments.lookupKey',
    slug: 'fragments.slug',
    title: 'fragments.title',
    content: 'fragments.content',
    embedding: 'fragments.embedding',
    searchVector: 'fragments.searchVector',
    createdAt: 'fragments.createdAt',
    deletedAt: 'fragments.deletedAt',
  },
  edits: {
    objectType: 'edits.objectType',
    objectId: 'edits.objectId',
    source: 'edits.source',
    timestamp: 'edits.timestamp',
    content: 'edits.content',
  },
  people: {
    lookupKey: 'people.lookupKey',
    name: 'people.name',
    content: 'people.content',
    embedding: 'people.embedding',
    searchVector: 'people.searchVector',
    deletedAt: 'people.deletedAt',
  },
}))

// ── Import under test (after mocks) ───────────────────────────────────────

const { regenerateWiki } = await import('./regen.js')
const { db: mockDb } = await import('../db/client.js')

// ── Helpers ───────────────────────────────────────────────────────────────

function baseWiki(overrides: Record<string, unknown> = {}) {
  return {
    lookupKey: 'wiki-key-1',
    name: 'Test Wiki',
    type: 'log',
    slug: 'test-wiki',
    content: 'previous content',
    prompt: null,
    deletedAt: null,
    ...overrides,
  }
}

// Query order consumed by regenerateWiki when fragmentKeys=[], no [[slug]] refs
// in wiki.content, no wiki.prompt override:
//   1. wikis select (top-level, by lookupKey) — outer regen wiki lookup
//   2. classifyUnfiledFragments pre-step (regen.ts:201-211)
//      → wikis select .where().limit(1) — pop returns [] so the
//        classify path bails at the `if (!wiki) return ...` guard.
//        This stage is REQUIRED (#222): if you under-stage by skipping it,
//        the next consumer pops the wrong response and the test will fail
//        with a meaningless mismatch.
//   3. edges select (FRAGMENT_IN_WIKI dst=wikiKey)  → empty → fragmentKeys=[]
//      [fragments select is SKIPPED because fragmentKeys.length === 0]
//   4. edits select (orderBy+limit)
//      [shared-fragment edges SKIPPED because fragmentKeys.length === 0]
//      [slug-ref wikis SKIPPED because content has no [[slug]] matches]
//      [linked wikis SKIPPED because cappedKeys.length === 0]
//   5. wikiTypes select (only when wiki.prompt is falsy/whitespace)

// ── Tests ─────────────────────────────────────────────────────────────────

describe('regenerateWiki — override hierarchy integration', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeEach(() => {
    llmCalls.length = 0
    dbUpdates.length = 0
    dbInserts.length = 0
    dbResponseQueue.length = 0
    warnSpy.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses disk default when wiki.prompt is empty and no userModified wiki_type row exists', async () => {
    stageDbResponses([
      [baseWiki()], // 1. wikis select (outer)
      [],           // 2. classifyUnfiledFragments wiki lookup → empty (early-returns)
      [],           // 3. fragment edges → empty
      [],           // 4. user edits → empty
      [],           // 5. wikiTypes select → no userModified row
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result).toBeDefined()
    expect(llmCalls).toHaveLength(1)
    // log.yaml system_message identifies Quill as a changelog author.
    expect(llmCalls[0].system).toContain('Quill')
    expect(llmCalls[0].system).toContain('changelog author')
    // Template render includes the wiki title and the canonical DOCUMENT STRUCTURE marker.
    expect(llmCalls[0].user).toContain('Test Wiki')
    expect(llmCalls[0].user).toContain('DOCUMENT STRUCTURE')
  })

  it('short-circuits type-level lookup and APPENDS wiki.prompt to system_message', async () => {
    stageDbResponses([
      [baseWiki({ prompt: 'You are a pirate poet, yarrr.' })], // 1. wikis select (outer)
      [],                                                        // 2. classifyUnfiledFragments wiki lookup
      [],                                                        // 3. fragment edges
      [],                                                        // 4. user edits
      // wikiTypes select is NEVER reached because wiki.prompt short-circuits.
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(llmCalls).toHaveLength(1)
    // System message APPENDS: Quill base stays, pirate text follows after a blank-line.
    expect(llmCalls[0].system).toContain('Quill')
    expect(llmCalls[0].system).toContain('changelog author')
    expect(llmCalls[0].system).toContain('You are a pirate poet, yarrr.')
    expect(llmCalls[0].system).toMatch(/\n\nYou are a pirate poet, yarrr\.$/)
    // Template (user) is still the disk default — title + DOCUMENT STRUCTURE intact.
    expect(llmCalls[0].user).toContain('Test Wiki')
    expect(llmCalls[0].user).toContain('DOCUMENT STRUCTURE')
  })

  it('honors a user-customized wiki_type YAML blob for template (system_message stays disk-sourced after sec-phase-4)', async () => {
    // SEC-H4 lockdown (sec-phase-4-pipeline 01): user YAML overrides may
    // change template, temperature, etc. — but system_message always comes
    // from the disk default. Even if a stored row carried a forbidden
    // override, the lenient loader strips it silently and the disk
    // system_message wins.
    const customYaml = `name: CustomLog
version: 7
category: generation
task: thread_wiki_log
description: custom log variant
temperature: 0.5
system_message: "CUSTOM_SYSTEM_MARKER — you are a custom log author."
template: |
  CUSTOM_TEMPLATE_MARKER
  Title: {{title}}
  Count: {{count}}
input_variables:
  - name: fragments
    description: fragment content
    required: true
  - name: title
    description: title
    required: true
  - name: date
    description: current date
    required: false
  - name: count
    description: count
    required: true
`

    stageDbResponses([
      [baseWiki()],              // 1. wikis select (outer)
      [],                        // 2. classifyUnfiledFragments wiki lookup
      [],                        // 3. fragment edges
      [],                        // 4. user edits
      [{ prompt: customYaml }],  // 5. wikiTypes select → userModified row
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(llmCalls).toHaveLength(1)
    // System message: disk default wins, the forbidden user override is stripped.
    expect(llmCalls[0].system).not.toContain('CUSTOM_SYSTEM_MARKER')
    expect(llmCalls[0].system).toContain('Quill')
    // Template (allowed override): the user's CUSTOM_TEMPLATE_MARKER drives the user prompt.
    expect(llmCalls[0].user).toContain('CUSTOM_TEMPLATE_MARKER')
    expect(llmCalls[0].user).toContain('Title: Test Wiki')
    expect(llmCalls[0].user).toContain('Count: 0')
    expect(llmCalls[0].user).not.toContain('DOCUMENT STRUCTURE')
  })

  it('emits a forbidden_field_stripped audit row when the stored YAML carries a system_message override', async () => {
    // sec-phase-4-pipeline 01: the runtime loader silently drops forbidden
    // fields and the regen path emits an audit row so operators can find
    // legacy rows that still carry an override.
    const customYaml = `name: CustomLog
version: 7
category: generation
task: thread_wiki_log
description: custom log variant
temperature: 0.5
system_message: "evil prompt override"
template: |
  Title: {{title}}
input_variables:
  - name: fragments
    description: fragment content
    required: true
  - name: title
    description: title
    required: true
  - name: date
    description: current date
    required: false
  - name: count
    description: count
    required: true
`

    stageDbResponses([
      [baseWiki()],
      [],
      [],
      [],
      [{ prompt: customYaml }],
    ])

    const { emitAuditEvent } = await import('../db/audit.js')
    const auditMock = emitAuditEvent as unknown as ReturnType<typeof vi.fn>
    auditMock.mockClear()

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(llmCalls).toHaveLength(1)
    // Disk system_message wins.
    expect(llmCalls[0].system).not.toContain('evil prompt override')
    expect(llmCalls[0].system).toContain('Quill')

    // Audit row emitted.
    const calls = auditMock.mock.calls
    const stripCall = calls.find(
      (c) => (c[1] as { eventType?: string }).eventType === 'forbidden_field_stripped'
    )
    expect(stripCall).toBeDefined()
    const params = stripCall?.[1] as {
      entityType: string
      entityId: string
      detail?: { fields?: string[]; wikiType?: string }
    }
    expect(params.entityType).toBe('wiki_type')
    expect(params.entityId).toBe('log')
    expect(params.detail?.fields).toContain('system_message')
  })

  it('falls back to disk default (does NOT throw) when the stored YAML blob is syntactically malformed', async () => {
    const corrupt = 'not: : : valid yaml ][['

    stageDbResponses([
      [baseWiki()],           // 1. wikis select (outer)
      [],                     // 2. classifyUnfiledFragments wiki lookup
      [],                     // 3. fragment edges
      [],                     // 4. user edits
      [{ prompt: corrupt }],  // 5. wikiTypes select → corrupt blob
    ])

    await expect(
      regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })
    ).resolves.toBeDefined()

    expect(llmCalls).toHaveLength(1)
    // Disk default took over — system reverts to Quill, not the corrupt row.
    expect(llmCalls[0].system).toContain('Quill')
    expect(llmCalls[0].system).not.toContain('CUSTOM_SYSTEM_MARKER')
    expect(llmCalls[0].user).toContain('DOCUMENT STRUCTURE')
  })

  it('falls back to disk default when the stored YAML blob fails PromptSpec schema validation', async () => {
    // Valid YAML syntax but missing required PromptSpec fields (system_message, template, ...).
    const schemaInvalid = `name: Incomplete
version: 1
category: generation
task: x
description: x
temperature: 0.3
`

    stageDbResponses([
      [baseWiki()],                // 1. wikis select (outer)
      [],                          // 2. classifyUnfiledFragments wiki lookup
      [],                          // 3. fragment edges
      [],                          // 4. user edits
      [{ prompt: schemaInvalid }], // 5. wikiTypes select → schema-invalid row
    ])

    await expect(
      regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })
    ).resolves.toBeDefined()

    expect(llmCalls).toHaveLength(1)
    expect(llmCalls[0].system).toContain('Quill')
  })

  it('trims surrounding whitespace from wiki.prompt before appending to system_message', async () => {
    stageDbResponses([
      [baseWiki({ prompt: 'pirate voice\n\n' })], // 1. wikis select (outer)
      [],                                          // 2. classifyUnfiledFragments wiki lookup
      [],                                          // 3. fragment edges
      [],                                          // 4. user edits
      // wikiTypes select is NEVER reached because wiki.prompt short-circuits.
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(llmCalls).toHaveLength(1)
    // Base system_message (Quill) is preserved; pirate voice appended cleanly without trailing newlines.
    expect(llmCalls[0].system).toContain('Quill')
    expect(llmCalls[0].system).toMatch(/\n\npirate voice$/)
  })

  it('treats whitespace-only wiki.prompt as "no override" and falls through to disk default', async () => {
    // wiki.prompt is non-empty string but .trim() is empty — the regen.ts guard
    // must treat this as "no override" and consult wikiTypes instead.
    stageDbResponses([
      [baseWiki({ prompt: '   \n\t  ' })], // 1. wikis select (outer)
      [],                                   // 2. classifyUnfiledFragments wiki lookup
      [],                                   // 3. fragment edges
      [],                                   // 4. user edits
      [], // 5. wikiTypes select reached because whitespace-only prompt was ignored
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(llmCalls).toHaveLength(1)
    // Whitespace was NOT used as the system message — disk default kicked in.
    expect(llmCalls[0].system).toContain('Quill')
    expect(llmCalls[0].system).not.toBe('')
  })
})

describe('regenerateWiki — sidecar persistence', () => {
  beforeEach(() => {
    llmCalls.length = 0
    dbUpdates.length = 0
    dbInserts.length = 0
    dbResponseQueue.length = 0
    // Reset the fake LLM response between tests.
    llmResponse = {
      markdown: '# Fake regenerated markdown',
      infobox: null,
      citations: [],
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('persists markdown, infobox (inside metadata), and citationDeclarations in a single wikis update', async () => {
    llmResponse = {
      markdown: '# Regen output\n\n## Progress\nShipped sidecar.',
      infobox: {
        rows: [
          { label: 'Status', value: 'active', valueKind: 'status' },
          { label: 'Owner', value: '[[person:sarah-chen]]', valueKind: 'ref' },
        ],
      },
      citations: [
        { sectionAnchor: 'progress', fragmentIds: ['frag-abc', 'frag-def'] },
      ],
    }

    stageDbResponses([
      [baseWiki()], // 1. wikis select (outer)
      [],           // 2. classifyUnfiledFragments wiki lookup
      [],           // 3. fragment edges → empty
      [],           // 4. user edits → empty
      [],           // 5. wikiTypes select → no userModified row
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result.content).toBe(llmResponse.markdown)

    // First update is the LINKING guard; second writes content + sidecar
    const contentUpdate = dbUpdates[1]
    expect(contentUpdate).toBeDefined()
    expect(contentUpdate.content).toBe(llmResponse.markdown)
    expect(contentUpdate.citationDeclarations).toEqual(llmResponse.citations)
    expect(contentUpdate.state).toBe('RESOLVED')
    const merged = contentUpdate.metadata as { infobox: unknown }
    expect(merged).toBeDefined()
    expect(merged.infobox).toEqual(llmResponse.infobox)
  })

  it('stores metadata.infobox = null and citationDeclarations = [] when the LLM emits neither', async () => {
    llmResponse = {
      markdown: '# Minimal output',
      infobox: null,
      citations: [],
    }

    stageDbResponses([
      [baseWiki()], // 1. wikis select (outer)
      [],           // 2. classifyUnfiledFragments wiki lookup
      [],           // 3. fragment edges
      [],           // 4. user edits
      [],           // 5. wikiTypes select
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    // dbUpdates[0] is the LINKING guard; [1] is the content update
    const contentUpdate = dbUpdates[1]
    expect(contentUpdate).toBeDefined()
    expect(contentUpdate.content).toBe('# Minimal output')
    expect(contentUpdate.citationDeclarations).toEqual([])
    expect(contentUpdate.state).toBe('RESOLVED')
    const merged = contentUpdate.metadata as { infobox: unknown }
    expect(merged.infobox).toBeNull()
  })

  it('preserves other keys in wikis.metadata while overwriting infobox', async () => {
    llmResponse = {
      markdown: '# New markdown',
      infobox: { rows: [{ label: 'Status', value: 'active', valueKind: 'status' }] },
      citations: [],
    }

    // Wiki already has metadata with a hypothetical future sidecar field present.
    const wikiWithExtras = baseWiki({
      metadata: { infobox: null, futureField: { answer: 42 } } as unknown,
    })

    stageDbResponses([
      [wikiWithExtras], // 1. wikis select (outer)
      [],               // 2. classifyUnfiledFragments wiki lookup
      [],               // 3. fragment edges
      [],               // 4. user edits
      [],               // 5. wikiTypes select
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    // dbUpdates[0] is the LINKING guard; [1] is the content update
    const contentUpdate = dbUpdates[1]
    const merged = contentUpdate.metadata as { infobox: unknown; futureField?: unknown }
    expect(merged.infobox).toEqual(llmResponse.infobox)
    expect(merged.futureField).toEqual({ answer: 42 })
  })
})

// ── Stream E1 keystone — partition tests ──────────────────────────────────
//
// Focus: assert the post-first-regen partition behaviour — no-op short-circuit,
// triggering-fragments shape, lifecycle_state transitions. The mock DB harness
// returns whatever the test queues; partition compute is pure JS over the
// queued fragment + edge rows.

describe('regenerateWiki — E1 partition (post-first-regen)', () => {
  beforeEach(() => {
    llmCalls.length = 0
    dbUpdates.length = 0
    dbInserts.length = 0
    dbResponseQueue.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('flips lifecycle_state to dreaming on entry and back to filed on success', async () => {
    stageDbResponses([
      [baseWiki()], // 1. wikis select (outer)
      [],           // 2. classifyUnfiledFragments
      [],           // 3. fragment edges (empty → first-regen path)
      [],           // 4. user edits
      [],           // 5. wikiTypes select
    ])

    await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    // dbUpdates[0] is the LINKING + dreaming flip; [1] is content + filed.
    expect(dbUpdates[0]).toMatchObject({ state: 'LINKING', lifecycleState: 'dreaming' })
    expect(dbUpdates[1]).toMatchObject({ state: 'RESOLVED', lifecycleState: 'filed' })
    // last_regen_at is stamped on success (not on the dreaming flip).
    expect(dbUpdates[1].lastRegenAt).toBeInstanceOf(Date)
  })

  it('returns triggeringFragments=undefined and skipped=undefined on first regen', async () => {
    // First regen: wiki.lastRebuiltAt is null → legacy full-synthesis path.
    // Partition is not computed; triggeringFragments is undefined.
    stageDbResponses([
      [baseWiki({ lastRebuiltAt: null })],
      [],
      [],
      [],
      [],
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })
    expect(result.triggeringFragments).toBeUndefined()
    expect(result.skipped).toBeFalsy()
    expect(llmCalls).toHaveLength(1)
  })

  it('short-circuits when partition is empty post-first-regen and lifecycle returns to filed', async () => {
    // Post-first-regen wiki with one INTEGRATED fragment (edge older than
    // last_rebuilt_at, fragment older than last_rebuilt_at). Partition: NEW
    // and UPDATED both empty; REMOVED empty too. Expect skipped=true.
    const lastRebuiltAt = new Date('2026-04-01T00:00:00Z')
    const oldEdge = {
      srcId: 'frag-1',
      attrs: null,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    }
    const oldFrag = {
      lookupKey: 'frag-1',
      slug: 'frag-1',
      title: 't',
      content: 'c',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
    }
    stageDbResponses([
      [baseWiki({ lastRebuiltAt, content: 'existing body' })],
      [],
      [oldEdge],   // FRAGMENT_IN_WIKI active edges (with createdAt)
      [],          // REMOVED partition: empty
      [oldFrag],   // hydrate fragments
      [],          // user edits
      [],          // wikiTypes select
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result.skipped).toBe(true)
    // No LLM call when partition is empty.
    expect(llmCalls).toHaveLength(0)
    // Still flips lifecycle back to filed and bumps last_rebuilt_at.
    const skipUpdate = dbUpdates.find(
      (u) => u.lifecycleState === 'filed' && u.state === 'RESOLVED' && u.content === undefined
    )
    expect(skipUpdate).toBeDefined()
    // Body stays the same — content key not in the skip-path update.
    // triggeringFragments still surfaces the integrated count for audit.
    expect(result.triggeringFragments).toBeDefined()
    expect(result.triggeringFragments?.integratedCount).toBe(1)
    expect(result.triggeringFragments?.new).toEqual([])
    expect(result.triggeringFragments?.updated).toEqual([])
    expect(result.triggeringFragments?.removed).toEqual([])
  })

  it('reports NEW fragments in triggeringFragments and INTEGRATED is absent from prompt', async () => {
    const lastRebuiltAt = new Date('2026-04-01T00:00:00Z')
    // One NEW edge (created after last_rebuilt_at), one INTEGRATED edge.
    const newEdge = {
      srcId: 'frag-new',
      attrs: null,
      createdAt: new Date('2026-04-15T00:00:00Z'),
    }
    const intEdge = {
      srcId: 'frag-int',
      attrs: null,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    }
    const newFrag = {
      lookupKey: 'frag-new',
      slug: 'frag-new',
      title: 'New fragment',
      content: 'fresh content body',
      createdAt: new Date('2026-04-15T00:00:00Z'),
      updatedAt: new Date('2026-04-15T00:00:00Z'),
    }
    const intFrag = {
      lookupKey: 'frag-int',
      slug: 'frag-int',
      title: 'Integrated fragment',
      content: 'this should NOT be in the prompt',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
    }
    stageDbResponses([
      [baseWiki({ lastRebuiltAt, content: 'existing body' })],
      [],
      [newEdge, intEdge],
      [],            // REMOVED partition: empty
      [newFrag, intFrag],
      [],            // user edits
      [],            // wikiTypes select
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result.skipped).toBeFalsy()
    expect(result.triggeringFragments?.new).toHaveLength(1)
    expect(result.triggeringFragments?.new[0].slug).toBe('frag-new')
    expect(result.triggeringFragments?.integratedCount).toBe(1)

    // Architectural enforcement: the integrated fragment's content must not
    // appear in the prompt. The new fragment's content must.
    expect(llmCalls).toHaveLength(1)
    expect(llmCalls[0].user).toContain('fresh content body')
    expect(llmCalls[0].user).not.toContain('this should NOT be in the prompt')
    // The partition header is prepended on post-first-regen.
    expect(llmCalls[0].user).toContain('[NEW FRAGMENTS')
  })

  it('reports REMOVED fragments and includes them in the prompt for deletion integration', async () => {
    const lastRebuiltAt = new Date('2026-04-01T00:00:00Z')
    // No active edges, but one REMOVED edge (deleted_at > last_rebuilt_at).
    stageDbResponses([
      [baseWiki({ lastRebuiltAt, content: 'existing body' })],
      [],
      [],            // active edges: none
      [{ srcId: 'frag-removed' }],  // removed-edge query
      [{ lookupKey: 'frag-removed', slug: 'frag-removed', title: 'Old fragment' }],  // removed frags hydrate
      [],            // user edits
      [],            // wikiTypes select
    ])

    const result = await regenerateWiki(mockDb, 'wiki-key-1', { skipEmbedding: true })

    expect(result.skipped).toBeFalsy()
    expect(result.triggeringFragments?.removed).toHaveLength(1)
    expect(result.triggeringFragments?.removed[0].slug).toBe('frag-removed')

    // The REMOVED partition is included in the prompt so Quill writes the
    // deletion into the body.
    expect(llmCalls).toHaveLength(1)
    expect(llmCalls[0].user).toContain('[REMOVED FRAGMENTS')
    expect(llmCalls[0].user).toContain('frag-removed')
  })
})
