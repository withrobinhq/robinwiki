// Wave G — wiki-agent-schema generator unit tests.
//
// Covers the prompt template structure and the resolveRetrievalIndexModel
// fallback. The full DB-integration path (insert/upsert) is exercised by
// the regen worker test suite.

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  GENERATOR_VERSION,
  HYDE_BODY_EXCERPT_CHARS,
  deleteHydeAgentSchemaRow,
  renderHydePrompt,
  resolveRetrievalIndexModel,
  upsertDescriptionAgentSchemaRow,
} from './wiki-agent-schema.js'

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
    // The cap is applied by the caller, but the constant is part of the
    // module contract — locking it here prevents a silent change.
    expect(HYDE_BODY_EXCERPT_CHARS).toBe(800)
  })

  it('exposes a stable generator version for v0.2.0', () => {
    expect(GENERATOR_VERSION).toBe('hyde_v1')
  })
})

describe('resolveRetrievalIndexModel', () => {
  const baseConfig = {
    apiKey: 'test',
    models: {
      extraction: 'extraction-model',
      classification: 'classification-model',
      wikiGeneration: 'writer-model',
      embedding: 'embedding-model',
    },
  }

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

describe('upsertDescriptionAgentSchemaRow', () => {
  it('issues an INSERT ... ON CONFLICT DO UPDATE on (wiki_key, kind)', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
    const insert = vi.fn().mockReturnValue({ values })
    const fakeDb = { insert } as unknown as Parameters<typeof upsertDescriptionAgentSchemaRow>[0]

    await upsertDescriptionAgentSchemaRow(fakeDb, 'wiki-key-1', 'a description', [0.1, 0.2])

    expect(insert).toHaveBeenCalledTimes(1)
    expect(values).toHaveBeenCalledTimes(1)
    const valuesArg = values.mock.calls[0][0]
    expect(valuesArg.wikiKey).toBe('wiki-key-1')
    expect(valuesArg.kind).toBe('description')
    expect(valuesArg.content).toBe('a description')
    expect(valuesArg.embedding).toEqual([0.1, 0.2])
    expect(valuesArg.generatorVersion).toBe(GENERATOR_VERSION)

    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1)
    const conflictArg = onConflictDoUpdate.mock.calls[0][0]
    expect(conflictArg.target).toHaveLength(2)
    expect(conflictArg.set.content).toBe('a description')
    expect(conflictArg.set.embedding).toEqual([0.1, 0.2])
    expect(conflictArg.set.generatorVersion).toBe(GENERATOR_VERSION)
    expect(conflictArg.set.generatedAt).toBeInstanceOf(Date)
  })
})

describe('deleteHydeAgentSchemaRow', () => {
  it('issues a DELETE WHERE wiki_key=? AND kind=hyde_synthetic', async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const del = vi.fn().mockReturnValue({ where })
    const fakeDb = { delete: del } as unknown as Parameters<typeof deleteHydeAgentSchemaRow>[0]

    await deleteHydeAgentSchemaRow(fakeDb, 'wiki-key-2')

    expect(del).toHaveBeenCalledTimes(1)
    expect(where).toHaveBeenCalledTimes(1)
  })
})
