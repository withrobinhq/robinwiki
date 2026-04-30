import { Hono } from 'hono'
import { and, eq, or, isNull, inArray } from 'drizzle-orm'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { edges, entries, fragments, wikis, people } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { relationshipsResponseSchema } from '../schemas/relationships.schema.js'

const log = logger.child({ component: 'relationships' })

const VALID_TYPES = ['entry', 'fragment', 'wiki', 'person'] as const

const relationshipsRouter = new Hono()
relationshipsRouter.use('*', sessionMiddleware)

// GET /relationships/:type/:id — get all relationships for an object
relationshipsRouter.get('/:type/:id', async (c) => {
  const type = c.req.param('type')
  const id = c.req.param('id')

  if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
    return c.json({ error: `Invalid type: ${type}` }, 400)
  }

  // Query edges where this object is either src or dst
  const edgeRows = await db
    .select()
    .from(edges)
    .where(
      and(
        isNull(edges.deletedAt),
        or(
          and(eq(edges.srcType, type), eq(edges.srcId, id)),
          and(eq(edges.dstType, type), eq(edges.dstId, id))
        )
      )
    )

  if (edgeRows.length === 0) {
    return c.json({ relationships: {} })
  }

  // Determine the "other" side for each edge
  const others: Array<{ id: string; type: string; edgeType: string }> = edgeRows.map((e) => {
    const isSrc = e.srcType === type && e.srcId === id
    return {
      id: isSrc ? e.dstId : e.srcId,
      type: isSrc ? e.dstType : e.srcType,
      edgeType: e.edgeType,
    }
  })

  // Collect IDs by type for batch label resolution
  const idsByType: Record<string, Set<string>> = {}
  for (const o of others) {
    if (!idsByType[o.type]) idsByType[o.type] = new Set()
    idsByType[o.type].add(o.id)
  }

  // Batch-resolve labels
  const labelMap: Record<string, string> = {}

  if (idsByType.entry?.size) {
    const ids = [...idsByType.entry]
    const rows = await db
      .select({ key: entries.lookupKey, title: entries.title })
      .from(entries)
      .where(and(inArray(entries.lookupKey, ids), isNull(entries.deletedAt)))
    for (const r of rows) labelMap[`entry:${r.key}`] = r.title || 'Untitled Entry'
  }
  if (idsByType.fragment?.size) {
    const ids = [...idsByType.fragment]
    const rows = await db
      .select({ key: fragments.lookupKey, title: fragments.title })
      .from(fragments)
      .where(and(inArray(fragments.lookupKey, ids), isNull(fragments.deletedAt)))
    for (const r of rows) labelMap[`fragment:${r.key}`] = r.title || 'Untitled Fragment'
  }
  if (idsByType.wiki?.size) {
    const ids = [...idsByType.wiki]
    const rows = await db
      .select({ key: wikis.lookupKey, name: wikis.name })
      .from(wikis)
      .where(and(inArray(wikis.lookupKey, ids), isNull(wikis.deletedAt)))
    for (const r of rows) labelMap[`wiki:${r.key}`] = r.name
  }
  if (idsByType.person?.size) {
    const ids = [...idsByType.person]
    const rows = await db
      .select({ key: people.lookupKey, name: people.name })
      .from(people)
      .where(and(inArray(people.lookupKey, ids), isNull(people.deletedAt)))
    for (const r of rows) labelMap[`person:${r.key}`] = r.name
  }

  // Group by edgeType. Drop entries whose label resolution returned
  // nothing — those rows point at a soft-deleted (or otherwise
  // missing) entity and shouldn't ship as phantom relationships
  // with bare-id labels.
  const grouped: Record<
    string,
    Array<{ id: string; type: string; label: string; edgeType: string }>
  > = {}
  for (const o of others) {
    const label = labelMap[`${o.type}:${o.id}`]
    if (!label) continue
    if (!grouped[o.edgeType]) grouped[o.edgeType] = []
    grouped[o.edgeType].push({
      id: o.id,
      type: o.type,
      label,
      edgeType: o.edgeType,
    })
  }

  log.debug({ type, id, edgeCount: edgeRows.length }, 'fetched relationships')
  return c.json(relationshipsResponseSchema.parse({ relationships: grouped }))
})

export { relationshipsRouter as relationshipsRoutes }
