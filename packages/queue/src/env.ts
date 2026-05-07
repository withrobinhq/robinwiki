import { z } from 'zod'

/**
 * Queue-package env loader. `@robin/queue` cannot import from `@robin/core`,
 * so we declare a minimal Zod loader here that mirrors the same shape used
 * in `core/src/bootstrap/env.ts`. Both sides validate the same min-length
 * shape; the prod boot gate (assertProdEnv) lives in core, while this
 * loader's role is local validation + a dev fallback so contributors do
 * not need to generate a secret to run the worker.
 *
 * If a shared env loader is later introduced (e.g. `@robin/shared/env`),
 * both core and queue should migrate to it in a follow-up.
 */
const queueEnvSchema = z.object({
  JOB_SIGNING_SECRET: z.string().min(32).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type QueueEnv = z.infer<typeof queueEnvSchema>

let cachedEnv: QueueEnv | null = null

export function getQueueEnv(runtimeEnv?: Record<string, string | undefined>): QueueEnv {
  if (cachedEnv) return cachedEnv
  const raw = runtimeEnv ?? (process.env as Record<string, string | undefined>)
  const cleaned = {
    JOB_SIGNING_SECRET: raw.JOB_SIGNING_SECRET === '' ? undefined : raw.JOB_SIGNING_SECRET,
    NODE_ENV: raw.NODE_ENV,
  }
  const parsed = queueEnvSchema.safeParse(cleaned)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const path = firstIssue?.path?.[0] ?? 'env'
    throw new Error(
      `[@robin/queue] env validation failed: ${String(path)}: ${firstIssue?.message ?? 'invalid'}`
    )
  }
  cachedEnv = parsed.data
  return cachedEnv
}

/** Test-only — clears the module-level cache so individual specs can swap envs. */
export function resetQueueEnvCacheForTesting(): void {
  cachedEnv = null
}
