import { Hono } from 'hono'
import { eq, and, isNull, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { createHash } from 'node:crypto'
import { verifyPassword } from 'better-auth/crypto'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import {
  users,
  accounts,
  apiKeys,
  configs,
  fragments,
  wikis,
  people,
  auditLog,
  entries,
  edges,
} from '../db/schema.js'
import { decryptPrivateKey } from '../keypair.js'
import { signMcpToken, clearKidCache } from '../mcp/jwt.js'
import { validationHook } from '../lib/validation.js'
import { getConfig, setConfig } from '../lib/config.js'
import { logger } from '../lib/logger.js'
import { emitAuditEvent } from '../db/audit.js'
import { buildExportZip } from '../lib/export-zip.js'
import { stream } from 'hono/streaming'
import {
  userProfileResponseSchema,
  userStatsResponseSchema,
  userActivityResponseSchema,
  userActivityQuerySchema,
  keypairResponseSchema,
  keypairRevealRequestSchema,
  keypairRevealResponseSchema,
  mcpEndpointResponseSchema,
  exportDataResponseSchema,
  userSettingsSchema,
  userSettingsResponseSchema,
  USER_SETTINGS_DEFAULTS,
} from '../schemas/users.schema.js'
import { okResponseSchema } from '../schemas/base.schema.js'

// ── Keypair reveal: in-process failed-verify lockout ───────────────────────
// 5 failed verifies inside a 30 minute rolling window triggers a 30-minute
// lockout for that userId. A successful verify clears the counter so a
// fat-fingered user doesn't lock themselves out by eventually getting it
// right. Per-process only — multi-instance deploys don't coordinate.
// Acceptable for the single-tenant deployment.
const REVEAL_WINDOW_MS = 30 * 60 * 1000
const REVEAL_LOCKOUT_MS = 30 * 60 * 1000
const REVEAL_MAX_FAILURES = 5

interface RevealAttemptState {
  failures: number[] // ms timestamps of failed verifies inside the window
  lockedUntil?: number // ms epoch
}
const revealAttempts = new Map<string, RevealAttemptState>()

function isLockedOut(
  userId: string,
): { locked: true; retryAfterMs: number } | { locked: false } {
  const now = Date.now()
  const state = revealAttempts.get(userId)
  if (!state) return { locked: false }
  if (state.lockedUntil && state.lockedUntil > now) {
    return { locked: true, retryAfterMs: state.lockedUntil - now }
  }
  return { locked: false }
}

function recordFailure(userId: string): void {
  const now = Date.now()
  const state = revealAttempts.get(userId) ?? { failures: [] }
  state.failures = state.failures.filter((t) => now - t < REVEAL_WINDOW_MS)
  state.failures.push(now)
  if (state.failures.length >= REVEAL_MAX_FAILURES) {
    state.lockedUntil = now + REVEAL_LOCKOUT_MS
  }
  revealAttempts.set(userId, state)
}

function recordSuccess(userId: string): void {
  // Locked decision: a single correct verify clears the failure history.
  revealAttempts.delete(userId)
}

const usersRouter = new Hono()
usersRouter.use('*', sessionMiddleware)

// GET /users/profile
usersRouter.get('/profile', async (c) => {
  const userId = c.get('userId') as string
  const [user] = await db.select().from(users).where(eq(users.id, userId))

  if (!user) return c.json({ error: 'User not found' }, 404)

  // Single-user app: any api key in the table is the active one
  const [key] = await db.select().from(apiKeys).limit(1)

  const mcpToken = await signMcpToken(user.id).catch(() => null)
  const appUrl = process.env.SERVER_PUBLIC_URL ?? 'http://localhost:3000'

  return c.json(
    userProfileResponseSchema.parse({
      id: user.id,
      email: user.email,
      name: user.name,
      mcpEndpointUrl: mcpToken ? `${appUrl}/mcp?token=${mcpToken}` : '',
      apiKeyHint: key?.hint ?? '',
      onboardedAt: user.onboardedAt?.toISOString() ?? null,
    })
  )
})

// PATCH /users/onboard — mark onboarding complete (skip button)
usersRouter.patch('/onboard', async (c) => {
  const userId = c.get('userId') as string
  await db
    .update(users)
    .set({ onboardedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.onboardedAt)))
  return c.json(okResponseSchema.parse({ ok: true }))
})

// GET /users/keypair — metadata only (no privateKey). The decrypted key is
// only ever returned via POST /users/keypair/reveal after a password proof.
usersRouter.get('/keypair', async (c) => {
  const userId = c.get('userId') as string
  const [user] = await db
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))

  if (!user || !user.publicKey) {
    return c.json({ error: 'No keypair found' }, 404)
  }

  const fingerprint = createHash('sha256')
    .update(Buffer.from(user.publicKey, 'hex'))
    .digest('hex')

  return c.json(
    keypairResponseSchema.parse({
      algorithm: 'Ed25519',
      publicKey: user.publicKey,
      fingerprint,
    }),
  )
})

// POST /users/keypair/reveal — return the decrypted private key after a
// constant-time password verify against the credential-account hash. No
// new session is issued. Rate limited per userId via the in-process
// failed-verify lockout above.
usersRouter.post(
  '/keypair/reveal',
  zValidator('json', keypairRevealRequestSchema, validationHook),
  async (c) => {
    const userId = c.get('userId') as string
    const log = logger.child({ component: 'users', userId, op: 'keypair-reveal' })

    const lock = isLockedOut(userId)
    if (lock.locked) {
      log.warn({ retryAfterMs: lock.retryAfterMs }, 'reveal locked out')
      return c.json(
        { error: 'Too many failed reveal attempts. Try again later.' },
        429,
      )
    }

    const { password } = c.req.valid('json')

    const [account] = await db
      .select({ password: accounts.password })
      .from(accounts)
      .where(
        and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')),
      )

    const [user] = await db
      .select({
        publicKey: users.publicKey,
        encryptedPrivateKey: users.encryptedPrivateKey,
      })
      .from(users)
      .where(eq(users.id, userId))

    if (!account?.password || !user?.publicKey || !user.encryptedPrivateKey) {
      // Treat missing-keypair / missing-credential-account as a failure so
      // the lockout still gates an attacker probing for users without keys.
      recordFailure(userId)
      log.warn('reveal: no keypair / credential account')
      return c.json({ error: 'No keypair found' }, 404)
    }

    const ok = await verifyPassword({ hash: account.password, password })
    if (!ok) {
      recordFailure(userId)
      // Failed-verify attempts are logged through pino (component='users');
      // emitAuditEvent fires only on the success path so the audit log
      // doesn't fill up with attacker noise on a leaked session cookie.
      log.warn('reveal: bad password')
      return c.json({ error: 'Invalid credentials' }, 401)
    }
    recordSuccess(userId)

    const encryptionSecret = process.env.KEY_ENCRYPTION_SECRET ?? ''
    const privateKeyDer = decryptPrivateKey(user.encryptedPrivateKey, encryptionSecret)
    const fingerprint = createHash('sha256')
      .update(Buffer.from(user.publicKey, 'hex'))
      .digest('hex')

    await emitAuditEvent(db, {
      entityType: 'user_keypair',
      entityId: userId,
      eventType: 'revealed',
      source: 'api',
      summary: 'Keypair revealed via password',
    })

    return c.json(
      keypairRevealResponseSchema.parse({
        algorithm: 'Ed25519',
        publicKey: user.publicKey,
        privateKey: privateKeyDer.toString('hex'),
        fingerprint,
      }),
    )
  },
)

// GET /users/stats
usersRouter.get('/stats', async (c) => {
  const [[noteCount], [wikiCount], [personCount], [unwikiedCountResult]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(fragments)
      .where(isNull(fragments.deletedAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(wikis)
      .where(isNull(wikis.deletedAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(people)
      .where(isNull(people.deletedAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(fragments)
      .where(
        and(
          isNull(fragments.deletedAt),
          sql`${fragments.lookupKey} NOT IN (
            SELECT src_id FROM edges
            WHERE edge_type = 'FRAGMENT_IN_WIKI'
            AND deleted_at IS NULL
          )`
        )
      ),
  ])

  return c.json(
    userStatsResponseSchema.parse({
      totalNotes: Number(noteCount?.count ?? 0),
      totalThreads: Number(wikiCount?.count ?? 0),
      peopleCount: Number(personCount?.count ?? 0),
      unthreadedCount: Number(unwikiedCountResult?.count ?? 0),
      lastSync: new Date().toISOString(),
    })
  )
})

// GET /users/activity
usersRouter.get('/activity', async (c) => {
  // SEC-L1: validate ?limit through a schema with .max(200). Reject (not
  // coerce-to-default) on parse failure so attackers can't push past the cap
  // by passing junk values. The default of 20 only applies when ?limit is
  // absent entirely; `?limit=abc` becomes NaN and fails .int() validation.
  const params = userActivityQuerySchema.safeParse({ limit: c.req.query('limit') })
  if (!params.success) {
    return c.json({ error: 'Invalid limit' }, 400)
  }

  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(sql`${auditLog.createdAt} DESC`)
    .limit(params.data.limit)

  return c.json(
    userActivityResponseSchema.parse({
      activity: rows.map((r) => ({
        action: `${r.entityType}.${r.eventType}`,
        time: r.createdAt?.toISOString() ?? '',
      })),
    })
  )
})

// POST /users/export — export all data
//
// Default (no ?format or ?format=json) returns the legacy JSON shape that
// existing API consumers and the OpenAPI manifest expect.
//
// ?format=zip streams a multi-file zip with markdown for wikis + entries,
// JSON for fragments/people, and a graph.json built from the edges table.
// See lib/export-zip.ts for the layout.
usersRouter.post('/export', async (c) => {
  const format = c.req.query('format')

  if (format === 'zip') {
    const archive = await buildExportZip()
    c.header('Content-Type', 'application/zip')
    c.header('Content-Disposition', 'attachment; filename="robin-export.zip"')
    return stream(c, async (s) => {
      // Bridge the Node Readable archive into hono's streaming response.
      // Errors on the archive surface as a stream abort; the client sees a
      // truncated download rather than a partial-success 200.
      for await (const chunk of archive) {
        await s.write(chunk as Uint8Array)
      }
    })
  }

  // Legacy JSON shape, kept verbatim so existing OpenAPI consumers don't
  // see a behaviour change. The zip branch above is the canonical export.
  const [userWikis, userFragments, userPeople] = await Promise.all([
    db.select().from(wikis),
    db.select().from(fragments),
    db.select().from(people),
  ])

  return c.json(
    exportDataResponseSchema.parse({
      exportedAt: new Date().toISOString(),
      wikis: userWikis,
      fragments: userFragments,
      people: userPeople,
    })
  )
})

// GET /users/providers - read-only listing of configured external providers
//
// Surfaces the OpenRouter-configured models per pipeline stage plus a
// last-4-chars hint of the API key so the user can confirm "is this the
// key I think it is" without ever exposing the full secret. Editing
// happens via env vars; there is no mutation surface here by design
// (per project memory: ports/URLs/runtime config live in env vars).
usersRouter.get('/providers', async (c) => {
  const apiKey = process.env.OPENROUTER_API_KEY ?? ''
  // Last 4 chars only. Defensive: keys shorter than 4 chars get an empty
  // hint so we can't accidentally surface the whole secret on a stub key.
  const apiKeyHint = apiKey.length >= 8 ? `...${apiKey.slice(-4)}` : ''

  const rows = await db
    .select({ key: configs.key, value: configs.value, updatedAt: configs.updatedAt })
    .from(configs)
    .where(
      and(
        eq(configs.scope, 'system'),
        eq(configs.kind, 'model_preference'),
      ),
    )

  const stages: Record<string, { model: string; updatedAt: string | null }> = {}
  for (const row of rows) {
    if (typeof row.value === 'string') {
      stages[row.key] = {
        model: row.value,
        updatedAt: row.updatedAt?.toISOString() ?? null,
      }
    }
  }

  return c.json({
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKeyConfigured: !!apiKey,
    apiKeyHint,
    stages: {
      extraction: stages.extraction ?? null,
      classification: stages.classification ?? null,
      wikiGeneration: stages.wiki_generation ?? null,
      embedding: stages.embedding ?? null,
    },
  })
})

// DELETE /users/data — delete all content (keeps account intact)
usersRouter.delete('/data', async (c) => {
  await Promise.all([
    db.delete(edges),
    db.delete(entries),
    db.delete(wikis),
    db.delete(people),
    db.delete(auditLog),
  ])

  return c.json(okResponseSchema.parse({ ok: true }))
})

// POST /users/regenerate-mcp — bump token version, return new MCP URL
usersRouter.post('/regenerate-mcp', async (c) => {
  const userId = c.get('userId') as string
  await db
    .update(users)
    .set({ mcpTokenVersion: sql`${users.mcpTokenVersion} + 1` })
    .where(eq(users.id, userId))
  // Evict the cached row so the next verify reloads the bumped version.
  clearKidCache(userId)
  const mcpToken = await signMcpToken(userId)
  if (!mcpToken) return c.json({ error: 'No keypair — sign out and back in to generate one' }, 400)
  const appUrl = process.env.SERVER_PUBLIC_URL ?? 'http://localhost:3000'
  return c.json(
    mcpEndpointResponseSchema.parse({ mcpEndpointUrl: `${appUrl}/mcp?token=${mcpToken}` })
  )
})

// DELETE /users/account — delete user entirely
usersRouter.delete('/account', async (c) => {
  const userId = c.get('userId') as string
  await db.delete(users).where(eq(users.id, userId))
  return c.json(okResponseSchema.parse({ ok: true }))
})

// GET /users/settings
usersRouter.get('/settings', async (c) => {
  const userId = c.get('userId') as string
  const raw = await getConfig({ scope: 'user', userId, kind: 'user_settings', key: 'default' })
  if (!raw) {
    return c.json(userSettingsResponseSchema.parse(USER_SETTINGS_DEFAULTS))
  }
  const merged = { ...USER_SETTINGS_DEFAULTS, ...(raw as Record<string, unknown>) }
  return c.json(userSettingsResponseSchema.parse(merged))
})

// PUT /users/settings (accepts partial updates)
usersRouter.put(
  '/settings',
  zValidator('json', userSettingsSchema, validationHook),
  async (c) => {
    const userId = c.get('userId') as string
    const body = c.req.valid('json')

    const existing = await getConfig({ scope: 'user', userId, kind: 'user_settings', key: 'default' })
    const current = { ...USER_SETTINGS_DEFAULTS, ...(existing as Record<string, unknown> ?? {}) }

    // Deep-merge nested objects so partial updates don't clobber siblings
    const merged = {
      notifications: { ...(current.notifications as Record<string, unknown>), ...body.notifications },
      privacy: { ...(current.privacy as Record<string, unknown>), ...body.privacy },
      theme: body.theme ?? current.theme,
    }

    await setConfig({
      scope: 'user',
      userId,
      kind: 'user_settings',
      key: 'default',
      value: merged,
    })

    await emitAuditEvent(db, {
      entityType: 'user_settings',
      entityId: userId,
      eventType: 'updated',
      source: 'api',
      summary: 'User settings updated',
      detail: body as unknown as Record<string, unknown>,
    })

    return c.json(okResponseSchema.parse({ ok: true }))
  }
)

export { usersRouter as users }
