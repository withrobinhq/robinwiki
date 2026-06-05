/***********************************************************************
 * @module mcp/server
 *
 * @summary MCP tool and resource registrations — thin declarative layer
 * that delegates all business logic to {@link module:mcp/handlers | handlers}
 * and {@link module:mcp/resolvers | resolvers}.
 *
 * @remarks
 * This file is intentionally kept minimal. Each `registerTool` /
 * `registerResource` call destructures inputs, passes them to the
 * appropriate handler or resolver, and wraps errors into MCP-shaped
 * responses. No business logic lives here.
 *
 * @see {@link createMcpServer} — factory function (the only export)
 * @see {@link McpServerDeps} — dependency injection interface (re-exported from handlers)
 * @see {@link module:mcp/handlers | handlers.ts} — write operations
 * @see {@link module:mcp/resolvers | resolvers.ts} — read operations
 ***********************************************************************/

import { z } from 'zod/v4'
import { eq, and, isNull, inArray, sql } from 'drizzle-orm'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listWikis, getWiki, getFragment, findPersonById, findPersonByQuery, listWikiTypes, briefPerson, resolveWikiBySlug } from './resolvers.js'
import type { McpResolverDeps } from './resolvers.js'
import { handleLogEntry, handleLogFragment, handleCreateWikiType, handleCreateWiki, handleEditWiki, handleAttachFragments, handlePublishWiki, handleUnpublishWiki, handleRegenNow, handleRegenStatus, handleCreatePerson, handleUpdatePerson, handleAddRelationship, handleListPendingPersons, handleSetAutoAcceptPersons } from './handlers.js'
import type { McpServerDeps } from './handlers.js'
import { wikis, wikiTypes, edges, auditLog, groups, groupWikis } from '../db/schema.js'
import { hybridSearch } from '../lib/search.js'
import { searchResponseSchema } from '../schemas/search.schema.js'
import { loadOpenRouterConfig } from '../lib/openrouter-config.js'
import { emitAuditEvent } from '../db/audit.js'
import {
  attachAliasesToServer as _attachAliasesToServer,
  type CanonicalToolCallback,
} from './alias-registry.js'

export type { McpServerDeps }

/**
 * Create and configure the Robin MCP server with all tools and resources.
 *
 * @remarks
 * Called per-request in `routes/mcp.ts`. Each invocation gets a fresh
 * server instance bound to the authenticated user's context.
 *
 * @param deps - Injected dependencies wired from the route handler
 * @returns Configured {@link McpServer} ready for `server.connect(transport)`
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    name: 'robin-mcp',
    version: '1.0.0',
  })

  // Stream I Phases 5+6 -- skill-pack alias registry. Capture every
  // canonical tool's callback as it registers so the alias resolver
  // can route alias calls (e.g. `/short-capture`) into the canonical
  // implementation (e.g. `log_entry`) without re-importing handlers.
  const canonicalCallbacks = new Map<string, CanonicalToolCallback>()
  const _origRegisterTool = server.registerTool.bind(server)
  server.registerTool = ((
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    cb: Parameters<typeof server.registerTool>[2]
  ) => {
    canonicalCallbacks.set(name, cb as unknown as CanonicalToolCallback)
    return _origRegisterTool(name, config, cb)
  }) as typeof server.registerTool
  ;(server as unknown as { _canonicalCallbacks?: Map<string, CanonicalToolCallback> })._canonicalCallbacks =
    canonicalCallbacks

  const resolverDeps: McpResolverDeps = {
    db: deps.db,
  }

  // ── MCP clientInfo handshake snapshot (Stream I Phase 2 + Stream C C2) ──
  // Stamps every MCP write with `{ name, version }` of the originating
  // client. The handshake completes during `server.connect(transport)`,
  // *after* this factory returns, so the deps closure (constructed in
  // `routes/mcp.ts`) reads it lazily via `getClientInfo()`. We bind that
  // accessor to the underlying `Server` instance here so handlers and
  // tool callbacks can both reach it without re-plumbing.
  if (!deps.getClientInfo) {
    deps.getClientInfo = () => {
      const v = server.server.getClientVersion()
      if (!v?.name) return undefined
      const version = typeof v.version === 'string' ? v.version : undefined
      return version ? { name: v.name, version } : { name: v.name }
    }
  }

  /***********************************************************************
   * ## Tools — Write operations
   ***********************************************************************/

  server.registerTool(
    'log_entry',
    {
      description: 'Log a new entry to your Robin second-brain',
      inputSchema: {
        content: z.string().describe('The text content to log'),
        source: z.enum(['mcp', 'api', 'web']).optional().describe('Origin of the entry'),
        type: z.enum(['thought', 'article', 'transcript', 'email', 'document']).optional().describe('Content type — defaults to thought'),
        authors: z.array(z.string()).optional().describe('Names of the people who wrote or said this content (e.g. ["Sarah Mwangi", "Chris Okoth"])'),
      },
    },
    async ({ content, source, type, authors }, extra) => {
      return handleLogEntry(
        deps,
        { content, source, type, authors, sourceClient: (deps.getClientInfo?.() as { [key: string]: unknown; name: string; version?: string } | undefined) ?? null },
        extra.authInfo?.clientId as string
      )
    }
  )

  server.registerTool(
    'log_fragment',
    {
      description:
        'Persist a fragment directly to a known wiki, bypassing the AI ingestion pipeline. ' +
        'Use when you already know which wiki the content belongs to. ' +
        'Get wiki slugs from list_wikis or get_wiki first.',
      inputSchema: {
        content: z.string().describe('Fragment body content'),
        threadSlug: z
          .string()
          .describe('Exact wiki slug to attach to (from list_wikis or get_wiki)'),
        title: z.string().optional().describe('Fragment title (derived from content if omitted)'),
        tags: z.array(z.string()).optional().describe('Optional tags'),
        authors: z.array(z.string()).optional().describe('Names of the people who wrote or said this (e.g. ["Sarah Mwangi"])'),
      },
    },
    async ({ content, threadSlug, title, tags, authors }, extra) => {
      return handleLogFragment(
        deps,
        { content, threadSlug, title, tags, authors, sourceClient: (deps.getClientInfo?.() as { [key: string]: unknown; name: string; version?: string } | undefined) ?? null },
        extra.authInfo?.clientId as string
      )
    }
  )

  server.registerTool(
    'create_wiki',
    {
      description:
        'Create a new wiki in the knowledge base. Both `description` and ' +
        '`type` are required (#232) — Robin no longer infers a type when ' +
        'one is missing. Use the get_wiki_types tool first to pick a ' +
        'valid type slug.',
      inputSchema: {
        title: z.string().describe('Wiki title (becomes the slug)'),
        description: z
          .string()
          .describe(
            'What this wiki is for — persisted on the wiki row and shown to users'
          ),
        type: z
          .string()
          .describe(
            'Wiki type slug from get_wiki_types. Required — there is no inference fallback.'
          ),
      },
    },
    async ({ title, description, type }, extra) => {
      return handleCreateWiki(
        deps,
        { title, description, type },
        extra.authInfo?.clientId as string
      )
    }
  )

  server.registerTool(
    'edit_wiki',
    {
      description:
        'Write content to a wiki. The full content is stored as an edit record and will be ' +
        'incorporated during the next regeneration cycle. Use list_wikis to get valid slugs.',
      inputSchema: {
        wikiSlug: z.string().describe('Exact wiki slug (from list_wikis)'),
        content: z
          .string()
          .describe('The content to add or replace. Full text is preserved for regen context.'),
      },
    },
    async ({ wikiSlug, content }, extra) => {
      return handleEditWiki(deps, { wikiSlug, content }, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'attach_fragments',
    {
      description:
        'Attach existing fragments to a wiki by slug. Use when you have ' +
        'fragments that already live in the second-brain and want to ' +
        'route them into a specific wiki without re-creating their ' +
        'content. Returns three lists: attached (newly linked), ' +
        'alreadyAttached (no-op idempotent re-runs), and notFound ' +
        '(slugs that did not resolve). Get fragment slugs from search, ' +
        'list_wikis -> get_wiki, or get_fragment.',
      inputSchema: {
        wikiSlug: z.string().describe('Target wiki slug (from list_wikis or get_wiki)'),
        fragmentSlugs: z
          .array(z.string())
          .min(1)
          .describe('One or more fragment slugs to attach to the target wiki'),
      },
    },
    async ({ wikiSlug, fragmentSlugs }, extra) => {
      return handleAttachFragments(
        deps,
        { wikiSlug, fragmentSlugs },
        extra.authInfo?.clientId as string
      )
    }
  )

  server.registerTool(
    'publish_wiki',
    {
      description:
        'Publish a wiki at a stable public URL. Returns the published ' +
        'slug + origin -- combine them as `${origin}/p/${slug}` for the ' +
        'shareable link. Idempotent: re-publishing keeps the same slug ' +
        'until unpublish rotates it.',
      inputSchema: {
        wikiSlug: z.string().describe('Wiki slug to publish (from list_wikis or get_wiki)'),
      },
    },
    async ({ wikiSlug }, extra) => {
      return handlePublishWiki(deps, { wikiSlug }, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'unpublish_wiki',
    {
      description:
        'Revoke a published wiki. The current public slug is rotated ' +
        '(nulled) so a future publish mints a fresh URL -- the previously ' +
        'shared link stops resolving immediately.',
      inputSchema: {
        wikiSlug: z.string().describe('Wiki slug to unpublish'),
      },
    },
    async ({ wikiSlug }, extra) => {
      return handleUnpublishWiki(deps, { wikiSlug }, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'regen_now',
    {
      description:
        'Force an immediate regen of a single wiki, bypassing the ' +
        'per-wiki debounce window. Use when the user explicitly asks for ' +
        'a refresh during an active ingest burst (where the scheduler ' +
        'would normally hold off until the wiki has been quiet for a few ' +
        'minutes). Returns the queued job id and timestamp; the regen ' +
        'itself runs asynchronously on the regen worker. Pass either the ' +
        'wiki lookupKey or the slug.',
      inputSchema: {
        wikiKey: z.string().describe('Wiki lookupKey or slug (from list_wikis or get_wiki)'),
      },
    },
    async ({ wikiKey }, extra) => {
      return handleRegenNow(deps, { wikiKey }, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'regen_status',
    {
      description:
        'Snapshot of the regen worker. Returns three views: ' +
        '`inFlight` (regen jobs currently active/waiting in the queue, ' +
        'with wikiKey and startedAt), `debounced` (wikis the scheduler ' +
        'is holding off on while fragments are still arriving, with ' +
        'etaToEligibleMs), and `recent` (last N pipeline events for ' +
        'stage=regen, with durationMs when known). The "regen happening ' +
        'now" indicator -- without it the LLM cost during ingest is ' +
        'invisible.',
      inputSchema: {
        recentLimit: z.number().optional().describe(
          'How many recent regen events to include (default 10, max 100)'
        ),
      },
    },
    async ({ recentLimit }, extra) => {
      return handleRegenStatus(deps, { recentLimit }, extra.authInfo?.clientId as string)
    }
  )

  /***********************************************************************
   * ## People tools (Stream P)
   ***********************************************************************/

  const relationshipInput = z
    .object({
      type: z.enum(['KNOWS', 'RELATED_TO', 'WORKS_AT', 'AFFILIATED_WITH']),
      target: z
        .string()
        .describe('person:<key|canonical-name> or wiki:<key|slug>'),
      direction: z.enum(['bidirectional', 'outbound']).optional(),
      role: z.string().optional(),
      note: z.string().optional(),
      sourceFragmentId: z.string().optional(),
    })

  server.registerTool(
    'create_person',
    {
      description:
        'Create a new Person row. MCP creation is the explicit "I know who this is" path: ' +
        'rows always land status="verified" and bypass the quarantine queue (auto-extracted ' +
        'persons go to quarantine instead). Returns lookupKey + slug + resolved/pending ' +
        'relationships.',
      inputSchema: {
        canonicalName: z.string().describe('Canonical display name'),
        aliases: z.array(z.string()).optional().describe('Optional aliases (deduped)'),
        relationship: z
          .string()
          .optional()
          .describe('Freeform relationship descriptor ("manager", "colleague")'),
        isOwner: z.boolean().optional().describe('Set true to flag this as the owner Person'),
        metadata: z
          .object({
            relationships: z.array(relationshipInput).optional(),
            notes: z.string().optional(),
          })
          .optional(),
      },
    },
    async (input, extra) => {
      return handleCreatePerson(deps, input, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'update_person',
    {
      description:
        'Apply field updates to an existing Person row. Aliases and notes append unless ' +
        '`replaceAliases` is true. Pending persons stay pending unless `promoteFromQuarantine` ' +
        'is true (adding context is a recognition signal but the operator must opt in).',
      inputSchema: {
        personLookupKey: z.string().describe('Person lookup key'),
        updates: z.object({
          canonicalName: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          notes: z.string().optional(),
          relationships: z.array(relationshipInput).optional(),
        }),
        options: z
          .object({
            promoteFromQuarantine: z.boolean().optional(),
            replaceAliases: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async (input, extra) => {
      return handleUpdatePerson(deps, input, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'list_pending_persons',
    {
      description:
        'List Persons in the quarantine queue (status="pending"). Read-only triage view. ' +
        'Approval and rejection are HTTP-only via /admin/people/:key/approve and /admin/people/:key/reject; ' +
        'this tool only surfaces the queue contents so AI agents can plan their next step.',
      inputSchema: {
        limit: z.number().optional().describe('Max rows (default 50, max 200)'),
        offset: z.number().optional().describe('Pagination offset'),
        since: z
          .string()
          .optional()
          .describe('ISO timestamp; only persons created after this'),
      },
    },
    async (input, extra) => {
      return handleListPendingPersons(deps, input, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'set_auto_accept_persons',
    {
      description:
        'Toggle the instance-wide `auto_accept_persons` flag (app_settings). When true, ' +
        'the extractor flips new candidates straight to status="verified" instead of ' +
        'routing them through the quarantine queue. Returns { previous, current }.',
      inputSchema: { value: z.boolean() },
    },
    async (input, extra) => {
      return handleSetAutoAcceptPersons(deps, input, extra.authInfo?.clientId as string)
    }
  )

  server.registerTool(
    'add_relationship',
    {
      description:
        'Add a single edge between an existing Person and a Person or Wiki. ' +
        'Idempotent — re-running the same triple is a no-op.',
      inputSchema: {
        source: z.string().describe('person:<key>'),
        target: z.string().describe('person:<key> or wiki:<key|slug>'),
        type: z.enum(['KNOWS', 'RELATED_TO', 'WORKS_AT', 'AFFILIATED_WITH']),
        attrs: z
          .object({
            note: z.string().optional(),
            sourceFragmentId: z.string().optional(),
          })
          .optional(),
      },
    },
    async (input, extra) => {
      return handleAddRelationship(deps, input, extra.authInfo?.clientId as string)
    }
  )

    /***********************************************************************
   * ## Wiki listing
   ***********************************************************************/

  server.registerTool(
    'list_wikis',
    {
      description:
        'List all wikis with fragment counts, previews, and type descriptors. ' +
        'Each item also includes a `refs` map keyed by `${kind}:${slug}` that ' +
        'resolves any [[kind:slug]] tokens present in the wiki content — use it ' +
        'to render or follow references without re-fetching each target. ' +
        'Per-section citations and infoboxes are omitted from list results; ' +
        'call get_wiki for full detail.',
      inputSchema: {
        includeDescriptors: z.boolean().optional().describe(
          'Include type descriptors in the response (default: true). Set false for compact output.'
        ),
      },
    },
    async ({ includeDescriptors }) => {
      try {
        const data = await listWikis(resolverDeps, { includeDescriptors })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  /***********************************************************************
   * ## Read tools
   ***********************************************************************/

  server.registerTool(
    'get_wiki',
    {
      description:
        'Get full detail for a wiki by slug. Response includes:\n' +
        '- `wikiBody`: markdown content with [[kind:slug]] tokens for internal references\n' +
        '- `refs`: resolver map from `${kind}:${slug}` → entity metadata. Use to render or ' +
        'follow tokens without re-fetching each target\n' +
        '- `sections`: parsed markdown headings with per-section `citations[]` pointing ' +
        'to the fragments that back each section (empty when the generator did not ' +
        'declare citations)\n' +
        '- `infobox`: structured key/value facts (status, dates, owners, etc) when the ' +
        'wiki type supports one — null otherwise\n' +
        '- `fragments`: member fragment snippets (unchanged)',
      inputSchema: {
        slug: z.string().describe('Wiki slug or partial slug for fuzzy matching'),
      },
    },
    async ({ slug }) => {
      try {
        const result = await getWiki(resolverDeps, slug)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message }),
            },
          ],
        }
      }
    }
  )

  server.registerTool(
    'get_fragment',
    {
      description:
        'Get full fragment content by slug. Response includes:\n' +
        '- `content`: markdown body (frontmatter stripped) with [[kind:slug]] tokens\n' +
        '- `frontmatter`: raw YAML block for structured parsing\n' +
        '- `refs`: resolver map from `${kind}:${slug}` → entity metadata for any ' +
        'tokens in the body\n' +
        '- `sections`: parsed markdown headings with stable slug anchors (fragments ' +
        'have no infobox and the generator does not emit citations for them — so ' +
        '`sections[].citations` is always empty)',
      inputSchema: {
        slug: z.string().describe('Fragment slug or partial slug'),
      },
    },
    async ({ slug }) => {
      try {
        const result = await getFragment(resolverDeps, slug)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message }),
            },
          ],
        }
      }
    }
  )

  server.registerTool(
    'find_person',
    {
      description:
        'Find a person by ID or name. ' +
        'If the input matches the pattern person{ULID} (e.g. "person01ABC..."), it routes to an exact ID lookup. ' +
        'Otherwise it performs fuzzy search across slug, name, and aliases. ' +
        'Pass id for guaranteed exact lookup; pass query for name-based search.\n\n' +
        'Response includes:\n' +
        '- `person`: canonical name, slug, aliases, relationship\n' +
        '- `body`: person wiki markdown with [[kind:slug]] tokens\n' +
        '- `refs`: resolver map from `${kind}:${slug}` → entity metadata for tokens ' +
        'in the body\n' +
        '- `sections`: parsed headings in the person body (citations empty — ' +
        'person infoboxes are server-derived, not LLM-cited)\n' +
        '- `infobox`: structured facts derived from the person row (relationship, ' +
        'aliases, first-mentioned date, mention count); null when all rows would ' +
        'be empty\n' +
        '- `fragments`: snippet list of fragments that mention this person\n' +
        '- `alternatives` (optional): other candidate names when the match was ambiguous',
      inputSchema: {
        id: z.string().optional().describe(
          'Exact person lookupKey (e.g. "person01ABCDEFGHIJKLMNOPQRS"). Use for precise lookup when you have the ID.'
        ),
        query: z.string().optional().describe(
          'Person name, slug, or alias to search for. Fuzzy-matched across all three fields.'
        ),
      },
    },
    async ({ id, query }) => {
      try {
        // Auto-detect: if input looks like a lookupKey, route to id lookup
        const input = id ?? query ?? ''
        const isLookupKey = /^person[0-9A-Z]{26}$/i.test(input)

        if (isLookupKey) {
          const result = await findPersonById(resolverDeps, input)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        }

        if (query) {
          const result = await findPersonByQuery(resolverDeps, query)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide id or query' }) }],
          isError: true as const,
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    'brief_person',
    {
      description:
        'Get a formatted briefing on a person including their wiki appearances and fragment mentions. ' +
        'Returns a markdown summary. Instant response, no LLM call.',
      inputSchema: {
        query: z.string().describe('Person name, slug, or lookupKey'),
      },
    },
    async ({ query }) => {
      try {
        const result = await briefPerson(resolverDeps, query)
        return { content: [{ type: 'text' as const, text: result }] }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  /***********************************************************************
   * ## Search
   ***********************************************************************/

  server.registerTool(
    'search',
    {
      description:
        'Search the knowledge base across wikis, fragments, and people. ' +
        'Returns ranked results using hybrid BM25 + semantic search with RRF fusion. ' +
        'Use mode=bm25 for keyword search, mode=vector for semantic, mode=hybrid (default) for both.',
      inputSchema: {
        query: z.string().describe('Search query text'),
        tables: z.string().optional().describe('Comma-separated: fragments,wikis,people (default: all)'),
        mode: z.enum(['hybrid', 'bm25', 'vector']).optional().describe('Search mode (default: hybrid)'),
        limit: z.number().optional().describe('Max results (default: 10)'),
      },
    },
    async ({ query, tables, mode, limit }) => {
      try {
        const parsedTables = tables
          ? (tables.split(',').map((t) => t.trim()).filter(Boolean) as ('fragment' | 'wiki' | 'person')[])
          : undefined

        let embedConfig: { apiKey: string; model: string } | undefined
        if (mode !== 'bm25') {
          try {
            const orConfig = await loadOpenRouterConfig()
            embedConfig = { apiKey: orConfig.apiKey, model: orConfig.models.embedding }
          } catch {
            // No OpenRouter key — fall back to BM25-only
            if (mode === 'vector') {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Vector search requires an OpenRouter API key' }) }],
                isError: true as const,
              }
            }
          }
        }

        const effectiveMode = (!embedConfig && mode !== 'bm25') ? 'bm25' : (mode ?? 'hybrid')

        const results = await hybridSearch(deps.db, query, {
          limit: limit ?? 10,
          tables: parsedTables,
          mode: effectiveMode,
          embedConfig,
        })

        // G3 shape parity: validate through the same schema the HTTP
        // /search route uses (routes/search.ts) before stringifying. Same
        // data today, but this prevents silent drift if the HTTP shape
        // ever changes and MCP keeps returning the legacy `SearchResult[]`.
        const response = searchResponseSchema.parse({ results })

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  /***********************************************************************
   * ## Wiki type tools
   ***********************************************************************/

  server.registerTool(
    'get_wiki_types',
    {
      description:
        'List all available wiki types with their descriptors. ' +
        'Use this to understand what types are available before classifying or creating wikis.',
      inputSchema: {},
    },
    async () => {
      try {
        const data = await listWikiTypes(resolverDeps)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    'create_wiki_type',
    {
      description:
        'Create a custom wiki type. Use this intentionally — only when the existing types ' +
        'do not fit the content. Requires a unique slug, a display name, a short descriptor ' +
        '(3-5 words), and a full descriptor sentence.',
      inputSchema: {
        slug: z.string().describe('Unique slug: lowercase alphanumeric + hyphens only'),
        name: z.string().describe('Display name (e.g. "Research Notes")'),
        shortDescriptor: z.string().describe('3-5 word label for pills/badges'),
        descriptor: z.string().describe('One sentence describing what this wiki type contains'),
        prompt: z.string().optional().describe('Optional: custom Quill generation instruction'),
      },
    },
    async ({ slug, name, shortDescriptor, descriptor, prompt }) => {
      return handleCreateWikiType(deps, { slug, name, shortDescriptor, descriptor, prompt })
    }
  )

  /***********************************************************************
   * ## Skills (Stream C / C4)
   ***********************************************************************/

  server.registerTool(
    'list_skills',
    {
      description:
        'List skill wikis: the metadata index of every wiki stored under ' +
        'the `skill` wiki_type. Returns slug, name, description, and version, ' +
        'sorted by most-recently updated. Read-only; the wiki body is not ' +
        'included (fetch it via `get_wiki` when needed). Useful when a Claude ' +
        'session needs to discover which skills the user has captured into ' +
        'their Robin (the Capture pack plus any user-authored skill wikis).',
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await deps.db
          .select({
            slug: wikis.slug,
            name: wikis.name,
            description: wikis.description,
            lookupKey: wikis.lookupKey,
            updatedAt: wikis.updatedAt,
            // The wiki_types row carries the version the skill was based on
            // (basedOnVersion). Surfaced as `version` for callers that
            // want to detect drift against the YAML defaults.
            version: wikiTypes.basedOnVersion,
          })
          .from(wikis)
          .leftJoin(wikiTypes, eq(wikis.type, wikiTypes.slug))
          .where(and(eq(wikis.type, 'skill'), isNull(wikis.deletedAt)))
          .orderBy(sql`${wikis.updatedAt} DESC`)

        const skills = rows.map((r) => ({
          slug: r.slug,
          name: r.name,
          description: r.description,
          lookupKey: r.lookupKey,
          version: r.version ?? null,
          updatedAt: r.updatedAt,
        }))

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ skills }) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  /***********************************************************************
   * ## Timeline
   ***********************************************************************/

  server.registerTool(
    'get_timeline',
    {
      description:
        'Get the audit timeline for a wiki — shows all events related to the wiki and its linked fragments, ' +
        'ordered newest first. Useful for understanding the history of a wiki.',
      inputSchema: {
        wikiSlug: z.string().describe('Wiki slug (fuzzy-matched)'),
        limit: z.number().optional().default(20).describe('Max events to return'),
      },
    },
    async ({ wikiSlug, limit }) => {
      try {
        const resolverDeps: McpResolverDeps = { db: deps.db }
        const resolved = await resolveWikiBySlug(resolverDeps, wikiSlug)
        if ('error' in resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(resolved) }],
            isError: true as const,
          }
        }

        const wikiKey = resolved.lookupKey

        const fragmentEdges = await deps.db
          .select({ srcId: edges.srcId })
          .from(edges)
          .where(
            and(
              eq(edges.dstId, wikiKey),
              eq(edges.edgeType, 'FRAGMENT_IN_WIKI'),
              isNull(edges.deletedAt)
            )
          )

        const relatedIds = [wikiKey, ...fragmentEdges.map(e => e.srcId)]

        const events = await deps.db
          .select()
          .from(auditLog)
          .where(inArray(auditLog.entityId, relatedIds))
          .orderBy(sql`${auditLog.createdAt} DESC`)
          .limit(limit ?? 20)

        const formatted = events.map(e =>
          `[${e.createdAt.toISOString()}] ${e.entityType}.${e.eventType} — ${e.summary}`
        ).join('\n')

        return {
          content: [{
            type: 'text' as const,
            text: formatted || 'No timeline events found for this wiki.',
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true as const,
        }
      }
    }
  )

  /***********************************************************************
   * ## Groups
   ***********************************************************************/

  server.registerTool(
    'list_groups',
    {
      description: 'List all groups with wiki counts',
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await deps.db
          .select({
            group: groups,
            wikiCount: sql<number>`count(${groupWikis.wikiId})::int`,
          })
          .from(groups)
          .leftJoin(groupWikis, eq(groupWikis.groupId, groups.id))
          .groupBy(groups.id)
          .orderBy(sql`${groups.updatedAt} DESC`)

        const data = rows.map((r) => ({
          id: r.group.id,
          name: r.group.name,
          slug: r.group.slug,
          icon: r.group.icon,
          color: r.group.color,
          description: r.group.description,
          wikiCount: r.wikiCount,
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    'create_group',
    {
      description: 'Create a new group for organising wikis',
      inputSchema: {
        name: z.string().describe('Group name'),
        slug: z.string().describe('URL-friendly slug (unique)'),
        icon: z.string().optional().describe('Emoji or icon identifier'),
        color: z.string().optional().describe('Hex color code'),
        description: z.string().optional().describe('What this group is for'),
      },
    },
    async ({ name, slug, icon, color, description }) => {
      try {
        const [existing] = await deps.db
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.slug, slug))
        if (existing) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Slug already taken' }) }],
            isError: true as const,
          }
        }

        // Stream V (migration 0015): groups owns its own source_client
        // text column. Stamp the originating MCP client name on the row
        // and stop duplicating it into audit_log.detail.
        const ci = deps.getClientInfo?.()
        const sourceClient = ci?.name ?? null

        const [group] = await deps.db
          .insert(groups)
          .values({
            name,
            slug,
            icon: icon ?? '',
            color: color ?? '',
            description: description ?? '',
            sourceClient,
          })
          .returning()

        await emitAuditEvent(deps.db, {
          entityType: 'group',
          entityId: group.id,
          eventType: 'created',
          source: 'mcp',
          summary: `Group created: ${name}`,
          detail: {
            groupId: group.id,
            slug,
          },
        })

        return { content: [{ type: 'text' as const, text: JSON.stringify(group) }] }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    'add_wiki_to_group',
    {
      description: 'Add a wiki to a group. Get group IDs from list_groups and wiki keys from list_wikis.',
      inputSchema: {
        groupId: z.string().describe('Group ID (from list_groups)'),
        wikiId: z.string().describe('Wiki lookupKey (from list_wikis)'),
      },
    },
    async ({ groupId, wikiId }) => {
      try {
        const [group] = await deps.db
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, groupId))
        if (!group) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Group not found' }) }],
            isError: true as const,
          }
        }

        const [wiki] = await deps.db
          .select({ lookupKey: wikis.lookupKey })
          .from(wikis)
          .where(eq(wikis.lookupKey, wikiId))
        if (!wiki) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Wiki not found' }) }],
            isError: true as const,
          }
        }

        await deps.db
          .insert(groupWikis)
          .values({ groupId, wikiId })
          .onConflictDoNothing()

        // Stream V: adding a wiki to a group is a membership tweak,
        // not a group authoring event, so we drop the audit detail
        // source_client stamp. The group's column captures the
        // creating surface (set at insert time); the audit row's
        // `source: 'mcp'` field already records this membership came
        // through the MCP surface.
        await emitAuditEvent(deps.db, {
          entityType: 'group',
          entityId: groupId,
          eventType: 'wiki_added',
          source: 'mcp',
          summary: `Wiki added to group: ${wikiId} -> ${groupId}`,
          detail: {
            groupId,
            wikiId,
          },
        })

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, groupId, wikiId }) }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true as const,
        }
      }
    }
  )

  return server
}

/**
 * Attach skill-pack aliases to a freshly-created MCP server. Called by
 * `routes/mcp.ts` between `createMcpServer` and `server.connect` so the
 * alias rows are visible on the very first `listTools` call from the
 * client. Exposed as a separate async helper to keep the synchronous
 * shape of `createMcpServer` (preserves the test harness).
 */
export async function attachAliases(
  server: McpServer,
  db: import('../db/client.js').DB
): Promise<number> {
  const map = (
    server as unknown as { _canonicalCallbacks?: Map<string, CanonicalToolCallback> }
  )._canonicalCallbacks
  if (!map) return 0
  return _attachAliasesToServer(server, db, map)
}
