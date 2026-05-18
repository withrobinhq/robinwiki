import { randomBytes } from 'node:crypto'
import { createConfigVar } from '@robin/shared'
import { z } from 'zod'

/**
 * Stable error name so `assertProdSafety` can discriminate prod-safety
 * failures from generic boot errors and aggregate them into a single
 * operator-friendly message.
 */
export class ProdSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProdSafetyError'
  }
}

/**
 * Fail-fast check for production deploys. Runs before any other bootstrap step
 * so operators get a single clean message listing everything missing, instead
 * of piecemeal crashes deep in module initialization (crypto.ts, db/client.ts,
 * ...). No-op outside production so local dev isn't forced to set every var.
 *
 * Throws `ProdSafetyError` on failure (instead of `process.exit(1)`) so the
 * `assertProdSafety` aggregator in core/src/bootstrap/assert-prod-safety.ts
 * can collect every prod-safety failure into one message before the boot
 * aborts. Direct callers in production must let the throw propagate so the
 * orchestrator restarts.
 */
export function assertProdEnv(): void {
  if (process.env.NODE_ENV !== 'production') return

  // Signing secrets can be any random value, so auto-generate ephemeral
  // ones on fresh deploys to avoid a crash loop. Infrastructure vars like
  // DATABASE_URL must still be operator-provided and fail fast below.
  const generatable = ['JOB_SIGNING_SECRET', 'RECOVERY_SECRET'] as const
  for (const key of generatable) {
    if (!process.env[key]) {
      const ephemeral = randomBytes(32).toString('hex')
      process.env[key] = ephemeral
      console.warn(
        `[WARN] ${key} not set — generated ephemeral value for this boot.\n` +
          `       Set a persistent value in your environment to avoid regeneration on restart:\n` +
          `       ${key}=$(openssl rand -hex 32)`,
      )
    }
  }

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'BETTER_AUTH_SECRET',
    'MASTER_KEY',
    'KEY_ENCRYPTION_SECRET',
    'WIKI_ORIGIN',
    'JOB_SIGNING_SECRET',
    'RECOVERY_SECRET',
    'SERVER_PUBLIC_URL',
  ] as const

  const recommended = ['OPENROUTER_API_KEY'] as const

  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    throw new ProdSafetyError(
      `missing required env vars in production: ${missing.join(', ')}. ` +
        'Set these in your deployment environment before starting the server.',
    )
  }

  // Empty / whitespace-only WIKI_ORIGIN passes the presence check above but
  // would silently fall through to the localhost default at the cors mount
  // site — refuse to boot so the misconfig is loud.
  const wikiOrigin = process.env.WIKI_ORIGIN
  if (!wikiOrigin || wikiOrigin.trim() === '') {
    throw new ProdSafetyError(
      'WIKI_ORIGIN must be a non-empty comma-separated origin list in production. ' +
        'Set WIKI_ORIGIN to one or more comma-separated https:// origins.',
    )
  }

  // SEC-H2 boot gate: cookie security flags are NODE_ENV-driven (auth.ts), so
  // an HTTP public URL in production would issue Secure cookies on a non-TLS
  // origin and immediately drop them. Refuse to start instead of silently
  // breaking auth — operator gets one clear message naming both env vars.
  const publicUrl = process.env.SERVER_PUBLIC_URL
  if (!publicUrl?.startsWith('https://')) {
    throw new ProdSafetyError(
      'SERVER_PUBLIC_URL must start with https:// in production. ' +
        `Got: ${publicUrl ?? '(unset)'}. ` +
        'Fix by setting SERVER_PUBLIC_URL to your HTTPS deploy URL ' +
        '(e.g. https://api.example.com) and redeploying.',
    )
  }

  const warn = recommended.filter((k) => !process.env[k])
  if (warn.length) {
    console.warn(
      `WARN: recommended env vars not set: ${warn.join(', ')} — some features may degrade silently.`,
    )
  }
}

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
    JOB_SIGNING_SECRET: z
      .string()
      .min(32)
      .optional()
      .describe(
        '32+ char HMAC secret for BullMQ job payload signing — required in production (openssl rand -hex 32)'
      ),
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
