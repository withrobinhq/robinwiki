import { z } from 'zod'
import { createConfigVar } from '@robin/shared'

/**
 * Fail-fast check for production deploys. Runs before any other bootstrap step
 * so operators get a single clean message listing everything missing, instead
 * of piecemeal crashes deep in module initialization (crypto.ts, db/client.ts,
 * ...). No-op outside production so local dev isn't forced to set every var.
 */
export function assertProdEnv(): void {
  if (process.env.NODE_ENV !== 'production') return

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'BETTER_AUTH_SECRET',
    'RECOVERY_SECRET',
    'MASTER_KEY',
    'KEY_ENCRYPTION_SECRET',
  ] as const

  const recommended = [
    'OPENROUTER_API_KEY',
    'SERVER_PUBLIC_URL',
    'WIKI_ORIGIN',
  ] as const

  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`FATAL: missing required env vars in production: ${missing.join(', ')}`)
    console.error('See .env.example at repo root for descriptions.')
    process.exit(1)
  }

  const warn = recommended.filter((k) => !process.env[k])
  if (warn.length) {
    console.warn(
      `WARN: recommended env vars not set: ${warn.join(', ')} — some features may degrade silently.`,
    )
  }
}

// Run the prod gate before Zod validation so a missing MASTER_KEY / DATABASE_URL
// in production produces one clean error instead of a Zod-style wall of issues.
assertProdEnv()

/**
 * Prepend `https://` to a bare hostname so values like the Railway interpolation
 * `${{wiki.RAILWAY_PUBLIC_DOMAIN}}` (which resolves to `wiki-prod.up.railway.app`
 * — no scheme) survive URL validation. Existing `http://` or `https://` prefixes
 * are preserved so local dev stays untouched.
 */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export const env = createConfigVar({
  schema: {
    DATABASE_URL: z.string().min(1).describe('Postgres connection string'),
    REDIS_URL: z.string().min(1).describe('Redis connection string'),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32)
      .describe('32+ char session signing key (openssl rand -hex 32)'),
    RECOVERY_SECRET: z
      .string()
      .min(32)
      .optional()
      .describe(
        '32+ char recovery secret for /auth/recover (separate from BETTER_AUTH_SECRET). Required in production.',
      ),
    SERVER_PUBLIC_URL: z
      .string()
      .min(1)
      .transform(normalizeOrigin)
      .pipe(z.string().url())
      .describe(
        'Server public URL, e.g. https://api.example.com (bare domain auto-prepends https://)',
      ),
    MASTER_KEY: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('64 hex chars — generate with: openssl rand -hex 32'),
    KEY_ENCRYPTION_SECRET: z.string().min(32).describe('32+ char key encryption secret'),
    INITIAL_USERNAME: z.string().email().describe('Email for first admin user'),
    INITIAL_PASSWORD: z.string().min(6).describe('Password for first admin user'),
    OPENROUTER_API_KEY: z.string().min(1).describe('OpenRouter API key (openrouter.ai/keys)'),
    WIKI_ORIGIN: z
      .string()
      .min(1)
      .transform((val) =>
        val
          .split(',')
          .map((entry) => normalizeOrigin(entry))
          .join(','),
      )
      .pipe(
        z
          .string()
          .refine(
            (val) => val.split(',').every((u) => z.string().url().safeParse(u).success),
            'Each comma-separated origin must be a valid URL (bare domain auto-prepends https://)',
          ),
      )
      .describe(
        'Wiki frontend URL(s) for CORS — comma-separated; bare domains auto-prepend https://',
      ),
    PORT: z.coerce.number().default(3000).describe('Server port'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.string().default('info'),
  },
})

// Propagate normalized values back to process.env. Several call sites read
// `process.env.SERVER_PUBLIC_URL` / `process.env.WIKI_ORIGIN` directly
// (auth.ts, index.ts, routes/users.ts) and won't see the schema's transform
// otherwise. Mutating here keeps the validator the single source of truth.
if (env.SERVER_PUBLIC_URL) process.env.SERVER_PUBLIC_URL = env.SERVER_PUBLIC_URL
if (env.WIKI_ORIGIN) process.env.WIKI_ORIGIN = env.WIKI_ORIGIN
