import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/client.js'
import * as schema from './db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { producer } from './queue/producer.js'
import { logger } from './lib/logger.js'
import { ensureFirstUser } from './bootstrap/jit-provision.js'

const log = logger.child({ component: 'auth' })

// SEC-H2: cookie security flags derive from deploy mode, not from a string-
// prefix check on SERVER_PUBLIC_URL. The boot gate in bootstrap/env.ts already
// refuses to start in production unless SERVER_PUBLIC_URL is HTTPS, so the two
// invariants stay aligned.
const isProd = process.env.NODE_ENV === 'production'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),

  emailAndPassword: { enabled: true },

  // Force-reset flag (#71). The boolean lives on users.password_reset_required
  // and is JIT-set to true the first time a user is provisioned. Exposing it
  // here as `mustResetPassword` makes it flow through every getSession call
  // (including the one useSession() polls), so the wiki AuthGuard can gate
  // protected routes on a single read. Cleared by POST /users/clear-reset-flag
  // and re-set by /auth/recover.
  user: {
    additionalFields: {
      mustResetPassword: {
        type: 'boolean',
        fieldName: 'password_reset_required',
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },

  // Single-user mode: no social providers. Use INITIAL_USERNAME/INITIAL_PASSWORD
  // env vars + the boot seed script to create the one-and-only user.

  secret: (() => {
    const s = process.env.BETTER_AUTH_SECRET
    if (!s) throw new Error('BETTER_AUTH_SECRET env var is required')
    return s
  })(),
  baseURL: process.env.SERVER_PUBLIC_URL ?? 'http://localhost:3000',
  basePath: '/api/auth',
  trustedOrigins: [
    ...(process.env.WIKI_ORIGIN?.split(',') ?? ['http://localhost:8080']),
  ],
  advanced: {
    useSecureCookies: isProd,
    defaultCookieAttributes: {
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
    },
  },

  hooks: {
    before: async (rawCtx) => {
      const ctx = rawCtx as Record<string, unknown>
      // JIT provisioning: ensure the first user exists before sign-in
      if (ctx.path === '/sign-in/email') {
        await ensureFirstUser()
      }
      // Single-user gate: block sign-up if any user exists.
      //
      // This JS pre-check is the FAST PATH for the common case (sequential
      // sign-ups against an already-populated DB get a clean 403). The
      // authoritative gate is the DB unique partial index
      // `users_singleton_uidx` (see migration 0002), which closes the TOCTOU
      // window between this count and better-auth's INSERT.
      //
      // Locked decision (#audit-M1): two concurrent /sign-up/email requests
      // may both pass this check; the loser's INSERT raises SQLSTATE 23505
      // and surfaces as a 500. Acceptable — single-tenant deployments hit
      // this only during onboarding. Engineering an after-hook interceptor
      // for provider-layer DB errors adds maintenance cost not justified by
      // the corner case.
      if (ctx.path === '/sign-up/email') {
        const [row] = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM users`)
        if (row && row.count > 0) {
          throw new APIError('FORBIDDEN', {
            message: 'sign-ups disabled — single-user mode',
          })
        }
      }
    },

    after: async (rawCtx) => {
      const ctx = rawCtx as Record<string, unknown>

      // Force-reset gate (#71). On every successful /sign-in/email, read the
      // flag and log its value. The user model's additionalFields config
      // (mustResetPassword → password_reset_required) is what actually exposes
      // it on session.user; this hook exists for observability and to keep
      // the integration point explicit.
      if (ctx.path === '/sign-in/email') {
        const c = ctx.context as Record<string, unknown> | undefined
        const newSession = c?.newSession as Record<string, unknown> | undefined
        const sess = c?.session as Record<string, unknown> | undefined
        const user = ((newSession?.user as Record<string, unknown>) ??
          (sess?.user as Record<string, unknown>) ??
          undefined) as Record<string, unknown> | undefined
        const userId = user?.id as string | undefined
        if (userId) {
          const [row] = await db
            .select({ flag: schema.users.passwordResetRequired })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
          const mustResetPassword = row?.flag === true
          log.debug({ userId, mustResetPassword }, 'sign-in/email after hook')
        }
        return { response: null, headers: null }
      }

      if (ctx.path !== '/sign-up/email') return { response: null, headers: null }

      const c = ctx.context as Record<string, unknown> | undefined
      const newSession = c?.newSession as Record<string, unknown> | undefined
      const session = c?.session as Record<string, unknown> | undefined
      const userId = ((newSession?.user as Record<string, unknown>)?.id ??
        (session?.user as Record<string, unknown>)?.id) as string | undefined
      log.debug({ path: ctx.path, userId }, 'after hook')
      if (!userId) {
        log.error('after hook: could not find userId in context')
        return { response: null, headers: null }
      }

      producer
        .enqueueProvision({
          type: 'provision',
          jobId: `provision-${userId}`,
          userId,
          enqueuedAt: new Date().toISOString(),
        })
        .catch((err) => log.error({ userId, err }, 'failed to enqueue provision'))

      return { response: null, headers: null }
    },
  },
})
