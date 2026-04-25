import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { generateSlug, makeLookupKey } from '@robin/shared'
import { NoOpenRouterKeyError, embedText } from '@robin/agent'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { wikis, edges, wikiTypes, fragments, people, auditLog, edits, groupWikis } from '../db/schema.js'
import { resolveWikiSlug } from '../db/slug.js'
import { inferWikiType } from '../mcp/wiki-type-inference.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import { nanoid24 } from '../lib/id.js'
import { regenerateWiki } from '../lib/regen.js'
import { buildSidecar } from '../lib/wikiSidecar.js'
import { makeSidecarDeps } from '../lib/wikiSidecarDeps.js'
import { stripWikiContent } from '../lib/strip-wiki-content.js'
import { producer } from '../queue/producer.js'
import {
  wikiResponseSchema,
  wikiListResponseSchema,
  wikiDetailResponseSchema,
  wikiListQuerySchema,
  updateWikiBodySchema,
  publishWikiResponseSchema,
  bouncerModeBodySchema,
  bouncerModeResponseSchema,
  toggleRegenerateBodySchema,
  toggleRegenerateResponseSchema,
  spawnWikiBodySchema,
  spawnWikiResponseSchema,
  updateProgressBodySchema,
  updateProgressResponseSchema,
  editHistoryResponseSchema,
  createWikiBodySchema,
} from '../schemas/wikis.schema.js'
import { emitAuditEvent } from '../db/audit.js'
import { timelineQuerySchema } from '../schemas/audit.schema.js'

const log = logger.child({ component: 'wikis' })

/** Prepare a wiki row for schema parsing (add id alias + computed defaults) */
function prepareWiki(
  t: typeof wikis.$inferSelect & {
    noteCount?: number
    lastUpdated?: string
    shortDescriptor?: string
    descriptor?: string
  }
) {
  return {
    ...t,
    id: t.lookupKey,
    noteCount: t.noteCount ?? 0,
    lastUpdated: t.lastUpdated ?? t.updatedAt.toISOString(),
    shortDescriptor: t.shortDescriptor ?? '',
    descriptor: t.descriptor ?? '',
    progress: t.progress ?? null,
  }
}

const wikisRouter = new Hono()
wikisRouter.use('*', sessionMiddleware)

// GET /wikis — wiki listing with fragment counts + descriptors
wikisRouter.get('/', zValidator('query', wikiListQuerySchema, validationHook), async (c) => {
  const { limit, offset, type } = c.req.valid('query')

  const conditions = [isNull(wikis.deletedAt)]
  if (type) conditions.push(eq(wikis.type, type))

  const rows = await db
    .select({
      wiki: wikis,
      fragmentCount: sql<number>`count(${edges.id})::int`,
      shortDescriptor: wikiTypes.shortDescriptor,
      descriptor: wikiTypes.descriptor,
    })
    .from(wikis)
    .leftJoin(wikiTypes, eq(wikis.type, wikiTypes.slug))
    .leftJoin(
      edges,
      and(
        eq(edges.dstId, wikis.lookupKey),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )
    .where(and(...conditions))
    .groupBy(wikis.lookupKey, wikiTypes.shortDescriptor, wikiTypes.descriptor)
    .orderBy(sql`${wikis.updatedAt} DESC`)
    .limit(limit)
    .offset(offset)

  return c.json(
    wikiListResponseSchema.parse({
      wikis: rows.map((r) =>
        wikiResponseSchema.parse(
          prepareWiki({
            ...r.wiki,
            noteCount: r.fragmentCount,
            shortDescriptor: r.shortDescriptor ?? '',
            descriptor: r.descriptor ?? '',
          })
        )
      ),
    })
  )
})

// POST /wikis — create a new wiki
wikisRouter.post('/', zValidator('json', createWikiBodySchema, validationHook), async (c) => {
  const body = c.req.valid('json')

  const slug = generateSlug(body.name)
  const finalSlug = await resolveWikiSlug(db, slug)
  const lookupKey = makeLookupKey('wiki')
  const wikiType = body.type || inferWikiType(body.description ?? '')

  const [created] = await db
    .insert(wikis)
    .values({
      lookupKey,
      slug: finalSlug,
      name: body.name.trim(),
      description: body.description ?? '',
      type: wikiType,
      state: 'PENDING',
      prompt: body.prompt ?? '',
    })
    .returning()

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: lookupKey,
    eventType: 'created',
    source: 'api',
    summary: `Wiki created: ${body.name.trim()}`,
    detail: { wikiKey: lookupKey, type: wikiType, slug: finalSlug },
  })

  // Quick-classify unfiled fragments by embedding similarity (mechanism 2)
  try {
    const orConfig = await loadOpenRouterConfig()
    const textToEmbed = `${body.name.trim()} ${body.description ?? ''}`.trim()
    const wikiVec = await embedText(textToEmbed, {
      apiKey: orConfig.apiKey,
      model: orConfig.models.embedding,
    })

    if (wikiVec) {
      const candidates = await db
        .select({
          lookupKey: fragments.lookupKey,
          distance: sql<number>`${fragments.embedding} <=> ${JSON.stringify(wikiVec)}::vector`,
        })
        .from(fragments)
        .where(
          and(
            isNull(fragments.deletedAt),
            sql`${fragments.embedding} IS NOT NULL`,
            sql`${fragments.lookupKey} NOT IN (
              SELECT src_id FROM edges
              WHERE edge_type = 'FRAGMENT_IN_WIKI' AND deleted_at IS NULL
            )`
          )
        )
        .orderBy(sql`${fragments.embedding} <=> ${JSON.stringify(wikiVec)}::vector`)
        .limit(20)

      const matched = candidates.filter((c) => 1 - c.distance > 0.6)

      for (const frag of matched) {
        await db
          .insert(edges)
          .values({
            id: crypto.randomUUID(),
            srcType: 'fragment',
            srcId: frag.lookupKey,
            dstType: 'wiki',
            dstId: lookupKey,
            edgeType: 'FRAGMENT_IN_WIKI',
            attrs: { score: 1 - frag.distance },
          })
          .onConflictDoNothing()
      }

      if (matched.length > 0) {
        await producer.enqueueRegen({
          type: 'regen',
          jobId: crypto.randomUUID(),
          objectKey: lookupKey,
          objectType: 'wiki',
          triggeredBy: 'manual',
          enqueuedAt: new Date().toISOString(),
        })
      }

      log.info({ wikiKey: lookupKey, linked: matched.length }, 'quick-classified fragments on wiki create')
    }
  } catch (err) {
    log.warn({ wikiKey: lookupKey, err }, 'quick-classify on wiki create failed — wiki created without fragment linking')
  }

  return c.json(wikiResponseSchema.parse(prepareWiki(created)), 201)
})

// GET /wikis/:id — wiki detail with member fragments and aggregated people
wikisRouter.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db
    .select({
      wiki: wikis,
      shortDescriptor: wikiTypes.shortDescriptor,
      descriptor: wikiTypes.descriptor,
    })
    .from(wikis)
    .leftJoin(wikiTypes, eq(wikis.type, wikiTypes.slug))
    .where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!row) return c.json({ error: 'Not found' }, 404)
  const wiki = row.wiki

  // Member fragments via FRAGMENT_IN_WIKI edges
  // For review-mode wikis, also include pending edges (deletedAt set) so the UI
  // can show them for accept/reject. Pending = edge exists with deletedAt set.
  const isReviewMode = wiki.bouncerMode === 'review'
  const edgeConditions = [
    eq(edges.dstId, id),
    eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
  ]
  if (!isReviewMode) edgeConditions.push(isNull(edges.deletedAt))

  const fragEdges = await db
    .select({ srcId: edges.srcId, deletedAt: edges.deletedAt })
    .from(edges)
    .where(and(...edgeConditions))

  // Build a map of fragmentKey → edgeStatus for the response
  const edgeStatusMap = new Map<string, 'active' | 'pending'>()
  for (const e of fragEdges) {
    edgeStatusMap.set(e.srcId, e.deletedAt ? 'pending' : 'active')
  }
  const fragKeys = fragEdges.map((e) => e.srcId)

  const frags =
    fragKeys.length > 0
      ? await db
          .select({
            lookupKey: fragments.lookupKey,
            slug: fragments.slug,
            title: fragments.title,
            content: fragments.content,
          })
          .from(fragments)
          .where(inArray(fragments.lookupKey, fragKeys))
      : []

  // Aggregated people: FRAGMENT_MENTIONS_PERSON edges from those fragments
  const personEdges =
    fragKeys.length > 0
      ? await db
          .select({ dstId: edges.dstId })
          .from(edges)
          .where(
            and(
              inArray(edges.srcId, fragKeys),
              eq(edges.edgeType, 'FRAGMENT_MENTIONS_PERSON'),
              isNull(edges.deletedAt)
            )
          )
      : []
  const personKeys = [...new Set(personEdges.map((e) => e.dstId))]

  const peopleRows =
    personKeys.length > 0
      ? await db
          .select({ lookupKey: people.lookupKey, name: people.name })
          .from(people)
          .where(inArray(people.lookupKey, personKeys))
      : []

  const sidecar = await buildSidecar({
    content: wiki.content ?? '',
    metadata: wiki.metadata ?? null,
    citationDeclarations: wiki.citationDeclarations ?? [],
    deps: makeSidecarDeps(db),
  })

  // ?raw — token-efficient response for LLM consumption
  if (c.req.query('raw') !== undefined) {
    const stripped = stripWikiContent(wiki.content ?? '', sidecar.refs)
    return c.json({
      ...prepareWiki(wiki),
      wikiContent: stripped,
      fragments: frags.map((f) => ({
        id: f.lookupKey,
        slug: f.slug,
        title: f.title,
        snippet: (f.content ?? '').slice(0, 200),
      })),
      people: peopleRows.map((p) => ({
        id: p.lookupKey,
        name: p.name,
      })),
    })
  }

  return c.json(
    wikiDetailResponseSchema.parse({
      ...prepareWiki({
        ...wiki,
        shortDescriptor: row.shortDescriptor ?? '',
        descriptor: row.descriptor ?? '',
      }),
      wikiContent: wiki.content ?? '',
      fragments: frags.map((f) => ({
        id: f.lookupKey,
        slug: f.slug,
        title: f.title,
        snippet: (f.content ?? '').slice(0, 200),
        edgeStatus: edgeStatusMap.get(f.lookupKey) ?? 'active',
      })),
      people: peopleRows.map((p) => ({
        id: p.lookupKey,
        name: p.name,
      })),
      refs: sidecar.refs,
      infobox: sidecar.infobox,
      sections: sidecar.sections,
    })
  )
})

// GET /wikis/:id/timeline — audit events related to this wiki and its fragments
wikisRouter.get('/:id/timeline', async (c) => {
  const id = c.req.param('id')
  const query = timelineQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const params = query.success ? query.data : { limit: 50, offset: 0 }

  const [wiki] = await db.select({ lookupKey: wikis.lookupKey }).from(wikis).where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  const fragmentEdges = await db
    .select({ srcId: edges.srcId })
    .from(edges)
    .where(
      and(
        eq(edges.dstId, id),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )

  const relatedIds = [id, ...fragmentEdges.map(e => e.srcId)]

  const events = await db
    .select()
    .from(auditLog)
    .where(inArray(auditLog.entityId, relatedIds))
    .orderBy(sql`${auditLog.createdAt} DESC`)
    .limit(params.limit)
    .offset(params.offset)

  return c.json({
    events: events.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
  })
})

// GET /wikis/:id/history — edit history for this wiki's content
wikisRouter.get('/:id/history', async (c) => {
  const id = c.req.param('id')
  const query = timelineQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const params = query.success ? query.data : { limit: 50, offset: 0 }

  const [wiki] = await db
    .select({ lookupKey: wikis.lookupKey })
    .from(wikis)
    .where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(edits)
    .where(and(eq(edits.objectType, 'wiki'), eq(edits.objectId, id)))

  const rows = await db
    .select()
    .from(edits)
    .where(and(eq(edits.objectType, 'wiki'), eq(edits.objectId, id)))
    .orderBy(desc(edits.timestamp))
    .limit(params.limit)
    .offset(params.offset)

  return c.json(
    editHistoryResponseSchema.parse({
      edits: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp.toISOString(),
        type: r.type,
        source: r.source,
        contentSnippet: r.content.slice(0, 200),
      })),
      total: countResult?.count ?? 0,
    })
  )
})

// PUT /wikis/:id — update wiki
wikisRouter.put('/:id', zValidator('json', updateWikiBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name != null) {
    updates.name = body.name
    const candidateSlug = generateSlug(body.name)
    // Only resolve slug collisions when the slug actually changes
    updates.slug = candidateSlug === existing.slug
      ? candidateSlug
      : await resolveWikiSlug(db, candidateSlug)
  }
  if (body.description != null) updates.description = body.description
  if (body.type != null) {
    updates.type = body.type
    // Type change affects wiki generation — mark PENDING so regen rebuilds with new type's prompt
    if (body.type !== existing.type) updates.state = 'PENDING'
  }
  if (body.prompt != null) {
    updates.prompt = body.prompt
    // Prompt change affects wiki generation — mark PENDING so regen rebuilds with new prompt
    if (body.prompt !== existing.prompt) updates.state = 'PENDING'
  }

  const [updated] = await db
    .update(wikis)
    .set(updates)
    .where(eq(wikis.lookupKey, id))
    .returning()

  const typeTransition = body.type != null && body.type !== existing.type
    ? { from: existing.type, to: body.type }
    : undefined

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: id,
    eventType: 'edited',
    source: 'api',
    summary: `Wiki edited: ${updated.name}`,
    detail: { wikiKey: id, changedFields: Object.keys(updates).filter(k => k !== 'updatedAt'), typeTransition },
  })

  return c.json(wikiResponseSchema.parse(prepareWiki(updated)))
})

// POST /wikis/:id/publish — publish wiki with stable nanoid slug
wikisRouter.post('/:id/publish', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  if (!wiki.content) {
    return c.json({ error: 'Cannot publish a wiki with no content' }, 400)
  }

  const slug = wiki.publishedSlug ?? nanoid24()
  const [updated] = await db
    .update(wikis)
    .set({
      published: true,
      publishedSlug: slug,
      publishedAt: wiki.publishedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(wikis.lookupKey, id))
    .returning()

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: id,
    eventType: 'published',
    source: 'api',
    summary: `Wiki published: ${wiki.name}`,
    detail: { wikiKey: id, publishedSlug: slug },
  })

  return c.json(publishWikiResponseSchema.parse(updated))
})

// POST /wikis/:id/unpublish — unpublish wiki (preserves slug for re-publish)
wikisRouter.post('/:id/unpublish', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  const [updated] = await db
    .update(wikis)
    .set({ published: false, updatedAt: new Date() })
    .where(eq(wikis.lookupKey, id))
    .returning()

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: id,
    eventType: 'unpublished',
    source: 'api',
    summary: `Wiki unpublished: ${wiki.name}`,
    detail: { wikiKey: id },
  })

  return c.json(publishWikiResponseSchema.parse(updated))
})

// POST /wikis/:id/regenerate — on-demand wiki regen
wikisRouter.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  if (!wiki.regenerate) {
    return c.json({ error: 'Regeneration is disabled for this wiki' }, 400)
  }

  try {
    const result = await regenerateWiki(db, id)
    log.info({ wikiKey: id, ...result }, 'wiki regenerated via on-demand endpoint')
    if (result.timing) {
      const t = result.timing
      c.header('Server-Timing', `classify;dur=${t.classify}, gather;dur=${t.gatherFragments}, llm;dur=${t.llmCall}, embed;dur=${t.embed}, total;dur=${t.total}`)
    }
    return c.json({ ok: true, lookupKey: id, fragmentCount: result.fragmentCount })
  } catch (err) {
    if (err instanceof NoOpenRouterKeyError) {
      return c.json({ error: 'OpenRouter API key not configured' }, 500)
    }
    const message = err instanceof Error ? err.message : String(err)
    log.error({ wikiKey: id, error: message }, 'wiki regen failed')
    return c.json({ error: 'Regeneration failed', detail: message }, 500)
  }
})

// PATCH /wikis/:id/regenerate — toggle regenerate boolean
wikisRouter.patch(
  '/:id/regenerate',
  zValidator('json', toggleRegenerateBodySchema, validationHook),
  async (c) => {
    const id = c.req.param('id')
    const { regenerate } = c.req.valid('json')

    const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
    if (!wiki) return c.json({ error: 'Not found' }, 404)

    const [updated] = await db
      .update(wikis)
      .set({ regenerate, updatedAt: new Date() })
      .where(eq(wikis.lookupKey, id))
      .returning()

    return c.json(
      toggleRegenerateResponseSchema.parse({
        id,
        regenerate: updated.regenerate,
      })
    )
  }
)

// PATCH /wikis/:id/bouncer — toggle bouncer mode (auto/review)
wikisRouter.patch('/:id/bouncer', zValidator('json', bouncerModeBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const { mode } = c.req.valid('json')

  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  await db
    .update(wikis)
    .set({ bouncerMode: mode, updatedAt: new Date() })
    .where(eq(wikis.lookupKey, id))

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: id,
    eventType: 'edited',
    source: 'api',
    summary: `Wiki bouncer mode set to ${mode}`,
    detail: { wikiKey: id, changedFields: ['bouncerMode'] },
  })

  return c.json(bouncerModeResponseSchema.parse({ id, bouncerMode: mode }))
})

// PUT /wikis/:id/progress — update progress milestones
wikisRouter.put(
  '/:id/progress',
  zValidator('json', updateProgressBodySchema, validationHook),
  async (c) => {
    const id = c.req.param('id')
    const { milestones } = c.req.valid('json')

    const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
    if (!wiki) return c.json({ error: 'Not found' }, 404)

    const completed = milestones.filter((m) => m.completed).length
    const percentage = Math.round((completed / milestones.length) * 100)
    const progress = { milestones: milestones.map((m) => ({ label: m.label, completed: m.completed })), percentage }

    await db
      .update(wikis)
      .set({ progress, updatedAt: new Date() })
      .where(eq(wikis.lookupKey, id))

    await emitAuditEvent(db, {
      entityType: 'wiki',
      entityId: id,
      eventType: 'progress_updated',
      source: 'api',
      summary: `Wiki progress updated: ${wiki.name} (${percentage}%)`,
      detail: { wikiKey: id, percentage, totalMilestones: milestones.length, completedMilestones: completed },
    })

    return c.json(updateProgressResponseSchema.parse({ progress }))
  }
)

// POST /wikis/:id/spawn — create a related child wiki with a WIKI_RELATED_TO_WIKI edge
wikisRouter.post(
  '/:id/spawn',
  zValidator('json', spawnWikiBodySchema, validationHook),
  async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    const [parent] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
    if (!parent) return c.json({ error: 'Not found' }, 404)

    const newWikiKey = makeLookupKey('wiki')
    const slug = await resolveWikiSlug(db, generateSlug(body.name))
    const type = body.type ?? parent.type

    await db.insert(wikis).values({
      lookupKey: newWikiKey,
      slug,
      name: body.name,
      type,
      state: 'PENDING',
      prompt: '',
    })

    // Create WIKI_RELATED_TO_WIKI edge from parent to child
    await db
      .insert(edges)
      .values({
        id: crypto.randomUUID(),
        srcType: 'wiki',
        srcId: parent.lookupKey,
        dstType: 'wiki',
        dstId: newWikiKey,
        edgeType: 'WIKI_RELATED_TO_WIKI',
      })
      .onConflictDoNothing()

    return c.json(
      spawnWikiResponseSchema.parse({
        lookupKey: newWikiKey,
        slug,
        name: body.name,
        type,
        parentKey: parent.lookupKey,
        fragmentCount: 0,
      })
    )
  }
)

// POST /wikis/:targetId/merge — merge source wiki into target
wikisRouter.post('/:targetId/merge', async (c) => {
  return c.json({ error: 'Not implemented — wiki merge needs edges table rewrite' }, 501)
})


// DELETE /wikis/:id — soft delete
wikisRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  await db
    .update(wikis)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(wikis.lookupKey, id))

  // Hard-delete group memberships — soft-delete doesn't trigger FK CASCADE
  await db.delete(groupWikis).where(eq(groupWikis.wikiId, id))

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: id,
    eventType: 'deleted',
    source: 'api',
    summary: `Wiki deleted: ${wiki.name}`,
    detail: { wikiKey: id, wikiSlug: wiki.slug },
  })

  return c.body(null, 204)
})

export { wikisRouter as wikisRoutes, prepareWiki }
