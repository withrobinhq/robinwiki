import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  real,
  index,
  uniqueIndex,
  vector,
  customType,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { WikiCitationDeclaration, WikiMetadata } from '@robin/shared/schemas/sidecar'
import { nanoid } from '../lib/id.js'

// tsvector custom column — managed by raw SQL triggers in the migration.
// Drizzle treats it as opaque; no reads or writes from the ORM layer.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector'
  },
})

// ─── Auth Tables (better-auth — single-user, user_id retained) ───
// NOTE: These four tables keep user_id and FKs because better-auth requires them.
// All other domain tables dropped user_id in M2 (single-user collapse). Do not
// re-add user_id to domain tables — single user means unscoped queries.

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name'),
    image: text('image'),
    // MCP JWT signing + token revocation (preserved from prior schema):
    publicKey: text('public_key').notNull().default(''),
    encryptedPrivateKey: text('encrypted_private_key').notNull().default(''),
    mcpTokenVersion: integer('mcp_token_version').notNull().default(1),
    // Single-user additions (M1):
    encryptedDek: text('encrypted_dek').notNull().default(''),
    passwordResetRequired: boolean('password_reset_required').notNull().default(false),
    onboardingComplete: boolean('onboarding_complete').notNull().default(false),
    onboardedAt: timestamp('onboarded_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  // Single-tenant invariant (#audit-M1). Mirrors migration
  // 0002_users_singleton_uidx.sql. The `(true)` expression collapses every
  // row to the same key, so the second insert raises SQLSTATE 23505.
  (_t) => [uniqueIndex('users_singleton_uidx').on(sql`(true)`)],
)

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ─── Groups (wiki organisation — replaces vaults) ───

export const groups = pgTable(
  'groups',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    orgId: text('org_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    icon: text('icon').notNull().default(''),
    color: text('color').notNull().default(''),
    description: text('description').notNull().default(''),
    // Stream V (migration 0015): client identifier for the surface that
    // created the row. Replaces the previous audit_log.detail.source_client
    // stamp so the value is queryable per row instead of buried in JSON.
    sourceClient: text('source_client'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('groups_slug_uidx').on(t.slug)]
)

// ─── Skill-Pack Aliases (Stream I Phases 5+6 — server-side alias registry) ───
//
// Maps user-facing alias names (e.g. `/short-capture`) to canonical MCP
// tool names (e.g. `log_entry`) plus optional default args. Populated
// when a skill pack installs (Stream C) and consumed at MCP
// tool-list time by the alias resolver in mcp/alias-registry.ts.

export const skillPackAliases = pgTable(
  'skill_pack_aliases',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    pack: text('pack').notNull(),
    aliasName: text('alias_name').notNull(),
    mcpToolName: text('mcp_tool_name').notNull(),
    /**
     * Optional JSON merged into the alias's call args before forwarding
     * to the canonical tool. Lets a pack pre-bake (e.g.) `source: 'mcp'`
     * or a default `wikiSlug` so the user types fewer words.
     */
    argsTemplate: jsonb('args_template').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('skill_pack_aliases_pack_alias_uidx').on(t.pack, t.aliasName),
    index('skill_pack_aliases_mcp_tool_idx').on(t.mcpToolName),
  ]
)

// ─── Configs (normalized config store — single-user) ───

export const configs = pgTable(
  'configs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    scope: text('scope').notNull(), // 'system' | 'user'
    kind: text('kind').notNull(), // 'llm_key' | 'model_preference' | 'wiki_type_prompt' | ...
    key: text('key').notNull(),
    value: jsonb('value').notNull().$type<unknown>(),
    encrypted: boolean('encrypted').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('configs_scope_kind_key_uidx').on(t.scope, t.kind, t.key),
    index('configs_kind_idx').on(t.kind),
  ]
)

// ─── Wiki Types (first-class type registry — seeded from YAML, user-customizable) ───

export const wikiTypes = pgTable('wiki_types', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  shortDescriptor: text('short_descriptor').notNull().default(''),
  descriptor: text('descriptor').notNull().default(''),
  /**
   * Full YAML spec blob. For seeded rows this is the raw file content
   * from packages/shared/src/prompts/specs/wiki-types/<slug>.yaml. For
   * user-modified rows this is the posted YAML validated via
   * prompt-validation.ts. See regen.ts and routes/wiki-types.ts.
   */
  prompt: text('prompt').notNull().default(''),
  /**
   * Type-aware authoring instruction for the HyDE generator (Wave G,
   * wiki_agent_schema kind='hyde_synthetic'). Loaded from the YAML
   * spec's `internal_framing` field on bootstrap. Belief wikis get
   * framed differently than Decision wikis. Nullable so legacy types
   * without framing still load.
   */
  internalFraming: text('internal_framing'),
  isDefault: boolean('is_default').notNull().default(false),
  userModified: boolean('user_modified').notNull().default(false),
  basedOnVersion: integer('based_on_version').notNull().default(1),
  // Stream V (migration 0015): client identifier for the surface that
  // created or last edited the row. Replaces the audit_log.detail.source_client
  // stamp so the value is queryable per row.
  sourceClient: text('source_client'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ─── State Enum ───

export const objectStateEnum = pgEnum('object_state', ['PENDING', 'LINKING', 'RESOLVED'])

// ─── Shared Base Columns ───

function baseColumns() {
  return {
    lookupKey: text('lookup_key').primaryKey(),
    slug: text('slug').notNull(),
    state: objectStateEnum('state').notNull().default('PENDING'),
    content: text('content').notNull().default(''),
    dedupHash: text('dedup_hash'),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at'),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  }
}

// ─── Domain Tables ───

// `entries` TS export intentionally preserved; SQL table name is `raw_sources`.
// The API and all internal code continue to use "entry" terminology.
export const entries = pgTable(
  'raw_sources',
  {
    ...baseColumns(),
    title: text('title').notNull().default(''),
    type: text('type').notNull().default('thought'),
    source: text('source').notNull().default('api'),
    sourceMetadata: jsonb('source_metadata').$type<{
      displayName?: string
      channel?: string
      sessionId?: string
    }>(),
    // Stream C / C2: MCP `clientInfo` payload (`{name, version, ...}`)
    // for MCP captures, `{name: 'web'}` for web-UI captures, NULL for
    // legacy rows or any caller that doesn't supply client identity.
    // Migration 0007. Decision 2026-05-07: jsonb (carries optional
    // `version` and any future MCP-spec fields without re-migrating).
    sourceClient: jsonb('source_client').$type<{
      name: string
      version?: string
      [key: string]: unknown
    } | null>(),
    ingestStatus: text('ingest_status').notNull().default('pending'),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('raw_sources_slug_uidx').on(t.slug),
    index('raw_sources_ingest_status_idx').on(t.ingestStatus),
  ]
)

export const fragments = pgTable(
  'fragments',
  {
    ...baseColumns(),
    title: text('title').notNull(),
    type: text('type'),
    tags: jsonb('tags').notNull().default([]).$type<string[]>(),
    confidence: real('confidence'),
    entryId: text('entry_id').references(() => entries.lookupKey, {
      onDelete: 'cascade',
    }),
    embedding: vector('embedding', { dimensions: 1536 }),
    // Embedding retry bookkeeping (m-embedding-retry / issue #151). Rows
    // with embedding=null get picked up by the retry scheduler; the
    // attempt count is bumped each tick until cap, then skipped.
    embeddingAttemptCount: integer('embedding_attempt_count').notNull().default(0),
    embeddingLastAttemptAt: timestamp('embedding_last_attempt_at'),
    searchVector: tsvector('search_vector'),
    // Stream V (migration 0015): client identifier for the surface that
    // created the fragment. Replaces audit_log.detail.source_client so the
    // value is queryable per row.
    sourceClient: text('source_client'),
    orgId: text('org_id'), // Add nullable org id to allow multi-org support in enteprise.
  },
  (t) => [
    uniqueIndex('fragments_slug_uidx').on(t.slug),
    // Partial index — keeps the dedup lookup O(1) on live rows only.
    // findDuplicateFragment filters on deleted_at IS NULL, so soft-deleted
    // rows are irrelevant to the hot path.
    index('fragments_dedup_hash_idx')
      .on(t.dedupHash)
      .where(sql`${t.deletedAt} IS NULL`),
    // Partial index — keeps the retry scan O(unembedded) regardless of
    // table size.
    index('fragments_embedding_null_idx')
      .on(t.embeddingLastAttemptAt)
      .where(sql`${t.embedding} IS NULL AND ${t.deletedAt} IS NULL`),
  ]
)

export const wikis = pgTable(
  'wikis',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').notNull().default('log'),
    prompt: text('prompt').notNull().default(''),
    /**
     * Per-wiki document structure override (#244). Sibling of `prompt`
     * (which still acts as a `system_message` override). When non-empty,
     * `loadWikiGenerationSpec` substitutes this for the type's
     * `default_structure` before rendering the `{{structure}}` placeholder.
     * Empty string means "use the type default".
     */
    structure: text('structure').notNull().default(''),
    lastRebuiltAt: timestamp('last_rebuilt_at'),
    /**
     * Auto-regen toggle (migration 0014 renamed the column to one word).
     * When true, the midnight batch worker rewrites this wiki on its
     * scheduled tick. Also gates the ingest-driven Reasons 1 and 2 in the
     * regen worker as of v0.2.2 (T4-bundle): autoregen is now the sole
     * regen gate, replacing the dropped `regenerate` flag. Default false,
     * opt-in per wiki.
     */
    autoregen: boolean('autoregen').notNull().default(false),
    /**
     * Column-backed dirty signal (migration 0014). Set to NOW() when a new
     * FRAGMENT_IN_WIKI edge lands or a member fragment is un-attached;
     * cleared to NULL on successful regen completion. Replaces the v0.2.1
     * MAX(edges.created_at) query-time derivation.
     */
    dirtySince: timestamp('dirty_since'),
    /**
     * Last-regen-completed timestamp. Distinct from `last_rebuilt_at`
     * (which the E1 partition reads). UI surfaces (chip tooltip, profile
     * counter) read this for human-friendly display.
     */
    lastRegenAt: timestamp('last_regen_at'),
    published: boolean('published').notNull().default(false),
    publishedSlug: text('published_slug'),
    publishedAt: timestamp('published_at'),
    /**
     * Origin captured at publish time (e.g. `https://wiki.example.com`).
     * Lets clients build an absolute public URL deterministically when
     * the user is browsing on a different host than where the wiki was
     * published. Nullable: legacy rows fall back to
     * `window.location.origin` or `process.env.SERVER_PUBLIC_URL`.
     */
    publishedOrigin: text('published_origin'),
    bouncerMode: text('bouncer_mode').notNull().default('auto'), // 'auto' | 'review'
    embedding: vector('embedding', { dimensions: 1536 }),
    // Embedding retry bookkeeping — same shape as fragments. The retry
    // worker scans rows where embedding IS NULL and self-heals.
    embeddingAttemptCount: integer('embedding_attempt_count').notNull().default(0),
    embeddingLastAttemptAt: timestamp('embedding_last_attempt_at'),
    searchVector: tsvector('search_vector'),
    progress: jsonb('progress').$type<{
      milestones: { label: string; completed: boolean }[]
      percentage: number
    } | null>(),
    // Sidecar metadata (m-wiki-sidecar). Currently bundles the infobox;
    // reserved for additional structured sidecar fields over time.
    metadata: jsonb('metadata').$type<WikiMetadata>(),
    // Sidecar citation declarations (m-wiki-sidecar). Raw per-section
    // declarations emitted by the wiki-generation LLM; attached to
    // resolved section objects at read time via buildSidecar.
    citationDeclarations: jsonb('citation_declarations')
      .$type<WikiCitationDeclaration[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Stream V (migration 0015): client identifier for the surface that
    // created or last edited the wiki. Replaces audit_log.detail.source_client
    // so the value is queryable per row.
    sourceClient: text('source_client'),
    orgId: text('org_id'), // Add nullable org id to allow multi-org support in enteprise.
  },
  (t) => [
    uniqueIndex('wikis_slug_uidx').on(t.slug).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('wikis_published_slug_uidx').on(t.publishedSlug),
  ]
)

export const groupWikis = pgTable(
  'group_wikis',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    wikiId: text('wiki_id')
      .notNull()
      .references(() => wikis.lookupKey, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at').defaultNow().notNull(),
  },
  (t) => [index('group_wikis_wiki_idx').on(t.wikiId)]
)

export const people = pgTable(
  'people',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    summary: text('summary').notNull().default(''),
    relationship: text('relationship').notNull().default(''),
    canonicalName: text('canonical_name').notNull().default(''),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    verified: boolean('verified').notNull().default(false),
    // Owner-Person flag (#238). Exactly one row may carry is_owner = true
    // (enforced by people_is_owner_uidx in 0011). The owner-Person
    // represents the user account itself; the classifier prompt's new
    // [AUTHORSHIP] block tells the agent to interpret first-person
    // pronouns as this Person.
    isOwner: boolean('is_owner').notNull().default(false),
    // Stream P quarantine model (migration 0017). Status gates whether
    // a row is "graph-visible" or sitting in the pending tray awaiting
    // operator approval. Existing rows default to 'verified' so legacy
    // deployments behave exactly as before. createdVia carries the
    // provenance label, extractedFromFragmentId backreferences the
    // surfacing fragment, contextNotes is an append-only history the
    // matcher reads back to disambiguate similar names.
    status: text('status').notNull().default('verified'),
    createdVia: text('created_via'),
    extractedFromFragmentId: text('extracted_from_fragment_id'),
    contextNotes: jsonb('context_notes').$type<{
      entries: Array<{ note: string; addedAt: string; source: string }>
    } | null>(),
    lastRebuiltAt: timestamp('last_rebuilt_at'),
    embedding: vector('embedding', { dimensions: 1536 }),
    // Embedding retry bookkeeping — same shape as fragments and wikis.
    embeddingAttemptCount: integer('embedding_attempt_count').notNull().default(0),
    embeddingLastAttemptAt: timestamp('embedding_last_attempt_at'),
    searchVector: tsvector('search_vector'),
    orgId: text('org_id'), // Add nullable org id to allow multi-org support in enteprise.
  },
  (t) => [
    uniqueIndex('people_slug_uidx').on(t.slug),
    index('people_aliases_gin_idx').using('gin', t.aliases),
    index('people_status_idx').on(t.status),
  ]
)

// ─── Edits (generalized edit log across any object type) ───

export const edits = pgTable(
  'edits',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    objectType: text('object_type').notNull(), // 'wiki' | 'raw_source' | 'fragment' | 'person'
    objectId: text('object_id').notNull(), // lookup_key of target
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    type: text('type').notNull().default('addition'),
    content: text('content').notNull(),
    source: text('source').notNull().default('user'),
    diff: text('diff').notNull().default(''),
    // Stream D / D1' — fragment edit audit. PUT /fragments/:id writes the
    // pre-edit content into `contentBefore` and the post-edit content into
    // `contentAfter`. The existing wiki-edit pattern in content.ts still
    // populates only `content`; both columns stay nullable so they coexist.
    contentBefore: text('content_before'),
    contentAfter: text('content_after'),
  },
  (t) => [index('edits_object_idx').on(t.objectType, t.objectId)]
)

// ─── Wiki Agent Schema (Stream D/G — machine-side retrieval index) ───
//
// Per-wiki rows describing what the machine indexes for retrieval.
// `kind='description'` is the bootstrap signal populated from
// wikis.description on wiki create (Stream D / D6). `kind='hyde_synthetic'`
// is the synthetic question/answer pair Stream G writes when the wiki has
// fragments to summarise. Unique (wiki_id, kind) so refreshing a kind is
// an UPDATE, not a second INSERT.
// `wikiAgentSchema` is owned by Stream G (PR #326). D6 empty-wiki bootstrap
// is deferred to a follow-up PR after G merges, which will write the
// kind='description' row from wikis.description into Stream G's schema.

// ─── Edges ───

// Canonical src_type / dst_type vocabulary, enforced by CHECK constraints
// added in migration 0016: 'raw_source' | 'fragment' | 'wiki' | 'person'.
// 'raw_source' is the canonical name for the entries-table side, since
// the underlying table was renamed from `entries` to `raw_sources` in
// v0.2.0. Writers must not emit 'entry' (the legacy spelling) anywhere.

export const edges = pgTable(
  'edges',
  {
    id: text('id').primaryKey(),
    srcType: text('src_type').notNull(),
    srcId: text('src_id').notNull(),
    dstType: text('dst_type').notNull(),
    dstId: text('dst_id').notNull(),
    edgeType: text('edge_type').notNull(),
    attrs: jsonb('attrs').$type<Record<string, unknown>>(),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('edges_src_dst_type_uidx').on(t.srcType, t.srcId, t.dstType, t.dstId, t.edgeType),
    index('edges_src_idx').on(t.srcType, t.srcId, t.edgeType),
    index('edges_dst_idx').on(t.dstType, t.dstId, t.edgeType),
  ]
)

// ─── Processed Jobs (dedup) ───

export const processedJobs = pgTable(
  'processed_jobs',
  {
    jobId: text('job_id').primaryKey(),
    contentHash: text('content_hash'),
    processedAt: timestamp('processed_at').defaultNow().notNull(),
  },
  (t) => [
    index('processed_jobs_content_hash_idx').on(t.contentHash),
    index('processed_jobs_processed_at_idx').on(t.processedAt),
  ]
)

// ─── Pipeline Events (observability) ───

export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: text('id').primaryKey(),
    // Nullable because regen and embedding-retry batch jobs are not entry-scoped
    // (regen keys on wikiKey, embed-retry batches across all unembedded rows).
    entryKey: text('entry_key'),
    jobId: text('job_id').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    fragmentKey: text('fragment_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('pipeline_events_entry_key_idx').on(t.entryKey),
    index('pipeline_events_status_stage_idx').on(t.status, t.stage),
    index('pipeline_events_created_at_idx').on(t.createdAt),
    // Used by /admin/diagnose and the regen/embed audit join paths.
    index('pipeline_events_job_id_idx').on(t.jobId),
  ]
)

// ─── Usage Events (cost & spend, Component #4) ───
//
// Sibling of pipeline_events per A-game line 120 / RESEARCH §4.3. Every
// OpenRouter call (mastra agent + embedding adapter) writes one row here
// keyed by job_id so a single BullMQ job correlates: pipeline_events.job_id
// for state, usage_events.job_id for cost. Cost is stored as
// `cost_usd_micros` (1e-6 USD) so we never lose precision rounding to cents.
export const usageEvents = pgTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    entryKey: text('entry_key'),
    wikiKey: text('wiki_key'),
    fragmentKey: text('fragment_key'),
    userId: text('user_id'),
    sourceClient: text('source_client'),
    stage: text('stage').notNull(), // capture | fragment | classify | regen | embed
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    costUsdMicros: integer('cost_usd_micros').notNull().default(0),
    durationMs: integer('duration_ms'),
    jobId: text('job_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('usage_events_user_id_created_at_idx').on(t.userId, t.createdAt),
    index('usage_events_wiki_key_created_at_idx').on(t.wikiKey, t.createdAt),
    index('usage_events_stage_created_at_idx').on(t.stage, t.createdAt),
    index('usage_events_job_id_idx').on(t.jobId),
  ]
)

// ─── App settings (single-tenant key/value store for budgets, etc.) ───
//
// Used by Phase A4 for storing budget caps (regen / embed / classify).
// Keys are free-form strings; values are JSONB so a budget cap can be
// `{ "limit_usd_micros": 10000000 }` and other settings can use other
// shapes. Single-tenant — no user_id column.
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().$type<unknown>(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

/**
 * Boot-time drift detection (#12). One-row-per-key store for migration
 * metadata. The boot path writes the SHA of `drizzle/migrations/meta/_journal.json`
 * here on successful apply; subsequent boots compare disk SHA to DB SHA and
 * refuse to start in production if they diverge.
 */
export const migrationsMeta = pgTable('migrations_meta', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ─── Operational Tables ───

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  eventType: text('event_type').notNull(),
  source: text('source'),
  summary: text('summary').notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('audit_log_entity_idx').on(t.entityType, t.entityId),
  index('audit_log_event_type_idx').on(t.eventType),
  index('audit_log_created_at_idx').on(t.createdAt),
])

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  hint: text('hint').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// ─── Scheduled Jobs (issue #322, heartbeat surface for periodic workers) ───
//
// One row per named scheduled job. The daily prune-pipeline-events worker,
// the (future) HyDE backfill, fragment-relationship backfill and any other
// recurring background job records its last-run state here via
// recordJobRun in core/src/lib/scheduled-jobs.ts. Distinct from audit_log:
// audit_log is for user-visible state changes; scheduled_jobs is worker
// telemetry. last_run_status is constrained to
// 'completed' | 'failed' | 'partial' by a CHECK constraint declared in
// migration 0012 (Drizzle's pg-core has no first-class CHECK helper, so
// the constraint stays authoritative in the SQL file).
export const scheduledJobs = pgTable('scheduled_jobs', {
  jobName: text('job_name').primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull(),
  lastRunStatus: text('last_run_status').notNull(),
  lastRunMeta: jsonb('last_run_meta').$type<Record<string, unknown> | null>(),
  lastRunDurationMs: integer('last_run_duration_ms'),
})

// ─── Wiki Agent Schema (multi-row agent-facing retrieval surface — Wave G) ───

/**
 * Multi-row keyed by (wikiKey, kind). Each `kind` is a different
 * representation pathway used during retrieval. v0.2.0 ships two kinds:
 *
 *   - `description`     direct embedding of `wikis.description`
 *   - `hyde_synthetic`  LLM-generated hypothetical document, then embedded
 *
 * Future kinds (post-v0.2.0) compose into the same table with no schema
 * change: `hyde_questions`, `expanded_keywords`, `retrieval_friendly_summary`,
 * `archetype_brief`. See docs/architecture/wiki-agent-schema.md.
 *
 * `generator_version` bumps when the prompt template, framing, embedding
 * model, or generator LLM changes. Backfill is incremental — wikis whose
 * stored version trails the canonical version surface in /settings/outstanding.
 *
 * The composite PRIMARY KEY (wiki_key, kind) is declared in the migration
 * (0005_wiki_agent_schema.sql). Drizzle's pg-core does not support
 * multi-column PKs via the column-level `.primaryKey()` helper without
 * raw SQL fallthrough, so the constraint stays authoritative in the
 * migration file. The kind index is declared here so drizzle-kit and
 * the SQL stay in sync when future migrations diff against the schema.
 */
export const wikiAgentSchema = pgTable(
  'wiki_agent_schema',
  {
    wikiKey: text('wiki_key')
      .notNull()
      .references(() => wikis.lookupKey, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    generatedAt: timestamp('generated_at').defaultNow().notNull(),
    generatorVersion: text('generator_version').notNull(),
  },
  (t) => [index('wiki_agent_schema_kind_idx').on(t.kind)]
)

