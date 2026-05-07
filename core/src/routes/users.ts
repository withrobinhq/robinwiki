import { Hono } from 'hono'
import { eq, and, isNull, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import {
  users,
  apiKeys,
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
import { emitAuditEvent } from '../db/audit.js'
import {
  userProfileResponseSchema,
  userStatsResponseSchema,
  userActivityResponseSchema,
  keypairResponseSchema,
  mcpEndpointResponseSchema,
  exportDataResponseSchema,
  userSettingsSchema,
  userSettingsResponseSchema,
  USER_SETTINGS_DEFAULTS,
} from '../schemas/users.schema.js'
import { okResponseSchema } from '../schemas/base.schema.js'

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

// GET /users/keypair
usersRouter.get('/keypair', async (c) => {
  const userId = c.get('userId') as string
  const [user] = await db
    .select({
      publicKey: users.publicKey,
      encryptedPrivateKey: users.encryptedPrivateKey,
    })
    .from(users)
    .where(eq(users.id, userId))

  if (!user || !user.publicKey || !user.encryptedPrivateKey) {
    return c.json({ error: 'No keypair found' }, 404)
  }

  const encryptionSecret = process.env.KEY_ENCRYPTION_SECRET ?? ''
  const privateKeyDer = decryptPrivateKey(user.encryptedPrivateKey, encryptionSecret)

  return c.json(
    keypairResponseSchema.parse({
      algorithm: 'Ed25519',
      publicKey: user.publicKey,
      privateKey: privateKeyDer.toString('hex'),
    })
  )
})

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
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(sql`${auditLog.createdAt} DESC`)
    .limit(20)

  return c.json(
    userActivityResponseSchema.parse({
      activity: rows.map((r) => ({
        action: `${r.entityType}.${r.eventType}`,
        time: r.createdAt?.toISOString() ?? '',
      })),
    })
  )
})

// POST /users/export — export all data as JSON
usersRouter.post('/export', async (c) => {
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
