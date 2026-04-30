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
    })),
    createTypedCaller: vi.fn(() => fakeCallLlm),
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

  it('honors a user-customized wiki_type YAML blob for both system_message and template', async () => {
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
    // Custom YAML fully drives system + template.
    expect(llmCalls[0].system).toContain('CUSTOM_SYSTEM_MARKER')
    expect(llmCalls[0].system).not.toContain('Quill')
    expect(llmCalls[0].user).toContain('CUSTOM_TEMPLATE_MARKER')
    expect(llmCalls[0].user).toContain('Title: Test Wiki')
    expect(llmCalls[0].user).toContain('Count: 0')
    expect(llmCalls[0].user).not.toContain('DOCUMENT STRUCTURE')
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
