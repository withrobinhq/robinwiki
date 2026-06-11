import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RegenJob } from '@robin/queue'

// ── Mocks ───────────────────────────────────────────────────────────────
//
// Tests that processRegenJob wraps regenerateWiki in wikiRegenLock,
// passes the correct CasLock params, and handles contention gracefully.

const mockUsing = vi.fn()
const mockRegenerateWiki = vi.fn()
const mockEmitPipelineEvent = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/client.js', () => ({
  db: {} as unknown,
}))

vi.mock('../db/schema.js', () => ({
  wikis: {},
  edges: {},
  fragments: {},
}))

vi.mock('../db/locks.js', () => ({
  wikiRegenLock: {
    using: (...args: unknown[]) => mockUsing(...args),
  },
}))

vi.mock('../lib/regen.js', () => ({
  regenerateWiki: (...args: unknown[]) => mockRegenerateWiki(...args),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db/pipeline-events.js', () => ({
  emitPipelineEvent: (...args: unknown[]) => mockEmitPipelineEvent(...args),
}))

vi.mock('../lib/wiki-editorial-state.js', () => ({
  editorialStateWhere: { learning: {} },
}))

vi.mock('../queue/regen-debounce.js', () => ({
  enqueueWikiRegen: vi.fn().mockResolvedValue({ jobId: 'j', queuedAt: '' }),
  filterDebouncedWikiKeys: vi.fn().mockResolvedValue({ eligible: [], debounced: [] }),
  regenDebounceMs: () => 300000,
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

const { processRegenJob } = await import('../queue/regen-worker.js')

// ── Helpers ─────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<RegenJob> = {}): RegenJob {
  return {
    type: 'regen',
    jobId: 'regen-job-1',
    objectKey: 'wiki01TEST',
    objectType: 'wiki',
    triggeredBy: 'manual',
    enqueuedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('processRegenJob — wikiRegenLock wrapping (Wave 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls wikiRegenLock.using with correct CasLock params', async () => {
    mockUsing.mockImplementationOnce(async (_params: unknown, routine: () => Promise<void>) => {
      await routine()
    })
    mockRegenerateWiki.mockResolvedValueOnce({
      content: 'body',
      fragmentCount: 3,
      hasEmbedding: true,
      timing: { classify: 1, gatherFragments: 2, llmCall: 5, embed: 1, total: 9 },
    })

    const result = await processRegenJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockUsing).toHaveBeenCalledTimes(1)

    const params = mockUsing.mock.calls[0][0]
    expect(params.key).toBe('wiki01TEST')
    expect(params.fromState).toEqual(['PENDING', 'RESOLVED'])
    expect(params.toState).toBe('LINKING')
    expect(params.successState).toBe('RESOLVED')
    expect(params.failureState).toBe('PENDING')
    expect(params.autoRenew).toBe(true)
    expect(params.lockedBy).toMatch(/^regen-worker-/)
  })

  it('returns { success: true } when CasLock contended (does not throw)', async () => {
    mockUsing.mockRejectedValueOnce(new Error('CasLock contended: wiki01TEST'))

    const result = await processRegenJob(makeJob())

    expect(result.success).toBe(true)
    expect(result.jobId).toBe('regen-job-1')
    expect(mockRegenerateWiki).not.toHaveBeenCalled()
  })

  it('re-throws non-lock errors so the job fails', async () => {
    mockUsing.mockRejectedValueOnce(new Error('database connection lost'))

    const result = await processRegenJob(makeJob())

    expect(result.success).toBe(false)
    expect(result.error).toBe('database connection lost')
  })

  it('calls regenerateWiki inside the lock routine with jobId', async () => {
    mockUsing.mockImplementationOnce(async (_params: unknown, routine: () => Promise<void>) => {
      await routine()
    })
    mockRegenerateWiki.mockResolvedValueOnce({
      content: 'body',
      fragmentCount: 1,
      hasEmbedding: false,
      timing: { classify: 0, gatherFragments: 0, llmCall: 0, embed: 0, total: 0 },
    })

    await processRegenJob(makeJob({ jobId: 'specific-job-id' }))

    expect(mockRegenerateWiki).toHaveBeenCalledTimes(1)
    const [, wikiKey, opts] = mockRegenerateWiki.mock.calls[0]
    expect(wikiKey).toBe('wiki01TEST')
    expect(opts).toEqual({ jobId: 'specific-job-id' })
  })
})
