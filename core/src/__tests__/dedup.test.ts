import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import type postgres from 'postgres'
import { processedJobs } from '../db/schema.js'
import { ensureTestDatabase, pushTestSchema, getTestDb, cleanupTestDb, canConnectToTestDb } from './test-setup.js'
import { isDuplicate, recordJob, computeContentHash } from '../db/dedup.js'

const dbAvailable = await canConnectToTestDb()

// ─── computeContentHash (no DB required) ───

describe('computeContentHash', () => {
  it('returns SHA-256 hex digest of input string', async () => {
    const hash = computeContentHash('hello world')
    // SHA-256 of "hello world"
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })

  it('returns consistent output for same input', () => {
    const hash1 = computeContentHash('test content')
    const hash2 = computeContentHash('test content')
    expect(hash1).toBe(hash2)
  })

  it('returns different output for different input', () => {
    const hash1 = computeContentHash('input a')
    const hash2 = computeContentHash('input b')
    expect(hash1).not.toBe(hash2)
  })

  it('returns a 64-character hex string', () => {
    const hash = computeContentHash('anything')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─── DB-backed tests — skipped when postgresql://robin:@localhost:5432/robin_test is unreachable ───

describe.skipIf(!dbAvailable)('dedup DB integration', () => {
  let db: ReturnType<typeof getTestDb>['db']
  let sqlConn: ReturnType<typeof postgres>

  beforeAll(async () => {
    await ensureTestDatabase()
    pushTestSchema()
    const conn = getTestDb()
    db = conn.db
    sqlConn = conn.sql
  }, 60_000)

  afterAll(async () => {
    await cleanupTestDb(sqlConn)
  })

  afterEach(async () => {
    await db.delete(processedJobs)
  })

  // ─── isDuplicate ───

  describe('isDuplicate', () => {
    it('returns false for a never-seen jobId with no contentHash match', async () => {
      const result = await isDuplicate(db, 'job-new-123', 'hash-never-seen')
      expect(result).toBe(false)
    })

    it('returns true for a previously recorded jobId', async () => {
      await recordJob(db, 'job-dup-1', 'hash-a')
      const result = await isDuplicate(db, 'job-dup-1', 'hash-different')
      expect(result).toBe(true)
    })

    it('returns true when contentHash matches existing record even with different jobId', async () => {
      await recordJob(db, 'job-original', 'hash-shared')
      const result = await isDuplicate(db, 'job-new-different', 'hash-shared')
      expect(result).toBe(true)
    })

    it('returns false when contentHash is null and jobId is new', async () => {
      const result = await isDuplicate(db, 'job-no-hash', null)
      expect(result).toBe(false)
    })

    it('returns true when jobId matches even if contentHash is null', async () => {
      await recordJob(db, 'job-null-hash', null)
      const result = await isDuplicate(db, 'job-null-hash', null)
      expect(result).toBe(true)
    })
  })

  // ─── recordJob ───

  describe('recordJob', () => {
    it('inserts a row with jobId, contentHash, and processedAt', async () => {
      await recordJob(db, 'job-insert-1', 'hash-insert')

      const rows = await db.select().from(processedJobs)
      expect(rows).toHaveLength(1)
      expect(rows[0].jobId).toBe('job-insert-1')
      expect(rows[0].contentHash).toBe('hash-insert')
      expect(rows[0].processedAt).toBeInstanceOf(Date)
    })

    it('prunes rows older than 7 days in the same transaction', async () => {
      // Insert an old row directly (8 days ago)
      await db.execute(
        sql`INSERT INTO processed_jobs (job_id, content_hash, processed_at)
            VALUES ('old-job', 'old-hash', NOW() - INTERVAL '8 days')`
      )

      // Insert a recent row (1 day ago)
      await db.execute(
        sql`INSERT INTO processed_jobs (job_id, content_hash, processed_at)
            VALUES ('recent-job', 'recent-hash', NOW() - INTERVAL '1 day')`
      )

      // recordJob should insert new + prune old
      await recordJob(db, 'new-job', 'new-hash')

      const rows = await db.select().from(processedJobs)
      const jobIds = rows.map((r) => r.jobId).sort()

      // old-job should be pruned, recent-job and new-job should remain
      expect(jobIds).toEqual(['new-job', 'recent-job'])
    })

    it('inserts with null contentHash', async () => {
      await recordJob(db, 'job-null', null)

      const rows = await db.select().from(processedJobs)
      expect(rows).toHaveLength(1)
      expect(rows[0].contentHash).toBeNull()
    })
  })
})
