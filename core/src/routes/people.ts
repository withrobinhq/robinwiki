import { Hono } from 'hono'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { people, edges, fragments, wikis } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import { buildSidecar } from '../lib/wikiSidecar.js'
import { makeSidecarDeps } from '../lib/wikiSidecarDeps.js'
import type { WikiInfobox } from '@robin/shared/schemas/sidecar'
import {
  personDetailResponseSchema,
  personListResponseSchema,
  updatePersonBodySchema,
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

// GET /people — list all people with pagination
peopleRouter.get('/', async (c) => {
  const query = personListQuerySchema.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  const limit = query.success ? query.data.limit : 50
  const offset = query.success ? query.data.offset : 0

  const rows = await db
    .select()
    .from(people)
    .where(isNull(people.deletedAt))
    .orderBy(people.name)
    .limit(limit)
    .offset(offset)

  return c.json(
    personListResponseSchema.parse({ people: rows.map((r) => ({ ...r, id: r.lookupKey })) })
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
