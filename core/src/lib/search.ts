import { sql } from 'drizzle-orm'
import { embedText, type EmbedConfig } from '@robin/agent'
import type { DB } from '../db/client.js'
import { fragments, wikis, people } from '../db/schema.js'

export interface SearchResult {
  id: string
  type: 'fragment' | 'wiki' | 'person'
  title: string
  snippet: string
  score: number
}

type SearchTable = 'fragment' | 'wiki' | 'person'

// to_tsquery operators we have to neutralise before splitting raw user
// input — postgres throws "syntax error in tsquery" if any of these
// reach the parser unescaped.
const TSQUERY_RESERVED = /[&|!():*<@'"\\]/g

/**
 * Convert raw user input into a safe `to_tsquery` OR-string.
 *
 * - Strips reserved tsquery operators (`& | ! ( ) : * < @ ' " \`).
 * - Splits on whitespace + any remaining non-alphanumeric junk.
 * - Lowercases and dedupes tokens.
 * - Joins with ` | ` for OR semantics. ts_rank still scores
 *   all-terms-matched docs higher than partial matches, so recall
 *   improves without flattening the ranking signal.
 *
 * Returns `null` when no usable tokens remain — callers should treat
 * that as "match nothing" and skip the BM25 query entirely.
 */
export function buildOrTsQuery(raw: string): string | null {
  const cleaned = raw.replace(TSQUERY_RESERVED, ' ')
  // Split on whitespace AND hyphens — `to_tsquery('machine-learning')`
  // becomes a phrase query (`<->` operator) on the english parser, so a
  // doc containing only the standalone stems wouldn't match. Splitting
  // on `-` lets us OR the parts and trade phrase-precision for recall.
  const tokens = cleaned
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  // Dedupe while preserving order so the query string stays stable
  // for caching and easier debugging.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      unique.push(t)
    }
  }
  return unique.join(' | ')
}

// Reciprocal Rank Fusion: score = sum(1 / (k + rank)) across all lists
function rrfFuse(lists: SearchResult[][], k = 60): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>()

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]
      const key = `${item.type}:${item.id}`
      const existing = scores.get(key)
      const rrfScore = 1 / (k + rank + 1)
      if (existing) {
        existing.score += rrfScore
      } else {
        scores.set(key, { result: item, score: rrfScore })
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }))
}

function snippet(text: string | null | undefined, len = 200): string {
  if (!text) return ''
  return text.length > len ? text.slice(0, len) : text
}

// Table metadata for building queries
const tableMeta = {
  fragment: {
    table: fragments,
    idCol: fragments.lookupKey,
    titleCol: fragments.title,
    contentCol: fragments.content,
    searchVectorCol: fragments.searchVector,
    embeddingCol: fragments.embedding,
    deletedAtCol: fragments.deletedAt,
  },
  wiki: {
    table: wikis,
    idCol: wikis.lookupKey,
    titleCol: wikis.name,
    contentCol: wikis.content,
    searchVectorCol: wikis.searchVector,
    embeddingCol: wikis.embedding,
    deletedAtCol: wikis.deletedAt,
  },
  person: {
    table: people,
    idCol: people.lookupKey,
    titleCol: people.name,
    contentCol: people.content,
    searchVectorCol: people.searchVector,
    embeddingCol: people.embedding,
    deletedAtCol: people.deletedAt,
  },
} as const

async function bm25SearchTable(
  database: DB,
  query: string,
  tableType: SearchTable,
  limit: number,
  tagsFilter?: string[]
): Promise<SearchResult[]> {
  const meta = tableMeta[tableType]
  const orQuery = buildOrTsQuery(query)
  if (orQuery === null) return []
  const tsQuery = sql`to_tsquery('english', ${orQuery})`

  // Tag filter (issue #46) only applies to fragments — wikis and
  // people have no tags column. UNION semantics: `tags=a,b` matches
  // any fragment whose tags array intersects {a,b}. Mirrors `tables=`,
  // which is also union over the row discriminator. Wikis/people
  // return no rows when a tag filter is set (none could ever satisfy).
  const tags =
    tagsFilter && tagsFilter.length > 0 ? tagsFilter : null
  if (tags && tableType !== 'fragment') return []

  // Build the tags filter clause separately because postgres-js does
  // not serialise JS arrays into a `text[]` parameter cleanly. We
  // pass each tag as its own parameter and bind them inside an
  // EXISTS over jsonb_array_elements_text — equivalent to
  // `tags ?| array[...]` (UNION) but bind-safe.
  const whereClause =
    tags && tableType === 'fragment'
      ? sql`${meta.deletedAtCol} IS NULL AND ${meta.searchVectorCol} @@ ${tsQuery} AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${fragments.tags}) AS t(elem) WHERE t.elem IN (${sql.join(
          tags.map((tag) => sql`${tag}`),
          sql`, `
        )}))`
      : sql`${meta.deletedAtCol} IS NULL AND ${meta.searchVectorCol} @@ ${tsQuery}`

  const rows = await database
    .select({
      id: meta.idCol,
      title: meta.titleCol,
      content: meta.contentCol,
      score: sql<number>`ts_rank(${meta.searchVectorCol}, ${tsQuery})`,
    })
    .from(meta.table)
    .where(whereClause)
    .orderBy(sql`ts_rank(${meta.searchVectorCol}, ${tsQuery}) DESC`)
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    type: tableType,
    title: r.title ?? '',
    snippet: snippet(r.content),
    score: Number(r.score ?? 0),
  }))
}

async function bm25Search(
  database: DB,
  query: string,
  opts: { limit?: number; tables?: SearchTable[]; tags?: string[] } = {}
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20
  const tables = opts.tables ?? ['fragment', 'wiki', 'person']

  const results = await Promise.all(
    tables.map((t) => bm25SearchTable(database, query, t, limit, opts.tags))
  )

  return results
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

async function vectorSearchTable(
  database: DB,
  queryEmbedding: number[],
  tableType: SearchTable,
  limit: number,
  tagsFilter?: string[]
): Promise<SearchResult[]> {
  const meta = tableMeta[tableType]
  const vecLiteral = JSON.stringify(queryEmbedding)

  // Same tag-filter rules as bm25SearchTable: fragments only.
  const tags =
    tagsFilter && tagsFilter.length > 0 ? tagsFilter : null
  if (tags && tableType !== 'fragment') return []

  const whereClause =
    tags && tableType === 'fragment'
      ? sql`${meta.deletedAtCol} IS NULL AND ${meta.embeddingCol} IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${fragments.tags}) AS t(elem) WHERE t.elem IN (${sql.join(
          tags.map((tag) => sql`${tag}`),
          sql`, `
        )}))`
      : sql`${meta.deletedAtCol} IS NULL AND ${meta.embeddingCol} IS NOT NULL`

  const rows = await database
    .select({
      id: meta.idCol,
      title: meta.titleCol,
      content: meta.contentCol,
      distance: sql<number>`${meta.embeddingCol} <=> ${vecLiteral}::vector`,
    })
    .from(meta.table)
    .where(whereClause)
    .orderBy(sql`${meta.embeddingCol} <=> ${vecLiteral}::vector`)
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    type: tableType,
    title: r.title ?? '',
    snippet: snippet(r.content),
    score: 1 - Number(r.distance ?? 1) / 2,
  }))
}

async function vectorSearch(
  database: DB,
  queryEmbedding: number[],
  opts: { limit?: number; tables?: SearchTable[]; tags?: string[] } = {}
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20
  const tables = opts.tables ?? ['fragment', 'wiki', 'person']

  const results = await Promise.all(
    tables.map((t) =>
      vectorSearchTable(database, queryEmbedding, t, limit, opts.tags)
    )
  )

  return results
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export async function hybridSearch(
  database: DB,
  query: string,
  opts: {
    limit?: number
    tables?: SearchTable[]
    tags?: string[]
    mode?: 'hybrid' | 'bm25' | 'vector'
    embedConfig?: EmbedConfig
  } = {}
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20
  const tables = opts.tables ?? ['fragment', 'wiki', 'person']
  const mode = opts.mode ?? 'hybrid'
  const tags = opts.tags

  const lists: SearchResult[][] = []

  if (mode === 'bm25' || mode === 'hybrid') {
    lists.push(await bm25Search(database, query, { limit, tables, tags }))
  }

  if (mode === 'vector' || mode === 'hybrid') {
    if (opts.embedConfig) {
      const vec = await embedText(query, opts.embedConfig)
      if (vec) {
        lists.push(await vectorSearch(database, vec, { limit, tables, tags }))
      }
    }
  }

  if (lists.length === 0) return []
  if (lists.length === 1) return lists[0].slice(0, limit)

  return rrfFuse(lists).slice(0, limit)
}
