import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { CasLock } from '@robin/caslock'
import { db } from './client.js'
import { entries, fragments, wikis } from './schema.js'
import { logger } from '../lib/logger.js'

const lockLog = logger.child({ component: 'caslock' })

// CasLock types against node-postgres; we run postgres-js. Both support
// `.execute(sql)` with identical row shapes, so a structural cast is safe.
const lockDb = db as unknown as NodePgDatabase<any>

export const entryLock = new CasLock({
  db: lockDb,
  table: entries,
  keyColumn: 'lookup_key',
  stateColumn: 'state',
  lockedByColumn: 'locked_by',
  lockedAtColumn: 'locked_at',
  lockTtlMs: 60_000,
})

export const fragmentLock = new CasLock({
  db: lockDb,
  table: fragments,
  keyColumn: 'lookup_key',
  stateColumn: 'state',
  lockedByColumn: 'locked_by',
  lockedAtColumn: 'locked_at',
  lockTtlMs: 60_000,
})

// Per-wiki regenerate lock (#audit-M5). Wraps POST /wikis/:id/regenerate so
// concurrent calls produce one 200 + one 409 instead of both burning LLM
// budget. TTL-based stolen-lock recovery (cas-lock.ts:89-91) takes over a
// stale lock once locked_at is older than lockTtlMs, so a crashed regen
// does not pin the wiki at LINKING forever. Regen can run for ~30s on long
// wikis; pad to 90s.
export const wikiRegenLock = new CasLock({
  db: lockDb,
  table: wikis,
  keyColumn: 'lookup_key',
  stateColumn: 'state',
  lockedByColumn: 'locked_by',
  lockedAtColumn: 'locked_at',
  lockTtlMs: 90_000,
})

for (const lock of [entryLock, fragmentLock, wikiRegenLock]) {
  lock.on('acquired', (e) => lockLog.debug(e, 'lock acquired'))
  lock.on('stolen', (e) => lockLog.warn(e, 'stole expired lock'))
  lock.on('contended', (e) => lockLog.debug(e, 'lock contended'))
  lock.on('released', (e) => lockLog.debug(e, 'lock released'))
  lock.on('renewed', (e) => lockLog.debug(e, 'lock renewed'))
  lock.on('renewFailed', (e) => lockLog.warn(e, 'lock renew failed'))
  lock.on('error', (err) => lockLog.error({ err }, 'lock error'))
}
