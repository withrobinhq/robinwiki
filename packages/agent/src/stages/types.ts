import type {
  PeopleExtractionOutput,
  FragmentationOutput,
  WikiClassificationOutput,
  FragmentRelevanceOutput,
} from '@robin/shared'
import type { OpenRouterConfig } from '../openrouter-config.js'

// ── Stage Result ─────────────────────────────────────────────────────────────

export interface StageResult<T> {
  data: T
  durationMs: number
}

// ── Stage Inputs ─────────────────────────────────────────────────────────────

export interface ExtractionInput {
  content: string
  entryKey: string
  source: string
  jobId: string
}

export interface LinkingInput {
  fragmentKey: string
  fragmentContent: string
  entryKey: string
  jobId: string
}

// ── Event Emitter ────────────────────────────────────────────────────────────

/**
 * Top-level stage taxonomy for pipeline_events emission. Mirrors the union in
 * `core/src/db/pipeline-events.ts`. Sub-stage detail (entity-extract,
 * wiki-classify, persist, etc.) goes into `metadata.substage` instead of
 * widening this union.
 */
export type EmitStage = 'capture' | 'fragment' | 'classify' | 'regen' | 'embed'

export type EmitEvent = (event: {
  /** Null for regen/embed batch jobs that are not entry-scoped. */
  entryKey: string | null
  jobId: string
  stage: EmitStage
  status: 'started' | 'completed' | 'failed'
  fragmentKey?: string
  metadata?: Record<string, unknown>
}) => Promise<void>

// ── Per-Stage Dependencies ───────────────────────────────────────────────────

export interface FragmentDeps {
  llmCall: (system: string, user: string) => Promise<FragmentationOutput>
  emitEvent: EmitEvent
}

export interface FragmentResult {
  content: string
  type: string
  confidence: number
  sourceSpan: string
  suggestedSlug: string
  title: string
  tags: string[]
  wikiLinks: string[]
}

// ── Linking Stage Dependencies ──────────────────────────────────────────────

export interface ThreadInfo {
  lookupKey: string
  name: string
  type: string | null
  prompt: string | null
  description: string | null
}

export interface WikiClassifyDeps {
  searchCandidates: (
    content: string,
    limit: number
  ) => Promise<Array<{ wikiKey: string; score: number }>>
  loadThreads: (wikiKeys: string[]) => Promise<ThreadInfo[]>
  /**
   * Resolve the owner-Person display name (#238). Implementations should
   * return null when no owner row is seeded yet — the loader falls back
   * to a generic "the owner" label so the prompt's [AUTHORSHIP] block
   * stays grammatical.
   */
  loadOwnerName?: () => Promise<string | null>
  llmCall: (system: string, user: string) => Promise<WikiClassificationOutput>
  emitEvent: EmitEvent
}

export interface WikiClassifyResult {
  wikiEdges: Array<{ wikiKey: string; score: number }>
  rawAssignments?: Array<{ wikiKey: string; confidence: number; reasoning: string }>
}

export interface FragRelateDeps {
  vectorSearch: (
    content: string,
    limit: number
  ) => Promise<Array<{ fragmentKey: string; score: number }>>
  loadFragmentContent: (fragmentKey: string) => Promise<string | null>
  llmCall: (system: string, user: string) => Promise<FragmentRelevanceOutput>
  emitEvent: EmitEvent
}

export interface FragRelateResult {
  relatedEdges: Array<{ fragmentKey: string; score: number }>
}

export interface PersistDeps {
  insertEntry: (entry: Record<string, unknown>) => Promise<void>
  insertFragment: (fragment: Record<string, unknown>) => Promise<void>
  insertEdge: (edge: Record<string, unknown>) => Promise<void>
  insertPerson: (person: Record<string, unknown>) => Promise<void>
  /** Update fragment embedding by lookupKey. No-op if embedding is null. */
  updateFragmentEmbedding: (fragmentKey: string, embedding: number[]) => Promise<void>
  /** Upsert a person: match by canonical_name (ILIKE), merge aliases, or insert. */
  upsertPerson: (input: {
    personKey: string
    canonicalName: string
    verified: boolean
  }) => Promise<{ personKey: string; isNew: boolean }>
  /** Merge new aliases into an existing person row. Case-insensitive dedup. */
  mergePersonAliases: (personKey: string, newAliases: string[]) => Promise<void>
  /** Optional callback fired after a new person is created (for audit logging). */
  onPersonCreated?: (personKey: string, name: string) => void
  emitEvent: EmitEvent
  openRouterConfig: OpenRouterConfig
}

export interface PersistResult {
  entryKey: string
  fragmentKeys: string[]
}

// ── Entity Extraction ───────────────────────────────────────────────────────

export interface ResolutionConfig {
  scoreFloor: number
  ratioThreshold: number
  canonicalWeight: number
  aliasWeight: number
}

export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  scoreFloor: 60,
  ratioThreshold: 1.5,
  canonicalWeight: 5,
  aliasWeight: 4,
}

export interface KnownPerson {
  lookupKey: string
  canonicalName: string
  aliases: string[]
}

export interface EntityExtractDeps {
  loadAllPeople: () => Promise<KnownPerson[]>
  llmCall: (system: string, user: string) => Promise<PeopleExtractionOutput>
  emitEvent: EmitEvent
  config: ResolutionConfig
  makePeopleKey: () => string
}

export interface EntityExtractResult {
  peopleMap: Map<string, string>
  newAliases: Map<string, string[]>
  extractions: PeopleExtractionOutput['people']
  newPeople: Array<{ personKey: string; canonicalName: string; verified: boolean }>
}
