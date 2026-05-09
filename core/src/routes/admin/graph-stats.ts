/**
 * Stream H5: read-only graph and pipeline observability surface.
 *
 * QA Issue 4f (2026-05-08) flagged that the graph layer had no operator
 * visibility. The "matcher dropped everything for a month" failure
 * mode in Stream P was invisible until someone went looking in the DB.
 * This endpoint surfaces graph counts, pipeline counters, and recent
 * regen activity in a single payload so an operator (or a future
 * settings panel) can glance at it and notice when something is off.
 *
 * Auth: session-cookie, same as `/admin/backfill/*` and `/admin/people/*`.
 * Robin is single-tenant, so the session check is the only gate.
 *
 * Endpoint:
 *   GET /admin/graph/stats
 *
 * The response is a snapshot, not a histogram. Operators are expected
 * to poll this every few minutes and watch the trend; per-event
 * timeseries belong in a separate observability layer (see
 * docs/architecture/observability.md).
 */

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { sessionMiddleware } from '../../middleware/session.js'
import { editorialStateWhere } from '../../lib/wiki-editorial-state.js'
import { logger } from '../../lib/logger.js'

const log = logger.child({ component: 'admin-graph-stats' })

export const adminGraphStatsRoutes = new Hono()
adminGraphStatsRoutes.use('*', sessionMiddleware)

interface PersonsBlock {
  total: number
  verified: number
  pending: number
  rejected: number
  owner: number
}

interface WikisBlock {
  total: number
  populated: number
  empty: number
  autoregenEnabled: number
  dirty: number
  editorialState: {
    empty: number
    learning: number
    dreaming: number
    filed: number
  }
}

interface FragmentsBlock {
  total: number
  withMention: number
  withoutMention: number
}

interface EdgesBlock {
  FRAGMENT_RELATED_TO_FRAGMENT: number
  FRAGMENT_IN_WIKI: number
  ENTRY_HAS_FRAGMENT: number
  FRAGMENT_MENTIONS_PERSON: number
  WIKI_RELATED_TO_WIKI: number
}

interface AgentSchemaBlock {
  wikisWithDescription: number
  wikisWithHyde: number
  wikisMissingEither: number
  wikisMissingBoth: number
}

interface PeopleExtraction24hBlock {
  rawMentionsSeen: number
  matched: number
  dropped: number
  dropRatePct: number
  telemetryStarted: string | null
}

interface Regen24hBlock {
  total: number
  debounced: number
  onDemand: number
}

interface GraphStatsResponse {
  persons: PersonsBlock
  wikis: WikisBlock
  fragments: FragmentsBlock
  edges: EdgesBlock
  agentSchema: AgentSchemaBlock
  peopleExtraction24h: PeopleExtraction24hBlock
  regen24h: Regen24hBlock
  lastUpdated: string
  telemetryWarning?: string
}

const TELEMETRY_WARNING =
  'people-extraction telemetry started after Stream P merged on 2026-05-08; counters reflect post-merge data only.'

/**
 * GET /admin/graph/stats
 *
 * Returns a single snapshot covering persons, wikis, fragments, edges,
 * wiki-agent-schema coverage, last-24h people-extraction counters, and
 * last-24h regen counts. All metrics are derived from existing tables
 * via small SELECTs; no migrations.
 */
adminGraphStatsRoutes.get('/stats', async (c) => {
  try {
    // ── persons ────────────────────────────────────────────────────────────
    const [personsRow] = await db.execute<{
      total: string
      verified: string
      pending: string
      rejected: string
      owner: string
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL)                                AS total,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'verified')        AS verified,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'pending')         AS pending,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'rejected')        AS rejected,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_owner = true)            AS owner
      FROM people
    `)

    // ── wikis (top-level + editorial state breakdown) ──────────────────────
    const [wikisRow] = await db.execute<{
      total: string
      populated: string
      empty_unfilled: string
      autoregen_enabled: string
      dirty: string
      es_empty: string
      es_learning: string
      es_dreaming: string
      es_filed: string
    }>(sql`
      WITH live AS (
        SELECT
          w.lookup_key,
          w.state,
          w.dirty_since,
          w.last_rebuilt_at,
          w.autoregen,
          (
            SELECT COUNT(*)
            FROM edges e
            WHERE e.dst_type = 'wiki'
              AND e.dst_id = w.lookup_key
              AND e.edge_type = 'FRAGMENT_IN_WIKI'
              AND e.deleted_at IS NULL
          ) AS fragment_count
        FROM wikis w
        WHERE w.deleted_at IS NULL
      )
      SELECT
        COUNT(*)                                                                  AS total,
        COUNT(*) FILTER (WHERE fragment_count > 0)                                AS populated,
        COUNT(*) FILTER (WHERE fragment_count = 0)                                AS empty_unfilled,
        COUNT(*) FILTER (WHERE autoregen = true)                                  AS autoregen_enabled,
        COUNT(*) FILTER (WHERE dirty_since IS NOT NULL)                           AS dirty,
        COUNT(*) FILTER (WHERE ${editorialStateWhere.empty})                      AS es_empty,
        COUNT(*) FILTER (WHERE ${editorialStateWhere.learning})                   AS es_learning,
        COUNT(*) FILTER (WHERE ${editorialStateWhere.dreaming})                   AS es_dreaming,
        COUNT(*) FILTER (WHERE ${editorialStateWhere.filed})                      AS es_filed
      FROM live
    `)

    // ── fragments ──────────────────────────────────────────────────────────
    const [fragmentsRow] = await db.execute<{
      total: string
      with_mention: string
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE f.deleted_at IS NULL) AS total,
        COUNT(DISTINCT f.lookup_key) FILTER (
          WHERE f.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM edges e
              WHERE e.src_type = 'fragment'
                AND e.src_id = f.lookup_key
                AND e.edge_type = 'FRAGMENT_MENTIONS_PERSON'
                AND e.deleted_at IS NULL
            )
        ) AS with_mention
      FROM fragments f
    `)

    // ── edges ──────────────────────────────────────────────────────────────
    const [edgesRow] = await db.execute<{
      frag_related: string
      frag_in_wiki: string
      entry_has_frag: string
      frag_mentions_person: string
      wiki_related_to_wiki: string
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT' AND deleted_at IS NULL) AS frag_related,
        COUNT(*) FILTER (WHERE edge_type = 'FRAGMENT_IN_WIKI'             AND deleted_at IS NULL) AS frag_in_wiki,
        COUNT(*) FILTER (WHERE edge_type = 'ENTRY_HAS_FRAGMENT'           AND deleted_at IS NULL) AS entry_has_frag,
        COUNT(*) FILTER (WHERE edge_type = 'FRAGMENT_MENTIONS_PERSON'     AND deleted_at IS NULL) AS frag_mentions_person,
        COUNT(*) FILTER (WHERE edge_type = 'WIKI_RELATED_TO_WIKI'         AND deleted_at IS NULL) AS wiki_related_to_wiki
      FROM edges
    `)

    // ── wiki_agent_schema coverage ─────────────────────────────────────────
    // We want the per-wiki view: how many wikis have a description row,
    // how many have a hyde row, how many are missing one or both. Computed
    // off live wikis only (deleted_at IS NULL).
    const [agentRow] = await db.execute<{
      with_description: string
      with_hyde: string
      missing_either: string
      missing_both: string
    }>(sql`
      WITH per_wiki AS (
        SELECT
          w.lookup_key,
          BOOL_OR(was.kind = 'description')    AS has_description,
          BOOL_OR(was.kind = 'hyde_synthetic') AS has_hyde
        FROM wikis w
        LEFT JOIN wiki_agent_schema was ON was.wiki_key = w.lookup_key
        WHERE w.deleted_at IS NULL
        GROUP BY w.lookup_key
      )
      SELECT
        COUNT(*) FILTER (WHERE has_description = true)                           AS with_description,
        COUNT(*) FILTER (WHERE has_hyde = true)                                  AS with_hyde,
        COUNT(*) FILTER (
          WHERE COALESCE(has_description, false) = false
             OR COALESCE(has_hyde, false) = false
        )                                                                         AS missing_either,
        COUNT(*) FILTER (
          WHERE COALESCE(has_description, false) = false
            AND COALESCE(has_hyde, false) = false
        )                                                                         AS missing_both
      FROM per_wiki
    `)

    // ── people-extraction last 24h ─────────────────────────────────────────
    // Stream P added rawMentionsSeen, matched, dropped to entity-extract
    // pipeline_events.metadata. We sum the integers across the last 24h
    // window. Telemetry only started populating from Stream P merge; any
    // window that predates it shows zero. telemetryStarted = MIN(created_at)
    // across rows that carry rawMentionsSeen, so the operator can tell
    // "no extraction yet" from "no telemetry yet".
    const [extractRow] = await db.execute<{
      raw_mentions_seen: string | null
      matched: string | null
      dropped: string | null
      telemetry_started: Date | string | null
    }>(sql`
      SELECT
        COALESCE(SUM((metadata->>'rawMentionsSeen')::bigint), 0) AS raw_mentions_seen,
        COALESCE(SUM((metadata->>'matched')::bigint),         0) AS matched,
        COALESCE(SUM((metadata->>'dropped')::bigint),         0) AS dropped
      FROM pipeline_events
      WHERE stage = 'classify'
        AND metadata->>'substage' = 'entity-extract'
        AND created_at > NOW() - INTERVAL '24 hours'
    `)

    const [telemetryStartRow] = await db.execute<{ telemetry_started: Date | string | null }>(sql`
      SELECT MIN(created_at) AS telemetry_started
      FROM pipeline_events
      WHERE stage = 'classify'
        AND metadata->>'substage' = 'entity-extract'
        AND metadata->>'rawMentionsSeen' IS NOT NULL
    `)

    // ── regen last 24h ─────────────────────────────────────────────────────
    // Source of truth: pipeline_events with stage='regen' and status='started'
    // in the last 24h. metadata.triggeredBy distinguishes scheduler-driven
    // (debounced) regens from manual ones (e.g. regen_now MCP, /regenerate
    // HTTP). We bucket scheduler -> debounced, anything else -> onDemand.
    const [regenRow] = await db.execute<{
      total: string
      debounced: string
      on_demand: string
    }>(sql`
      SELECT
        COUNT(*)                                                                  AS total,
        COUNT(*) FILTER (WHERE metadata->>'triggeredBy' = 'scheduler')            AS debounced,
        COUNT(*) FILTER (WHERE metadata->>'triggeredBy' IS NOT NULL
                           AND metadata->>'triggeredBy' <> 'scheduler')           AS on_demand
      FROM pipeline_events
      WHERE stage = 'regen'
        AND status = 'started'
        AND created_at > NOW() - INTERVAL '24 hours'
    `)

    // ── assemble response ──────────────────────────────────────────────────
    const persons: PersonsBlock = {
      total: toInt(personsRow?.total),
      verified: toInt(personsRow?.verified),
      pending: toInt(personsRow?.pending),
      rejected: toInt(personsRow?.rejected),
      owner: toInt(personsRow?.owner),
    }

    const wikis: WikisBlock = {
      total: toInt(wikisRow?.total),
      populated: toInt(wikisRow?.populated),
      empty: toInt(wikisRow?.empty_unfilled),
      autoregenEnabled: toInt(wikisRow?.autoregen_enabled),
      dirty: toInt(wikisRow?.dirty),
      editorialState: {
        empty: toInt(wikisRow?.es_empty),
        learning: toInt(wikisRow?.es_learning),
        dreaming: toInt(wikisRow?.es_dreaming),
        filed: toInt(wikisRow?.es_filed),
      },
    }

    const fragmentsTotal = toInt(fragmentsRow?.total)
    const fragmentsWithMention = toInt(fragmentsRow?.with_mention)
    const fragments: FragmentsBlock = {
      total: fragmentsTotal,
      withMention: fragmentsWithMention,
      withoutMention: Math.max(fragmentsTotal - fragmentsWithMention, 0),
    }

    const edges: EdgesBlock = {
      FRAGMENT_RELATED_TO_FRAGMENT: toInt(edgesRow?.frag_related),
      FRAGMENT_IN_WIKI: toInt(edgesRow?.frag_in_wiki),
      ENTRY_HAS_FRAGMENT: toInt(edgesRow?.entry_has_frag),
      FRAGMENT_MENTIONS_PERSON: toInt(edgesRow?.frag_mentions_person),
      WIKI_RELATED_TO_WIKI: toInt(edgesRow?.wiki_related_to_wiki),
    }

    const agentSchema: AgentSchemaBlock = {
      wikisWithDescription: toInt(agentRow?.with_description),
      wikisWithHyde: toInt(agentRow?.with_hyde),
      wikisMissingEither: toInt(agentRow?.missing_either),
      wikisMissingBoth: toInt(agentRow?.missing_both),
    }

    const rawMentionsSeen = toInt(extractRow?.raw_mentions_seen)
    const matched = toInt(extractRow?.matched)
    const dropped = toInt(extractRow?.dropped)
    const dropRatePct =
      rawMentionsSeen > 0 ? Number(((dropped / rawMentionsSeen) * 100).toFixed(2)) : 0
    const telemetryStartedRaw = telemetryStartRow?.telemetry_started ?? null
    const telemetryStarted = toIso(telemetryStartedRaw)
    const peopleExtraction24h: PeopleExtraction24hBlock = {
      rawMentionsSeen,
      matched,
      dropped,
      dropRatePct,
      telemetryStarted,
    }

    const regen24h: Regen24hBlock = {
      total: toInt(regenRow?.total),
      debounced: toInt(regenRow?.debounced),
      onDemand: toInt(regenRow?.on_demand),
    }

    const response: GraphStatsResponse = {
      persons,
      wikis,
      fragments,
      edges,
      agentSchema,
      peopleExtraction24h,
      regen24h,
      lastUpdated: new Date().toISOString(),
    }

    if (peopleExtraction24h.rawMentionsSeen === 0 && peopleExtraction24h.telemetryStarted === null) {
      response.telemetryWarning = TELEMETRY_WARNING
    }

    return c.json(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err: message }, 'graph-stats query failed')
    return c.json({ error: 'graph-stats query failed', detail: message }, 500)
  }
})

// ── helpers ───────────────────────────────────────────────────────────────

function toInt(value: string | number | null | undefined): number {
  if (value == null) return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  // Postgres-js returns timestamps as Date objects, but the count rows come
  // back with a string for some drivers; coerce defensively.
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
