import { Hono } from 'hono'
import { eq, and, sql, isNull, inArray } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { groups, groupWikis, wikis, edges } from '../db/schema.js'
import { validationHook } from '../lib/validation.js'
import { emitAuditEvent } from '../db/audit.js'
import {
  groupResponseSchema,
  groupListResponseSchema,
  groupDetailResponseSchema,
  groupWikisListResponseSchema,
  createGroupBodySchema,
  updateGroupBodySchema,
  addWikiToGroupBodySchema,
} from '../schemas/groups.schema.js'

const groupsRouter = new Hono()
groupsRouter.use('*', sessionMiddleware)

// GET /groups — list groups with wiki counts
groupsRouter.get('/', async (c) => {
  const rows = await db
    .select({
      group: groups,
      wikiCount: sql<number>`count(${groupWikis.wikiId})::int`,
    })
    .from(groups)
    .leftJoin(groupWikis, eq(groupWikis.groupId, groups.id))
    .groupBy(groups.id)
    .orderBy(sql`${groups.updatedAt} DESC`)

  return c.json(
    groupListResponseSchema.parse({
      groups: rows.map((r) => ({
        ...r.group,
        wikiCount: r.wikiCount,
      })),
    })
  )
})

// POST /groups — create group
groupsRouter.post('/', zValidator('json', createGroupBodySchema, validationHook), async (c) => {
  const body = c.req.valid('json')

  const [existing] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.slug, body.slug))
  if (existing) return c.json({ error: 'Slug already taken' }, 409)

  const [group] = await db
    .insert(groups)
    .values({
      name: body.name,
      slug: body.slug,
      icon: body.icon,
      color: body.color,
      description: body.description,
      // Stream V (migration 0015): groups carries its own source_client
      // text column. Web-UI creates stamp the row so audit consumers can
      // distinguish HTTP-route creates from MCP creates without a join.
      sourceClient: 'web',
    })
    .returning()

  await emitAuditEvent(db, {
    entityType: 'group',
    entityId: group.id,
    eventType: 'created',
    source: 'api',
    summary: `Group created: ${body.name}`,
    detail: { groupId: group.id, slug: body.slug },
  })

  return c.json(groupResponseSchema.parse({ ...group, wikiCount: 0 }), 201)
})

// GET /groups/:id — get group detail
groupsRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [group] = await db.select().from(groups).where(eq(groups.id, id))
  if (!group) return c.json({ error: 'Not found' }, 404)

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(groupWikis)
    .where(eq(groupWikis.groupId, id))

  return c.json(
    groupDetailResponseSchema.parse({
      ...group,
      wikiCount: countResult?.count ?? 0,
    })
  )
})

// PUT /groups/:id — update group
groupsRouter.put('/:id', zValidator('json', updateGroupBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db.select().from(groups).where(eq(groups.id, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.slug && body.slug !== existing.slug) {
    const [conflict] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.slug, body.slug))
    if (conflict) return c.json({ error: 'Slug already taken' }, 409)
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name != null) updates.name = body.name
  if (body.slug != null) updates.slug = body.slug
  if (body.icon != null) updates.icon = body.icon
  if (body.color != null) updates.color = body.color
  if (body.description != null) updates.description = body.description
  // Stream V (migration 0015): record the most recent editing surface.
  updates.sourceClient = 'web'

  const [group] = await db.update(groups).set(updates).where(eq(groups.id, id)).returning()

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(groupWikis)
    .where(eq(groupWikis.groupId, id))

  await emitAuditEvent(db, {
    entityType: 'group',
    entityId: id,
    eventType: 'edited',
    source: 'api',
    summary: `Group updated: ${group.name}`,
    detail: { groupId: id, changedFields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
  })

  return c.json(groupResponseSchema.parse({ ...group, wikiCount: countResult?.count ?? 0 }))
})

// DELETE /groups/:id — delete group (cascade removes memberships, wikis survive)
groupsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [group] = await db.select().from(groups).where(eq(groups.id, id))
  if (!group) return c.json({ error: 'Not found' }, 404)

  await db.delete(groups).where(eq(groups.id, id))

  await emitAuditEvent(db, {
    entityType: 'group',
    entityId: id,
    eventType: 'deleted',
    source: 'api',
    summary: `Group deleted: ${group.name}`,
    detail: { groupId: id },
  })

  return c.body(null, 204)
})

// POST /groups/:id/wikis — add wiki to group
groupsRouter.post(
  '/:id/wikis',
  zValidator('json', addWikiToGroupBodySchema, validationHook),
  async (c) => {
    const id = c.req.param('id')
    const { wikiId } = c.req.valid('json')

    const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, id))
    if (!group) return c.json({ error: 'Group not found' }, 404)

    const [wiki] = await db
      .select({ lookupKey: wikis.lookupKey })
      .from(wikis)
      .where(eq(wikis.lookupKey, wikiId))
    if (!wiki) return c.json({ error: 'Wiki not found' }, 404)

    await db
      .insert(groupWikis)
      .values({ groupId: id, wikiId })
      .onConflictDoNothing()

    return c.json({ ok: true, groupId: id, wikiId }, 201)
  }
)

// DELETE /groups/:id/wikis/:wikiId — remove wiki from group
groupsRouter.delete('/:id/wikis/:wikiId', async (c) => {
  const id = c.req.param('id')
  const wikiId = c.req.param('wikiId')

  const deleted = await db
    .delete(groupWikis)
    .where(and(eq(groupWikis.groupId, id), eq(groupWikis.wikiId, wikiId)))
    .returning()

  if (deleted.length === 0) return c.json({ error: 'Membership not found' }, 404)

  return c.body(null, 204)
})

// GET /groups/:id/wikis — list wikis in group with fragment counts
groupsRouter.get('/:id/wikis', async (c) => {
  const id = c.req.param('id')

  const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, id))
  if (!group) return c.json({ error: 'Not found' }, 404)

  const memberships = await db
    .select({ wikiId: groupWikis.wikiId })
    .from(groupWikis)
    .where(eq(groupWikis.groupId, id))

  if (memberships.length === 0) {
    return c.json(groupWikisListResponseSchema.parse({ wikis: [] }))
  }

  const wikiIds = memberships.map((m) => m.wikiId)

  const rows = await db
    .select({
      lookupKey: wikis.lookupKey,
      slug: wikis.slug,
      name: wikis.name,
      type: wikis.type,
      fragmentCount: sql<number>`count(${edges.id})::int`,
    })
    .from(wikis)
    .leftJoin(
      edges,
      and(
        eq(edges.dstId, wikis.lookupKey),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )
    .where(and(inArray(wikis.lookupKey, wikiIds), isNull(wikis.deletedAt)))
    .groupBy(wikis.lookupKey)

  return c.json(groupWikisListResponseSchema.parse({ wikis: rows }))
})

export { groupsRouter as groupsRoutes }
