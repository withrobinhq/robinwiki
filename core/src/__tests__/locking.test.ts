import { describe, it, expect, vi } from 'vitest'

// db/locking.js was deleted in 8c30af3 and replaced by @robin/caslock + db/locks.js.
// The old acquireLock/releaseLock/canRebuildThread helpers are gone; lock
// lifecycle is now managed by CasLock instances.
//
// This test verifies that the three exported CasLock instances are properly
// configured — their presence and basic shapes are the unit-testable surface
// without a live DB.

// Prevent db/client.js from throwing on missing DATABASE_URL at module load.
vi.mock('../db/client.js', () => ({
  db: {},
}))

// Stub the CasLock constructor to capture config for assertion.
const capturedConfigs: Record<string, { keyColumn: string; stateColumn: string; lockTtlMs: number }> = {}

vi.mock('@robin/caslock', () => {
  class FakeCasLock {
    config: { keyColumn: string; stateColumn: string; lockTtlMs: number }
    constructor(cfg: { keyColumn: string; stateColumn: string; lockTtlMs: number; [k: string]: unknown }) {
      this.config = { keyColumn: cfg.keyColumn, stateColumn: cfg.stateColumn, lockTtlMs: cfg.lockTtlMs }
    }
    on() {}
  }
  return { CasLock: FakeCasLock }
})

vi.mock('../db/schema.js', () => ({
  entries: { lookupKey: 'entries.lookup_key', state: 'entries.state', lockedBy: 'entries.locked_by', lockedAt: 'entries.locked_at' },
  fragments: { lookupKey: 'fragments.lookup_key', state: 'fragments.state', lockedBy: 'fragments.locked_by', lockedAt: 'fragments.locked_at' },
  wikis: { lookupKey: 'wikis.lookup_key', state: 'wikis.state', lockedBy: 'wikis.locked_by', lockedAt: 'wikis.locked_at' },
}))

vi.mock('../lib/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { entryLock, fragmentLock, wikiRegenLock } = await import('../db/locks.js')

describe('lock instances (db/locks.js — 8c30af3)', () => {
  it('exports entryLock, fragmentLock, and wikiRegenLock', () => {
    expect(entryLock).toBeDefined()
    expect(fragmentLock).toBeDefined()
    expect(wikiRegenLock).toBeDefined()
  })

  it('entryLock is keyed on lookup_key with state column', () => {
    // @ts-ignore — accessing FakeCasLock internals
    expect(entryLock.config.keyColumn).toBe('lookup_key')
    // @ts-ignore
    expect(entryLock.config.stateColumn).toBe('state')
  })

  it('fragmentLock is keyed on lookup_key with state column', () => {
    // @ts-ignore
    expect(fragmentLock.config.keyColumn).toBe('lookup_key')
    // @ts-ignore
    expect(fragmentLock.config.stateColumn).toBe('state')
  })

  it('wikiRegenLock has a higher TTL than entry/fragment locks (90s vs 60s)', () => {
    // wikiRegenLock is padded to 90s because regen can take ~30s on long wikis.
    // @ts-ignore
    expect(wikiRegenLock.config.lockTtlMs).toBe(90_000)
    // @ts-ignore
    expect(entryLock.config.lockTtlMs).toBe(60_000)
    // @ts-ignore
    expect(fragmentLock.config.lockTtlMs).toBe(60_000)
  })
})
