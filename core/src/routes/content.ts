import { Hono } from 'hono'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { entries, fragments, wikis, people, edits, edges } from '../db/schema.js'
import { VALID_TYPES, WRITE_SCHEMAS, type ContentType } from '../lib/content-schemas.js'
import {
  contentRawResponseSchema,
  contentStructuredResponseSchema,
} from '../schemas/content.schema.js'
import { okResponseSchema } from '../schemas/base.schema.js'
import { logger } from '../lib/logger.js'
import { nanoid } from '../lib/id.js'
import { emitAuditEvent } from '../db/audit.js'
import { htmlToWikiMarkdown } from '../lib/htmlToWikiMarkdown.js'
import { deriveCitationDeclarations, type FragmentSlugMap } from '../lib/citations-from-markdown.js'

const log = logger.child({ component: 'content' })

const contentRoutes = new Hono()
contentRoutes.use('*', sessionMiddleware)

// ── Table map for DB lookups ─────────────────────────────────────────────

const TABLE_MAP = {
  fragment: fragments,
  entry: entries,
  wiki: wikis,
  person: people,
} as const

// ── Helpers ──────────────────────────────────────────────────────────────

function isValidType(type: string): type is ContentType {
  return (VALID_TYPES as readonly string[]).includes(type)
}

// ── GET /:type/:key ─────────────────────────────────────────────────────
// Post-M2: content lives in DB columns, not git. Returns the entry content
// for type=entry; other types currently have no body store and return empty.

contentRoutes.get('/:type/:key', async (c) => {
  const type = c.req.param('type')
  const key = c.req.param('key')

  if (!isValidType(type)) {
    return c.json(
      {
        error: `Invalid content type: ${type}. Valid types: ${VALID_TYPES.join(', ')}`,
      },
      400
    )
  }

  const table = TABLE_MAP[type]
  const [row] = await db
    .select()
    .from(table)
    .where(eq(table.lookupKey, key))
    .limit(1)

  if (!row || row.deletedAt) {
    return c.json({ error: 'Not found' }, 404)
  }

  const raw = (row as { content?: string }).content ?? ''
  const format = c.req.query('format')

  if (format === 'structured') {
    return c.json(
      contentStructuredResponseSchema.parse({
        frontmatter: { wikiLinks: [], brokenLinks: [], tags: [] },
        body: raw,
        raw,
      })
    )
  }

  return c.json(contentRawResponseSchema.parse({ content: raw }))
})

// ── PUT /:type/:key ─────────────────────────────────────────────────────
// Post-M2: writes update DB columns directly. No git, no frontmatter merging.

contentRoutes.put('/:type/:key', async (c) => {
  const type = c.req.param('type') as string
  const key = c.req.param('key')

  if (!isValidType(type)) {
    return c.json(
      {
        error: `Invalid content type: ${type}. Valid types: ${VALID_TYPES.join(', ')}`,
      },
      400
    )
  }

  const table = TABLE_MAP[type]
  const [row] = await db
    .select({ lookupKey: table.lookupKey, deletedAt: table.deletedAt })
    .from(table)
    .where(eq(table.lookupKey, key))
    .limit(1)

  if (!row || row.deletedAt) {
    return c.json({ error: 'Not found' }, 404)
  }

  let rawBody: unknown
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  const schema = WRITE_SCHEMAS[type]
  const parsed = schema.safeParse(rawBody)

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.flatten() }, 400)
  }

  const data = parsed.data as {
    frontmatter: Record<string, unknown>
    body?: string
  }
  const body = type === 'entry' ? '' : (data.body ?? '')
  const now = new Date()

  if (type === 'fragment') {
    await db
      .update(fragments)
      .set({
        title: data.frontmatter.title as string,
        tags: (data.frontmatter.tags as string[]) ?? [],
        content: body,
        updatedAt: now,
      })
      .where(eq(fragments.lookupKey, key))
  } else if (type === 'entry') {
    await db
      .update(entries)
      .set({
        title: data.frontmatter.title as string,
        updatedAt: now,
      })
      .where(eq(entries.lookupKey, key))
  } else if (type === 'wiki') {
    const [currentWiki] = await db
      .select({ content: wikis.content })
      .from(wikis)
      .where(eq(wikis.lookupKey, key))
      .limit(1)
    const previousContent = currentWiki?.content ?? ''

    // The inline editor (Tiptap) emits HTML; the read pipeline expects
    // canonical markdown so parseSections / deriveCitationDeclarations /
    // remark plugins all fire. Normalize on save so wikis.content stays
    // in one canonical form. htmlToWikiMarkdown is idempotent on
    // markdown input (no-tag passthrough), so regen output round-
    // tripping through here doesn't get re-converted.
    //
    // Defensive: a converter throw must not 500 the user's save. If the
    // walker hits something it can't handle, log it and fall back to the
    // raw HTML body. User keeps their edit; downstream rendering is
    // degraded (slug-initial citation fallback) until the next regen
    // restores canonical markdown. Worst case is the pre-fix status quo.
    let normalizedBody = body
    try {
      normalizedBody = htmlToWikiMarkdown(body)
    } catch (err) {
      log.warn(
        {
          wikiKey: key,
          err: err instanceof Error ? { name: err.name, message: err.message } : err,
        },
        'htmlToWikiMarkdown failed; storing raw body, next regen will recover',
      )
    }

    // Re-derive citation declarations from the new body so the read-time
    // sidecar reflects what the user just wrote, not what regen last cached.
    // Without this, an edit that drops a `[[fragment:slug]]` reference
    // leaves the bottom Citations list + the Fragments-tab cited/uncited
    // status pointing at the pre-edit declarations.
    //
    // The wiki's attached fragment edges give us the slug↔lookupKey map
    // deriveCitationDeclarations needs; tokens that don't resolve to an
    // attached fragment are silently skipped (same contract as regen).
    const attachedFragments = await db
      .select({ lookupKey: fragments.lookupKey, slug: fragments.slug })
      .from(fragments)
      .innerJoin(
        edges,
        and(
          eq(edges.srcId, fragments.lookupKey),
          eq(edges.dstId, key),
          eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
          isNull(edges.deletedAt),
        ),
      )
      .where(isNull(fragments.deletedAt))
    const fragmentSlugMap: FragmentSlugMap = {
      slugToKey: new Map(attachedFragments.map((f) => [f.slug, f.lookupKey])),
      keySet: new Set(attachedFragments.map((f) => f.lookupKey)),
    }
    const derivedCitationDeclarations = deriveCitationDeclarations(
      normalizedBody,
      fragmentSlugMap,
    )

    await db
      .update(wikis)
      .set({
        name: data.frontmatter.name as string,
        type: (data.frontmatter.type as string) ?? 'log',
        prompt: (data.frontmatter.prompt as string) ?? '',
        content: normalizedBody,
        citationDeclarations: derivedCitationDeclarations,
        // Stamp dirty_since so the editorial-state dot flips to
        // "learning" (amber) and reflects that the wiki has unintegrated
        // changes. The next autoregen pass hits the empty-partition
        // skip path (no fragment edges changed), clears dirty_since,
        // and the dot returns to green, body untouched. Without this
        // stamp, hand edits leave no visible signal on the dot at all.
        dirtySince: now,
        updatedAt: now,
      })
      .where(eq(wikis.lookupKey, key))

    if (normalizedBody && normalizedBody !== previousContent) {
      await db.insert(edits).values({
        id: nanoid(),
        objectType: 'wiki',
        objectId: key,
        type: 'addition',
        content: previousContent,
        source: 'user',
        diff: '',
      })
      log.info({ wikiKey: key }, 'logged wiki edit')
    }
  } else if (type === 'person') {
    await db
      .update(people)
      .set({
        name: data.frontmatter.name as string,
        relationship: (data.frontmatter.relationship as string) ?? '',
        content: body,
        updatedAt: now,
      })
      .where(eq(people.lookupKey, key))
  }

  await emitAuditEvent(db, {
    entityType: type,
    entityId: key,
    eventType: 'edited',
    source: 'api',
    summary: `${type} content updated`,
    detail: { key, contentType: type },
  })

  return c.json(okResponseSchema.parse({ ok: true }))
})

export { contentRoutes }
