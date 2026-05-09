import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { generateSlug, makeLookupKey } from '@robin/shared'
import { NoOpenRouterKeyError, embedText } from '@robin/agent'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { wikis, edges, wikiTypes, fragments, people, auditLog, edits, groupWikis, groups } from '../db/schema.js'
import { resolveWikiSlug } from '../db/slug.js'
import { inferWikiType } from '../mcp/wiki-type-inference.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import { nanoid24 } from '../lib/id.js'
import { regenerateWiki } from '../lib/regen.js'
import { editorialStateOf } from '../lib/wiki-editorial-state.js'
import {
  upsertDescriptionAgentSchemaRow,
  deleteHydeAgentSchemaRow,
} from '../lib/wiki-agent-schema.js'
import { wikiRegenLock } from '../db/locks.js'
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
  autoRegenBodySchema,
  spawnWikiBodySchema,
  spawnWikiResponseSchema,
  updateProgressBodySchema,
  updateProgressResponseSchema,
  editHistoryResponseSchema,
  createWikiBodySchema,
} from '../schemas/wikis.schema.js'
import { emitAuditEvent } from '../db/audit.js'
import { publishWiki as publishWikiService, unpublishWiki as unpublishWikiService } from '../services/publish.js'
import { timelineQuerySchema } from '../schemas/audit.schema.js'

const log = logger.child({ component: 'wikis' })

type WikiCollectionRow = { id: string; name: string; slug: string; color: string }

/**
 * Batched collection-membership lookup. Joined into the GET /wikis response
 * so the Explorer collection filter (and any other consumer) can render
 * which collection(s) a wiki belongs to without N+1 calls. Returns an
 * empty map for empty input.
 */
async function loadWikiCollections(
  wikiIds: string[]
): Promise<Map<string, WikiCollectionRow[]>> {
  const result = new Map<string, WikiCollectionRow[]>()
  if (wikiIds.length === 0) return result

  const rows = await db
    .select({
      wikiId: groupWikis.wikiId,
      id: groups.id,
      name: groups.name,
      slug: groups.slug,
      color: groups.color,
    })
    .from(groupWikis)
    .innerJoin(groups, eq(groups.id, groupWikis.groupId))
    .where(inArray(groupWikis.wikiId, wikiIds))

  for (const row of rows) {
    const arr = result.get(row.wikiId) ?? []
    arr.push({ id: row.id, name: row.name, slug: row.slug, color: row.color })
    result.set(row.wikiId, arr)
  }
  return result
}

/** Prepare a wiki row for schema parsing (add id alias + computed defaults) */
function prepareWiki(
  t: typeof wikis.$inferSelect & {
    noteCount?: number
    lastUpdated?: string
    shortDescriptor?: string
    descriptor?: string
    collections?: WikiCollectionRow[]
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
    collections: t.collections ?? [],
    // T4-bundle (v0.2.2): editorial state is derived in app code from
    // {state, dirtySince, lastRebuiltAt}. See lib/wiki-editorial-state.
    editorialState: editorialStateOf({
      state: t.state as 'LINKING' | 'RESOLVED' | 'PENDING' | 'ATTACHED',
      dirtySince: t.dirtySince ?? null,
      lastRebuiltAt: t.lastRebuiltAt ?? null,
    }),
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

  const collectionsByWiki = await loadWikiCollections(rows.map((r) => r.wiki.lookupKey))

  return c.json(
    wikiListResponseSchema.parse({
      wikis: rows.map((r) =>
        wikiResponseSchema.parse(
          prepareWiki({
            ...r.wiki,
            noteCount: r.fragmentCount,
            shortDescriptor: r.shortDescriptor ?? '',
            descriptor: r.descriptor ?? '',
            collections: collectionsByWiki.get(r.wiki.lookupKey) ?? [],
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
      structure: body.structure ?? '',
      // Stream V (migration 0015): web-UI captures stamp the wiki row
      // with `source_client = 'web'` so retrospective queries can break
      // creates down by surface without unpacking audit_log.detail.
      // Mirrors the pattern entries.ts uses for raw_sources.source_client.
      sourceClient: 'web',
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
      // Self-heal: persist the wiki embedding at create time so backward
      // classification (regen.ts hybridSearch + edge-vector lookups) can
      // hit a non-null vector immediately. Without this the wiki sits
      // embedding=null until the next regen run, which masks similarity
      // until then. (#246)
      await db
        .update(wikis)
        .set({ embedding: wikiVec })
        .where(eq(wikis.lookupKey, lookupKey))

      // Empty-wiki bootstrap (#69 D6 follow-up): seed the kind='description'
      // row in wiki_agent_schema immediately so a brand-new wiki competes in
      // hybrid search on day one. wikiVec already encodes name + description;
      // re-using it here keeps the cost at zero extra LLM/embedding calls.
      // The hyde_synthetic row is deferred to the heal worker because HyDE
      // is an LLM round-trip we will not block POST on.
      try {
        await upsertDescriptionAgentSchemaRow(
          db,
          lookupKey,
          body.description ?? '',
          wikiVec
        )
      } catch (err) {
        log.warn(
          { wikiKey: lookupKey, err },
          'failed to seed description agent_schema row at create — heal worker will retry'
        )
      }

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
        // T4-bundle (v0.2.2): a freshly-created wiki with attached fragments
        // is 'learning' (derived). Stamp dirty_since so editorialStateOf
        // returns 'learning' until the first regen clears the column.
        await db
          .update(wikis)
          .set({ dirtySince: new Date() })
          .where(eq(wikis.lookupKey, lookupKey))

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

  const collectionsByWiki = await loadWikiCollections([wiki.lookupKey])

  return c.json(
    wikiDetailResponseSchema.parse({
      ...prepareWiki({
        ...wiki,
        shortDescriptor: row.shortDescriptor ?? '',
        descriptor: row.descriptor ?? '',
        collections: collectionsByWiki.get(wiki.lookupKey) ?? [],
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

  // Validate type against the wiki_types registry. The column is
  // user-extensible (single-tenant table), so a runtime lookup replaces
  // any static enum validation — same approach as MCP create_wiki.
  if (body.type != null) {
    const [typeRow] = await db
      .select({ slug: wikiTypes.slug })
      .from(wikiTypes)
      .where(eq(wikiTypes.slug, body.type))
      .limit(1)
    if (!typeRow) {
      return c.json(
        {
          error: 'Validation failed',
          fields: { fieldErrors: { type: [`unknown wiki type "${body.type}"`] } },
        },
        400
      )
    }
  }

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
  // Document-structure override (#244). Sibling of `prompt`; same PENDING
  // semantics on change so the next regen rebuilds against the new skeleton.
  if (body.structure != null) {
    updates.structure = body.structure
    if (body.structure !== existing.structure) updates.state = 'PENDING'
  }
  // T4-bundle (v0.2.2): autoregen flag now editable via the unified PUT body.
  if (body.autoregen != null) updates.autoregen = body.autoregen

  // Self-heal: name/description feed the embedded text used for
  // backward classification, so a change to either invalidates the
  // stored vector. Null the embedding; the next regen run (or any
  // future heal pass) will refill it. (#246)
  const nameChanged = body.name != null && body.name !== existing.name
  const descriptionChanged =
    body.description != null && body.description !== existing.description
  if (nameChanged || descriptionChanged) {
    updates.embedding = null
  }

  // Stream V (migration 0015): record the most recent editing surface
  // on the wiki row. Web-UI edits stamp 'web' so audit consumers can
  // tell the row was last touched through the HTTP route, not MCP.
  updates.sourceClient = 'web'

  const [updated] = await db
    .update(wikis)
    .set(updates)
    .where(eq(wikis.lookupKey, id))
    .returning()

  // Refresh the agent_schema rows when the description changes so hybrid
  // search keeps using a representation that matches the current text.
  // The description-kind row gets re-embedded synchronously (cheap, one
  // embedding call) and upserted in place. The hyde_synthetic row, which
  // grounds itself on the description, gets deleted; the heal worker
  // re-creates it on the next tick. We do not run the LLM HyDE call here
  // because PUT is a request-path handler and a 3 to 8s LLM round-trip is
  // unacceptable latency.
  if (descriptionChanged) {
    try {
      const orConfig = await loadOpenRouterConfig()
      const newDescription = updated.description ?? ''
      if (newDescription.trim().length > 0) {
        const descVec = await embedText(newDescription, {
          apiKey: orConfig.apiKey,
          model: orConfig.models.embedding,
        })
        if (descVec) {
          await upsertDescriptionAgentSchemaRow(db, id, newDescription, descVec)
        } else {
          log.warn(
            { wikiKey: id },
            'description embed returned null on edit, heal worker will retry'
          )
        }
      }
      await deleteHydeAgentSchemaRow(db, id)
    } catch (err) {
      log.warn(
        { wikiKey: id, err },
        'failed to refresh agent_schema rows on description edit, heal worker will retry'
      )
    }
  }

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

// POST /wikis/:id/publish — delegates to services/publish so MCP and HTTP
// share one code path (Stream I Phase 4).
wikisRouter.post('/:id/publish', async (c) => {
  const id = c.req.param('id')
  const origin = (() => {
    try {
      return new URL(c.req.url).origin
    } catch {
      return process.env.SERVER_PUBLIC_URL ?? null
    }
  })()

  const result = await publishWikiService(db, id, { origin, source: 'api' })
  if (result.ok === false) {
    if (result.error === 'not-found') return c.json({ error: 'Not found' }, 404)
    return c.json({ error: 'Cannot publish a wiki with no content' }, 400)
  }
  return c.json(publishWikiResponseSchema.parse(result.wiki))
})

// POST /wikis/:id/unpublish — delegates to services/publish (Stream I Phase 4).
wikisRouter.post('/:id/unpublish', async (c) => {
  const id = c.req.param('id')
  const result = await unpublishWikiService(db, id, { source: 'api' })
  if (result.ok === false) {
    if (result.error === 'not-found') return c.json({ error: 'Not found' }, 404)
    return c.json({ error: 'Unpublish failed' }, 500)
  }
  return c.json(publishWikiResponseSchema.parse(result.wiki))
})

// POST /wikis/:id/regenerate — on-demand wiki regen, serialized via wikiRegenLock (#audit-M5)
//
// T4-bundle (v0.2.2): on-demand regen is no longer gated by a per-wiki
// regenerate flag. The autoregen flag governs the batch worker only;
// explicit POSTs always run.
wikisRouter.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  // wikiRegenLock keys on lookup_key. Concurrent calls produce one 200 + one
  // 409. successState/failureState both return the wiki to PENDING so the
  // next regen can acquire. TTL-based stolen-lock recovery (90s) takes over
  // a stale lock after a crashed regen.
  const lockedBy = `regen-${id}-${crypto.randomUUID()}`
  let result: Awaited<ReturnType<typeof regenerateWiki>> | null = null

  try {
    await wikiRegenLock.using(
      {
        key: id,
        fromState: 'PENDING',
        toState: 'LINKING',
        successState: 'PENDING',
        failureState: 'PENDING',
        lockedBy,
        autoRenew: true,
      },
      async () => {
        result = await regenerateWiki(db, id)
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('CasLock contended')) {
      return c.json({ error: 'Regeneration already in progress' }, 409)
    }
    if (err instanceof NoOpenRouterKeyError) {
      return c.json({ error: 'OpenRouter API key not configured' }, 500)
    }
    log.error({ wikiKey: id, error: message }, 'wiki regen failed')
    return c.json({ error: 'Regeneration failed', detail: message }, 500)
  }

  if (!result) {
    log.error({ wikiKey: id }, 'wiki regen completed without result')
    return c.json({ error: 'Regeneration failed', detail: 'no result' }, 500)
  }

  // TS sees `result` as never inside the closure due to control-flow analysis;
  // rebind to a local with the correct type for the rest of the handler.
  const regenResult: Awaited<ReturnType<typeof regenerateWiki>> = result
  log.info({ wikiKey: id, ...regenResult }, 'wiki regenerated via on-demand endpoint')
  if (regenResult.timing) {
    const t = regenResult.timing
    c.header('Server-Timing', `classify;dur=${t.classify}, gather;dur=${t.gatherFragments}, llm;dur=${t.llmCall}, embed;dur=${t.embed}, total;dur=${t.total}`)
  }
  return c.json({ ok: true, lookupKey: id, fragmentCount: regenResult.fragmentCount })
})

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

// DELETE /wikis/:id/fragments/:fragmentId — un-attach a fragment from a wiki
//
// Stream E2: the wiki page surfaces a member-fragments table; the user clicks
// "un-attach" on a row; the server soft-deletes the FRAGMENT_IN_WIKI edge.
// The fragment row itself is untouched — it lives on as an unattached atom
// per the A-game brief.
//
// Composes with E1: on the next regen, the partition picks up this edge as
// REMOVED (deleted_at > last_rebuilt_at) and Quill writes the deletion into
// the body.
//
// This endpoint is bouncer-mode-agnostic. The existing
// POST /fragments/:id/reject is review-mode-only (see fragments.ts:461). For
// auto-mode wikis, this is the un-attach path.
wikisRouter.delete('/:id/fragments/:fragmentId', async (c) => {
  const id = c.req.param('id')
  const fragmentId = c.req.param('fragmentId')

  const [wiki] = await db
    .select()
    .from(wikis)
    .where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!wiki) return c.json({ error: 'Wiki not found' }, 404)

  const [edge] = await db
    .select()
    .from(edges)
    .where(
      and(
        eq(edges.srcId, fragmentId),
        eq(edges.dstId, id),
        eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
        isNull(edges.deletedAt)
      )
    )
    .limit(1)
  if (!edge) return c.json({ error: 'No active edge between fragment and wiki' }, 404)

  const now = new Date()
  await db
    .update(edges)
    .set({ deletedAt: now })
    .where(eq(edges.id, edge.id))

  // T4-bundle (v0.2.2): an un-attach is a partition mutation, stamp dirty_since
  // so editorialStateOf returns 'learning'. Skip when state is LINKING (dreaming),
  // the regen completion will clear dirty_since for us.
  await db
    .update(wikis)
    .set({ dirtySince: now })
    .where(and(eq(wikis.lookupKey, id), ne(wikis.state, 'LINKING')))

  await emitAuditEvent(db, {
    entityType: 'wiki',
    entityId: id,
    eventType: 'fragment_unattached',
    source: 'api',
    summary: `Fragment un-attached from ${wiki.name}`,
    detail: { wikiKey: id, fragmentKey: fragmentId, wikiName: wiki.name },
  })

  return c.json({ ok: true, wikiId: id, fragmentId })
})

// PATCH /wikis/:id/auto-regen — toggle autoregen boolean (Stream E5; #259)
//
// Wiki-level opt-in for the midnight cron. Profile-level default lives in the
// configs table under the autoregen-default kind and is consulted at wiki
// creation time. Default is false, the feature is opt-in per Andrew lock.
//
// T4-bundle (v0.2.2): autoregen is the sole regen gate (regenerate dropped),
// and the column is one word to match migration 0014.
wikisRouter.patch(
  '/:id/auto-regen',
  zValidator('json', autoRegenBodySchema, validationHook),
  async (c) => {
    const id = c.req.param('id')
    const { autoregen } = c.req.valid('json')

    const [wiki] = await db.select().from(wikis).where(eq(wikis.lookupKey, id))
    if (!wiki) return c.json({ error: 'Not found' }, 404)

    await db
      .update(wikis)
      .set({ autoregen, updatedAt: new Date() })
      .where(eq(wikis.lookupKey, id))

    await emitAuditEvent(db, {
      entityType: 'wiki',
      entityId: id,
      eventType: 'edited',
      source: 'api',
      summary: `Wiki autoregen set to ${autoregen}`,
      detail: { wikiKey: id, changedFields: ['autoregen'] },
    })

    return c.json({ id, autoregen })
  }
)

// DELETE /wikis/:id — soft delete
wikisRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  await db
    .update(wikis)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(wikis.lookupKey, id))

  // Cascade: soft-delete every edge that references this wiki on
  // either side. Without this the graph keeps zombie nodes alive
  // and the classifier can route fresh fragments through stale
  // FRAGMENT_IN_WIKI edges. Mirrors the read-side soft-delete
  // contract used everywhere else in the codebase.
  await db
    .update(edges)
    .set({ deletedAt: now })
    .where(
      and(
        isNull(edges.deletedAt),
        sql`(${edges.srcId} = ${id} OR ${edges.dstId} = ${id})`,
      ),
    )

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
