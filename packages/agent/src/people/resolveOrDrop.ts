import type {
  MatchedMention,
  CandidateMention,
} from '@robin/shared'
import { dedupCandidate, type DedupCandidate } from './dedup.js'
import { resolvePerson } from '../stages/entity-extract.js'
import type { KnownPerson, ResolutionConfig } from '../stages/types.js'
import { DEFAULT_RESOLUTION_CONFIG } from '../stages/types.js'

/**
 * Stream P (#PEOPLE-EXTRACT-Q) shared resolveOrDrop helper.
 *
 * Replaces the divergent person-resolution logic that used to live
 * in two places: `entity-extract.ts` (worker pipeline) and
 * `mcp/handlers.ts` (`log_fragment` fast path). Pre-fix, the worker
 * dropped any unmatched mention, while the MCP path inserted a new
 * Person row for the same input. Same fragment in two surfaces, two
 * different graphs. resolveOrDrop is the single place both call so
 * the outcome is identical regardless of how the fragment arrived.
 *
 * Usage flow:
 *
 *   1. The extractor (Elfie v3) returns matched + candidates.
 *   2. Caller invokes resolveOrDrop with both buckets and a few deps.
 *   3. The helper returns one outcome per mention. The caller writes
 *      FRAGMENT_MENTIONS_PERSON edges based on outcomes uniformly.
 *
 * Outcome kinds:
 *
 *   matched           — mention maps to a verified known person.
 *   pending           — mention dedups onto an existing pending row.
 *   created_pending   — new row inserted with status='pending' and
 *                        created_via='extractor_pending'.
 *   created_verified  — new row inserted with status='verified' (only
 *                        when `autoAccept = true`); created_via=
 *                        'extractor_auto'.
 *   dropped           — matched bucket entry whose matchedKey did not
 *                        survive the resolver (score floor / ambiguity).
 */

export interface SourceSpan {
  text: string
  start?: number
  end?: number
}

export type ResolveOutcome =
  | {
      kind: 'matched'
      lookupKey: string
      mention: string
      confidence: number
      sourceSpan: SourceSpan
    }
  | {
      kind: 'pending'
      lookupKey: string
      mention: string
      confidence: number
      sourceSpan: SourceSpan
    }
  | {
      kind: 'created_pending'
      lookupKey: string
      mention: string
      sourceSpan: SourceSpan
    }
  | {
      kind: 'created_verified'
      lookupKey: string
      mention: string
      sourceSpan: SourceSpan
    }
  | { kind: 'dropped'; mention: string; reason: string }

export interface ResolveOrDropContext {
  /** Fragment that surfaced these mentions (for traceability). */
  fragmentId: string | null
  /** Whether the extractor should auto-verify new persons. */
  autoAccept: boolean
  /** Existing verified persons (matcher targets). */
  verifiedPeople: KnownPerson[]
  /** Existing pending persons (dedup targets only). */
  pendingPeople: KnownPerson[]
  /** Mint a fresh person lookup key. */
  makePersonKey: () => string
  /**
   * Insert a new Person row. The implementation lives in core (it
   * needs Drizzle), but the helper passes the structured payload so
   * the row carries the right `status`, `created_via`, and provenance
   * fields uniformly across surfaces.
   */
  insertPerson: (input: {
    lookupKey: string
    canonicalName: string
    status: 'verified' | 'pending'
    createdVia: 'extractor_pending' | 'extractor_auto'
    extractedFromFragmentId: string | null
  }) => Promise<void>
  /** Optional override for the matcher's resolution thresholds. */
  resolutionConfig?: ResolutionConfig
}

export interface ResolveOrDropInput {
  matched: MatchedMention[]
  candidates: CandidateMention[]
}

function toSpan(text: string): SourceSpan {
  return { text }
}

function toDedupCandidates(
  verifiedPeople: KnownPerson[],
  pendingPeople: KnownPerson[]
): DedupCandidate[] {
  return [
    ...verifiedPeople.map((p) => ({
      lookupKey: p.lookupKey,
      canonicalName: p.canonicalName,
      aliases: p.aliases,
      status: 'verified' as const,
    })),
    ...pendingPeople.map((p) => ({
      lookupKey: p.lookupKey,
      canonicalName: p.canonicalName,
      aliases: p.aliases,
      status: 'pending' as const,
    })),
  ]
}

export async function resolveOrDrop(
  input: ResolveOrDropInput,
  context: ResolveOrDropContext
): Promise<ResolveOutcome[]> {
  const outcomes: ResolveOutcome[] = []
  const config = context.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG
  const dedupPool = toDedupCandidates(context.verifiedPeople, context.pendingPeople)
  // Track in-batch creations so two candidates that name the same
  // person inside one fragment do not mint two pending rows.
  const inBatchCreated: DedupCandidate[] = []

  // ── Matched bucket ──────────────────────────────────────────────────
  for (const mention of input.matched) {
    const resolved = resolvePerson(
      {
        mention: mention.mention,
        inferredName: mention.inferredName,
        matchedKey: mention.matchedKey,
      },
      context.verifiedPeople,
      config,
      context.makePersonKey
    )
    if (resolved.isNew) {
      // Resolver disagrees with the LLM (score floor / ambiguity).
      // Drop rather than mint a row from a noisy match signal.
      outcomes.push({
        kind: 'dropped',
        mention: mention.mention,
        reason: 'matcher disagreed with LLM matchedKey',
      })
      continue
    }
    outcomes.push({
      kind: 'matched',
      lookupKey: resolved.personKey,
      mention: mention.mention,
      confidence: mention.confidence,
      sourceSpan: toSpan(mention.sourceSpan),
    })
  }

  // ── Candidate bucket ────────────────────────────────────────────────
  for (const mention of input.candidates) {
    const pool = [...dedupPool, ...inBatchCreated]
    const hit = dedupCandidate(mention.inferredName || mention.mention, pool)
    if (hit) {
      outcomes.push({
        kind: hit.status === 'verified' ? 'matched' : 'pending',
        lookupKey: hit.lookupKey,
        mention: mention.mention,
        confidence: mention.confidence,
        sourceSpan: toSpan(mention.sourceSpan),
      })
      continue
    }

    // No hit — mint a new row.
    const lookupKey = context.makePersonKey()
    const canonicalName = mention.inferredName || mention.mention
    if (context.autoAccept) {
      await context.insertPerson({
        lookupKey,
        canonicalName,
        status: 'verified',
        createdVia: 'extractor_auto',
        extractedFromFragmentId: context.fragmentId,
      })
      outcomes.push({
        kind: 'created_verified',
        lookupKey,
        mention: mention.mention,
        sourceSpan: toSpan(mention.sourceSpan),
      })
      inBatchCreated.push({
        lookupKey,
        canonicalName,
        aliases: [],
        status: 'verified',
      })
    } else {
      await context.insertPerson({
        lookupKey,
        canonicalName,
        status: 'pending',
        createdVia: 'extractor_pending',
        extractedFromFragmentId: context.fragmentId,
      })
      outcomes.push({
        kind: 'created_pending',
        lookupKey,
        mention: mention.mention,
        sourceSpan: toSpan(mention.sourceSpan),
      })
      inBatchCreated.push({
        lookupKey,
        canonicalName,
        aliases: [],
        status: 'pending',
      })
    }
  }

  return outcomes
}
