import { describe, it, expect } from 'vitest'
import { editorialStateOf, EditorialState } from './wiki-editorial-state.js'

describe('editorialStateOf', () => {
  const past = new Date('2026-04-01T12:00:00Z')
  const earlier = new Date('2026-03-01T12:00:00Z')

  it('returns dreaming when state is LINKING regardless of other signals', () => {
    expect(
      editorialStateOf({ state: 'LINKING', dirtySince: null, lastRebuiltAt: null })
    ).toBe('dreaming')
    expect(
      editorialStateOf({ state: 'LINKING', dirtySince: past, lastRebuiltAt: past })
    ).toBe('dreaming')
    expect(
      editorialStateOf({ state: 'LINKING', dirtySince: null, lastRebuiltAt: past })
    ).toBe('dreaming')
  })

  it('returns learning when dirty_since is set and state is not LINKING', () => {
    expect(
      editorialStateOf({ state: 'PENDING', dirtySince: past, lastRebuiltAt: null })
    ).toBe('learning')
    expect(
      editorialStateOf({ state: 'RESOLVED', dirtySince: past, lastRebuiltAt: earlier })
    ).toBe('learning')
    expect(
      editorialStateOf({ state: 'ATTACHED', dirtySince: past, lastRebuiltAt: earlier })
    ).toBe('learning')
  })

  it('returns empty when never regenned and not dirty', () => {
    expect(
      editorialStateOf({ state: 'PENDING', dirtySince: null, lastRebuiltAt: null })
    ).toBe('empty')
    expect(
      editorialStateOf({ state: 'RESOLVED', dirtySince: null, lastRebuiltAt: null })
    ).toBe('empty')
  })

  it('returns filed when regenned and not dirty', () => {
    expect(
      editorialStateOf({ state: 'RESOLVED', dirtySince: null, lastRebuiltAt: past })
    ).toBe('filed')
    expect(
      editorialStateOf({ state: 'PENDING', dirtySince: null, lastRebuiltAt: past })
    ).toBe('filed')
  })

  it('rejects malformed input via the Zod schema', () => {
    expect(() =>
      editorialStateOf({
        state: 'BOGUS' as unknown as 'PENDING',
        dirtySince: null,
        lastRebuiltAt: null,
      })
    ).toThrow()
  })

  it('exposes EditorialState as a runtime enum with all four members', () => {
    expect(EditorialState.options).toEqual(['empty', 'learning', 'dreaming', 'filed'])
  })
})
