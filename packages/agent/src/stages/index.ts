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
        stage: 'extraction',
        status: 'started',
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
          stage: 'entity-extract',
          status: 'failed',
          metadata: { error: entitySettled.reason?.message ?? 'unknown' },
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
        stage: 'extraction',
        status: 'completed',
        metadata: {
          fragmentCount: persistResult.data.fragmentKeys.length,
        },
      })

      return {
        entryKey: input.entryKey,
        fragmentKeys: persistResult.data.fragmentKeys,
        personKeys: entityResult ? Array.from(entityResult.peopleMap.values()) : [],
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
        stage: 'linking',
        status: 'started',
        fragmentKey: input.fragmentKey,
      })

      // Stage 1: wiki classification
      const wikiResult = await wikiClassify(deps.wikiClassifyDeps, {
        fragmentContent: input.fragmentContent,
        fragmentKey: input.fragmentKey,
        jobId: input.jobId,
        entryKey: input.entryKey,
      })

      for (const edge of wikiResult.data.wikiEdges) {
        await deps.insertEdge({
          srcType: 'fragment',
          srcId: input.fragmentKey,
          dstType: 'wiki',
          dstId: edge.wikiKey,
          edgeType: 'FRAGMENT_IN_WIKI',
          attrs: { score: edge.score },
        })
      }

      // Stage 2: fragment-to-fragment relationships
      const relateResult = await fragRelate(deps.fragRelateDeps, {
        fragmentContent: input.fragmentContent,
        fragmentKey: input.fragmentKey,
        jobId: input.jobId,
        entryKey: input.entryKey,
      })

      // Pick a wiki context for audit detail. Prefer the highest-scoring
      // wikiClassify result; fall back to empty string when the fragment
      // didn't classify into any wiki on this run.
      const wikiKeyForAudit =
        wikiResult.data.wikiEdges.length > 0
          ? wikiResult.data.wikiEdges.slice().sort((a, b) => b.score - a.score)[0].wikiKey
          : ''

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
        stage: 'linking',
        status: 'completed',
        fragmentKey: input.fragmentKey,
        metadata: {
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
