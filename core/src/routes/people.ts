import { Hono } from 'hono'
import { eq, and, isNull, inArray, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { generateSlug, makeLookupKey } from '@robin/shared'
import { sessionMiddleware } from '../middleware/session.js'
import { resolveOrgMiddleware, checkPermissionMiddleware } from '../middleware/hooks.js'
import { db } from '../db/client.js'
import { people, edges, fragments, wikis } from '../db/schema.js'
import { resolvePersonSlug } from '../db/slug.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import { buildSidecar } from '../lib/wikiSidecar.js'
import { makeSidecarDeps } from '../lib/wikiSidecarDeps.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { embedText } from '@robin/agent'
import type { WikiInfobox } from '@robin/shared/schemas/sidecar'
import {
  personDetailResponseSchema,
  personListResponseSchema,
  updatePersonBodySchema,
  createPersonBodySchema,
  mergePersonBodySchema,
  personListQuerySchema,
} from '../schemas/people.schema.js'
import { emitAuditEvent } from '../db/audit.js'

const log = logger.child({ component: 'people' })

/**
 * Build a server-derived infobox from a person row + mention count. The
 * contract pins this to read-time computation so it survives person edits
 * without needing a regeneration pass. Returns null when every row is empty.
 */
function derivePersonInfobox(
  person: typeof people.$inferSelect,
  mentionCount: number
): WikiInfobox | null {
  const firstMentionDate = person.createdAt instanceof Date
    ? person.createdAt.toISOString().slice(0, 10)
    : ''
  const rows = [
    { label: 'Relationship', value: person.relationship, valueKind: 'text' as const },
    { label: 'Aliases', value: person.aliases.join(', '), valueKind: 'text' as const },
    { label: 'First mentioned', value: firstMentionDate, valueKind: 'date' as const },
    {
      label: 'Mentions',
      value: mentionCount > 0 ? String(mentionCount) : '',
      valueKind: 'text' as const,
    },
  ].filter((r) => r.value && r.value !== '0')
  if (rows.length === 0) return null
  return { rows }
}

const peopleRouter = new Hono()
peopleRouter.use('*', sessionMiddleware)
peopleRouter.use('*', resolveOrgMiddleware)
peopleRouter.use('*', checkPermissionMiddleware)

// GET /people — list all people with pagination
peopleRouter.get('/', async (c) => {
  const query = personListQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const limit = query.success ? query.data.limit : 50
  const offset = query.success ? query.data.offset : 0

  // Stream P quarantine: GET /people defaults to status='verified'.
  // Pass ?status=pending to load the triage queue, ?status=all to
  // see every row regardless of status (used by admin tooling).
  const statusFilter = c.req.query('status') ?? 'verified'
  const where =
    statusFilter === 'all'
      ? isNull(people.deletedAt)
      : statusFilter === 'pending'
        ? and(isNull(people.deletedAt), sql`${people.status} = 'pending'`)
        : statusFilter === 'rejected'
          ? and(isNull(people.deletedAt), sql`${people.status} = 'rejected'`)
          : and(isNull(people.deletedAt), sql`${people.status} = 'verified'`)

  const rows = await db
    .select()
    .from(people)
    .where(where)
    .orderBy(people.name)
    .limit(limit)
    .offset(offset)

  return c.json(
    personListResponseSchema.parse({
      people: rows.map((r) => ({
        ...r,
        id: r.lookupKey,
        status: (r as unknown as { status?: string }).status ?? 'verified',
      })),
    })
  )
})

// POST /people — manual create (#234). Bypasses AI extraction; the row lands
// verified=true / state=RESOLVED so the matcher treats it as a canonical
// anchor. Returns 409 on duplicate canonical name (case-insensitive).
peopleRouter.post('/', zValidator('json', createPersonBodySchema, validationHook), async (c) => {
  const body = c.req.valid('json')
  const trimmedName = body.name.trim()
  if (!trimmedName) return c.json({ error: 'name is required' }, 400)

  const lowered = trimmedName.toLowerCase()
  const [collision] = await db
    .select({ key: people.lookupKey })
    .from(people)
    .where(and(sql`lower(${people.name}) = ${lowered}`, isNull(people.deletedAt)))
    .limit(1)
  if (collision) {
    return c.json({ error: `Person "${trimmedName}" already exists` }, 409)
  }

  const lookupKey = makeLookupKey('person')
  const slug = await resolvePersonSlug(db, generateSlug(trimmedName))

  const [created] = await db
    .insert(people)
    .values({
      lookupKey,
      slug,
      name: trimmedName,
      canonicalName: trimmedName,
      relationship: body.relationship ?? '',
      aliases: body.aliases ?? [],
      verified: true,
      state: 'RESOLVED',
    })
    .returning()

  // Embed the person at create time. Without this, manually-created people
  // sit unembedded until the retry worker heals them. Embed text combines
  // the canonical name + aliases + relationship — the same dimensions vector
  // search would compare against. Falls through silently on failure.
  try {
    const embedSource = [trimmedName, ...(body.aliases ?? []), body.relationship ?? '']
      .filter((s) => s && s.length > 0)
      .join(' ')
    const orConfig = await loadOpenRouterConfig()
    const vec = await embedText(embedSource, {
      apiKey: orConfig.apiKey,
      model: orConfig.models.embedding,
    })
    if (vec) {
      await db
        .update(people)
        .set({ embedding: vec })
        .where(eq(people.lookupKey, lookupKey))
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), personKey: lookupKey },
      'create-person embedding failed — row inserted without embedding'
    )
  }

  await emitAuditEvent(db, {
    entityType: 'person',
    entityId: lookupKey,
    eventType: 'created',
    source: 'api',
    summary: `Person created (manual): ${trimmedName}`,
    detail: { personKey: lookupKey, manual: true },
  })

  return c.json(
    {
      ...created,
      id: created.lookupKey,
      content: created.content ?? '',
      backlinks: [] as Array<{ id: string; title: string }>,
      wikis: [] as Array<unknown>,
    },
    201
  )
})

// GET /people/:id — detail with content and backlinks (fragments mentioning this person)
peopleRouter.get('/:id', async (c) => {
  const id = c.req.param('id')

  const [person] = await db.select().from(people).where(and(eq(people.lookupKey, id), isNull(people.deletedAt)))
  if (!person) return c.json({ error: 'Not found' }, 404)

  // Query backlinks: edges where dstId = this person and edgeType = FRAGMENT_MENTIONS_PERSON
  const mentionEdges = await db
    .select()
    .from(edges)
    .where(
      and(
        eq(edges.dstId, id),
        eq(edges.edgeType, 'FRAGMENT_MENTIONS_PERSON'),
        isNull(edges.deletedAt)
      )
    )

  const backlinks: { id: string; title: string }[] = []
  const srcIds = mentionEdges.map((e) => e.srcId)
  if (srcIds.length) {
    const rows = await db
      .select({ key: fragments.lookupKey, title: fragments.title })
      .from(fragments)
      .where(inArray(fragments.lookupKey, srcIds))
    for (const r of rows) backlinks.push({ id: r.key, title: r.title })
  }

  // Linked wikis: fragments mentioning this person -> FRAGMENT_IN_WIKI edges -> wikis
  const wikiEdges = srcIds.length > 0
    ? await db
        .select({ dstId: edges.dstId })
        .from(edges)
        .where(and(
          inArray(edges.srcId, srcIds),
          eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
          isNull(edges.deletedAt)
        ))
    : []

  // Count fragments per wiki
  const wikiFragCount = new Map<string, number>()
  for (const e of wikiEdges) {
    wikiFragCount.set(e.dstId, (wikiFragCount.get(e.dstId) ?? 0) + 1)
  }
  const wikiKeys = [...wikiFragCount.keys()]

  const wikiRows = wikiKeys.length > 0
    ? await db
        .select({
          lookupKey: wikis.lookupKey,
          name: wikis.name,
          slug: wikis.slug,
          type: wikis.type,
        })
        .from(wikis)
        .where(inArray(wikis.lookupKey, wikiKeys))
    : []

  const linkedWikis = wikiRows.map((w) => ({
    id: w.lookupKey,
    name: w.name,
    slug: w.slug,
    type: w.type,
    fragmentCount: wikiFragCount.get(w.lookupKey) ?? 0,
  }))

  const derivedInfobox = derivePersonInfobox(person, backlinks.length)
  const sidecar = await buildSidecar({
    content: person.content ?? '',
    metadata: null, // people table has no metadata column
    deps: makeSidecarDeps(db),
    derivedInfobox,
  })

  return c.json(
    personDetailResponseSchema.parse({
      ...person,
      id: person.lookupKey,
      content: person.content ?? '',
      backlinks,
      wikis: linkedWikis,
      refs: sidecar.refs,
      infobox: sidecar.infobox,
      sections: sidecar.sections,
    })
  )
})

// PUT /people/:id — update person
peopleRouter.put('/:id', zValidator('json', updatePersonBodySchema, validationHook), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db.select().from(people).where(eq(people.lookupKey, id))
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name != null) updates.name = body.name
  if (body.relationship != null) updates.relationship = body.relationship
  if (body.aliases != null) updates.aliases = body.aliases
  if (body.content != null) updates.content = body.content

  // Self-heal: name + aliases feed the embedded text used for person
  // similarity / search, so a change to either invalidates the stored
  // vector. Null the embedding; a future heal pass refills it. (#246)
  const nameChanged = body.name != null && body.name !== existing.name
  const aliasesChanged =
    body.aliases != null &&
    JSON.stringify(body.aliases) !== JSON.stringify(existing.aliases ?? [])
  if (nameChanged || aliasesChanged) {
    updates.embedding = null
  }

  const [person] = await db
    .update(people)
    .set(updates)
    .where(eq(people.lookupKey, id))
    .returning()

  await emitAuditEvent(db, {
    entityType: 'person',
    entityId: id,
    eventType: 'edited',
    source: 'api',
    summary: `Person edited: ${person.name}`,
    detail: { personKey: id, changedFields: Object.keys(updates).filter(k => k !== 'updatedAt') },
  })

  // Sidecar is best-effort on PUT — no backlink recount, no citations.
  // Clients that need a fresh infobox/refs/sections should GET after edit.
  return c.json(
    personDetailResponseSchema.parse({
      ...person,
      id: person.lookupKey,
      content: person.content ?? '',
      backlinks: [],
    })
  )
})

// POST /people/:id/regenerate — manual person body regen
// TODO(M3): regen worker is dormant in M2. Restore when regen pipeline lands.
peopleRouter.post('/:id/regenerate', async (c) => {
  log.warn('person regen requested but disabled in M2')
  return c.json({ error: 'Person regen disabled in M2 — will be restored in M3' }, 503)
})


// POST /people/:id/merge — merge source person into a target person (#234).
// Steps:
//   1. Repoint FRAGMENT_MENTIONS_PERSON edges from source to target
//   2. Append source name + aliases into target.aliases (deduped, lower-trim)
//   3. Rewrite [[person:source-slug]] → [[person:target-slug]] in every
//      non-deleted wiki body so previously-rendered prose still resolves
//   4. Soft-delete the source row
//   5. Emit audit event with the alias delta
peopleRouter.post(
  '/:id/merge',
  zValidator('json', mergePersonBodySchema, validationHook),
  async (c) => {
    const sourceId = c.req.param('id')
    const { targetPersonId } = c.req.valid('json')

    if (sourceId === targetPersonId) {
      return c.json({ error: 'Cannot merge a person into themselves' }, 400)
    }

    const [source] = await db
      .select()
      .from(people)
      .where(and(eq(people.lookupKey, sourceId), isNull(people.deletedAt)))
    if (!source) return c.json({ error: 'Source person not found' }, 404)

    const [target] = await db
      .select()
      .from(people)
      .where(and(eq(people.lookupKey, targetPersonId), isNull(people.deletedAt)))
    if (!target) return c.json({ error: 'Target person not found' }, 404)

    // 1. Repoint FRAGMENT_MENTIONS_PERSON edges
    const repointed = await db
      .update(edges)
      .set({ dstId: targetPersonId })
      .where(
        and(
          eq(edges.dstId, sourceId),
          eq(edges.edgeType, 'FRAGMENT_MENTIONS_PERSON'),
          isNull(edges.deletedAt)
        )
      )
      .returning({ id: edges.id })

    // 2. Alias union — dedup case-insensitively, preserve target ordering.
    const seen = new Set<string>()
    const merged: string[] = []
    const push = (raw: string) => {
      const t = raw.trim()
      if (!t) return
      const k = t.toLowerCase()
      if (seen.has(k)) return
      seen.add(k)
      merged.push(t)
    }
    for (const a of target.aliases ?? []) push(a)
    for (const a of source.aliases ?? []) push(a)
    if (source.name) push(source.name)
    // Don't fold the target's own canonical name into its own aliases.
    const targetCanon = (target.canonicalName || target.name || '').trim().toLowerCase()
    const finalAliases = merged.filter((a) => a.trim().toLowerCase() !== targetCanon)

    await db
      .update(people)
      .set({ aliases: finalAliases, embedding: null, updatedAt: new Date() })
      .where(eq(people.lookupKey, targetPersonId))

    // 3. Rewrite [[person:source-slug]] in non-deleted wiki bodies
    let bodiesRewritten = 0
    if (source.slug && target.slug && source.slug !== target.slug) {
      const sourceToken = `[[person:${source.slug}]]`
      const targetToken = `[[person:${target.slug}]]`
      const updated = await db
        .update(wikis)
        .set({
          content: sql`replace(${wikis.content}, ${sourceToken}, ${targetToken})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            isNull(wikis.deletedAt),
            sql`${wikis.content} like ${`%${sourceToken}%`}`
          )
        )
        .returning({ id: wikis.lookupKey })
      bodiesRewritten = updated.length
    }

    // 4. Soft-delete source
    await db
      .update(people)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(people.lookupKey, sourceId))

    // 5. Audit
    await emitAuditEvent(db, {
      entityType: 'person',
      entityId: targetPersonId,
      eventType: 'merged',
      source: 'api',
      summary: `Person merged: ${source.name} → ${target.name}`,
      detail: {
        sourcePersonKey: sourceId,
        targetPersonKey: targetPersonId,
        edgesRepointed: repointed.length,
        bodiesRewritten,
        addedAliases: finalAliases.filter(
          (a) => !(target.aliases ?? []).some((b) => b.toLowerCase() === a.toLowerCase())
        ),
      },
    })

    return c.json({
      ok: true,
      sourcePersonId: sourceId,
      targetPersonId,
      edgesRepointed: repointed.length,
      bodiesRewritten,
      aliases: finalAliases,
    })
  }
)

// DELETE /people/:id — soft delete
peopleRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [person] = await db.select().from(people).where(and(eq(people.lookupKey, id), isNull(people.deletedAt)))
  if (!person) return c.json({ error: 'Not found' }, 404)

  await db
    .update(people)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(people.lookupKey, id))

  await emitAuditEvent(db, {
    entityType: 'person',
    entityId: id,
    eventType: 'deleted',
    source: 'api',
    summary: `Person deleted: ${person.name}`,
    detail: { personKey: id },
  })

  return c.body(null, 204)
})

export { peopleRouter as peopleRoutes }
