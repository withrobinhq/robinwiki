import { createHmac, timingSafeEqual } from 'node:crypto'
import { getQueueEnv } from './env.js'

/**
 * Dev-only fallback secret. Used when JOB_SIGNING_SECRET is not set AND we
 * are NOT running in production. The fallback is logged loudly on every
 * worker boot — loud logs over silent insecurity in staging.
 */
const JOB_SIGNING_SECRET_DEV_FALLBACK = 'robin-dev-fallback-secret-do-not-use-in-prod'

/**
 * `signJob` and `verifyJob` HMAC-sign job payloads with SHA-256 over a
 * canonical-JSON representation of `{ jobId, payload }`. The signature is
 * attached as `__sig` on the wire; the worker strips it before passing the
 * payload to the typed handler so business logic never sees it.
 */

let cachedSecret: string | null = null

/**
 * Resolve the JOB_SIGNING_SECRET. In production, throws if the env var is
 * missing or empty. In dev / test, falls back to a fixed sentinel and emits
 * a loud warning at module init so operators notice the un-safe config.
 */
export function getJobSigningSecret(): string {
  if (cachedSecret !== null) return cachedSecret
  const env = getQueueEnv()
  const fromEnv = env.JOB_SIGNING_SECRET
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv
    return cachedSecret
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      '[job-signing] JOB_SIGNING_SECRET is required in production (32+ char hex). Generate with: openssl rand -hex 32'
    )
  }
  // Loud warning fires once per process at first call, then again at module
  // init so it surfaces on every worker boot. The combination is intentional:
  // running with the dev fallback should be impossible to miss in staging.
  console.warn('[job-signing] running with DEV FALLBACK secret — NOT SAFE FOR PRODUCTION')
  cachedSecret = JOB_SIGNING_SECRET_DEV_FALLBACK
  return cachedSecret
}

/** Test-only — clears the cached secret so specs can swap envs. */
export function resetJobSigningSecretCacheForTesting(): void {
  cachedSecret = null
}

// Loud-log on module init when running with the dev fallback. Mirrors the
// per-call warning above but fires once per process import — guarantees the
// message lands in worker boot logs even if no job is signed yet.
try {
  const env = getQueueEnv()
  if (
    env.NODE_ENV !== 'production' &&
    (!env.JOB_SIGNING_SECRET || env.JOB_SIGNING_SECRET.length < 32)
  ) {
    console.warn(
      '[job-signing] DEV FALLBACK secret active at module load — NOT SAFE FOR PRODUCTION'
    )
  }
} catch {
  // env validation will surface elsewhere; init-time warning is best-effort.
}

export class JobSignatureError extends Error {
  override readonly name = 'JobSignatureError' as const
}

/**
 * Minimum shape we require off a job payload to verify it. Kept structural
 * (no index signature) so callers can pass typed job shapes like
 * Signed<ExtractionJob> without TypeScript balking on the strict schema.
 */
interface JobLike {
  jobId: string
  __sig?: string
}

/**
 * Build the canonical bytes that the HMAC covers. We sort top-level keys
 * for deterministic output across cross-process serialization drift, then
 * prefix with `${jobId}\x00` so a payload swap between two jobs (same body,
 * different jobId) cannot pass verification.
 */
function buildSignedBody(payload: Record<string, unknown>, jobId: string): string {
  const sortedKeys = Object.keys(payload).sort()
  const ordered: Record<string, unknown> = {}
  for (const k of sortedKeys) ordered[k] = payload[k]
  return `${jobId}\x00${JSON.stringify(ordered)}`
}

/**
 * Compute the HMAC-SHA256 (hex) signature of a job payload and return the
 * payload with `__sig` attached. Idempotent: any pre-existing `__sig` is
 * stripped before signing so re-signing is safe.
 */
export function signJob<T extends { jobId: string }>(
  job: T,
  secretOverride?: string
): T & { __sig: string } {
  const secret = secretOverride ?? getJobSigningSecret()
  const asRecord = job as unknown as Record<string, unknown>
  const { __sig: _omit, ...stripped } = asRecord
  void _omit
  const body = buildSignedBody(stripped, job.jobId)
  const sig = createHmac('sha256', secret).update(body).digest('hex')
  return { ...(stripped as unknown as T), __sig: sig }
}

/**
 * Verify a signed job payload. Throws JobSignatureError on missing or
 * mismatched signature. Returns the payload with `__sig` deleted so the
 * handler code never sees it.
 */
export function verifyJob<T extends JobLike>(signed: T, secretOverride?: string): Omit<T, '__sig'> {
  if (!signed || typeof signed.__sig !== 'string' || signed.__sig.length === 0) {
    throw new JobSignatureError('missing signature')
  }
  const secret = secretOverride ?? getJobSigningSecret()
  const presented = signed.__sig
  const asRecord = signed as unknown as Record<string, unknown>
  const { __sig: _omit, ...stripped } = asRecord
  void _omit
  const body = buildSignedBody(stripped, signed.jobId)
  const expected = createHmac('sha256', secret).update(body).digest('hex')

  // timingSafeEqual requires equal-length buffers. Treat any length / encoding
  // mismatch as an explicit signature failure rather than a node-level throw.
  let presentedBuf: Buffer
  let expectedBuf: Buffer
  try {
    presentedBuf = Buffer.from(presented, 'hex')
    expectedBuf = Buffer.from(expected, 'hex')
  } catch {
    throw new JobSignatureError('signature decode failed')
  }
  if (presentedBuf.length !== expectedBuf.length) {
    throw new JobSignatureError('signature length mismatch')
  }
  if (!timingSafeEqual(presentedBuf, expectedBuf)) {
    throw new JobSignatureError('signature mismatch')
  }
  return stripped as Omit<T, '__sig'>
}
