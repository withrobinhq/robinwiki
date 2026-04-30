import { describe, it, expect } from 'vitest'
import { buildOrTsQuery } from './search.js'

// Sanitiser unit tests — guard against the class of bug where raw user
// input reaches `to_tsquery` with an unescaped operator and crashes the
// query parser. Every dangerous character must round-trip to whitespace
// or be dropped before it can reach postgres.

describe('buildOrTsQuery', () => {
  it('OR-joins simple multi-word queries', () => {
    expect(buildOrTsQuery('divya europe travel')).toBe('divya | europe | travel')
  })

  it('lowercases tokens', () => {
    expect(buildOrTsQuery('Divya EUROPE')).toBe('divya | europe')
  })

  it('dedupes repeated tokens while preserving order', () => {
    expect(buildOrTsQuery('alpha bravo alpha charlie bravo')).toBe(
      'alpha | bravo | charlie'
    )
  })

  it('strips tsquery reserved chars (& | ! ( ) : * < @)', () => {
    // & | ! ( ) : * < @ all become whitespace, splitting tokens cleanly.
    expect(buildOrTsQuery('foo & bar | baz')).toBe('foo | bar | baz')
    expect(buildOrTsQuery('a:* | (b!c)')).toBe('a | b | c')
    expect(buildOrTsQuery("don't @mention")).toBe('don | t | mention')
  })

  it('strips quotes and backslashes (also tsquery-fatal)', () => {
    expect(buildOrTsQuery('"quoted phrase" plain')).toBe(
      'quoted | phrase | plain'
    )
    expect(buildOrTsQuery('back\\slash here')).toBe('back | slash | here')
  })

  it('returns null for empty / whitespace / pure-punctuation input', () => {
    expect(buildOrTsQuery('')).toBeNull()
    expect(buildOrTsQuery('   ')).toBeNull()
    expect(buildOrTsQuery('& | ! @')).toBeNull()
  })

  it('splits hyphenated tokens so tag slugs match indexed stems', () => {
    // to_tsquery treats `machine-learning` as a phrase query (<->) on
    // the english parser, so we explicitly OR the parts to keep recall.
    expect(buildOrTsQuery('machine-learning')).toBe('machine | learning')
  })

  it('handles unicode-ish junk gracefully (non-alphanum splits)', () => {
    // The regex passes [A-Za-z0-9_-] only; non-ASCII letters get split.
    // We assert the call does not throw and returns a usable string.
    const out = buildOrTsQuery('café münchen 東京')
    expect(out).not.toBeNull()
    // At minimum the ASCII fragments survive:
    expect(out).toContain('caf')
  })
})
