import { Hono } from 'hono'
import { eq, and, desc, isNull } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { sessionMiddleware } from '../middleware/session.js'
import { producer } from '../queue/producer.js'
import { db } from '../db/client.js'
import { entries as entriesTable, fragments } from '../db/schema.js'
import { makeLookupKey, parseLookupKey, generateSlug } from '@robin/shared'
import { resolveEntrySlug } from '../db/slug.js'
import { computeContentHash, findDuplicateEntry } from '../db/dedup.js'
import type { ExtractionJob } from '@robin/queue'
import { validationHook } from '../lib/validation.js'
import { buildSidecar } from '../lib/wikiSidecar.js'
import { makeSidecarDeps } from '../lib/wikiSidecarDeps.js'
import {
  entryResponseSchema,
  entryCreatedResponseSchema,
  entryListResponseSchema,
  createEntryBodySchema,
  entryListQuerySchema,
} from '../schemas/entries.schema.js'
import { fragmentListResponseSchema } from '../schemas/fragments.schema.js'
import { emitAuditEvent } from '../db/audit.js'

const entries = new Hono()
entries.use('*', sessionMiddleware)

// POST /entries — accept raw input, persist entry row, enqueue extraction job
entries.post('/', zValidator('json', createEntryBodySchema, validationHook), async (c) => {
  const { content, title, source, type } = c.req.valid('json')

  // Content-level dedup: reject if identical content already exists
  const hash = computeContentHash(content)
  const existing = await findDuplicateEntry(db, hash)
  if (existing) {
    return c.json(
      entryCreatedResponseSchema.parse({
        ...existing,
        id: existing.lookupKey,
        jobId: parseLookupKey(existing.lookupKey).ulid,
        status: 'duplicate',
      }),
      200
    )
  }

  const entryKey = makeLookupKey('entry')
  const { ulid: entryUlid } = parseLookupKey(entryKey)
  const slug = await resolveEntrySlug(db, generateSlug(title ?? content.slice(0, 80)))

  // Stream C / C2: web-UI captures get `{name: 'web'}`. Other HTTP
  // captures (`source: 'api'` or anything else) leave `source_client`
  // NULL. MCP-originated rows are populated by handleLogEntry from the
  // protocol-level clientInfo handshake.
  const sourceClient = source === 'web' ? { name: 'web' } : null

  // Persist entry row — pure DB, no git write-through
  const [entry] = await db
    .insert(entriesTable)
    .values({
      lookupKey: entryKey,
      slug,
      title: title ?? content.slice(0, 80),
      content,
      dedupHash: hash,
      type,
      source,
      sourceClient,
      ingestStatus: 'pending',
    })
    .returning()

  // Enqueue extraction job directly (no legacy WriteJob path)
  const job: ExtractionJob = {
    type: 'extraction',
    jobId: entryUlid,
    entryKey,
    content,
    source,
    enqueuedAt: new Date().toISOString(),
  }

  await producer.enqueueExtraction(job)

  await emitAuditEvent(db, {
    entityType: 'raw_source',
    entityId: entryKey,
    eventType: 'ingested',
    source: 'api',
    summary: `Entry ingested: ${(title ?? content.slice(0, 80)).slice(0, 80)}`,
    detail: { entryKey, source: source ?? 'api' },
  })

  return c.json(
    entryCreatedResponseSchema.parse({
      ...entry,
      id: entry.lookupKey,
      jobId: entryUlid,
      status: 'queued',
    }),
    202
  )
})

// GET /entries — list entries
entries.get('/', async (c) => {
  const query = entryListQuerySchema.safeParse({ limit: c.req.query('limit') })
  const limit = query.success ? query.data.limit : 50
  const rows = await db
    .select()
    .from(entriesTable)
    .where(isNull(entriesTable.deletedAt))
    .orderBy(desc(entriesTable.createdAt))
    .limit(limit)
  return c.json(
    entryListResponseSchema.parse({ entries: rows.map((r) => ({ ...r, id: r.lookupKey })) })
  )
})

// GET /entries/:id — get entry by id
entries.get('/:id', async (c) => {
  const id = c.req.param('id')

  const [entry] = await db
    .select()
    .from(entriesTable)
    .where(and(eq(entriesTable.lookupKey, id), isNull(entriesTable.deletedAt)))
  if (!entry) return c.json({ error: 'Not found' }, 404)

  // Entries have no metadata column and no LLM citations yet; sidecar only
  // contributes refs (from any [[kind:slug]] tokens in the raw text) and
  // sections (from any markdown headings).
  const sidecar = await buildSidecar({
    content: entry.content ?? '',
    metadata: null,
    deps: makeSidecarDeps(db),
    derivedInfobox: null,
  })

  return c.json(
    entryResponseSchema.parse({
      ...entry,
      id: entry.lookupKey,
      refs: sidecar.refs,
      sections: sidecar.sections,
    })
  )
})

// GET /entries/:id/fragments — get all fragments derived from an entry
entries.get('/:id/fragments', async (c) => {
  const id = c.req.param('id')

  const [entry] = await db
    .select()
    .from(entriesTable)
    .where(and(eq(entriesTable.lookupKey, id), isNull(entriesTable.deletedAt)))
  if (!entry) return c.json({ error: 'Not found' }, 404)

  const rows = await db
    .select()
    .from(fragments)
    .where(and(eq(fragments.entryId, id), isNull(fragments.deletedAt)))
    .orderBy(desc(fragments.createdAt))

  return c.json(
    fragmentListResponseSchema.parse({ fragments: rows.map((r) => ({ ...r, id: r.lookupKey })) })
  )
})

// POST /entries/:id/retry — re-enqueue a failed entry for extraction
entries.post('/:id/retry', async (c) => {
  const id = c.req.param('id')

  const [entry] = await db
    .select()
    .from(entriesTable)
    .where(and(eq(entriesTable.lookupKey, id), isNull(entriesTable.deletedAt)))
  if (!entry) return c.json({ error: 'Not found' }, 404)

  if (entry.ingestStatus !== 'failed') {
    return c.json({ error: 'Entry is not in failed state' }, 409)
  }

  await db
    .update(entriesTable)
    .set({ ingestStatus: 'pending', lastError: null, updatedAt: new Date() })
    .where(eq(entriesTable.lookupKey, id))

  const { ulid: entryUlid } = parseLookupKey(id)
  const job: ExtractionJob = {
    type: 'extraction',
    jobId: entryUlid,
    entryKey: id,
    content: entry.content,
    source: entry.source,
    enqueuedAt: new Date().toISOString(),
  }

  await producer.enqueueExtraction(job)

  await emitAuditEvent(db, {
    entityType: 'raw_source',
    entityId: id,
    eventType: 'retried',
    source: 'api',
    summary: `Entry retried: ${entry.title.slice(0, 80)}`,
    detail: { entryKey: id },
  })

  return c.json({ ok: true, entryKey: id }, 202)
})

export { entries }
