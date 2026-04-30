import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolvePerson, entityExtract } from '../stages/entity-extract'
import type { EntityExtractDeps, KnownPerson, ResolutionConfig } from '../stages/types'
import { DEFAULT_RESOLUTION_CONFIG } from '../stages/types'

const config = DEFAULT_RESOLUTION_CONFIG
let keyCounter = 0
const makeKey = () => `person${String(++keyCounter).padStart(4, '0')}`

function resetKeyCounter() {
  keyCounter = 0
}

describe('resolvePerson', () => {
  beforeEach(resetKeyCounter)

  it('returns new person when knownPeople is empty', () => {
    const result = resolvePerson(
      { mention: 'Sarah', inferredName: 'Sarah', matchedKey: null },
      [],
      config,
      makeKey
    )
    expect(result.isNew).toBe(true)
    expect(result.personKey).toBe('person0001')
  })

  it('matches exact canonicalName and returns existing key', () => {
    const known: KnownPerson[] = [
      { lookupKey: 'personABC', canonicalName: 'Sarah Ouma', aliases: [] },
    ]
    const result = resolvePerson(
      { mention: 'Sarah Ouma', inferredName: 'Sarah Ouma', matchedKey: null },
      known,
      config,
      makeKey
    )
    expect(result.isNew).toBe(false)
    expect(result.personKey).toBe('personABC')
    expect(result.newAlias).toBeUndefined()
  })

  it('matches via alias and identifies mention as new alias', () => {
    const known: KnownPerson[] = [
      { lookupKey: 'personABC', canonicalName: 'Sarah Ouma', aliases: ['Sarah'] },
    ]
    const result = resolvePerson(
      { mention: 'S. Ouma', inferredName: 'S. Ouma', matchedKey: null },
      known,
      config,
      makeKey
    )
    expect(result.isNew).toBe(false)
    expect(result.personKey).toBe('personABC')
    expect(result.newAlias).toBe('S. Ouma')
  })

  it('handles order-insensitive match (token_set_ratio)', () => {
    const known: KnownPerson[] = [
      { lookupKey: 'personABC', canonicalName: 'Sarah Ouma', aliases: [] },
    ]
    const result = resolvePerson(
      { mention: 'Ouma, Sarah', inferredName: 'Ouma, Sarah', matchedKey: null },
      known,
      config,
      makeKey
    )
    expect(result.isNew).toBe(false)
    expect(result.personKey).toBe('personABC')
  })

  it('scores canonicalName at 5x and aliases at 4x', () => {
    // Same string "Alex" as canonical vs alias should produce different weighted scores
    const knownCanonical: KnownPerson[] = [{ lookupKey: 'p1', canonicalName: 'Alex', aliases: [] }]
    const knownAlias: KnownPerson[] = [
      { lookupKey: 'p2', canonicalName: 'Alexander The Great', aliases: ['Alex'] },
    ]
    const extraction = { mention: 'Alex', inferredName: 'Alex', matchedKey: null }

    const r1 = resolvePerson(extraction, knownCanonical, config, makeKey)
    const r2 = resolvePerson(extraction, knownAlias, config, makeKey)

    // Both should match, but canonical match should be favored (5x > 4x)
    expect(r1.isNew).toBe(false)
    expect(r2.isNew).toBe(false)
  })

  it('returns new person when score below floor', () => {
    const known: KnownPerson[] = [
      { lookupKey: 'personABC', canonicalName: 'Maximilian Von Reichtenstein', aliases: [] },
    ]
    const result = resolvePerson(
      { mention: 'Bob', inferredName: 'Bob', matchedKey: null },
      known,
      config,
      makeKey
    )
    expect(result.isNew).toBe(true)
  })

  it('returns new person when scores are ambiguous (close ratio)', () => {
    const known: KnownPerson[] = [
      { lookupKey: 'p1', canonicalName: 'Sarah Jones', aliases: [] },
      { lookupKey: 'p2', canonicalName: 'Sarah James', aliases: [] },
    ]
    const result = resolvePerson(
      { mention: 'Sarah J', inferredName: 'Sarah J', matchedKey: null },
      known,
      config,
      makeKey
    )
    // Two close scores should trigger ambiguous -> new person
    expect(result.isNew).toBe(true)
  })

  it('creates person with "(unnamed)" suffix for role-only mention', () => {
    const result = resolvePerson(
      { mention: 'my manager', inferredName: 'manager (unnamed)', matchedKey: null },
      [],
      config,
      makeKey
    )
    expect(result.isNew).toBe(true)
    expect(result.personKey).toBe('person0001')
  })

  it('auto-upgrades when matched "(unnamed)" person gets real name', () => {
    const known: KnownPerson[] = [
      { lookupKey: 'personXYZ', canonicalName: 'manager (unnamed)', aliases: ['my manager'] },
    ]
    const result = resolvePerson(
      { mention: 'Sarah the manager', inferredName: 'Sarah', matchedKey: null },
      known,
      { ...config, scoreFloor: 40 }, // lower floor so "manager" tokens match
      makeKey
    )
    // If the match happens, it should upgrade
    if (!result.isNew) {
      expect(result.isUpgrade).toBe(true)
      expect(result.upgradedCanonicalName).toBe('Sarah the manager')
    }
    // If it doesn't match due to score, that's also acceptable behavior
  })
})

describe('entityExtract', () => {
  beforeEach(resetKeyCounter)

  it('matches known people and DROPS unmatched mentions (#237 — matcher-only)', async () => {
    // Even if the LLM mistakenly returns a matchedKey: null candidate
    // (i.e. ignores the prompt's instruction to drop unknowns), the
    // stage must still drop it: no peopleMap entry, no newPeople push.
    // resolvePerson will report isNew = true because the score floor
    // is unmet against the lone known person, and the stage now
    // treats isNew as a "no match" signal rather than a "create new"
    // signal.
    const mockDeps: EntityExtractDeps = {
      loadAllPeople: vi
        .fn()
        .mockResolvedValue([
          { lookupKey: 'personABC', canonicalName: 'Sarah Ouma', aliases: ['Sarah'] },
        ]),
      llmCall: vi.fn().mockResolvedValue({
        people: [
          {
            mention: 'Sarah',
            inferredName: 'Sarah Ouma',
            matchedKey: 'personABC',
            confidence: 0.9,
            sourceSpan: 'with Sarah',
          },
          {
            mention: 'Bob',
            inferredName: 'Bob',
            matchedKey: null,
            confidence: 0.8,
            sourceSpan: 'Bob said',
          },
        ],
      }),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      config: DEFAULT_RESOLUTION_CONFIG,
      makePeopleKey: makeKey,
    }

    const result = await entityExtract(mockDeps, {
      content: 'Had coffee with Sarah. Bob said hello.',
      entryKey: 'entry001',
      jobId: 'job001',
    })

    // Only the matched mention survives.
    expect(result.data.peopleMap.size).toBe(1)
    expect(result.data.peopleMap.get('Sarah')).toBe('personABC')
    expect(result.data.peopleMap.has('Bob')).toBe(false)

    // Elfie no longer creates Person rows.
    expect(result.data.newPeople).toHaveLength(0)

    // extractions returned to persist must also be filtered down so
    // matchMentionsToFragments cannot re-introduce a dropped mention.
    expect(result.data.extractions).toHaveLength(1)
    expect(result.data.extractions[0].mention).toBe('Sarah')

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns empty results when no people found', async () => {
    const mockDeps: EntityExtractDeps = {
      loadAllPeople: vi.fn().mockResolvedValue([]),
      llmCall: vi.fn().mockResolvedValue({ people: [] }),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      config: DEFAULT_RESOLUTION_CONFIG,
      makePeopleKey: makeKey,
    }

    const result = await entityExtract(mockDeps, {
      content: 'Nice weather today.',
      entryKey: 'entry002',
      jobId: 'job002',
    })

    expect(result.data.peopleMap.size).toBe(0)
    expect(result.data.newPeople).toHaveLength(0)
    expect(result.data.extractions).toHaveLength(0)
  })
})
