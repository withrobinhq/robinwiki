import type { Readable } from 'node:stream'
import archiver from 'archiver'
import { isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  edges,
  entries,
  fragments,
  people,
  wikis,
} from '../db/schema.js'
import { assembleFrontmatter } from './frontmatter.js'

export interface ExportZipCounts {
  wikis: number
  entries: number
  fragments: number
  people: number
  edges: number
}

export interface ExportZipManifest {
  version: 1
  exportedAt: string
  counts: ExportZipCounts
}

/**
 * Build a streaming zip of the entire knowledge base.
 *
 * Layout:
 *   manifest.json                versioned export schema + counts
 *   wikis/<slug>.md              one file per wiki (frontmatter + body)
 *   entries/<id>.md              one file per entry (frontmatter + raw input)
 *   fragments.json               fragments preserved as JSON (atomic, indexed)
 *   people.json                  people rows
 *   graph.json                   { nodes, edges } from edges table (live only)
 *
 * All `deleted_at IS NOT NULL` rows are excluded across every table.
 */
export async function buildExportZip(): Promise<Readable> {
  const archive = archiver('zip', { zlib: { level: 9 } })

  // Surface archive errors on the returned stream so the caller can log
  // them. archiver emits 'warning' for ENOENT-class non-fatal issues; we
  // swallow those (they cannot occur for in-memory appends) and re-throw
  // anything else as a stream error.
  archive.on('warning', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      archive.emit('error', err)
    }
  })

  const [wikiRows, entryRows, fragmentRows, peopleRows, edgeRows] =
    await Promise.all([
      db.select().from(wikis).where(isNull(wikis.deletedAt)),
      db.select().from(entries).where(isNull(entries.deletedAt)),
      db.select().from(fragments).where(isNull(fragments.deletedAt)),
      db.select().from(people).where(isNull(people.deletedAt)),
      db.select().from(edges).where(isNull(edges.deletedAt)),
    ])

  const counts: ExportZipCounts = {
    wikis: wikiRows.length,
    entries: entryRows.length,
    fragments: fragmentRows.length,
    people: peopleRows.length,
    edges: edgeRows.length,
  }

  const manifest: ExportZipManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    counts,
  }

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })

  // Wikis as markdown: frontmatter holds the structured columns, body is
  // the rendered content. Slug is unique per live row (wikis_slug_uidx).
  const usedWikiNames = new Set<string>()
  for (const row of wikiRows) {
    const fm: Record<string, unknown> = {
      lookupKey: row.lookupKey,
      slug: row.slug,
      name: row.name,
      type: row.type,
      description: row.description,
      state: row.state,
      published: row.published,
      publishedSlug: row.publishedSlug,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      lastRebuiltAt: row.lastRebuiltAt?.toISOString() ?? null,
    }
    const md = assembleFrontmatter(fm, row.content ?? '')
    const filename = uniqueFilename(`wikis/${safeSlug(row.slug)}.md`, usedWikiNames)
    archive.append(md, { name: filename })
  }

  // Entries as markdown: `content` holds the raw input; `title` is empty
  // for unstructured thoughts so we don't synthesize one.
  const usedEntryNames = new Set<string>()
  for (const row of entryRows) {
    const fm: Record<string, unknown> = {
      lookupKey: row.lookupKey,
      slug: row.slug,
      title: row.title,
      type: row.type,
      source: row.source,
      ingestStatus: row.ingestStatus,
      state: row.state,
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }
    const md = assembleFrontmatter(fm, row.content ?? '')
    const filename = uniqueFilename(
      `entries/${safeSlug(row.lookupKey)}.md`,
      usedEntryNames,
    )
    archive.append(md, { name: filename })
  }

  // Fragments stay JSON. Per Andrew 2026-05-07: atomic + indexed, markdown
  // serialization adds noise without preserving meaning.
  archive.append(JSON.stringify(stripEmbeddings(fragmentRows), null, 2), {
    name: 'fragments.json',
  })

  archive.append(JSON.stringify(stripEmbeddings(peopleRows), null, 2), {
    name: 'people.json',
  })

  // Graph: edges already carry both endpoints and the edge type. Vertex
  // identity is `${type}:${id}` (the canonical form used everywhere else
  // in the agent stack).
  const nodes = collectNodes(wikiRows, entryRows, fragmentRows, peopleRows)
  const edgesOut = edgeRows.map((e) => ({
    id: e.id,
    src: `${e.srcType}:${e.srcId}`,
    dst: `${e.dstType}:${e.dstId}`,
    edgeType: e.edgeType,
    attrs: e.attrs ?? null,
    createdAt: e.createdAt?.toISOString() ?? null,
  }))
  archive.append(JSON.stringify({ nodes, edges: edgesOut }, null, 2), {
    name: 'graph.json',
  })

  // archiver Readable streams need finalize() to flush the central directory.
  // No await: finalize resolves when the consumer drains the stream.
  void archive.finalize()

  return archive
}

/**
 * Slugs are user-controlled but already pass through the slugger before
 * insert. Belt-and-braces: strip any path traversal or zip-slip vectors.
 */
function safeSlug(slug: string): string {
  return slug.replace(/[\\/]/g, '_').replace(/^\.+/, '_')
}

/**
 * Disambiguate filenames if two rows somehow collide post-sanitization.
 * Adds a `-N` suffix before the extension on collision.
 */
function uniqueFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot === -1 ? name : name.slice(0, dot)
  const ext = dot === -1 ? '' : name.slice(dot)
  let n = 2
  while (used.has(`${stem}-${n}${ext}`)) n++
  const next = `${stem}-${n}${ext}`
  used.add(next)
  return next
}

/**
 * Strip embedding columns: they're large pgvector blobs that aren't
 * useful in an export and inflate the zip size.
 */
function stripEmbeddings<T extends Record<string, unknown>>(rows: T[]): Array<Omit<T, 'embedding' | 'searchVector'>> {
  return rows.map((row) => {
    const { embedding: _e, searchVector: _s, ...rest } = row as Record<string, unknown>
    return rest as Omit<T, 'embedding' | 'searchVector'>
  })
}

interface VertexLike {
  lookupKey: string
  slug: string
}
interface NamedVertex extends VertexLike {
  name: string
}
interface TitledVertex extends VertexLike {
  title: string
}

function collectNodes(
  wikiRows: NamedVertex[],
  entryRows: TitledVertex[],
  fragmentRows: TitledVertex[],
  peopleRows: NamedVertex[],
): Array<{ id: string; type: string; label: string }> {
  const nodes: Array<{ id: string; type: string; label: string }> = []
  for (const w of wikiRows) {
    nodes.push({ id: `wiki:${w.lookupKey}`, type: 'wiki', label: w.name })
  }
  for (const e of entryRows) {
    nodes.push({
      id: `entry:${e.lookupKey}`,
      type: 'entry',
      label: e.title || e.slug,
    })
  }
  for (const f of fragmentRows) {
    nodes.push({
      id: `fragment:${f.lookupKey}`,
      type: 'fragment',
      label: f.title || f.slug,
    })
  }
  for (const p of peopleRows) {
    nodes.push({ id: `person:${p.lookupKey}`, type: 'person', label: p.name })
  }
  return nodes
}
