import { Hono } from 'hono'
import { eq, and, desc, isNull, inArray, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { makeLookupKey, generateSlug } from '@robin/shared'
import { resolveFragmentSlug } from '../db/slug.js'
import { computeContentHash, findDuplicateFragment } from '../db/dedup.js'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { fragments, entries, edges, wikis, people } from '../db/schema.js'
import { producer } from '../queue/producer.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import {
  fragmentResponseSchema,
  fragmentWithContentResponseSchema,
  fragmentDetailResponseSchema,
  fragmentListResponseSchema,
  createFragmentBodySchema,
  updateFragmentBodySchema,
  fragmentListQuerySchema,
  fragmentReviewBodySchema,
} from '../schemas/fragments.schema.js'
import { emitAuditEvent } from '../db/audit.js'

const log = logger.child({ component: 'fragments' })

const fragmentsRouter = new Hono()
fragmentsRouter.use('*', sessionMiddleware)

// GET /fragments — list fragments (metadata only, no content)
fragmentsRouter.get('/', async (c) => {
  const query = fragmentListQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const limit = query.success ? query.data.limit : 50
  const offset = query.success ? query.data.offset : 0

  const rows = await db
    .select()
    .from(fragments)
    .where(isNull(fragments.deletedAt))
    .orderBy(desc(fragments.updatedAt))
    .limit(limit)
    .offset(offset)

  return c.json(
    fragmentListResponseSchema.parse({ fragments: rows.map((r) => ({ ...r, id: r.lookupKey })) })
  )
})

// GET /fragments/:id — detail with content and backlinks
fragmentsRouter.get('/:id', async (c) => {
  const id = c.req.param('id')

  const [fragment] = await db
    .select()
    .from(fragments)
    .where(and(eq(fragments.lookupKey, id), isNull(fragments.deletedAt)))
  if (!fragment) return c.json({ error: 'Not found' }, 404)

  // Resolve backlinks: edges where this fragment is srcId
  const outEdges = await db
    .select()
    .from(edges)
    .where(and(eq(edges.srcId, id), isNull(edges.deletedAt)))

  // Batch-resolve destination names
  const backlinks: { id: string; name: string; type: string; bouncerMode?: string }[] = []
  const dstByType: Record<string, string[]> = {}
  for (const e of outEdges) {
    const t = e.dstType === 'frag' ? 'fragment' : e.dstType
    if (!dstByType[t]) dstByType[t] = []
    dstByType[t].push(e.dstId)
  }

  if (dstByType.wiki?.length) {
    const rows = await db
      .select({ key: wikis.lookupKey, name: wikis.name, bouncerMode: wikis.bouncerMode })
      .from(wikis)
      .where(and(inArray(wikis.lookupKey, dstByType.wiki), isNull(wikis.deletedAt)))
    for (const r of rows) backlinks.push({ id: r.key, name: r.name, type: 'wiki', bouncerMode: r.bouncerMode })
  }
  if (dstByType.person?.length) {
    const rows = await db
      .select({ key: people.lookupKey, name: people.name })
      .from(people)
      .where(and(inArray(people.lookupKey, dstByType.person), isNull(people.deletedAt)))
    for (const r of rows) backlinks.push({ id: r.key, name: r.name, type: 'person' })
  }
  if (dstByType.fragment?.length) {
    const rows = await db
      .select({ key: fragments.lookupKey, title: fragments.title })
      .from(fragments)
      .where(and(inArray(fragments.lookupKey, dstByType.fragment), isNull(fragments.deletedAt)))
    for (const r of rows) backlinks.push({ id: r.key, name: r.title, type: 'fragment' })
  }

  // Resolve related fragments via FRAGMENT_RELATED_TO_FRAGMENT edges (both directions)
  const relatedEdges = await db
    .select({ srcId: edges.srcId, dstId: edges.dstId, attrs: edges.attrs })
    .from(edges)
    .where(
      and(
        eq(edges.edgeType, 'FRAGMENT_RELATED_TO_FRAGMENT'),
        isNull(edges.deletedAt),
        sql`(${edges.srcId} = ${id} OR ${edges.dstId} = ${id})`
      )
    )

  const relatedKeySet = new Set<string>()
  const relatedScores = new Map<string, number>()
  for (const e of relatedEdges) {
    const otherKey = e.srcId === id ? e.dstId : e.srcId
    if (!relatedKeySet.has(otherKey)) {
      relatedKeySet.add(otherKey)
      const attrs = e.attrs as Record<string, unknown> | null
      relatedScores.set(otherKey, typeof attrs?.score === 'number' ? attrs.score : 0)
    }
  }

  const relatedFragments: { id: string; slug: string; title: string; similarity: number }[] = []
  if (relatedKeySet.size > 0) {
    const relatedRows = await db
      .select({ lookupKey: fragments.lookupKey, slug: fragments.slug, title: fragments.title })
      .from(fragments)
      .where(and(inArray(fragments.lookupKey, [...relatedKeySet]), isNull(fragments.deletedAt)))
    for (const r of relatedRows) {
      relatedFragments.push({
        id: r.lookupKey,
        slug: r.slug,
        title: r.title,
        similarity: relatedScores.get(r.lookupKey) ?? 0,
      })
    }
    relatedFragments.sort((a, b) => b.similarity - a.similarity)
  }

  return c.json(
    fragmentDetailResponseSchema.parse({
      ...fragment,
      id: fragment.lookupKey,
      content: fragment.content ?? '',
      backlinks,
      relatedFragments,
    })
  )
})

// POST /fragments — create fragment
fragmentsRouter.post('/', zValidator('json', createFragmentBodySchema, validationHook), async (c) => {
  const { title, content, entryId, tags } = c.req.valid('json')

  /** @gate — verify entryId exists */
  const [parentEntry] = await db
    .select({ lookupKey: entries.lookupKey })
    .from(entries)
    .where(eq(entries.lookupKey, entryId))
  if (!parentEntry) return c.json({ error: 'Entry not found' }, 404)

  // Content-level dedup: reject if identical content already exists
  if (content) {
    const hash = computeContentHash(content)
    const existing = await findDuplicateFragment(db, hash)
    if (existing) {
      return c.json(
        fragmentWithContentResponseSchema.parse({
          ...existing,
          id: existing.lookupKey,
          content,
        }),
        200
      )
    }
  }

  const fragKey = makeLookupKey('frag')
  const slug = await resolveFragmentSlug(db, generateSlug(title))

  const [fragment] = await db
    .insert(fragments)
    .values({
      lookupKey: fragKey,
      slug,
      entryId,
      title,
      content: content ?? '',
      dedupHash: content ? computeContentHash(content) : null,
      tags,
    })
    .returning()

  await emitAuditEvent(db, {
    entityType: 'fragment',
    entityId: fragKey,
    eventType: 'created',
    source: 'api',
    summary: `Fragment created: ${title}`,
    detail: { fragmentKey: fragKey, entryId },
  })

  return c.json(
    fragmentWithContentResponseSchema.parse({
      ...fragment,
      id: fragment.lookupKey,
      content: content ?? '',
    }),
    201
  )
})

// PUT /fragments/:id — update fragment
fragmentsRouter.put('/:id', zValidator('json', updateFragmentBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db.select().from(fragments).where(eq(fragments.lookupKey, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.title != null) updates.title = body.title
  if (body.content != null) {
    updates.content = body.content
    updates.dedupHash = computeContentHash(body.content)
  }
  if (body.tags != null) updates.tags = body.tags

  const [fragment] = await db
    .update(fragments)
    .set(updates)
    .where(eq(fragments.lookupKey, id))
    .returning()

  await emitAuditEvent(db, {
    entityType: 'fragment',
    entityId: id,
    eventType: 'edited',
    source: 'api',
    summary: 'Fragment updated',
    detail: { fragmentKey: id, changedFields: Object.keys(updates).filter(k => k !== 'updatedAt') },
  })

  return c.json(fragmentResponseSchema.parse({ ...fragment, id: fragment.lookupKey }))
})

// POST /fragments/:id/accept — accept fragment into a review-mode wiki
fragmentsRouter.post('/:id/accept', zValidator('json', fragmentReviewBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const { wikiId } = c.req.valid('json')

  // Verify fragment exists
  const [fragment] = await db.select().from(fragments).where(eq(fragments.lookupKey, id))
  if (!fragment) return c.json({ error: 'Fragment not found' }, 404)

  // Verify wiki exists and is in review mode
  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, wikiId))
  if (!wiki) return c.json({ error: 'Wiki not found' }, 404)
  if (wiki.bouncerMode !== 'review') {
    return c.json({ error: 'Wiki is not in review mode' }, 400)
  }

  // Find the FRAGMENT_IN_WIKI edge
  const [edge] = await db
    .select()
    .from(edges)
    .where(
      and(
        eq(edges.srcId, id),
        eq(edges.dstId, wikiId),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI')
      )
    )
  if (!edge) return c.json({ error: 'No edge between fragment and wiki' }, 404)

  // Accept: clear deletedAt to activate the edge
  await db
    .update(edges)
    .set({ deletedAt: null })
    .where(eq(edges.id, edge.id))

  await emitAuditEvent(db, {
    entityType: 'fragment',
    entityId: id,
    eventType: 'accepted',
    source: 'api',
    summary: `Fragment accepted into ${wiki.name ?? wikiId}`,
    detail: { fragmentKey: id, wikiKey: wikiId },
  })


    // Queue wiki regen so the accepted fragment's content is incorporated into the wiki body
    try {
      await producer.enqueueRegen({
        type: 'regen',
        jobId: crypto.randomUUID(),
        objectKey: wikiId,
        objectType: 'wiki',
        triggeredBy: 'manual',
        enqueuedAt: new Date().toISOString(),
      })
    } catch (err) {
      log.warn({ wikiKey: wikiId, err }, 'failed to enqueue regen after fragment acceptance')
    }

  return c.json({ ok: true, fragmentId: id, wikiId })
})

// POST /fragments/:id/reject — reject fragment from a review-mode wiki
fragmentsRouter.post('/:id/reject', zValidator('json', fragmentReviewBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const { wikiId } = c.req.valid('json')

  // Verify fragment exists
  const [fragment] = await db.select().from(fragments).where(eq(fragments.lookupKey, id))
  if (!fragment) return c.json({ error: 'Fragment not found' }, 404)

  // Verify wiki exists and is in review mode
  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, wikiId))
  if (!wiki) return c.json({ error: 'Wiki not found' }, 404)
  if (wiki.bouncerMode !== 'review') {
    return c.json({ error: 'Wiki is not in review mode' }, 400)
  }

  // Find the FRAGMENT_IN_WIKI edge
  const [edge] = await db
    .select()
    .from(edges)
    .where(
      and(
        eq(edges.srcId, id),
        eq(edges.dstId, wikiId),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI')
      )
    )
  if (!edge) return c.json({ error: 'No edge between fragment and wiki' }, 404)

  // Reject: soft-delete the edge
  await db
    .update(edges)
    .set({ deletedAt: new Date() })
    .where(eq(edges.id, edge.id))

  await emitAuditEvent(db, {
    entityType: 'fragment',
    entityId: id,
    eventType: 'rejected',
    source: 'api',
    summary: `Fragment rejected from ${wiki.name ?? wikiId}`,
    detail: { fragmentKey: id, wikiKey: wikiId },
  })

  // Queue wiki regen so the rejected fragment's content is removed from the wiki body
  try {
    await producer.enqueueRegen({
      type: 'regen',
      jobId: crypto.randomUUID(),
      objectKey: wikiId,
      objectType: 'wiki',
      triggeredBy: 'manual',
      enqueuedAt: new Date().toISOString(),
    })
  } catch (err) {
    log.warn({ wikiKey: wikiId, err }, 'failed to enqueue regen after fragment rejection')
  }

  return c.json({ ok: true, fragmentId: id, wikiId })
})

export { fragmentsRouter as fragmentsRoutes }
