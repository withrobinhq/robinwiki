import { Hono } from 'hono'
import { eq, and, desc, isNull, inArray, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { makeLookupKey, generateSlug } from '@robin/shared'
import { resolveFragmentSlug } from '../db/slug.js'
import { computeContentHash, findDuplicateFragment } from '../db/dedup.js'
import { applyFragmentTitleDatePrefix } from '../lib/fragmentTitlePrefix.js'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { fragments, entries, edges, wikis, people, edits, auditLog } from '../db/schema.js'
import { nanoid } from '../lib/id.js'
import { producer } from '../queue/producer.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import { handleLogFragment } from '../mcp/handlers.js'
import type { McpServerDeps } from '../mcp/handlers.js'
import {
  fragmentResponseSchema,
  fragmentWithContentResponseSchema,
  fragmentDetailResponseSchema,
  fragmentListResponseSchema,
  createFragmentBodySchema,
  updateFragmentBodySchema,
  fragmentListQuerySchema,
  fragmentReviewBodySchema,
  logFragmentBodySchema,
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
    const relatedKeys = [...relatedKeySet]
    const relatedRows = await db
      .select({ lookupKey: fragments.lookupKey, slug: fragments.slug, title: fragments.title })
      .from(fragments)
      .where(and(inArray(fragments.lookupKey, relatedKeys), isNull(fragments.deletedAt)))

    // #262 — terminal-wiki check. A related fragment may itself be live
    // but only sit inside a soft-deleted wiki; surfacing it lets the
    // user navigate from a live fragment into ghost content. Keep
    // only fragments with at least one live FRAGMENT_IN_WIKI edge
    // pointing at a live (non-soft-deleted) wiki.
    const liveTerminalRows = await db
      .select({ srcId: edges.srcId })
      .from(edges)
      .innerJoin(wikis, eq(wikis.lookupKey, edges.dstId))
      .where(
        and(
          eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
          isNull(edges.deletedAt),
          isNull(wikis.deletedAt),
          inArray(edges.srcId, relatedKeys),
        ),
      )
    const liveTerminal = new Set(liveTerminalRows.map((r) => r.srcId))

    for (const r of relatedRows) {
      if (!liveTerminal.has(r.lookupKey)) continue
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

// POST /fragments/log — #235 direct-to-wiki capture (bypasses classifier).
// Mirrors the MCP `log_fragment` tool: persist a fragment straight to a
// known wiki by slug. Skips the AI extraction pipeline so user-confirmed
// destinations aren't second-guessed.
fragmentsRouter.post(
  '/log',
  zValidator('json', logFragmentBodySchema, validationHook),
  async (c) => {
    const body = c.req.valid('json')
    const userId = c.get('userId') as string | undefined

    const deps: McpServerDeps = {
      db,
      producer,
      spawnWriteWorker: () => {},
      // Web direct-send mirrors the MCP wiring (no entity extraction).
      // The classifier-bypass is the whole point — keep this fail-open.
      entityExtractCall: async () => ({ matched: [], candidates: [] }),
      loadUserPeople: async () => [],
    }

    // Body is validated by Zod above (content + threadSlug both `min(1)`),
    // but core's tsconfig has `strict: false` which weakens Zod's narrowing
    // on optional vs required. Cast to the handler's signature explicitly.
    // Stream C / C2: HTTP path is the web UI route; tag clientInfo as
    // `{name: 'web'}` so the fragment audit_log detail mirrors the
    // entries.source_client shape.
    const result = await handleLogFragment(
      deps,
      {
        ...(body as {
          content: string
          threadSlug: string
          title?: string
          tags?: string[]
        }),
        sourceClient: { name: 'web' },
      },
      userId
    )
    if (result.isError) {
      const text =
        result.content.find((p) => p.type === 'text')?.text ?? 'log_fragment failed'
      return c.json({ error: text.replace(/^Error:\s*/, '') }, 400)
    }

    const text = result.content.find((p) => p.type === 'text')?.text ?? '{}'
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return c.json({ ok: true, raw: text })
    }
    return c.json(parsed, 201)
  }
)

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
  // #239 — prepend UTC YYMMDD to the title at the only fragment-create
  // site that lives in this route. No-op when the title already opens
  // with a date-shaped prefix.
  const prefixedTitle = applyFragmentTitleDatePrefix(title)
  const slug = await resolveFragmentSlug(db, generateSlug(prefixedTitle))

  const [fragment] = await db
    .insert(fragments)
    .values({
      lookupKey: fragKey,
      slug,
      entryId,
      title: prefixedTitle,
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

  // Self-heal: if title or content changed, the embedded text is now stale.
  // Null the embedding + reset retry bookkeeping so the embedding-retry
  // worker (15-min cadence) refills it on the next tick (#246).
  if (body.title != null || body.content != null) {
    updates.embedding = null
    updates.embeddingAttemptCount = 0
    updates.embeddingLastAttemptAt = null
  }

  const [fragment] = await db
    .update(fragments)
    .set(updates)
    .where(eq(fragments.lookupKey, id))
    .returning()

  // D1' — emit an edit-history snapshot when content changed. The Stream A5
  // GET /fragments/:id/history endpoint and Stream F4's evolution timeline
  // both read from this table; without a row per PUT the visual is blank.
  // Title-only edits don't snapshot — there's no diffable content delta to
  // show on the timeline. Failure here is non-fatal: the fragment is already
  // updated above and the audit row below still surfaces the edit.
  let editId: string | null = null
  if (body.content != null && body.content !== existing.content) {
    editId = nanoid()
    try {
      await db.insert(edits).values({
        id: editId,
        objectType: 'fragment',
        objectId: id,
        type: 'edit',
        content: existing.content ?? '',
        contentBefore: existing.content ?? '',
        contentAfter: body.content,
        source: 'api',
        diff: '',
      })
    } catch (err) {
      log.warn({ fragmentKey: id, err }, 'failed to insert fragment edit snapshot')
      editId = null
    }
  }

  await emitAuditEvent(db, {
    entityType: 'fragment',
    entityId: id,
    eventType: 'fragment.updated',
    source: 'api',
    summary: 'Fragment updated',
    detail: {
      fragmentKey: id,
      changedFields: Object.keys(updates).filter((k) => k !== 'updatedAt'),
      editId,
    },
  })

  return c.json(fragmentResponseSchema.parse({ ...fragment, id: fragment.lookupKey }))
})

// DELETE /fragments/:id — soft-delete the fragment and cascade-soft-delete
// every edge that references it in either direction. Mirrors the pattern at
// core/src/routes/wikis.ts:715-739 (lookup → 404 if missing → soft-delete row
// + cascade joins → audit emit → 204 no body).
fragmentsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [fragment] = await db
    .select()
    .from(fragments)
    .where(and(eq(fragments.lookupKey, id), isNull(fragments.deletedAt)))
  if (!fragment) return c.json({ error: 'Not found' }, 404)

  const now = new Date()

  await db
    .update(fragments)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(fragments.lookupKey, id))

  // Cascade: soft-delete every active edge that references the fragment in
  // either direction. Covers FRAGMENT_IN_WIKI, FRAGMENT_RELATED_TO_FRAGMENT
  // (both src and dst), FRAGMENT_MENTIONS_PERSON, ENTRY_HAS_FRAGMENT — i.e.
  // any edge type whose row mentions this lookup_key.
  await db
    .update(edges)
    .set({ deletedAt: now })
    .where(
      and(
        isNull(edges.deletedAt),
        sql`(${edges.srcId} = ${id} OR ${edges.dstId} = ${id})`
      )
    )

  await emitAuditEvent(db, {
    entityType: 'fragment',
    entityId: id,
    eventType: 'deleted',
    source: 'api',
    summary: `Fragment deleted: ${fragment.title}`,
    detail: { fragmentKey: id, fragmentSlug: fragment.slug },
  })

  return c.body(null, 204)
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


    // Queue wiki regen so the accepted fragment's content is incorporated into the wiki body.
    // Failure here is silent to the user (the fragment is already accepted) but we must
    // surface it via an audit row so downstream observability can detect stuck wikis (#271).
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
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ wikiKey: wikiId, err }, 'failed to enqueue regen after fragment acceptance')
      await emitAuditEvent(db, {
        entityType: 'wiki',
        entityId: wikiId,
        eventType: 'regen_enqueue_failed',
        source: 'api',
        summary: `Regen enqueue failed after fragment acceptance: ${message}`,
        detail: { error: message, reason: 'acceptance', fragmentKey: id },
      })
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

  // Queue wiki regen so the rejected fragment's content is removed from the wiki body.
  // Stale-content risk: if this enqueue silently fails the wiki keeps showing content
  // sourced from the rejected fragment — surface via audit row (#272). Tagged
  // reason=rejection in payload to distinguish from #271's acceptance path.
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
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ wikiKey: wikiId, err }, 'failed to enqueue regen after fragment rejection')
    await emitAuditEvent(db, {
      entityType: 'wiki',
      entityId: wikiId,
      eventType: 'regen_enqueue_failed',
      source: 'api',
      summary: `Regen enqueue failed after fragment rejection: ${message}`,
      detail: { error: message, reason: 'rejection', fragmentKey: id },
    })
  }

  return c.json({ ok: true, fragmentId: id, wikiId })
})

// ── GET /fragments/:id/history ─────────────────────────────────────────────
//
// Phase A5 — read side of the fragment evolution surface (Stream F4
// renders this on the fragment detail page). Returns:
//   - edits: rows from the `edits` table where object_type='fragment'
//     and object_id=:id, ordered by editedAt desc
//   - auditEvents: audit_log rows for the same fragment (entity_type
//     ='fragment', entity_id=:id) so the timeline carries the
//     classification / acceptance / deletion events alongside content
//     edits
//
// The write side (creating `edits` rows on PUT /fragments/:id) is
// owned by Stream D1' and lands later. Until that ships this endpoint
// returns an empty `edits` array gracefully, the audit_log block still
// renders the lifecycle events that already get written today
// (created / classified / accepted / rejected / deleted).
//
// Auth: standard session via the router-wide sessionMiddleware. Single
// tenant means "operator-only" is the same as "session-authenticated".
fragmentsRouter.get('/:id/history', async (c) => {
  const id = c.req.param('id')

  // Verify the fragment exists; return 404 otherwise so the client
  // does not render a timeline for a phantom row.
  const [fragment] = await db
    .select({ lookupKey: fragments.lookupKey })
    .from(fragments)
    .where(eq(fragments.lookupKey, id))
    .limit(1)
  if (!fragment) return c.json({ error: 'Fragment not found' }, 404)

  // Pagination: cursor by editedAt desc. Plan asks for >50 rows to be
  // rare but cheap to support; we accept ?cursor=<iso> and ?limit=
  // (clamped 1..200, default 50).
  const rawLimit = Number(c.req.query('limit') ?? '50')
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50))
  const cursorIso = c.req.query('cursor')
  const cursorDate = cursorIso ? new Date(cursorIso) : null

  // edits table read. cursorDate restricts to rows strictly older than
  // the cursor so the next page lines up without duplicate boundary
  // rows. When the cursor is invalid (NaN) we just ignore it; the
  // first page is the intended fallback.
  const editRows = await db
    .select({
      id: edits.id,
      type: edits.type,
      content: edits.content,
      source: edits.source,
      diff: edits.diff,
      editedAt: edits.timestamp,
    })
    .from(edits)
    .where(
      and(
        eq(edits.objectType, 'fragment'),
        eq(edits.objectId, id),
        cursorDate && !Number.isNaN(cursorDate.getTime())
          ? sql`${edits.timestamp} < ${cursorDate.toISOString()}`
          : sql`true`,
      ),
    )
    .orderBy(desc(edits.timestamp))
    .limit(limit)

  // audit_log read. Only the rows whose entity_type/entity_id matches;
  // we deliberately do NOT pull in detail.fragmentKey-shaped rows
  // because that scan requires JSONB containment over the full audit
  // table and the volume does not justify it for the timeline view.
  // Entries whose detail block carries a fragmentKey are surfaced via
  // /admin/diagnose, not this endpoint.
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'fragment'),
        eq(auditLog.entityId, id),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)

  return c.json({
    fragmentId: id,
    edits: editRows.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      source: r.source,
      diff: r.diff,
      editedAt: r.editedAt.toISOString(),
    })),
    auditEvents: auditRows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor:
      editRows.length === limit
        ? editRows[editRows.length - 1].editedAt.toISOString()
        : null,
  })
})

export { fragmentsRouter as fragmentsRoutes }
