// Wave G + Stream S — wiki-agent-schema unit tests.
//
// Covers:
//   1. The HyDE prompt template structure and resolveRetrievalIndexModel fallback.
//   2. `ensureAgentSchema` dispatch across all 5 modes (create, refresh, heal,
//      regen-bump, backfill). Each mode is asserted via the sequence of
//      mocked DB calls and (where applicable) embedText / hydeCaller invocations.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const embedTextMock = vi.fn()
vi.mock('@robin/agent', () => ({
  embedText: (...args: unknown[]) => embedTextMock(...args),
}))

const emitPipelineEventMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../db/pipeline-events.js', () => ({
  emitPipelineEvent: (...args: unknown[]) => emitPipelineEventMock(...args),
}))

const {
  GENERATOR_VERSION,
  HYDE_BODY_EXCERPT_CHARS,
  ensureAgentSchema,
  renderHydePrompt,
  resolveRetrievalIndexModel,
} = await import('./wiki-agent-schema.js')

type AnyDB = Parameters<typeof ensureAgentSchema>[0]

interface SnapshotRow {
  kind: 'description' | 'hyde_synthetic'
  content: string | null
  hasEmbedding: boolean
  generatorVersion: string | null
}

interface MockDbState {
  snapshotRows: SnapshotRow[]
  wikiRow: { type: string; name: string; description: string | null; content: string | null } | null
  internalFraming: string | null
  inserts: Array<{ values: Record<string, unknown>; conflict: Record<string, unknown> | null }>
  deletes: number
}

function createMockDb(): { db: AnyDB; state: MockDbState } {
  const state: MockDbState = {
    snapshotRows: [],
    wikiRow: null,
    internalFraming: null,
    inserts: [],
    deletes: 0,
  }

  // Sequence of select() calls per mode:
  //   loadSnapshot  → select({kind, content, hasEmbedding, generatorVersion}).from(wikiAgentSchema).where(...)
  //   loadWikiRow   → select({type, name, description, content}).from(wikis).where(...)
  //   loadInternalFraming → select({internalFraming}).from(wikiTypes).where(...)
  //
  // We disambiguate by the projection keys.
  const db: AnyDB = {
    select(projection: Record<string, unknown> | undefined) {
      const keys = projection ? Object.keys(projection) : []
      const fromMethod = (_table: unknown) => ({
        where: async (_clause: unknown) => {
          if (keys.includes('kind')) {
            return state.snapshotRows.map((r) => ({
              kind: r.kind,
              content: r.content,
              hasEmbedding: r.hasEmbedding,
              generatorVersion: r.generatorVersion,
            }))
          }
          if (keys.includes('type') && keys.includes('name')) {
            return state.wikiRow ? [state.wikiRow] : []
          }
          if (keys.includes('internalFraming')) {
            return state.internalFraming != null
              ? [{ internalFraming: state.internalFraming }]
              : []
          }
          return []
        },
      })
      return { from: fromMethod }
    },
    insert(_table: unknown) {
      return {
        values: (vals: Record<string, unknown>) => {
          const insertEntry: { values: Record<string, unknown>; conflict: Record<string, unknown> | null } = {
            values: vals,
            conflict: null,
          }
          state.inserts.push(insertEntry)
          return {
            onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
              insertEntry.conflict = conflict
            },
          }
        },
      }
    },
    delete(_table: unknown) {
      return {
        where: async () => {
          state.deletes++
        },
      }
    },
  } as unknown as AnyDB

  return { db, state }
}

const baseConfig = {
  apiKey: 'k',
  models: {
    extraction: 'x',
    classification: 'y',
    wikiGeneration: 'writer-model',
    embedding: 'embedding-model',
  },
}

beforeEach(() => {
  embedTextMock.mockReset()
  emitPipelineEventMock.mockReset().mockResolvedValue(undefined)
})

// ── HyDE prompt template ──────────────────────────────────────────────────

describe('renderHydePrompt', () => {
  it('contains all five interpolated fields verbatim', () => {
    const prompt = renderHydePrompt({
      wikiType: 'decision',
      title: 'Shipping cadence: ship daily',
      description: 'A choice about how often to release software.',
      sourceExcerpt: 'The team chose to ship daily rather than batch weekly.',
      internalFraming:
        'Write as if recounting why a choice was made. Cover what was chosen, what was rejected, the constraints, and who was involved.',
    })

    expect(prompt).toContain('Wiki type: decision')
    expect(prompt).toContain('Title: Shipping cadence: ship daily')
    expect(prompt).toContain('Description: A choice about how often to release software.')
    expect(prompt).toContain('Source excerpt: The team chose to ship daily')
    expect(prompt).toContain('Write as if recounting why a choice was made')
  })

  it('emits CONTEXT, TASK, OUTPUT blocks in order', () => {
    const prompt = renderHydePrompt({
      wikiType: 'belief',
      title: 't',
      description: 'd',
      sourceExcerpt: 's',
      internalFraming: 'f',
    })

    const ctxIdx = prompt.indexOf('[CONTEXT]')
    const taskIdx = prompt.indexOf('[TASK]')
    const outIdx = prompt.indexOf('[OUTPUT]')

    expect(ctxIdx).toBeGreaterThanOrEqual(0)
    expect(taskIdx).toBeGreaterThan(ctxIdx)
    expect(outIdx).toBeGreaterThan(taskIdx)
  })

  it('forbids meta-language and out-of-source claims via MUST NOT block', () => {
    const prompt = renderHydePrompt({
      wikiType: 'log',
      title: 't',
      description: 'd',
      sourceExcerpt: 's',
      internalFraming: 'f',
    })

    expect(prompt).toContain('The passage MUST NOT')
    expect(prompt).toContain('Introduce claims not present in the source')
    expect(prompt).toContain('this wiki')
    expect(prompt).toContain('Exceed 200 words')
  })

  it('caps the source excerpt at HYDE_BODY_EXCERPT_CHARS in the calling code', () => {
    expect(HYDE_BODY_EXCERPT_CHARS).toBe(800)
  })

  it('exposes a stable generator version for v0.2.0', () => {
    expect(GENERATOR_VERSION).toBe('hyde_v1')
  })
})

// ── resolveRetrievalIndexModel ────────────────────────────────────────────

describe('resolveRetrievalIndexModel', () => {
  const originalEnv = process.env.RETRIEVAL_INDEX_MODEL

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RETRIEVAL_INDEX_MODEL
    else process.env.RETRIEVAL_INDEX_MODEL = originalEnv
  })

  it('falls back to writer model when env var is unset', () => {
    delete process.env.RETRIEVAL_INDEX_MODEL
    expect(resolveRetrievalIndexModel(baseConfig)).toBe('writer-model')
  })

  it('uses RETRIEVAL_INDEX_MODEL env var when set', () => {
    process.env.RETRIEVAL_INDEX_MODEL = 'anthropic/claude-haiku-4.5'
    expect(resolveRetrievalIndexModel(baseConfig)).toBe('anthropic/claude-haiku-4.5')
  })

  it('treats whitespace-only env var as unset', () => {
    process.env.RETRIEVAL_INDEX_MODEL = '   '
    expect(resolveRetrievalIndexModel(baseConfig)).toBe('writer-model')
  })
})

// ── ensureAgentSchema, mode='create' ──────────────────────────────────────

describe("ensureAgentSchema mode='create'", () => {
  it('upserts the description row using the precomputed embedding (no embed call)', async () => {
    const { db, state } = createMockDb()
    const result = await ensureAgentSchema(db, 'wiki-1', {
      mode: 'create',
      description: 'a fresh description',
      precomputedEmbedding: [0.1, 0.2, 0.3],
      context: { source: 'api' },
    })

    expect(result.written.description).toBe(true)
    expect(result.written.hyde_synthetic).toBe(false)
    expect(result.shortCircuited).toBe(false)
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].values.kind).toBe('description')
    expect(state.inserts[0].values.wikiKey).toBe('wiki-1')
    expect(state.inserts[0].values.content).toBe('a fresh description')
    expect(state.inserts[0].values.embedding).toEqual([0.1, 0.2, 0.3])
    expect(state.inserts[0].values.generatorVersion).toBe(GENERATOR_VERSION)
    expect(embedTextMock).not.toHaveBeenCalled()
  })

  it('embeds via the service when no precomputedEmbedding is supplied', async () => {
    const { db, state } = createMockDb()
    embedTextMock.mockResolvedValueOnce([0.4, 0.5])
    const result = await ensureAgentSchema(db, 'wiki-2', {
      mode: 'create',
      description: 'd',
      orConfig: baseConfig,
      context: { source: 'api' },
    })
    expect(result.written.description).toBe(true)
    expect(state.inserts[0].values.embedding).toEqual([0.4, 0.5])
    expect(embedTextMock).toHaveBeenCalledTimes(1)
  })

  it('short-circuits with empty description', async () => {
    const { db, state } = createMockDb()
    const result = await ensureAgentSchema(db, 'wiki-3', {
      mode: 'create',
      description: '   ',
      precomputedEmbedding: [0.1],
      context: { source: 'api' },
    })
    expect(result.shortCircuited).toBe(true)
    expect(state.inserts).toHaveLength(0)
  })
})

// ── ensureAgentSchema, mode='refresh' ─────────────────────────────────────

describe("ensureAgentSchema mode='refresh'", () => {
  it('upserts description and stales hyde when both rows exist', async () => {
    const { db, state } = createMockDb()
    state.snapshotRows = [
      { kind: 'description', content: 'old desc', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
      { kind: 'hyde_synthetic', content: 'old hyde', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    const result = await ensureAgentSchema(db, 'wiki-r', {
      mode: 'refresh',
      description: 'new desc',
      precomputedEmbedding: [0.9],
      context: { source: 'api' },
    })
    expect(result.written.description).toBe(true)
    expect(result.staled.hyde_synthetic).toBe(true)
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].values.content).toBe('new desc')
    expect(state.deletes).toBe(1)
  })

  it('skips hyde stale when no hyde row exists', async () => {
    const { db, state } = createMockDb()
    state.snapshotRows = []
    const result = await ensureAgentSchema(db, 'wiki-r2', {
      mode: 'refresh',
      description: 'new desc',
      precomputedEmbedding: [0.9],
      context: { source: 'api' },
    })
    expect(result.written.description).toBe(true)
    expect(result.staled.hyde_synthetic).toBe(false)
    expect(state.deletes).toBe(0)
  })

  it('still stales hyde when description is empty', async () => {
    const { db, state } = createMockDb()
    state.snapshotRows = [
      { kind: 'hyde_synthetic', content: 'old', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    const result = await ensureAgentSchema(db, 'wiki-r3', {
      mode: 'refresh',
      description: '',
      context: { source: 'api' },
    })
    expect(result.written.description).toBe(false)
    expect(result.staled.hyde_synthetic).toBe(true)
    expect(state.deletes).toBe(1)
  })
})

// ── ensureAgentSchema, mode='heal' ────────────────────────────────────────

describe("ensureAgentSchema mode='heal'", () => {
  it('writes only the missing description row when hyde already exists', async () => {
    const { db, state } = createMockDb()
    state.wikiRow = { type: 'log', name: 'L', description: 'desc text', content: 'body' }
    state.internalFraming = 'frame'
    state.snapshotRows = [
      { kind: 'hyde_synthetic', content: 'h', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    embedTextMock.mockResolvedValueOnce([0.5])

    const hydeCaller = vi.fn().mockResolvedValue('should not be called')
    const result = await ensureAgentSchema(db, 'wiki-h', {
      mode: 'heal',
      orConfig: baseConfig,
      hydeCaller,
      context: { source: 'system', jobId: 'j-1' },
    })
    expect(result.written.description).toBe(true)
    expect(result.written.hyde_synthetic).toBe(false)
    expect(hydeCaller).not.toHaveBeenCalled()
  })

  it('writes only the missing hyde row when description already present', async () => {
    const { db, state } = createMockDb()
    state.wikiRow = { type: 'log', name: 'L', description: 'desc', content: 'body' }
    state.internalFraming = 'frame'
    state.snapshotRows = [
      { kind: 'description', content: 'desc', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    embedTextMock.mockResolvedValueOnce([0.6, 0.6])
    const hydeCaller = vi.fn().mockResolvedValue('synthetic passage')
    const result = await ensureAgentSchema(db, 'wiki-h2', {
      mode: 'heal',
      orConfig: baseConfig,
      hydeCaller,
      context: { source: 'system' },
    })
    expect(result.written.description).toBe(false)
    expect(result.written.hyde_synthetic).toBe(true)
    expect(hydeCaller).toHaveBeenCalledTimes(1)
    const insertedHyde = state.inserts.find((i) => i.values.kind === 'hyde_synthetic')
    expect(insertedHyde).toBeDefined()
    expect(insertedHyde!.values.content).toBe('synthetic passage')
  })

  it('returns no-op when wiki has been deleted', async () => {
    const { db } = createMockDb()
    const result = await ensureAgentSchema(db, 'gone', {
      mode: 'heal',
      orConfig: baseConfig,
      context: { source: 'system' },
    })
    expect(result.written.description).toBe(false)
    expect(result.written.hyde_synthetic).toBe(false)
  })
})

// ── ensureAgentSchema, mode='regen-bump' ──────────────────────────────────

describe("ensureAgentSchema mode='regen-bump'", () => {
  it('short-circuits when description and hyde are both current', async () => {
    const { db, state } = createMockDb()
    state.wikiRow = { type: 'log', name: 'L', description: 'same', content: 'b' }
    state.snapshotRows = [
      { kind: 'description', content: 'same', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
      { kind: 'hyde_synthetic', content: 'h', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    const hydeCaller = vi.fn()
    const result = await ensureAgentSchema(db, 'wiki-rb', {
      mode: 'regen-bump',
      orConfig: baseConfig,
      hydeCaller,
      context: { source: 'system', jobId: 'j-rb' },
    })
    expect(result.shortCircuited).toBe(true)
    expect(result.written.description).toBe(false)
    expect(result.written.hyde_synthetic).toBe(false)
    expect(hydeCaller).not.toHaveBeenCalled()
    expect(embedTextMock).not.toHaveBeenCalled()
  })

  it('regenerates both rows when description has changed', async () => {
    const { db, state } = createMockDb()
    state.wikiRow = { type: 'log', name: 'L', description: 'fresh', content: 'b' }
    state.internalFraming = 'frame'
    state.snapshotRows = [
      { kind: 'description', content: 'old', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
      { kind: 'hyde_synthetic', content: 'old hyde', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    embedTextMock
      .mockResolvedValueOnce([0.1]) // description embed
      .mockResolvedValueOnce([0.2]) // hyde embed
    const hydeCaller = vi.fn().mockResolvedValue('new synthetic')

    const result = await ensureAgentSchema(db, 'wiki-rb2', {
      mode: 'regen-bump',
      orConfig: baseConfig,
      hydeCaller,
      context: { source: 'system' },
    })
    expect(result.shortCircuited).toBe(false)
    expect(result.written.description).toBe(true)
    expect(result.written.hyde_synthetic).toBe(true)
    expect(hydeCaller).toHaveBeenCalledTimes(1)
  })

  it('regenerates when hyde row is missing even if description matches', async () => {
    const { db, state } = createMockDb()
    state.wikiRow = { type: 'log', name: 'L', description: 'same', content: 'b' }
    state.internalFraming = 'frame'
    state.snapshotRows = [
      { kind: 'description', content: 'same', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    embedTextMock
      .mockResolvedValueOnce([0.3])
      .mockResolvedValueOnce([0.4])
    const hydeCaller = vi.fn().mockResolvedValue('synthetic')
    const result = await ensureAgentSchema(db, 'wiki-rb3', {
      mode: 'regen-bump',
      orConfig: baseConfig,
      hydeCaller,
      context: { source: 'system' },
    })
    expect(result.shortCircuited).toBe(false)
    expect(result.written.hyde_synthetic).toBe(true)
  })
})

// ── ensureAgentSchema, mode='backfill' ────────────────────────────────────

describe("ensureAgentSchema mode='backfill'", () => {
  it('writes a description row when none exists', async () => {
    const { db, state } = createMockDb()
    state.snapshotRows = []
    const result = await ensureAgentSchema(db, 'wiki-bf', {
      mode: 'backfill',
      description: 'd',
      precomputedEmbedding: [0.7],
      context: { source: 'system', jobId: 'bf-1' },
    })
    expect(result.written.description).toBe(true)
    expect(state.inserts).toHaveLength(1)
  })

  it('is idempotent: skips when row is already current', async () => {
    const { db, state } = createMockDb()
    state.snapshotRows = [
      { kind: 'description', content: 'd', hasEmbedding: true, generatorVersion: GENERATOR_VERSION },
    ]
    const result = await ensureAgentSchema(db, 'wiki-bf2', {
      mode: 'backfill',
      description: 'd',
      precomputedEmbedding: [0.7],
      context: { source: 'system' },
    })
    expect(result.shortCircuited).toBe(true)
    expect(state.inserts).toHaveLength(0)
  })

  it('embeds via service when no precomputedEmbedding given and description present', async () => {
    const { db, state } = createMockDb()
    state.snapshotRows = []
    embedTextMock.mockResolvedValueOnce([0.8])
    const result = await ensureAgentSchema(db, 'wiki-bf3', {
      mode: 'backfill',
      description: 'desc',
      orConfig: baseConfig,
      context: { source: 'system' },
    })
    expect(result.written.description).toBe(true)
    expect(state.inserts[0].values.embedding).toEqual([0.8])
  })
})

// ── observability ─────────────────────────────────────────────────────────

describe('ensureAgentSchema pipeline_events emission', () => {
  it('emits started + completed pipeline events with mode and outcome', async () => {
    const { db } = createMockDb()
    await ensureAgentSchema(db, 'wiki-obs', {
      mode: 'create',
      description: 'd',
      precomputedEmbedding: [0.1],
      context: { source: 'api', jobId: 'job-x' },
    })
    expect(emitPipelineEventMock).toHaveBeenCalledTimes(2)
    const startedCall = emitPipelineEventMock.mock.calls[0][1] as { status: string; metadata: Record<string, unknown> }
    const completedCall = emitPipelineEventMock.mock.calls[1][1] as { status: string; metadata: Record<string, unknown> }
    expect(startedCall.status).toBe('started')
    expect(startedCall.metadata.mode).toBe('create')
    expect(startedCall.metadata.wikiKey).toBe('wiki-obs')
    expect(completedCall.status).toBe('completed')
  })
})
