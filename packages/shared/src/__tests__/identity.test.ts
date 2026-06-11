import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ObjectType, TYPE_TO_DIR, makeLookupKey, parseLookupKey } from '../identity'

const fixturesPath = path.resolve(__dirname, '../../../../fixtures/identity-cases.json')
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'))

describe('ObjectType', () => {
  it('defines all 4 types', () => {
    expect(ObjectType.ENTRY).toBe('entry')
    expect(ObjectType.FRAGMENT).toBe('frag')
    expect(ObjectType.WIKI).toBe('wiki')
    expect(ObjectType.PERSON).toBe('person')
  })
})

describe('TYPE_TO_DIR', () => {
  it('maps entry->entries, frag->fragments, wiki->wikis, person->people', () => {
    expect(TYPE_TO_DIR.entry).toBe('entries')
    expect(TYPE_TO_DIR.frag).toBe('fragments')
    expect(TYPE_TO_DIR.wiki).toBe('wikis')
    expect(TYPE_TO_DIR.person).toBe('people')
  })
})

describe('makeLookupKey', () => {
  it('returns string starting with "entry" + 26 uppercase chars for entry type', () => {
    const key = makeLookupKey('entry')
    expect(key).toMatch(/^entry[0-9A-Z]{26}$/)
  })

  it('returns string starting with "frag" + 26 uppercase chars for frag type', () => {
    const key = makeLookupKey('frag')
    expect(key).toMatch(/^frag[0-9A-Z]{26}$/)
  })

  it('produces valid prefixed keys for all 4 types', () => {
    const types = ['entry', 'frag', 'wiki', 'person'] as const
    for (const type of types) {
      const key = makeLookupKey(type)
      expect(key.startsWith(type)).toBe(true)
      const ulid = key.slice(type.length)
      expect(ulid).toMatch(/^[0-9A-Z]{26}$/)
    }
  })
})

describe('parseLookupKey', () => {
  it('round-trips: parseLookupKey(makeLookupKey(type)).type === type', () => {
    const types = ['entry', 'frag', 'wiki', 'person'] as const
    for (const type of types) {
      const key = makeLookupKey(type)
      const parsed = parseLookupKey(key)
      expect(parsed.type).toBe(type)
    }
  })

  it('extracts correct ULID (26 chars, valid Crockford Base32)', () => {
    const key = makeLookupKey('entry')
    const parsed = parseLookupKey(key)
    expect(parsed.ulid).toMatch(/^[0-9A-Z]{26}$/)
    expect(parsed.ulid).toBe(key.slice('entry'.length))
  })

  it('throws on unknown prefix', () => {
    expect(() => parseLookupKey('unknown01ABCDEFGHJKMNPQRSTVWXYZ')).toThrow(/Unknown type prefix/)
  })
})

describe('monotonic ordering', () => {
  it('100 ULIDs generated in sequence are sorted', () => {
    const keys = Array.from({ length: 100 }, () => makeLookupKey('entry'))
    const ulids = keys.map((k) => k.slice('entry'.length))
    const sorted = [...ulids].sort()
    expect(ulids).toEqual(sorted)
  })
})

describe('golden fixtures', () => {
  it('lookupKeys: composing type+ulid === key for each fixture case', () => {
    for (const fixture of fixtures.lookupKeys) {
      expect(`${fixture.type}${fixture.ulid}`).toBe(fixture.key)
    }
  })

  it('parseLookupKey correctly parses all fixture keys', () => {
    for (const fixture of fixtures.lookupKeys) {
      const parsed = parseLookupKey(fixture.key)
      expect(parsed.type).toBe(fixture.type)
      expect(parsed.ulid).toBe(fixture.ulid)
    }
  })
})
