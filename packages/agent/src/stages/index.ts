import type { PgTable } from 'drizzle-orm/pg-core'
import type { CasLock } from '@robin/caslock'
import type {
  EmitEvent,
  ExtractionInput,
  LinkingInput,
  FragmentDeps,
  PersistDeps,
  WikiClassifyDeps,
  FragRelateDeps,
  EntityExtractDeps,
  EntityExtractResult,
} from './types.js'
import { fragment } from './fragment.js'
import { persist } from './persist.js'
import { entityExtract } from './entity-extract.js'
import { wikiClassify } from './wiki-classify.js'
import { fragRelate } from './frag-relate.js'

// ── Orchestrator Dep Types ──────────────────────────────────────────────────

export interface ExtractionOrchestratorDeps {
  fragmentDeps: FragmentDeps
  entityExtractDeps: EntityExtractDeps
  persistDeps: PersistDeps
  entryLock: CasLock<PgTable>
  emitEvent: EmitEvent
  enqueueLinkJob: (job: {
    type: 'link'
    fragmentKey: string
    entryKey: string
    fragmentContent: string
  }) => Promise<void>
}

export interface ExtractionResult {
  entryKey: string
  fragmentKeys: string[]
  personKeys: string[]
  authorshipMentions: Array<{
    personKey: string
    role: 'byline' | 'quoted'
    sourceSpan: string
    mention: string
  }>
  fragmentContents: Array<{ key: string; content: string }>
}

/**
 * Audit emit hook for the linking orchestrator. Fires once per
 * (entity, eventType) pair so the worker path produces the same audit
 * surface as the regen-time path in core/src/lib/regen.ts. Optional so
 * older callers / tests don't need to wire it.
 */
export type LinkingAuditEmit = (params: {
  entityType: string
  entityId: string
  eventType: string
  source?: string
  summary: string
  detail?: Record<string, unknown>
}) => Promise<void>

export interface LinkingOrchestratorDeps {
  wikiClassifyDeps: WikiClassifyDeps
  fragRelateDeps: FragRelateDeps
  fragmentLock: CasLock<PgTable>
  emitEvent: EmitEvent
  insertEdge: (edge: Record<string, unknown>) => Promise<void>
  emitAuditEvent?: LinkingAuditEmit
}

export interface LinkingResult {
  fragmentKey: string
  wikiEdges: Array<{ wikiKey: string; score: number }>
  relatedEdges: Array<{ fragmentKey: string; score: number }>
}

// ── Extraction Orchestrator ─────────────────────────────────────────────────

/**
 * Extraction orchestrator: vault-classify -> fragment -> persist.
 * Uses caslock.using() for PENDING->LINKING->RESOLVED state transitions.
 * On error, state reverts to PENDING via failureState. On contention, using() throws.
 */
export async function runExtraction(
  deps: ExtractionOrchestratorDeps,
  input: ExtractionInput
): Promise<ExtractionResult> {
  return deps.entryLock.using(
    {
      key: input.entryKey,
      fromState: 'PENDING',
      toState: 'LINKING',
      successState: 'RESOLVED',
      failureState: 'PENDING',
      lockedBy: input.jobId,
      autoRenew: true,
    },
    async () => {
      await deps.emitEvent({
        entryKey: input.entryKey,
        jobId: input.jobId,
        stage: 'capture',
        status: 'started',
        metadata: { substage: 'extraction' },
      })

      // Stage 1: fragment + entity-extract in parallel (entity-extract fail-open)
      const [fragSettled, entitySettled] = await Promise.allSettled([
        fragment(deps.fragmentDeps, {
          content: input.content,
          entryKey: input.entryKey,
          jobId: input.jobId,
        }),
        entityExtract(deps.entityExtractDeps, {
          content: input.content,
          entryKey: input.entryKey,
          jobId: input.jobId,
          entryType: input.entryType,
        }),
      ])

      if (fragSettled.status === 'rejected') throw fragSettled.reason
      const fragResult = fragSettled.value

      let entityResult: EntityExtractResult | null = null
      if (entitySettled.status === 'fulfilled') {
        entityResult = entitySettled.value.data
      } else {
        await deps.emitEvent({
          entryKey: input.entryKey,
          jobId: input.jobId,
          stage: 'classify',
          status: 'failed',
          metadata: {
            substage: 'entity-extract',
            error: entitySettled.reason?.message ?? 'unknown',
          },
        })
      }

      // Stage 2: persist
      const persistResult = await persist(deps.persistDeps, {
        entryKey: input.entryKey,
        entryContent: input.content,
        source: input.source,
        fragments: fragResult.data.fragments,
        primaryTopic: fragResult.data.primaryTopic,
        jobId: input.jobId,
        peopleMap: entityResult?.peopleMap ?? new Map(),
        newAliases: entityResult?.newAliases ?? new Map(),
        extractions: entityResult?.extractions ?? [],
        newPeople: entityResult?.newPeople ?? [],
        entityExtractionStatus: entityResult ? 'completed' : 'failed',
      })

      // Enqueue one LinkJob per fragment
      for (let i = 0; i < persistResult.data.fragmentKeys.length; i++) {
        const fragKey = persistResult.data.fragmentKeys[i]
        const fragContent = fragResult.data.fragments[i]?.content ?? ''
        await deps.enqueueLinkJob({
          type: 'link',
          fragmentKey: fragKey,
          entryKey: input.entryKey,
          fragmentContent: fragContent,
        })
      }

      await deps.emitEvent({
        entryKey: input.entryKey,
        jobId: input.jobId,
        stage: 'capture',
        status: 'completed',
        metadata: {
          substage: 'extraction',
          fragmentCount: persistResult.data.fragmentKeys.length,
        },
      })

      return {
        entryKey: input.entryKey,
        fragmentKeys: persistResult.data.fragmentKeys,
        personKeys: entityResult ? Array.from(entityResult.peopleMap.values()) : [],
        authorshipMentions: entityResult?.authorshipMentions ?? [],
        fragmentContents: persistResult.data.fragmentKeys.map((key, i) => ({
          key,
          content: fragResult.data.fragments[i]?.content ?? '',
        })),
      }
    }
  )
}

// ── Linking Orchestrator ────────────────────────────────────────────────────

/**
 * Linking orchestrator: wiki-classify -> frag-relate -> edge creation.
 * Uses caslock.using() with PENDING->LINKING->RESOLVED transitions.
 */
export async function runLinking(
  deps: LinkingOrchestratorDeps,
  input: LinkingInput
): Promise<LinkingResult> {
  return deps.fragmentLock.using(
    {
      key: input.fragmentKey,
      fromState: 'PENDING',
      toState: 'LINKING',
      successState: 'RESOLVED',
      failureState: 'PENDING',
      lockedBy: input.jobId,
      autoRenew: true,
    },
    async () => {
      await deps.emitEvent({
        entryKey: input.entryKey,
        jobId: input.jobId,
        stage: 'classify',
        status: 'started',
        fragmentKey: input.fragmentKey,
        metadata: { substage: 'linking' },
      })

      // Stage 1: wiki classification
      const wikiResult = await wikiClassify(deps.wikiClassifyDeps, {
        fragmentContent: input.fragmentContent,
        fragmentKey: input.fragmentKey,
        jobId: input.jobId,
        entryKey: input.entryKey,
      })

      // Pick the top-1 wiki by score; only that edge carries
      // citationSpans (Stream T1 / #320). Secondary FRAGMENT_IN_WIKI
      // edges still get score in attrs but no spans, so render-side
      // can rely on top-1 spans being authoritative for the fragment.
      const topWikiKey =
        wikiResult.data.wikiEdges.length > 0
          ? wikiResult.data.wikiEdges
              .slice()
              .sort((a, b) => b.score - a.score)[0].wikiKey
          : null

      for (const edge of wikiResult.data.wikiEdges) {
        const isTop = edge.wikiKey === topWikiKey
        const attrs: Record<string, unknown> = { score: edge.score }
        if (isTop && edge.citationSpans && edge.citationSpans.length > 0) {
          attrs.citationSpans = edge.citationSpans
        }
        await deps.insertEdge({
          srcType: 'fragment',
          srcId: input.fragmentKey,
          dstType: 'wiki',
          dstId: edge.wikiKey,
          edgeType: 'FRAGMENT_IN_WIKI',
          attrs,
        })
      }

      // H4 (#328): WIKI_RELATED_TO_WIKI edges from Marcel secondary
      // candidates. When the classifier scored top-N wikis, the runners
      // up still surface conceptual adjacency. Persist secondaries above
      // RELATED_THRESHOLD so future "related wikis" surfaces have a
      // ready signal without re-running Marcel.
      //
      // Direction: top-1 winner -> each above-threshold secondary.
      // Idempotency: edges.unique(src,dst,type,edge_type) is enforced at
      // the schema level. The first fragment that co-classifies a pair
      // wins the edge; subsequent fragments inserting the same pair are
      // absorbed by onConflictDoNothing inside `deps.insertEdge`. This
      // diverges from the spec's "accumulate per fragment" wording but
      // matches the existing schema constraint and avoids a migration.
      // Aggregate co-occurrence counts can be derived later from
      // FRAGMENT_IN_WIKI overlap if the surface ever needs them.
      //
      // Skip writing when the worker pipeline produced no winner
      // (multi-classify can return zero wikis above THRESHOLD).
      const RELATED_THRESHOLD = 0.4
      const raw = wikiResult.data.rawAssignments ?? []
      const winners = wikiResult.data.wikiEdges
      if (winners.length > 0 && raw.length > 1) {
        const top = winners.slice().sort((a, b) => b.score - a.score)[0]
        // Defensive dedup against the top-1 wiki itself, since Marcel
        // returns it inside `rawAssignments` too.
        const secondaries = raw.filter(
          (a) => a.wikiKey !== top.wikiKey && a.confidence > RELATED_THRESHOLD
        )
        for (const secondary of secondaries) {
          await deps.insertEdge({
            srcType: 'wiki',
            srcId: top.wikiKey,
            dstType: 'wiki',
            dstId: secondary.wikiKey,
            edgeType: 'WIKI_RELATED_TO_WIKI',
            attrs: {
              sourceFragmentId: input.fragmentKey,
              marcelConfidence: secondary.confidence,
            },
          })
        }
      }

      // Stage 2: fragment-to-fragment relationships
      const relateResult = await fragRelate(deps.fragRelateDeps, {
        fragmentContent: input.fragmentContent,
        fragmentKey: input.fragmentKey,
        jobId: input.jobId,
        entryKey: input.entryKey,
      })

      // Audit detail uses the same top-1 wikiKey we used to stamp
      // citationSpans, falling back to empty string when nothing
      // classified.
      const wikiKeyForAudit = topWikiKey ?? ''

      for (const edge of relateResult.data.relatedEdges) {
        // attrs.method='cosine-regen' must match the regen-time path in
        // core/src/lib/regen.ts so downstream consumers can identify the
        // detector regardless of which path produced the edge (#227).
        await deps.insertEdge({
          srcType: 'fragment',
          srcId: input.fragmentKey,
          dstType: 'fragment',
          dstId: edge.fragmentKey,
          edgeType: 'FRAGMENT_RELATED_TO_FRAGMENT',
          attrs: { score: edge.score, method: 'cosine-regen' },
        })
        await deps.insertEdge({
          srcType: 'fragment',
          srcId: edge.fragmentKey,
          dstType: 'fragment',
          dstId: input.fragmentKey,
          edgeType: 'FRAGMENT_RELATED_TO_FRAGMENT',
          attrs: { score: edge.score, method: 'cosine-regen' },
        })

        // Bidirectional related_detected audit so timeline endpoints surface
        // relationship detection from either side (#229). Mirrors the emit
        // shape in core/src/lib/regen.ts createRelatedToEdges().
        if (deps.emitAuditEvent) {
          const pct = Math.round(edge.score * 100)
          await deps.emitAuditEvent({
            entityType: 'fragment',
            entityId: input.fragmentKey,
            eventType: 'related_detected',
            source: 'system',
            summary: `Related fragment detected: ${edge.fragmentKey} (${pct}%)`,
            detail: {
              fragmentKey: input.fragmentKey,
              relatedKey: edge.fragmentKey,
              similarity: edge.score,
              wikiKey: wikiKeyForAudit,
              method: 'cosine-regen',
            },
          })
          await deps.emitAuditEvent({
            entityType: 'fragment',
            entityId: edge.fragmentKey,
            eventType: 'related_detected',
            source: 'system',
            summary: `Related fragment detected: ${input.fragmentKey} (${pct}%)`,
            detail: {
              fragmentKey: edge.fragmentKey,
              relatedKey: input.fragmentKey,
              similarity: edge.score,
              wikiKey: wikiKeyForAudit,
              method: 'cosine-regen',
            },
          })
        }
      }

      await deps.emitEvent({
        entryKey: input.entryKey,
        jobId: input.jobId,
        stage: 'classify',
        status: 'completed',
        fragmentKey: input.fragmentKey,
        metadata: {
          substage: 'linking',
          wikiEdgeCount: wikiResult.data.wikiEdges.length,
          relatedEdgeCount: relateResult.data.relatedEdges.length,
        },
      })

      return {
        fragmentKey: input.fragmentKey,
        wikiEdges: wikiResult.data.wikiEdges,
        relatedEdges: relateResult.data.relatedEdges,
      }
    }
  )
}
