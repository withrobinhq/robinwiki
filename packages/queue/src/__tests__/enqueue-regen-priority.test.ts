import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resetQueueEnvCacheForTesting } from '../env.js'
import { resetJobSigningSecretCacheForTesting } from '../job-signing.js'

// ── Mocks ───────────────────────────────────────────────────────────────
//
// Tests enqueueRegen priority-bump behavior: manual triggers promote
// waiting jobs to priority 1; active jobs log but don't changePriority;
// scheduler triggers never touch priority.

const mockChangePriority = vi.fn().mockResolvedValue(undefined)
const mockGetState = vi.fn()
const mockAdd = vi.fn()

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: (...args: unknown[]) => mockAdd(...args),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  Worker: vi.fn(),
}))

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}))

const originalEnv = process.env

beforeEach(() => {
  process.env = { ...originalEnv }
  process.env.NODE_ENV = 'test'
  process.env.JOB_SIGNING_SECRET = 'a'.repeat(64)
  resetQueueEnvCacheForTesting()
  resetJobSigningSecretCacheForTesting()

  vi.clearAllMocks()
  mockAdd.mockResolvedValue({
    id: 'regen-wikiXYZ',
    getState: mockGetState,
    changePriority: mockChangePriority,
  })
})

afterEach(() => {
  process.env = originalEnv
  resetQueueEnvCacheForTesting()
  resetJobSigningSecretCacheForTesting()
})

// Import after mocks
const { BullMQProducer } = await import('../index.js')

function makeRegenJob(triggeredBy: 'manual' | 'scheduler') {
  return {
    type: 'regen' as const,
    jobId: 'job-1',
    objectKey: 'wikiXYZ',
    objectType: 'wiki' as const,
    triggeredBy,
    enqueuedAt: new Date().toISOString(),
  }
}

describe('enqueueRegen — priority-bump on manual trigger', () => {
  it('calls changePriority({ priority: 1 }) when manual trigger finds a waiting job', async () => {
    mockGetState.mockResolvedValueOnce('waiting')

    const producer = new BullMQProducer()
    await producer.enqueueRegen(makeRegenJob('manual'))

    expect(mockGetState).toHaveBeenCalledTimes(1)
    expect(mockChangePriority).toHaveBeenCalledTimes(1)
    expect(mockChangePriority).toHaveBeenCalledWith({ priority: 1 })
  })

  it('does not call changePriority when manual trigger finds an active job', async () => {
    mockGetState.mockResolvedValueOnce('active')

    const producer = new BullMQProducer()
    await producer.enqueueRegen(makeRegenJob('manual'))

    expect(mockGetState).toHaveBeenCalledTimes(1)
    expect(mockChangePriority).not.toHaveBeenCalled()
  })

  it('does not call changePriority on scheduler triggers', async () => {
    const producer = new BullMQProducer()
    await producer.enqueueRegen(makeRegenJob('scheduler'))

    expect(mockGetState).not.toHaveBeenCalled()
    expect(mockChangePriority).not.toHaveBeenCalled()
  })

  it('does not call changePriority when manual trigger finds a completed job', async () => {
    mockGetState.mockResolvedValueOnce('completed')

    const producer = new BullMQProducer()
    await producer.enqueueRegen(makeRegenJob('manual'))

    expect(mockGetState).toHaveBeenCalledTimes(1)
    expect(mockChangePriority).not.toHaveBeenCalled()
  })

  it('uses deduplicated jobId format regen-{objectKey}', async () => {
    mockGetState.mockResolvedValueOnce('waiting')

    const producer = new BullMQProducer()
    await producer.enqueueRegen(makeRegenJob('manual'))

    expect(mockAdd).toHaveBeenCalledTimes(1)
    const [, , opts] = mockAdd.mock.calls[0]
    expect(opts.jobId).toBe('regen-wikiXYZ')
  })
})
