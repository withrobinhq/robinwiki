import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetQueueEnvCacheForTesting } from '../env.js'
import {
  JobSignatureError,
  resetJobSigningSecretCacheForTesting,
  signJob,
  verifyJob,
} from '../job-signing.js'

const originalEnv = process.env

beforeEach(() => {
  process.env = { ...originalEnv }
  resetQueueEnvCacheForTesting()
  resetJobSigningSecretCacheForTesting()
})

afterEach(() => {
  process.env = originalEnv
  resetQueueEnvCacheForTesting()
  resetJobSigningSecretCacheForTesting()
})

const TEST_SECRET = 'a'.repeat(64) // 64-char test secret

describe('signJob / verifyJob', () => {
  it('round-trips: signed job verifies and yields the original payload', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const signed = signJob({ jobId: 'a', x: 1, y: 'two' })
    expect(typeof signed.__sig).toBe('string')
    expect(signed.__sig).toHaveLength(64)
    const verified = verifyJob(signed)
    expect(verified).toEqual({ jobId: 'a', x: 1, y: 'two' })
    expect((verified as { __sig?: string }).__sig).toBeUndefined()
  })

  it('mutated payload fails verification', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const signed = signJob({ jobId: 'a', x: 1 })
    const tampered = { ...signed, x: 99 }
    expect(() => verifyJob(tampered)).toThrow(JobSignatureError)
  })

  it('mutated jobId fails verification', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const signed = signJob({ jobId: 'a', x: 1 })
    const tampered = { ...signed, jobId: 'b' }
    expect(() => verifyJob(tampered)).toThrow(JobSignatureError)
  })

  it('missing __sig fails verification', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    expect(() => verifyJob({ jobId: 'a', x: 1 } as never)).toThrow(JobSignatureError)
  })

  it('truncated __sig fails verification (length mismatch)', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const signed = signJob({ jobId: 'a', x: 1 })
    const tampered = { ...signed, __sig: 'deadbeef' }
    expect(() => verifyJob(tampered)).toThrow(JobSignatureError)
  })

  it('wrong secret fails verification', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const signed = signJob({ jobId: 'a', x: 1 })
    const otherSecret = 'b'.repeat(64)
    expect(() => verifyJob(signed, otherSecret)).toThrow(JobSignatureError)
  })

  it('signing is deterministic (same payload -> same sig)', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const a = signJob({ jobId: 'a', x: 1, y: 'two' })
    const b = signJob({ jobId: 'a', x: 1, y: 'two' })
    expect(a.__sig).toBe(b.__sig)
  })

  it('signing is order-independent (key order does not change the sig)', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const a = signJob({ jobId: 'a', x: 1, y: 'two' })
    const b = signJob({ jobId: 'a', y: 'two', x: 1 })
    expect(a.__sig).toBe(b.__sig)
  })

  it('signing strips a pre-existing __sig before recomputing (idempotent)', () => {
    process.env.NODE_ENV = 'test'
    process.env.JOB_SIGNING_SECRET = TEST_SECRET
    const once = signJob({ jobId: 'a', x: 1 })
    const twice = signJob(once)
    expect(once.__sig).toBe(twice.__sig)
  })
})

describe('getJobSigningSecret — env behavior', () => {
  it('throws in production when JOB_SIGNING_SECRET is missing', async () => {
    process.env.NODE_ENV = 'production'
    // biome-ignore lint/performance/noDelete: env mutation requires actual delete to unset
    delete process.env.JOB_SIGNING_SECRET
    resetQueueEnvCacheForTesting()
    resetJobSigningSecretCacheForTesting()
    const { getJobSigningSecret } = await import('../job-signing.js')
    expect(() => getJobSigningSecret()).toThrow(/JOB_SIGNING_SECRET is required in production/)
  })

  it('falls back to the dev sentinel outside production (with warn)', async () => {
    process.env.NODE_ENV = 'development'
    // biome-ignore lint/performance/noDelete: env mutation requires actual delete to unset
    delete process.env.JOB_SIGNING_SECRET
    resetQueueEnvCacheForTesting()
    resetJobSigningSecretCacheForTesting()
    const { getJobSigningSecret } = await import('../job-signing.js')
    const secret = getJobSigningSecret()
    expect(secret).toMatch(/dev-fallback/)
  })
})
