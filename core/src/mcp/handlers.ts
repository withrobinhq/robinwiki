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
import {
  publishWiki as publishWikiService,
  unpublishWiki as unpublishWikiService,
} from '../services/publish.js'
import type { McpResolverDeps } from './resolvers.js'
import { resolvePerson, DEFAULT_RESOLUTION_CONFIG, embedText } from '@robin/agent'
import type { KnownPerson } from '@robin/agent'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { eq, and, isNull, inArray, ne } from 'drizzle-orm'
import { nanoid } from '../lib/id.js'
import { logger } from '../lib/logger.js'
import { emitAuditEvent } from '../db/audit.js'
import { applyFragmentTitleDatePrefix } from '../lib/fragmentTitlePrefix.js'

const log = logger.child({ component: 'mcp' })

/**
 * Read the MCP `clientInfo` snapshot off the deps and shape it for
 * `auditLog.detail.source_client`. Returns `undefined` if the deps don't
 * carry the accessor (legacy callers, tests) or if the handshake has not
 * yet populated client info. The caller spreads the result into the audit
 * detail object -- keeping the field absent (vs `null`) means non-MCP
 * writes don't pick up a junk-drawer key.
 */
function readSourceClient(deps: McpServerDeps): McpClientInfo | undefined {
  try {
    const info = deps.getClientInfo?.()
    if (!info?.name) return undefined
    return info.version ? { name: info.name, version: info.version } : { name: info.name }
  } catch {
    return undefined
  }
}

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
/**
 * MCP `clientInfo` handshake snapshot (#UAT Finding 11). Populated lazily
 * by {@link createMcpServer}; reads forwarded by `routes/mcp.ts` so handlers
 * can stamp every write with `{ name, version }` of the originating client.
 *
 * `version` is optional because the MCP SDK's `Implementation` type only
 * mandates `name`; a few in-the-wild clients omit version.
 */
export interface McpClientInfo {
  name: string
  version?: string
}

export interface McpServerDeps {
  producer: BullMQProducer
  db: DB
  spawnWriteWorker: (userId: string) => void
  entityExtractCall: (system: string, user: string) => Promise<PeopleExtractionOutput>
  loadUserPeople: (userId: string) => Promise<KnownPerson[]>
  /**
   * Lazy accessor for the MCP `clientInfo` handshake. Returns `undefined`
   * before the transport handshake completes (or for non-MCP callers in
   * tests). Persisted into audit-event `detail.source_client` and -- once
   * Stream C2 lands the schema migration -- onto `entries.source_client`.
   */
  getClientInfo?: () => McpClientInfo | undefined
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
  input: {
    content: string
    source?: 'mcp' | 'api' | 'web'
    /**
     * MCP `clientInfo` payload (Stream C / C2). Persisted to
     * `entries.source_client` jsonb. NULL when the caller is the legacy
     * pre-clientInfo path or a non-MCP route that didn't supply it.
     */
    sourceClient?: { name: string; version?: string; [key: string]: unknown } | null
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
      sourceClient: input.sourceClient ?? null,
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

    const sourceClient = readSourceClient(deps)
    await emitAuditEvent(deps.db, {
      entityType: 'raw_source',
      entityId: entryKey,
      eventType: 'ingested',
      source: entrySource,
      summary: `Entry ingested: ${title}`,
      detail: {
        entryKey,
        source: entrySource,
        ...(sourceClient ? { source_client: sourceClient } : {}),
      },
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
    /**
     * MCP `clientInfo` payload (Stream C / C2). The fragments table has
     * no `source_client` column (migration 0007 only added it to
     * `raw_sources`), so the value is recorded in the fragment's
     * audit_log `detail` jsonb instead. Keeps the per-event traceability
     * without expanding the schema beyond C2 scope.
     */
    sourceClient?: { name: string; version?: string; [key: string]: unknown } | null
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

    // Stream E lifecycle: bump to 'learning' on attach (skip when wiki is
    // currently being regenerated; the regen completion will reset it).
    await deps.db
      .update(wikisTable)
      .set({ lifecycleState: 'learning' })
      .where(
        and(
          eq(wikisTable.lookupKey, threadResult.lookupKey),
          ne(wikisTable.lifecycleState, 'dreaming')
        )
      )

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

    const sourceClient = readSourceClient(deps)
    await emitAuditEvent(deps.db, {
      entityType: 'fragment',
      entityId: fragKey,
      eventType: 'created',
      source: 'mcp',
      summary: `Fragment created: ${title}`,
      detail: {
        fragmentKey: fragKey,
        wikiKey: threadResult.lookupKey,
        threadSlug: threadResult.slug,
        // C2: fragments table has no source_client column; the audit
        // detail carries the MCP clientInfo for parity with entries.
        // Stream I plumbs clientInfo via deps.getClientInfo() so callers
        // that don't pass input.sourceClient still get audit signal.
        sourceClient: input.sourceClient ?? sourceClient ?? null,
      },
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

    const sourceClient = readSourceClient(deps)
    await emitAuditEvent(deps.db, {
      entityType: 'wiki_type',
      entityId: slug,
      eventType: 'created',
      source: 'mcp',
      summary: `Wiki type created: ${input.name.trim()}`,
      detail: {
        slug,
        name: input.name.trim(),
        ...(sourceClient ? { source_client: sourceClient } : {}),
      },
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
 * @summary Creates a new wiki with the caller-supplied type. #232 made
 * both `description` and `type` required: the previous behaviour
 * inferred a type from the description when omitted, which surfaced as
 * silently-wrong wiki types when LLM clients skipped the optional
 * field. Now the handler returns a clear error pointing the caller at
 * `get_wiki_types` instead.
 *
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

  // #232 — `description` and `type` are now both required at the handler
  // level. We surface separate errors so an LLM client knows exactly
  // which field to add when it retries.
  if (!input.description?.trim()) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: description is required. Describe what this wiki is for.',
        },
      ],
      isError: true as const,
    }
  }

  if (!input.type?.trim()) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            'Error: type is required. Use the get_wiki_types tool to list valid type slugs.',
        },
      ],
      isError: true as const,
    }
  }

  try {
    const slug = generateSlug(input.title.trim())
    const finalSlug = await resolveWikiSlug(deps.db, slug)
    const lookupKey = makeLookupKey('wiki')

    // The caller-supplied type must exist in the wiki_types registry —
    // the column is user-extensible (single-tenant table), so a runtime
    // lookup replaces any static enum validation. No inference fallback:
    // #232 deliberately removed the silent inferWikiType path.
    const explicitType = input.type.trim()
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
    const resolvedType = row.slug

    await deps.db.insert(wikisTable).values({
      lookupKey,
      slug: finalSlug,
      name: input.title.trim(),
      description: input.description.trim(),
      type: resolvedType,
      state: 'PENDING',
      prompt: '',
    })

    // Embed the wiki at create time. Without this, freshly-created wikis are
    // invisible to vector search until their first regen — which can be hours
    // away. Mirrors the HTTP POST /wikis path. Falls through silently on
    // failure; the row is still created.
    try {
      const orConfig = await loadOpenRouterConfig()
      const textToEmbed = `${input.title.trim()} ${input.description.trim()}`.trim()
      const wikiVec = await embedText(textToEmbed, {
        apiKey: orConfig.apiKey,
        model: orConfig.models.embedding,
      })
      if (wikiVec) {
        await deps.db
          .update(wikisTable)
          .set({ embedding: wikiVec })
          .where(eq(wikisTable.lookupKey, lookupKey))
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), wikiKey: lookupKey },
        'mcp create_wiki embedding failed — wiki created without embedding'
      )
    }

    const sourceClient = readSourceClient(deps)
    await emitAuditEvent(deps.db, {
      entityType: 'wiki',
      entityId: lookupKey,
      eventType: 'created',
      source: 'mcp',
      summary: `Wiki created: ${input.title.trim()}`,
      detail: {
        wikiKey: lookupKey,
        type: resolvedType,
        inferred: false,
        ...(sourceClient ? { source_client: sourceClient } : {}),
      },
    })

    const result = {
      slug: finalSlug,
      lookupKey,
      type: resolvedType,
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

    const sourceClient = readSourceClient(deps)
    await emitAuditEvent(deps.db, {
      entityType: 'wiki',
      entityId: wiki.lookupKey,
      eventType: 'edited',
      source: 'mcp',
      summary: `Wiki edited via MCP: ${wiki.slug}`,
      detail: {
        wikiKey: wiki.lookupKey,
        wikiSlug: wiki.slug,
        ...(sourceClient ? { source_client: sourceClient } : {}),
      },
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




/**
 * Handle the `attach_fragments` MCP tool call.
 *
 * @summary Bulk-attach a list of existing fragments to a target wiki by
 * slug. Phyl's #17 verb -- the first cleanly-named MCP attach surface,
 * paired with the un-attach affordance owned by the wiki UI.
 *
 * Behaviour:
 * - Resolves the wiki via `resolveWikiBySlug` (fuzzy slug, returns 404
 *   semantics when not found).
 * - Looks up each fragment by exact slug. Missing slugs are reported
 *   back in the response under `notFound[]`; the call is partially
 *   successful (idempotent for the slugs that do resolve).
 * - Inserts a FRAGMENT_IN_WIKI edge per resolved fragment with
 *   `onConflictDoNothing` so re-running the call is a no-op.
 * - Marks the wiki PENDING so the next regen rebuilds with the new
 *   members included.
 * - Emits one audit row per attached fragment with `source_client`
 *   stamped from the MCP handshake (Phase 2).
 *
 * Returns `{ wikiKey, wikiSlug, attached, alreadyAttached, notFound }`.
 */
export async function handleAttachFragments(
  deps: McpServerDeps,
  input: { wikiSlug: string; fragmentSlugs: string[] },
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

  const slugs = (input.fragmentSlugs ?? [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
  if (slugs.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'Error: fragmentSlugs must contain at least one slug' }],
      isError: true as const,
    }
  }

  try {
    const resolverDeps: McpResolverDeps = { db: deps.db }
    const wikiResult = await resolveWikiBySlug(resolverDeps, input.wikiSlug.trim())
    if ('error' in wikiResult) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(wikiResult) }],
        isError: true as const,
      }
    }

    // Look up fragments by exact slug. Anything we don't find gets
    // reported back so the caller can fix the slug and retry without
    // re-attaching the ones that already landed.
    const rows = await deps.db
      .select({ lookupKey: fragmentsTable.lookupKey, slug: fragmentsTable.slug })
      .from(fragmentsTable)
      .where(
        and(
          isNull(fragmentsTable.deletedAt),
          inArray(fragmentsTable.slug, slugs)
        )
      )

    const found = new Map(rows.map((r) => [r.slug, r.lookupKey]))
    const notFound = slugs.filter((s) => !found.has(s))

    const attached: string[] = []
    const alreadyAttached: string[] = []
    const sourceClient = readSourceClient(deps)

    for (const [slug, fragKey] of found.entries()) {
      // Detect already-attached so the caller can distinguish a
      // refresh from a fresh attach. Cheaper than a returning() trick
      // because edges has a composite uniqueness on (src, dst, type).
      const existing = await deps.db
        .select({ id: edgesTable.id })
        .from(edgesTable)
        .where(
          and(
            eq(edgesTable.srcId, fragKey),
            eq(edgesTable.dstId, wikiResult.lookupKey),
            eq(edgesTable.edgeType, 'FRAGMENT_IN_WIKI'),
            isNull(edgesTable.deletedAt)
          )
        )
        .limit(1)

      if (existing.length > 0) {
        alreadyAttached.push(slug)
        continue
      }

      await deps.db
        .insert(edgesTable)
        .values({
          id: crypto.randomUUID(),
          srcType: 'fragment',
          srcId: fragKey,
          dstType: 'wiki',
          dstId: wikiResult.lookupKey,
          edgeType: 'FRAGMENT_IN_WIKI',
        })
        .onConflictDoNothing()

      attached.push(slug)

      await emitAuditEvent(deps.db, {
        entityType: 'fragment',
        entityId: fragKey,
        eventType: 'attached',
        source: 'mcp',
        summary: `Fragment attached to wiki: ${slug} -> ${wikiResult.slug}`,
        detail: {
          fragmentKey: fragKey,
          fragmentSlug: slug,
          wikiKey: wikiResult.lookupKey,
          wikiSlug: wikiResult.slug,
          ...(sourceClient ? { source_client: sourceClient } : {}),
        },
      })
    }

    if (attached.length > 0) {
      // Bump wiki to PENDING so regen rebuilds it with the new
      // members. Skip when nothing landed -- avoid spurious churn.
      await deps.db
        .update(wikisTable)
        .set({ state: 'PENDING', updatedAt: new Date() })
        .where(eq(wikisTable.lookupKey, wikiResult.lookupKey))
    }

    const result = {
      wikiKey: wikiResult.lookupKey,
      wikiSlug: wikiResult.slug,
      attached,
      alreadyAttached,
      notFound,
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp attach_fragments failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}


/**
 * Handle the `publish_wiki` MCP tool call.
 *
 * @summary Reinstated MCP tool (#260). Resolves the wiki by slug and
 * delegates to {@link publishWikiService}, so the HTTP route and the
 * MCP tool flow through one code path. The `published_origin` is
 * captured from `process.env.SERVER_PUBLIC_URL` -- MCP has no request
 * context so the env var is the only deterministic source. When the
 * env var is unset, origin lands as null and the UI falls back to
 * `window.location.origin`.
 */
export async function handlePublishWiki(
  deps: McpServerDeps,
  input: { wikiSlug: string },
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

  try {
    const resolverDeps: McpResolverDeps = { db: deps.db }
    const wikiResult = await resolveWikiBySlug(resolverDeps, input.wikiSlug.trim())
    if ('error' in wikiResult) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(wikiResult) }],
        isError: true as const,
      }
    }

    const origin = process.env.SERVER_PUBLIC_URL?.trim() || null
    const sourceClient = readSourceClient(deps)
    const result = await publishWikiService(deps.db, wikiResult.lookupKey, {
      origin,
      source: 'mcp',
      sourceClient,
    })
    if (result.ok === false) {
      const message =
        result.error === 'no-content'
          ? 'Cannot publish a wiki with no content'
          : 'Wiki not found'
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true as const,
      }
    }

    const payload = {
      wikiKey: result.wiki.lookupKey,
      wikiSlug: result.wiki.slug,
      published: result.wiki.published,
      publishedSlug: result.wiki.publishedSlug,
      publishedOrigin: result.wiki.publishedOrigin,
      publishedAt: result.wiki.publishedAt,
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp publish_wiki failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `unpublish_wiki` MCP tool call.
 *
 * @summary Reinstated MCP tool (#260). Resolves the wiki by slug and
 * delegates to {@link unpublishWikiService}.
 */
export async function handleUnpublishWiki(
  deps: McpServerDeps,
  input: { wikiSlug: string },
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

  try {
    const resolverDeps: McpResolverDeps = { db: deps.db }
    const wikiResult = await resolveWikiBySlug(resolverDeps, input.wikiSlug.trim())
    if ('error' in wikiResult) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(wikiResult) }],
        isError: true as const,
      }
    }

    const sourceClient = readSourceClient(deps)
    const result = await unpublishWikiService(deps.db, wikiResult.lookupKey, {
      source: 'mcp',
      sourceClient,
    })
    if (result.ok === false) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Wiki not found' }],
        isError: true as const,
      }
    }

    const payload = {
      wikiKey: result.wiki.lookupKey,
      wikiSlug: result.wiki.slug,
      published: result.wiki.published,
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp unpublish_wiki failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `regen_status` MCP tool call.
 *
 * @summary Read-only snapshot of the regen worker's live state. Pairs
 * with the per-wiki debounce as the "regen happening now" indicator
 * QA Issue 6 (2026-05-08) called for: without a surface like this the
 * regen cost is invisible to the user.
 *
 * Returns three views:
 *   - `inFlight`: BullMQ active/waiting/delayed regen jobs
 *   - `debounced`: wikis the worker is currently holding off on,
 *     with eta_to_eligible_ms
 *   - `recent`: last N pipeline_events entries for stage='regen'
 */
export async function handleRegenStatus(
  deps: McpServerDeps,
  input: { recentLimit?: number },
  userId: string | undefined
) {
  if (!userId) {
    return {
      content: [{ type: 'text' as const, text: 'Error: not authenticated' }],
      isError: true as const,
    }
  }
  try {
    const { getRegenStatus } = await import('../queue/regen-debounce.js')
    const snapshot = await getRegenStatus(deps.db, { recentLimit: input.recentLimit })
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(snapshot) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp regen_status failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}

/**
 * Handle the `regen_now` MCP tool call.
 *
 * @summary On-demand regen for a single wiki, bypassing the per-wiki
 * debounce window. Same auth surface as other write tools (auth check
 * via `userId`); only the debounce is skipped, never the auth.
 *
 * Surfaced for QA Issue 6 (2026-05-08): once the regen worker debounces
 * during active ingest, callers need an explicit "regen this one now"
 * affordance for the cases where waiting is wrong (manual review, demo
 * prep, fixture sweeps). Routes through the same enqueue helper the
 * batch worker uses so behavior on the queue side is identical.
 */
export async function handleRegenNow(
  deps: McpServerDeps,
  input: { wikiKey: string },
  userId: string | undefined
) {
  if (!userId) {
    return {
      content: [{ type: 'text' as const, text: 'Error: not authenticated' }],
      isError: true as const,
    }
  }
  if (!input.wikiKey?.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'Error: wikiKey is required' }],
      isError: true as const,
    }
  }

  try {
    const { resolveWikiForRegen, enqueueWikiRegen } = await import(
      '../queue/regen-debounce.js'
    )
    const wiki = await resolveWikiForRegen(deps.db, input.wikiKey.trim())
    if (!wiki) {
      return {
        content: [{ type: 'text' as const, text: `Error: wiki "${input.wikiKey}" not found` }],
        isError: true as const,
      }
    }

    const { jobId, queuedAt } = await enqueueWikiRegen(wiki.lookupKey, 'manual')

    const sourceClient = readSourceClient(deps)
    await emitAuditEvent(deps.db, {
      entityType: 'wiki',
      entityId: wiki.lookupKey,
      eventType: 'regen_requested',
      source: 'mcp',
      summary: `On-demand regen requested via MCP: ${wiki.slug}`,
      detail: {
        wikiKey: wiki.lookupKey,
        wikiSlug: wiki.slug,
        jobId,
        triggeredBy: 'manual',
        ...(sourceClient ? { source_client: sourceClient } : {}),
      },
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            jobId,
            queuedAt,
            wikiKey: wiki.lookupKey,
            wikiSlug: wiki.slug,
          }),
        },
      ],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, 'mcp regen_now failed')
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    }
  }
}
