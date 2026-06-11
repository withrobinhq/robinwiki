import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProvisionJob } from '@robin/queue'

// ── Mocks ───────────────────────────────────────────────────────────────

const mockSelect = vi.fn()
const mockFrom = vi.fn()
const mockWhere = vi.fn()
const mockUpdate = vi.fn()
const mockSet = vi.fn()
const mockUpdateWhere = vi.fn()

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: mockFrom }),
    update: () => ({ set: mockSet }),
  },
}))

mockFrom.mockReturnValue({ where: mockWhere })
mockSet.mockReturnValue({ where: mockUpdateWhere })
mockUpdateWhere.mockResolvedValue(undefined)

vi.mock('../db/schema.js', () => ({
  users: {
    id: 'id',
    publicKey: 'public_key',
    encryptedPrivateKey: 'encrypted_private_key',
  },
  entries: {},
  fragments: {},
  wikis: {},
  edges: {},
  people: {},
}))

const mockGenerateKeypair = vi.fn().mockReturnValue({
  publicKey: 'deadbeef',
  encryptedPrivateKey: 'base64secret',
})
vi.mock('../keypair.js', () => ({
  generateKeypair: (...args: unknown[]) => mockGenerateKeypair(...args),
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

vi.stubEnv('KEY_ENCRYPTION_SECRET', 'test-secret-32chars!!!!!!!!!!!')

// ── Import under test (after mocks) ────────────────────────────────────

const { processProvisionJob } = await import('../queue/worker')

// ── Helpers ─────────────────────────────────────────────────────────────

function makeJob(userId = 'u1'): ProvisionJob {
  return {
    type: 'provision',
    jobId: `provision-${userId}`,
    userId,
    enqueuedAt: new Date().toISOString(),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('processProvisionJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFrom.mockReturnValue({ where: mockWhere })
    mockSet.mockReturnValue({ where: mockUpdateWhere })
    mockUpdateWhere.mockResolvedValue(undefined)
    mockWhere.mockResolvedValue([])
    mockGenerateKeypair.mockReturnValue({
      publicKey: 'deadbeef',
      encryptedPrivateKey: 'base64secret',
    })
  })

  it('returns failure when user not found', async () => {
    mockWhere.mockResolvedValueOnce([])

    const result = await processProvisionJob(makeJob('missing'))

    expect(result.success).toBe(false)
    expect(result.error).toBe('user not found')
    expect(mockGenerateKeypair).not.toHaveBeenCalled()
  })

  it('skips keygen if user already has a keypair', async () => {
    mockWhere.mockResolvedValueOnce([
      {
        id: 'u1',
        publicKey: 'existing-pk',
        encryptedPrivateKey: 'existing-epk',
      },
    ])

    const result = await processProvisionJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockGenerateKeypair).not.toHaveBeenCalled()
  })

  it('generates keypair and writes DB for new user', async () => {
    mockWhere.mockResolvedValueOnce([{ id: 'u1', publicKey: '', encryptedPrivateKey: '' }])

    const result = await processProvisionJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockGenerateKeypair).toHaveBeenCalledOnce()
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: 'deadbeef',
        encryptedPrivateKey: 'base64secret',
      })
    )
  })

  it('provisions user with null keypair columns', async () => {
    mockWhere.mockResolvedValueOnce([{ id: 'u1', publicKey: null, encryptedPrivateKey: null }])

    const result = await processProvisionJob(makeJob())

    expect(result.success).toBe(true)
    expect(mockGenerateKeypair).toHaveBeenCalledOnce()
  })

  it('throws when KEY_ENCRYPTION_SECRET is missing', async () => {
    mockWhere.mockResolvedValueOnce([{ id: 'u1', publicKey: '', encryptedPrivateKey: '' }])

    const origSecret = process.env.KEY_ENCRYPTION_SECRET
    delete process.env.KEY_ENCRYPTION_SECRET

    try {
      await expect(processProvisionJob(makeJob())).rejects.toThrow('KEY_ENCRYPTION_SECRET')
    } finally {
      process.env.KEY_ENCRYPTION_SECRET = origSecret
    }
  })
})
