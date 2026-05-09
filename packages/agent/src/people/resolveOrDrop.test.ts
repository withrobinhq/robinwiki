import { describe, it, expect, vi } from 'vitest'
import { resolveOrDrop } from './resolveOrDrop.js'
import type { ResolveOrDropContext } from './resolveOrDrop.js'

let keyCounter = 0
const makePersonKey = () => `person${String(++keyCounter).padStart(4, '0')}`

function ctx(overrides: Partial<ResolveOrDropContext> = {}): ResolveOrDropContext {
  keyCounter = 0
  return {
    fragmentId: 'frag01',
    autoAccept: false,
    verifiedPeople: [],
    pendingPeople: [],
    makePersonKey,
    insertPerson: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('resolveOrDrop', () => {
  it('matched bucket -> matched outcome', async () => {
    const c = ctx({
      verifiedPeople: [
        { lookupKey: 'personABC', canonicalName: 'Sarah Ouma', aliases: ['Sarah'] },
      ],
    })
    const outcomes = await resolveOrDrop(
      {
        matched: [
          {
            mention: 'Sarah',
            inferredName: 'Sarah Ouma',
            matchedKey: 'personABC',
            confidence: 0.9,
            sourceSpan: 'with Sarah',
          },
        ],
        candidates: [],
      },
      c
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ kind: 'matched', lookupKey: 'personABC' })
    expect(c.insertPerson).not.toHaveBeenCalled()
  })

  it('candidate with no dedup hit creates pending by default', async () => {
    const c = ctx()
    const outcomes = await resolveOrDrop(
      {
        matched: [],
        candidates: [
          {
            mention: 'Bob',
            inferredName: 'Bob',
            confidence: 0.7,
            sourceSpan: 'Bob said hello',
          },
        ],
      },
      c
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ kind: 'created_pending' })
    expect(c.insertPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        createdVia: 'extractor_pending',
        canonicalName: 'Bob',
        extractedFromFragmentId: 'frag01',
      })
    )
  })

  it('candidate with autoAccept=true creates verified', async () => {
    const c = ctx({ autoAccept: true })
    const outcomes = await resolveOrDrop(
      {
        matched: [],
        candidates: [
          {
            mention: 'Carol',
            inferredName: 'Carol',
            confidence: 0.7,
            sourceSpan: 'Carol waved',
          },
        ],
      },
      c
    )
    expect(outcomes[0]).toMatchObject({ kind: 'created_verified' })
    expect(c.insertPerson).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'verified', createdVia: 'extractor_auto' })
    )
  })

  it('candidate dedups onto existing verified person', async () => {
    const c = ctx({
      verifiedPeople: [
        { lookupKey: 'personXYZ', canonicalName: 'Diana Patel', aliases: [] },
      ],
    })
    const outcomes = await resolveOrDrop(
      {
        matched: [],
        candidates: [
          {
            mention: 'Diana Patel',
            inferredName: 'Diana Patel',
            confidence: 0.6,
            sourceSpan: 'with Diana Patel',
          },
        ],
      },
      c
    )
    expect(outcomes[0]).toMatchObject({ kind: 'matched', lookupKey: 'personXYZ' })
    expect(c.insertPerson).not.toHaveBeenCalled()
  })

  it('candidate dedups onto existing pending person', async () => {
    const c = ctx({
      pendingPeople: [
        { lookupKey: 'personPND', canonicalName: 'Eric Tan', aliases: [] },
      ],
    })
    const outcomes = await resolveOrDrop(
      {
        matched: [],
        candidates: [
          {
            mention: 'Eric Tan',
            inferredName: 'Eric Tan',
            confidence: 0.7,
            sourceSpan: 'Eric Tan replied',
          },
        ],
      },
      c
    )
    expect(outcomes[0]).toMatchObject({ kind: 'pending', lookupKey: 'personPND' })
    expect(c.insertPerson).not.toHaveBeenCalled()
  })

  it('two candidates with the same name only mint one pending row', async () => {
    const c = ctx()
    const outcomes = await resolveOrDrop(
      {
        matched: [],
        candidates: [
          {
            mention: 'Frances',
            inferredName: 'Frances',
            confidence: 0.7,
            sourceSpan: 'Frances stood up',
          },
          {
            mention: 'Frances',
            inferredName: 'Frances',
            confidence: 0.7,
            sourceSpan: 'Frances kept talking',
          },
        ],
      },
      c
    )
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0].kind).toBe('created_pending')
    expect(outcomes[1].kind).toBe('pending')
    expect(c.insertPerson).toHaveBeenCalledTimes(1)
  })

  it('matched mention that resolver rejects yields dropped outcome', async () => {
    // The LLM picked a key but the score floor disagreed.
    const c = ctx({
      verifiedPeople: [
        {
          lookupKey: 'personABC',
          canonicalName: 'Maximilian Von Reichtenstein',
          aliases: [],
        },
      ],
    })
    const outcomes = await resolveOrDrop(
      {
        matched: [
          {
            mention: 'Bob',
            inferredName: 'Bob',
            matchedKey: 'personABC',
            confidence: 0.9,
            sourceSpan: 'Bob said hello',
          },
        ],
        candidates: [],
      },
      c
    )
    expect(outcomes[0]).toMatchObject({ kind: 'dropped' })
  })
})
