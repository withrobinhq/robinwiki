import { describe, it, expect } from 'vitest'
import { LK_REGEX, LK_REGEX_STRICT, safeRefToHref } from '../identity'

// Covers the LOOKUP_KEY_RE → LK_REGEX rename, the new anchored variant
// LK_REGEX_STRICT, and the safeRefToHref helper added for #audit-M9.

const VALID_WIKI = 'wiki01ARZ3NDEKTSV4RRFFQ69G5FAV'
const VALID_FRAG = 'frag01ARZ3NDEKTSV4RRFFQ69G5FAV'
const VALID_ENTRY = 'entry01ARZ3NDEKTSV4RRFFQ69G5FAV'
const VALID_PERSON = 'person01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('LK_REGEX (unanchored substring form, renamed from LOOKUP_KEY_RE)', () => {
  it('matches a valid wiki key embedded in surrounding text', () => {
    const text = `see ${VALID_WIKI} inline`
    const match = text.match(LK_REGEX.wiki)
    expect(match?.[0]).toBe(VALID_WIKI)
  })

  it('matches a valid fragment key embedded in surrounding text', () => {
    const text = `cite ${VALID_FRAG} please`
    const match = text.match(LK_REGEX.frag)
    expect(match?.[0]).toBe(VALID_FRAG)
  })

  it('matches a valid entry key embedded in surrounding text', () => {
    const text = `link ${VALID_ENTRY} here`
    const match = text.match(LK_REGEX.entry)
    expect(match?.[0]).toBe(VALID_ENTRY)
  })

  it('matches a valid person key embedded in surrounding text', () => {
    const text = `meet ${VALID_PERSON} today`
    const match = text.match(LK_REGEX.person)
    expect(match?.[0]).toBe(VALID_PERSON)
  })
})

describe('LK_REGEX_STRICT (anchored form for trust boundaries)', () => {
  it('matches a bare valid wiki key', () => {
    expect(LK_REGEX_STRICT.wiki.test(VALID_WIKI)).toBe(true)
  })

  it('rejects an absolute URL', () => {
    expect(LK_REGEX_STRICT.wiki.test('https://evil.com')).toBe(false)
  })

  it('rejects a URL whose path contains a valid key (no embedding)', () => {
    expect(LK_REGEX_STRICT.wiki.test(`https://evil.com/${VALID_WIKI}`)).toBe(false)
  })

  it('rejects a key with a leading prefix segment', () => {
    expect(LK_REGEX_STRICT.wiki.test(`prefix ${VALID_WIKI}`)).toBe(false)
  })

  it('rejects a key with a trailing suffix segment', () => {
    expect(LK_REGEX_STRICT.wiki.test(`${VALID_WIKI}/extra`)).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(LK_REGEX_STRICT.wiki.test('')).toBe(false)
  })

  it('rejects a string that is one character too short', () => {
    expect(LK_REGEX_STRICT.wiki.test(VALID_WIKI.slice(0, -1))).toBe(false)
  })

  it('rejects lowercase ULID body', () => {
    expect(LK_REGEX_STRICT.wiki.test(VALID_WIKI.toLowerCase())).toBe(false)
  })
})

describe('safeRefToHref', () => {
  it('returns /wiki/<key> for a valid wiki key', () => {
    expect(safeRefToHref(VALID_WIKI)).toBe(`/wiki/${VALID_WIKI}`)
  })

  it('returns /fragments/<key> for a valid fragment key', () => {
    expect(safeRefToHref(VALID_FRAG)).toBe(`/fragments/${VALID_FRAG}`)
  })

  it('returns /entries/<key> for a valid entry key', () => {
    expect(safeRefToHref(VALID_ENTRY)).toBe(`/entries/${VALID_ENTRY}`)
  })

  it('returns /people/<key> for a valid person key', () => {
    expect(safeRefToHref(VALID_PERSON)).toBe(`/people/${VALID_PERSON}`)
  })

  it('returns null for an absolute URL', () => {
    expect(safeRefToHref('https://evil.com')).toBeNull()
  })

  it('returns null for a URL whose path contains a valid key', () => {
    expect(safeRefToHref(`https://evil.com/${VALID_WIKI}`)).toBeNull()
  })

  it('returns null for an unknown prefix', () => {
    expect(safeRefToHref('vault01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull()
  })

  it('returns null for the empty string', () => {
    expect(safeRefToHref('')).toBeNull()
  })

  it('returns null for a path-traversal attempt', () => {
    expect(safeRefToHref('../wiki/foo')).toBeNull()
  })

  it('returns null for a key with leading/trailing whitespace', () => {
    expect(safeRefToHref(` ${VALID_WIKI} `)).toBeNull()
  })
})
