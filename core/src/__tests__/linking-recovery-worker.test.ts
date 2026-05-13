import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LinkingRecoveryJob } from '@robin/queue'

// ── Mocks ───────────────────────────────────────────────────────────────
//
// Tests the LINKING recovery cron: stuck wikis (state=LINKING, locked_at
// >15 min stale) are reset to PENDING with dirty_since=NOW(); recent
// LINKING wikis and non-LINKING wikis are untouched.

const mockSelect = vi.fn()
const mockUpdate = vi.fn()
const mockRecordJobRun = vi.fn().mockResolvedValue(undefined)

// Track calls to select().from().where() and update().set().where()
const mockSelectFrom = vi.fn()
const mockSelectWhere = vi.fn()
const mockUpdateSet = vi.fn()
const mockUpdateWhere = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}))

vi.mock('../db/schema.js', () => ({
  wikis: {
    state: 'wikis.state',
    lockedAt: 'wikis.locked_at',
    lockedBy: 'wikis.locked_by',
    deletedAt: 'wikis.deleted_at',
    lookupKey: 'wikis.lookup_key',
    dirtySince: 'wikis.dirty_since',
  },
}))

vi.mock('../lib/scheduled-jobs.js', () => ({
  recordJobRun: (...args: unknown[]) => mockRecordJobRun(...args),
}))

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

// ── Import under test (after mocks) ────────────────────────────────────

const { processLinkingRecoveryJob } = await import(
  '../queue/linking-recovery-worker.js'
)

// ── Helpers ─────────────────────────────────────────────────────────────

function makeJob(jobId = 'recovery-tick-1'): LinkingRecoveryJob {
  return {
    type: 'linking-recovery',
    jobId,
    triggeredBy: 'scheduler',
    enqueuedAt: new Date().toISOString(),
  }
}

function setupSelectReturning(rows: unknown[]) {
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere })
  mockSelectWhere.mockResolvedValue(rows)
  mockSelect.mockReturnValue({ from: mockSelectFrom })
}

function setupUpdateReturning() {
  mockUpdateWhere.mockResolvedValue(undefined)
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere })
  mockUpdate.mockReturnValue({ set: mockUpdateSet })
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('processLinkingRecoveryJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateReturning()
  })

  it('resets wikis with state=LINKING and stale locked_at to PENDING with dirty_since set', async () => {
    const staleWiki = { lookupKey: 'wiki-stuck-1' }
    setupSelectReturning([staleWiki])

    const result = await processLinkingRecoveryJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdateSet).toHaveBeenCalledTimes(1)

    const setArg = mockUpdateSet.mock.calls[0][0]
    expect(setArg.state).toBe('PENDING')
    expect(setArg.dirtySince).toBeInstanceOf(Date)
    expect(setArg.lockedBy).toBeNull()
    expect(setArg.lockedAt).toBeNull()
  })

  it('does not touch any wikis when none are stuck (empty scan result)', async () => {
    setupSelectReturning([])

    const result = await processLinkingRecoveryJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('records a completed heartbeat in scheduled_jobs', async () => {
    setupSelectReturning([])

    await processLinkingRecoveryJob(makeJob('recovery-heartbeat'))

    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    const [, jobName, status, meta] = mockRecordJobRun.mock.calls[0]
    expect(jobName).toBe('linking_recovery')
    expect(status).toBe('completed')
    expect(meta).toEqual({ jobId: 'recovery-heartbeat', recovered: 0 })
  })

  it('is idempotent: running twice on same stuck wiki does not error', async () => {
    const staleWiki = { lookupKey: 'wiki-stuck-2' }
    // First run: wiki is stuck
    setupSelectReturning([staleWiki])
    const r1 = await processLinkingRecoveryJob(makeJob('run-1'))
    expect(r1.success).toBe(true)

    // Second run: no wikis match (already reset to PENDING by first run)
    vi.clearAllMocks()
    setupUpdateReturning()
    setupSelectReturning([])
    const r2 = await processLinkingRecoveryJob(makeJob('run-2'))
    expect(r2.success).toBe(true)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('processes multiple stuck wikis in a single scan', async () => {
    const stuckWikis = [
      { lookupKey: 'wiki-stuck-a' },
      { lookupKey: 'wiki-stuck-b' },
      { lookupKey: 'wiki-stuck-c' },
    ]
    setupSelectReturning(stuckWikis)

    const result = await processLinkingRecoveryJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(3)

    // Each update should reset to PENDING
    for (let i = 0; i < 3; i++) {
      const setArg = mockUpdateSet.mock.calls[i][0]
      expect(setArg.state).toBe('PENDING')
      expect(setArg.lockedBy).toBeNull()
      expect(setArg.lockedAt).toBeNull()
    }

    // Heartbeat should report recovered=3
    const [, , , meta] = mockRecordJobRun.mock.calls[0]
    expect(meta.recovered).toBe(3)
  })

  it('records a failed heartbeat and rethrows on DB error', async () => {
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('connection reset')),
      }),
    })

    await expect(processLinkingRecoveryJob(makeJob('tick-err'))).rejects.toThrow(
      'connection reset'
    )

    expect(mockRecordJobRun).toHaveBeenCalledTimes(1)
    const [, jobName, status, meta] = mockRecordJobRun.mock.calls[0]
    expect(jobName).toBe('linking_recovery')
    expect(status).toBe('failed')
    expect(meta.error).toBe('connection reset')
  })
})
