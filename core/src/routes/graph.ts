import { Hono } from 'hono'
import { and, isNull, inArray } from 'drizzle-orm'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { edges, entries, fragments, wikis, people } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { graphResponseSchema } from '../schemas/graph.schema.js'

const log = logger.child({ component: 'graph' })

const EDGE_TYPE_MAP: Record<string, string> = {
  ENTRY_HAS_FRAGMENT: 'filing',
  FRAGMENT_IN_WIKI: 'filing',
  FRAGMENT_MENTIONS_PERSON: 'mention',
  FRAGMENT_RELATED_TO_FRAGMENT: 'wikilink',
  WIKI_RELATED_TO_WIKI: 'wikilink',
}

// DB stores "frag" → API "fragment"; "raw_source" (the table name after
// 0001_taxonomy_rename) → API "entry". The API-facing set is enumerated
// by graphNodeSchema.type; any other literal passes through unchanged and
// will be rejected downstream — which is the desired loud-fail behaviour
// for unknown DB types rather than a silent 500.
export function normalizeNodeType(t: string): string {
  if (t === 'frag') return 'fragment'
  if (t === 'raw_source') return 'entry'
  return t
}

const graphRouter = new Hono()
graphRouter.use('*', sessionMiddleware)

// GET /graph — build graph nodes and edges from the edges table
graphRouter.get('/', async (c) => {
  const wikiId = c.req.query('wikiId')

  // 1. Query all edges
  let edgeRows = await db.select().from(edges).where(isNull(edges.deletedAt))

  // 2. If wikiId filter, return only subgraph for that wiki (its fragments + their people)
  if (wikiId) {
    const wikiFragEdges = edgeRows.filter(
      (e) => e.edgeType === 'FRAGMENT_IN_WIKI' && e.dstId === wikiId
    )
    const fragIds = new Set(wikiFragEdges.map((e) => e.srcId))

    edgeRows = edgeRows.filter(
      (e) =>
        (e.edgeType === 'FRAGMENT_IN_WIKI' && e.dstId === wikiId) ||
        (fragIds.has(e.srcId) && e.srcId !== wikiId)
    )
  }

  if (edgeRows.length === 0) {
    return c.json({ nodes: [], edges: [] })
  }

  // 3. Collect unique node identifiers.
  const nodeSet = new Map<string, { type: string; id: string; edgeCount: number }>()
  for (const e of edgeRows) {
    const srcType = normalizeNodeType(e.srcType)
    const dstType = normalizeNodeType(e.dstType)
    const srcKey = `${srcType}:${e.srcId}`
    const dstKey = `${dstType}:${e.dstId}`
    if (!nodeSet.has(srcKey)) nodeSet.set(srcKey, { type: srcType, id: e.srcId, edgeCount: 0 })
    if (!nodeSet.has(dstKey)) nodeSet.set(dstKey, { type: dstType, id: e.dstId, edgeCount: 0 })
    const srcNode = nodeSet.get(srcKey)
    if (srcNode) srcNode.edgeCount++
    const dstNode = nodeSet.get(dstKey)
    if (dstNode) dstNode.edgeCount++
  }

  // 4. Batch-resolve labels
  const idsByType: Record<string, string[]> = {}
  for (const n of nodeSet.values()) {
    if (!idsByType[n.type]) idsByType[n.type] = []
    idsByType[n.type].push(n.id)
  }

  const labelMap: Record<string, { label: string; snippet: string }> = {}

  if (idsByType.entry?.length) {
    const rows = await db
      .select({
        key: entries.lookupKey,
        title: entries.title,
        content: entries.content,
      })
      .from(entries)
      .where(and(inArray(entries.lookupKey, idsByType.entry), isNull(entries.deletedAt)))
    for (const r of rows)
      labelMap[`entry:${r.key}`] = {
        label: r.title || 'Untitled Entry',
        snippet: (r.content ?? '').slice(0, 100),
      }
  }
  if (idsByType.fragment?.length) {
    const rows = await db
      .select({
        key: fragments.lookupKey,
        title: fragments.title,
        content: fragments.content,
      })
      .from(fragments)
      .where(and(inArray(fragments.lookupKey, idsByType.fragment), isNull(fragments.deletedAt)))
    for (const r of rows)
      labelMap[`fragment:${r.key}`] = {
        label: r.title || 'Untitled Fragment',
        snippet: (r.content ?? '').slice(0, 100),
      }
  }
  if (idsByType.thread?.length) {
    const rows = await db
      .select({ key: wikis.lookupKey, name: wikis.name, content: wikis.content })
      .from(wikis)
      .where(and(inArray(wikis.lookupKey, idsByType.thread), isNull(wikis.deletedAt)))
    for (const r of rows)
      labelMap[`thread:${r.key}`] = {
        label: r.name,
        snippet: (r.content ?? '').slice(0, 100),
      }
  }
  if (idsByType.wiki?.length) {
    const rows = await db
      .select({ key: wikis.lookupKey, name: wikis.name, content: wikis.content })
      .from(wikis)
      .where(and(inArray(wikis.lookupKey, idsByType.wiki), isNull(wikis.deletedAt)))
    for (const r of rows)
      labelMap[`wiki:${r.key}`] = {
        label: r.name,
        snippet: (r.content ?? '').slice(0, 100),
      }
  }
  if (idsByType.person?.length) {
    const rows = await db
      .select({ key: people.lookupKey, name: people.name, content: people.content })
      .from(people)
      .where(and(inArray(people.lookupKey, idsByType.person), isNull(people.deletedAt)))
    for (const r of rows)
      labelMap[`person:${r.key}`] = {
        label: r.name,
        snippet: (r.content ?? '').slice(0, 100),
      }
  }

  // 5. Build nodes array
  const nodes = [...nodeSet.entries()].map(([key, n]) => {
    const resolved = labelMap[key]
    return {
      id: n.id,
      label: resolved?.label ?? n.id,
      type: n.type as 'wiki' | 'fragment' | 'person' | 'entry',
      size: n.edgeCount,
      snippet: resolved?.snippet ?? '',
    }
  })

  // 6. Build edges array
  const graphEdges = edgeRows.map((e) => ({
    source: e.srcId,
    target: e.dstId,
    edgeType: (EDGE_TYPE_MAP[e.edgeType] ?? 'filing') as 'filing' | 'wikilink' | 'mention',
  }))

  log.debug({ nodeCount: nodes.length, edgeCount: graphEdges.length }, 'built graph')
  return c.json(graphResponseSchema.parse({ nodes, edges: graphEdges }))
})

export { graphRouter as graphRoutes }
