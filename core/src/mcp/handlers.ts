/**
 * @module mcp/handlers
 *
 * @summary MCP write handlers — business logic behind `log_entry` and
 * `log_fragment` tools. Extracted from `server.ts` so tool registration
 * stays thin and declarative.
 *
 * @remarks
 * Both handlers return MCP-shaped responses (`{ content, isError }`)
 * so they plug directly into tool registrations with no transformation.
 *
 * **Two paths, one contract:**
 * - {@link handleLogEntry} feeds the full 6-stage AI pipeline via BullMQ.
 *   The entry row must exist before enqueue because the worker reads it.
 * - {@link handleLogFragment} is the fast path — bypasses the pipeline and
 *   writes a fragment directly to a known wiki. Useful when the caller
 *   already knows the destination (e.g. after `list_wikis`).
 *
 * **Fail-open semantics:**
 * - Entity extraction errors → fragment persisted without people edges.
 * - Wiki marked DIRTY after insert → wiki regen picks it up next cycle.
 *
 * @see {@link handleLogEntry} — pipeline entry point
 * @see {@link handleLogFragment} — direct-to-wiki fast path
 * @see {@link McpServerDeps} — dependency injection interface
 */

import {
  makeLookupKey,
  parseLookupKey,
  generateSlug,
  loadPeopleExtractionSpec,
} from '@robin/shared'
import type { PeopleExtractionOutput } from '@robin/shared'
import type { BullMQProducer, ExtractionJob } from '@robin/queue'
import { resolveEntrySlug, resolveFragmentSlug, resolveWikiSlug } from '../db/slug.js'
import { computeContentHash, findDuplicateEntry, findDuplicateFragment } from '../db/dedup.js'
import type { DB } from '../db/client.js'
import {
  entries as entriesTable,
  fragments as fragmentsTable,
  wikis as wikisTable,
  edges as edgesTable,
  people as peopleTable,
  wikiTypes as wikiTypesTable,
  edits as editsTable,
} from '../db/schema.js'
import { resolveWikiBySlug } from './resolvers.js'
import type { McpResolverDeps } from './resolvers.js'
import { inferWikiType } from './wiki-type-inference.js'
import { resolvePerson, DEFAULT_RESOLUTION_CONFIG } from '@robin/agent'
import type { KnownPerson } from '@robin/agent'
import { eq, and, isNull } from 'drizzle-orm'
import { nanoid } from '../lib/id.js'
import { logger } from '../lib/logger.js'
import { emitAuditEvent } from '../db/audit.js'
import { applyFragmentTitleDatePrefix } from '../lib/fragmentTitlePrefix.js'

const log = logger.child({ component: 'mcp' })

/**
 * Dependency injection interface shared by both handlers and
 * {@link createMcpServer}. Wired in `routes/mcp.ts` at request time.
 *
 * @remarks
 * Deliberately broader than {@link McpResolverDeps} — handlers need
 * write access (producer) plus LLM calls for entity extraction, while
 * resolvers only need reads.
 *
 * @property producer              - BullMQ producer for enqueuing pipeline jobs
 * @property db                    - Drizzle database instance
 * @property spawnWriteWorker      - Ensures a write worker exists for the user
 * @property entityExtractCall     - LLM call for people extraction (fail-open)
 * @property loadUserPeople        - Loads known people for fuzzy name matching
 */
export interface McpServerDeps {
  producer: BullMQProducer
  db: DB
  spawnWriteWorker: (userId: string) => void
  entityExtractCall: (system: string, user: string) => Promise<PeopleExtractionOutput>
  loadUserPeople: (userId: string) => Promise<KnownPerson[]>
}

/**
 * Handle the `log_entry` MCP tool call.
 *
 * @summary Captures a raw thought and feeds it into the full AI
 * ingestion pipeline (6 stages via BullMQ).
 *
 * @param deps   - Injected dependencies (db, producer, etc.)
 * @param input  - The raw content and optional source tag
 * @param userId - Authenticated user ID (`undefined` = not authenticated)
 * @returns MCP-shaped response with entry key or error
 *
 * @throws Never — all errors are caught and returned as `{ isError: true }`
 */
export async function handleLogEntry(
  deps: McpServerDeps,
  input: { content: string; source?: 'mcp' | 'api' | 'web' },
  userId: string | undefined
) {
  if (!userId) {
    return {
      content: [{ type: 'text' as const, text: 'Error: not authenticated' }],
      isError: true as const,
    }
  }

  const trimmed = input.content?.trim()
  if (!trimmed) {
    return {
      content: [{ type: 'text' as const, text: 'Error: content is required' }],
      isError: true as const,
    }
  }

  try {
    const hash = computeContentHash(trimmed)
    const dup = await findDuplicateEntry(deps.db, hash)
    if (dup) {
      return {
        content: [{ type: 'text' as const, text: `Duplicate: entry ${dup.lookupKey} already contains this content` }],
      }
    }

    const entryKey = makeLookupKey('entry')
    const { ulid: entryUlid } = parseLookupKey(entryKey)
    const title = trimmed.slice(0, 80)
    const slug = await resolveEntrySlug(deps.db, generateSlug(title))
    const entrySource = input.source ?? 'mcp'
    const now = new Date()

    await deps.db.insert(entriesTable).values({
      lookupKey: entryKey,
      slug,
      title,
      content: trimmed,
      dedupHash: hash,
      type: 'thought',
      source: entrySource,
    })

    const job: ExtractionJob = {
      type: 'extraction',
      jobId: entryUlid,
      enqueuedAt: now.toISOString(),
      content: trimmed,
      entryKey,
      source: entrySource,
    }
    await deps.producer.enqueueExtraction(job)

    await emitAuditEvent(deps.db, {
      entityType: 'raw_source',
      entityId: entryKey,
      eventType: 'ingested',
      source: entrySource,
      summary: `Entry ingested: ${title}`,
      detail: { entryKey, source: entrySource },
    })

    deps.spawnWriteWorker(userId)

    return {
      content: [{ type: 'text' as const, text: `Entry queued: ${entryKey}` }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp log_entry failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `log_fragment` MCP tool call.
 *
 * @summary Persist a fragment directly to a known wiki, bypassing
 * the full AI ingestion pipeline.
 *
 * @param deps   - Injected dependencies (db, LLM calls, etc.)
 * @param input  - Fragment content, target wiki slug, optional title/tags
 * @param userId - Authenticated user ID (`undefined` = not authenticated)
 * @returns MCP-shaped response with fragment/wiki keys or error
 *
 * @throws Never — all errors caught and returned as `{ isError: true }`
 */
export async function handleLogFragment(
  deps: McpServerDeps,
  input: {
    content: string
    threadSlug: string
    title?: string
    tags?: string[]
  },
  userId: string | undefined
) {
  if (!userId) {
    return {
      content: [{ type: 'text' as const, text: 'Error: not authenticated' }],
      isError: true as const,
    }
  }

  const trimmed = input.content?.trim()
  if (!trimmed) {
    return {
      content: [{ type: 'text' as const, text: 'Error: content is required' }],
      isError: true as const,
    }
  }

  if (!input.threadSlug?.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'Error: threadSlug is required' }],
      isError: true as const,
    }
  }

  try {
    const hash = computeContentHash(trimmed)
    const dup = await findDuplicateFragment(deps.db, hash)
    if (dup) {
      return {
        content: [{ type: 'text' as const, text: `Duplicate: fragment ${dup.lookupKey} already contains this content` }],
      }
    }

    const resolverDeps: McpResolverDeps = {
      db: deps.db,
    }

    const threadResult = await resolveWikiBySlug(resolverDeps, input.threadSlug.trim())

    if ('error' in threadResult) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(threadResult) }],
        isError: true as const,
      }
    }

    // Entity extraction (fail-open)
    const personKeys: string[] = []
    const newPeople: Array<{ personKey: string; canonicalName: string }> = []
    try {
      const knownPeople = await deps.loadUserPeople(userId)
      const knownPeopleJson =
        knownPeople.length > 0
          ? JSON.stringify(
              knownPeople.map((p) => ({
                key: p.lookupKey,
                canonicalName: p.canonicalName,
                aliases: p.aliases,
              }))
            )
          : undefined

      const spec = loadPeopleExtractionSpec({
        content: trimmed,
        knownPeople: knownPeopleJson,
      })
      const parsed = await deps.entityExtractCall(spec.system, spec.user)

      const makePeopleKey = () => makeLookupKey('person')
      for (const extraction of parsed.people) {
        const resolved = resolvePerson(
          extraction,
          knownPeople,
          DEFAULT_RESOLUTION_CONFIG,
          makePeopleKey
        )
        personKeys.push(resolved.personKey)
        if (resolved.isNew) {
          newPeople.push({
            personKey: resolved.personKey,
            canonicalName: extraction.inferredName,
          })
        }
      }
    } catch (err) {
      log.warn({ err, userId }, 'log_fragment entity extraction failed (continuing)')
    }

    // Generate fragment identifiers. The slug must survive a collision
    // when two fragments share the same first-80-char title prefix
    // (which is common for incremental edits to the same thought):
    // resolveFragmentSlug appends -2/-3/... on conflict instead of
    // relying on a 6-char ULID-prefix suffix that is only unique within
    // a millisecond.
    const fragKey = makeLookupKey('frag')
    const rawTitle = input.title?.trim() || trimmed.slice(0, 80)
    // #239 — prepend UTC YYMMDD to the title before slug generation so the
    // slug picks up the date prefix too (chronological ordering in lists).
    const title = applyFragmentTitleDatePrefix(rawTitle)
    const fragSlug = await resolveFragmentSlug(deps.db, generateSlug(title))
    const now = new Date()

    // Insert fragment row
    await deps.db.insert(fragmentsTable).values({
      lookupKey: fragKey,
      slug: fragSlug,
      title,
      type: 'observation',
      tags: input.tags ?? [],
      entryId: null,
      state: 'RESOLVED',
      content: trimmed,
      dedupHash: hash,
    })

    // Insert FRAGMENT_IN_WIKI edge
    await deps.db
      .insert(edgesTable)
      .values({
        id: crypto.randomUUID(),
        srcType: 'fragment',
        srcId: fragKey,
        dstType: 'wiki',
        dstId: threadResult.lookupKey,
        edgeType: 'FRAGMENT_IN_WIKI',
      })
      .onConflictDoNothing()

    // Insert FRAGMENT_MENTIONS_PERSON edges (one per person)
    for (const personKey of personKeys) {
      await deps.db
        .insert(edgesTable)
        .values({
          id: crypto.randomUUID(),
          srcType: 'fragment',
          srcId: fragKey,
          dstType: 'person',
          dstId: personKey,
          edgeType: 'FRAGMENT_MENTIONS_PERSON',
        })
        .onConflictDoNothing()
    }

    // Insert new people rows (for people not yet in DB)
    for (const person of newPeople) {
      await deps.db
        .insert(peopleTable)
        .values({
          lookupKey: person.personKey,
          slug: generateSlug(person.canonicalName),
          name: person.canonicalName,
          canonicalName: person.canonicalName,
          state: 'RESOLVED',
          aliases: [],
          verified: false,
        })
        .onConflictDoNothing()
    }

    // Mark wiki for regen (PENDING signals regen needed)
    await deps.db
      .update(wikisTable)
      .set({ state: 'PENDING', updatedAt: now })
      .where(eq(wikisTable.lookupKey, threadResult.lookupKey))

    await emitAuditEvent(deps.db, {
      entityType: 'fragment',
      entityId: fragKey,
      eventType: 'created',
      source: 'mcp',
      summary: `Fragment created: ${title}`,
      detail: { fragmentKey: fragKey, wikiKey: threadResult.lookupKey, threadSlug: threadResult.slug },
    })

    const result = {
      fragmentKey: fragKey,
      fragmentSlug: fragSlug,
      threadSlug: threadResult.slug,
      wikiKey: threadResult.lookupKey,
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp log_fragment failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `create_wiki_type` MCP tool call.
 *
 * @summary Create a custom wiki type with guardrails for slug format,
 * conflict detection, and required fields.
 */
export async function handleCreateWikiType(
  deps: McpServerDeps,
  input: {
    slug: string
    name: string
    shortDescriptor: string
    descriptor: string
    prompt?: string
  }
) {
  try {
    // Normalize slug
    const slug = input.slug
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')

    if (!slug) {
      return {
        content: [{ type: 'text' as const, text: 'Error: slug is required and must contain alphanumeric characters or hyphens' }],
        isError: true as const,
      }
    }

    if (!input.name?.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Error: name is required' }],
        isError: true as const,
      }
    }

    if (!input.shortDescriptor?.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Error: shortDescriptor is required' }],
        isError: true as const,
      }
    }

    if (!input.descriptor?.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Error: descriptor is required' }],
        isError: true as const,
      }
    }

    // Check for slug conflict
    const [existing] = await deps.db
      .select({ slug: wikiTypesTable.slug })
      .from(wikiTypesTable)
      .where(eq(wikiTypesTable.slug, slug))
    if (existing) {
      return {
        content: [{ type: 'text' as const, text: `Error: wiki type "${slug}" already exists` }],
        isError: true as const,
      }
    }

    const prompt = input.prompt?.trim() || `You are Quill. Generate a ${input.name.trim()} document.`

    const [created] = await deps.db
      .insert(wikiTypesTable)
      .values({
        slug,
        name: input.name.trim(),
        shortDescriptor: input.shortDescriptor.trim(),
        descriptor: input.descriptor.trim(),
        prompt,
        isDefault: false,
        userModified: true,
      })
      .returning()

    await emitAuditEvent(deps.db, {
      entityType: 'wiki_type',
      entityId: slug,
      eventType: 'created',
      source: 'mcp',
      summary: `Wiki type created: ${input.name.trim()}`,
      detail: { slug, name: input.name.trim() },
    })

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(created) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, 'mcp create_wiki_type failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `create_wiki` MCP tool call.
 *
 * @summary Creates a new wiki with an inferred type based on description.
 * Slug collisions are resolved with a nanoid(6) suffix.
 */
export async function handleCreateWiki(
  deps: McpServerDeps,
  input: { title: string; description?: string; type?: string },
  userId: string | undefined
) {
  if (!userId) {
    return {
      content: [{ type: 'text' as const, text: 'Error: not authenticated' }],
      isError: true as const,
    }
  }

  if (!input.title?.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'Error: title is required' }],
      isError: true as const,
    }
  }

  try {
    const slug = generateSlug(input.title.trim())
    const finalSlug = await resolveWikiSlug(deps.db, slug)
    const lookupKey = makeLookupKey('wiki')

    // Resolve type: explicit `input.type` wins, else infer from description.
    // Explicit types must exist in the wiki_types registry — the column is
    // user-extensible (single-tenant table), so a runtime lookup replaces
    // any static enum validation.
    let resolvedType: string
    let inferred: boolean
    const explicitType = input.type?.trim()
    if (explicitType) {
      const [row] = await deps.db
        .select({ slug: wikiTypesTable.slug })
        .from(wikiTypesTable)
        .where(eq(wikiTypesTable.slug, explicitType))
        .limit(1)
      if (!row) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Error: unknown wiki type "${explicitType}". Use the get_wiki_types tool to list valid types.`,
            },
          ],
          isError: true as const,
        }
      }
      resolvedType = row.slug
      inferred = false
    } else {
      resolvedType = inferWikiType(input.description ?? '')
      inferred = true
    }

    await deps.db.insert(wikisTable).values({
      lookupKey,
      slug: finalSlug,
      name: input.title.trim(),
      description: input.description?.trim() ?? '',
      type: resolvedType,
      state: 'PENDING',
      prompt: '',
    })

    await emitAuditEvent(deps.db, {
      entityType: 'wiki',
      entityId: lookupKey,
      eventType: 'created',
      source: 'mcp',
      summary: `Wiki created: ${input.title.trim()}`,
      detail: { wikiKey: lookupKey, type: resolvedType, inferred },
    })

    const result = {
      slug: finalSlug,
      lookupKey,
      type: resolvedType,
      inferredType: inferred ? resolvedType : undefined,
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp create_wiki failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `edit_wiki` MCP tool call.
 *
 * @summary Updates a wiki's canonical content and stores the previous
 * content as an edit record tagged `source: 'mcp'`.
 */
export async function handleEditWiki(
  deps: McpServerDeps,
  input: { wikiSlug: string; content: string },
  userId: string | undefined
) {
  if (!userId) {
    return {
      content: [{ type: 'text' as const, text: 'Error: not authenticated' }],
      isError: true as const,
    }
  }

  if (!input.wikiSlug?.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'Error: wikiSlug is required' }],
      isError: true as const,
    }
  }

  if (!input.content?.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'Error: content is required' }],
      isError: true as const,
    }
  }

  try {
    // Resolve wiki by exact slug match (exclude soft-deleted)
    const [wiki] = await deps.db
      .select({
        lookupKey: wikisTable.lookupKey,
        slug: wikisTable.slug,
        content: wikisTable.content,
      })
      .from(wikisTable)
      .where(and(eq(wikisTable.slug, input.wikiSlug.trim()), isNull(wikisTable.deletedAt)))
      .limit(1)

    if (!wiki) {
      // Provide suggestions via resolveWikiBySlug
      const resolverDeps: McpResolverDeps = { db: deps.db }
      const resolved = await resolveWikiBySlug(resolverDeps, input.wikiSlug.trim())
      if ('error' in resolved) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(resolved) }],
          isError: true as const,
        }
      }
      // Shouldn't reach here if resolveWikiBySlug returned an error
      return {
        content: [{ type: 'text' as const, text: `Error: wiki "${input.wikiSlug}" not found` }],
        isError: true as const,
      }
    }

    const previousContent = wiki.content || ''

    // Update canonical content
    await deps.db
      .update(wikisTable)
      .set({ content: input.content, updatedAt: new Date() })
      .where(eq(wikisTable.lookupKey, wiki.lookupKey))

    // Store previous content as edit record (diff computation deferred)
    await deps.db.insert(editsTable).values({
      id: nanoid(),
      objectType: 'wiki',
      objectId: wiki.lookupKey,
      type: 'addition',
      content: previousContent,
      diff: '',
      source: 'mcp',
    })

    await emitAuditEvent(deps.db, {
      entityType: 'wiki',
      entityId: wiki.lookupKey,
      eventType: 'edited',
      source: 'mcp',
      summary: `Wiki edited via MCP: ${wiki.slug}`,
      detail: { wikiKey: wiki.lookupKey, wikiSlug: wiki.slug },
    })

    const result = { wikiSlug: wiki.slug, lookupKey: wiki.lookupKey, recorded: true }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp edit_wiki failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}


