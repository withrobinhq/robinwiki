import { EventEmitter } from 'node:events'
import { sql, type Name, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { CasLockEvents } from './events.js'

export interface CasLockConfig<TTable extends PgTable> {
  db: NodePgDatabase<any>
  table: TTable
  keyColumn: string
  stateColumn: string
  lockedByColumn: string
  lockedAtColumn: string
  lockTtlMs: number
}

export interface AcquireParams {
  key: string
  fromState: string | string[]
  toState: string
  lockedBy: string
}

export interface ReleaseParams {
  toState: string
}

export interface UsingParams extends AcquireParams {
  successState: string
  failureState: string
  autoRenew?: boolean
}

export type LockedRow<TRow> = TRow & {
  __lockMeta: {
    key: string
    lockedBy: string
    lockedAt: Date
    acquiredAt: Date
  }
}

const PREV_LOCKED_BY = 'prev_locked_by'
const PREV_ID = sql.identifier(PREV_LOCKED_BY)

export class CasLock<
  TTable extends PgTable,
  TRow = TTable['$inferSelect'],
> extends EventEmitter {
  private readonly db: NodePgDatabase<any>
  private readonly table: TTable
  private readonly lockedAtCol: string
  private readonly lockTtlMs: number
  private readonly ttlInterval: SQL
  private readonly keyId: Name
  private readonly stateId: Name
  private readonly lockedById: Name
  private readonly lockedAtId: Name

  constructor(config: CasLockConfig<TTable>) {
    super()
    this.db = config.db
    this.table = config.table
    this.lockedAtCol = config.lockedAtColumn
    this.lockTtlMs = config.lockTtlMs
    this.keyId = sql.identifier(config.keyColumn)
    this.stateId = sql.identifier(config.stateColumn)
    this.lockedById = sql.identifier(config.lockedByColumn)
    this.lockedAtId = sql.identifier(config.lockedAtColumn)
    const ttlSec = Math.max(1, Math.ceil(config.lockTtlMs / 1000))
    this.ttlInterval = sql.raw(`'${ttlSec} seconds'`)
  }

  async acquire(params: AcquireParams): Promise<LockedRow<TRow> | null> {
    const { key, fromState, toState, lockedBy } = params

    // Build the fromState predicate: single value uses =, array uses IN (...)
    const states = Array.isArray(fromState) ? fromState : [fromState]
    const fromStatePredicate =
      states.length === 1
        ? sql`${this.table}.${this.stateId} = ${states[0]}`
        : sql`${this.table}.${this.stateId} IN (${sql.join(states.map(s => sql`${s}`), sql`, `)})`

    let result: unknown
    try {
      result = await this.db.execute(
        sql`UPDATE ${this.table}
            SET ${this.stateId} = ${toState},
                ${this.lockedById} = ${lockedBy},
                ${this.lockedAtId} = NOW(),
                updated_at = NOW()
            FROM (SELECT ${this.lockedById} AS ${PREV_ID}
                  FROM ${this.table}
                  WHERE ${this.keyId} = ${key}) AS old
            WHERE ${this.table}.${this.keyId} = ${key}
              AND (${fromStatePredicate}
                   OR (${this.table}.${this.stateId} = ${toState}
                       AND ${this.table}.${this.lockedAtId} < NOW() - INTERVAL ${this.ttlInterval}))
            RETURNING ${this.table}.*, old.${PREV_ID}`
      )
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.emit(CasLockEvents.error, e)
      throw e
    }

    const rows = extractRows(result)
    if (rows.length === 0) {
      this.emit(CasLockEvents.contended, { key, fromState })
      return null
    }

    const { [PREV_LOCKED_BY]: prev, ...row } = rows[0] as Record<string, unknown>
    if (prev != null && prev !== lockedBy) {
      this.emit(CasLockEvents.stolen, {
        key,
        prevLockedBy: String(prev),
        lockedBy,
      })
    }

    const lockedAt = toDate(row[this.lockedAtCol]) ?? new Date()
    const locked = {
      ...row,
      __lockMeta: { key, lockedBy, lockedAt, acquiredAt: new Date() },
    } as LockedRow<TRow>

    this.emit(CasLockEvents.acquired, { key, lockedBy, fromState, toState })
    return locked
  }

  async release(lock: LockedRow<TRow>, params: ReleaseParams): Promise<void> {
    const { toState } = params
    const { key } = lock.__lockMeta

    try {
      await this.db.execute(
        sql`UPDATE ${this.table}
            SET ${this.stateId} = ${toState},
                ${this.lockedById} = NULL,
                ${this.lockedAtId} = NULL,
                updated_at = NOW()
            WHERE ${this.keyId} = ${key}`
      )
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.emit(CasLockEvents.error, e)
      throw e
    }

    this.emit(CasLockEvents.released, { key, toState })
  }

  async renew(lock: LockedRow<TRow>): Promise<boolean> {
    const { key, lockedBy } = lock.__lockMeta

    let result: unknown
    try {
      result = await this.db.execute(
        sql`UPDATE ${this.table}
            SET ${this.lockedAtId} = NOW(),
                updated_at = NOW()
            WHERE ${this.keyId} = ${key}
              AND ${this.lockedById} = ${lockedBy}
            RETURNING ${this.lockedAtId}`
      )
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.emit(CasLockEvents.renewFailed, { key, reason: e.message })
      return false
    }

    const rows = extractRows(result)
    if (rows.length === 0) {
      this.emit(CasLockEvents.renewFailed, { key, reason: 'lock no longer held' })
      return false
    }

    const newLockedAt = toDate((rows[0] as Record<string, unknown>)[this.lockedAtCol]) ?? new Date()
    const newExpiresAt = new Date(newLockedAt.getTime() + this.lockTtlMs)
    this.emit(CasLockEvents.renewed, { key, newExpiresAt })
    return true
  }

  async using<T>(
    params: UsingParams,
    routine: (lock: LockedRow<TRow>) => Promise<T>
  ): Promise<T> {
    const { successState, failureState, autoRenew, ...acquireParams } = params

    const lock = await this.acquire(acquireParams)
    if (!lock) {
      throw new Error(`CasLock contended: ${params.key}`)
    }

    let renewTimer: ReturnType<typeof setInterval> | undefined
    if (autoRenew) {
      // renew() catches its own errors and emits renewFailed; never throws
      const interval = Math.max(1, Math.floor(this.lockTtlMs * 0.8))
      renewTimer = setInterval(() => {
        void this.renew(lock)
      }, interval)
    }

    try {
      const result = await routine(lock)
      await this.release(lock, { toState: successState })
      return result
    } catch (err) {
      try {
        await this.release(lock, { toState: failureState })
      } catch (releaseErr) {
        const e = releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr))
        this.emit(CasLockEvents.error, e)
      }
      throw err
    } finally {
      if (renewTimer) clearInterval(renewTimer)
    }
  }
}

function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows
    if (Array.isArray(rows)) return rows
  }
  return []
}

function toDate(v: unknown): Date | null {
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number') return new Date(v)
  return null
}
