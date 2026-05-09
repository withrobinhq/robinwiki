// ── Dedup ────────────────────────────────────────────────────────────────
export { jaccardSimilarity, dedupBatch } from './dedup.js'

// ── Stage-runner orchestrators ───────────────────────────────────────────
export { runExtraction, runLinking } from './stages/index.js'
export { wikiClassify } from './stages/wiki-classify.js'
export { entityExtract, resolvePerson } from './stages/entity-extract.js'
export { persist, matchMentionsToFragments } from './stages/persist.js'
export type { ResolveResult } from './stages/entity-extract.js'

// ── People helpers (Stream P) ────────────────────────────────────────────
export { resolveOrDrop } from './people/resolveOrDrop.js'
export type {
  ResolveOutcome,
  ResolveOrDropContext,
  ResolveOrDropInput,
  SourceSpan,
} from './people/resolveOrDrop.js'
export { dedupCandidate } from './people/dedup.js'
export type { DedupCandidate, DedupHit } from './people/dedup.js'
export type {
  ExtractionOrchestratorDeps,
  LinkingOrchestratorDeps,
  ExtractionResult,
  LinkingResult,
} from './stages/index.js'
export type {
  ExtractionInput,
  LinkingInput,
  FragmentDeps,
  WikiClassifyDeps,
  FragRelateDeps,
  PersistDeps,
  PersistResult,
  EntityExtractDeps,
  EntityExtractResult,
  ResolutionConfig,
  KnownPerson,
  FragmentResult,
  EmitEvent,
} from './stages/types.js'
export { DEFAULT_RESOLUTION_CONFIG } from './stages/types.js'

// ── OpenRouter + embeddings ──────────────────────────────────────────────
export type { OpenRouterConfig } from './openrouter-config.js'
export { NoOpenRouterKeyError } from './openrouter-config.js'
export {
  embedText,
  probeEmbeddingReachable,
  takeLastEmbedFailure,
} from './embeddings.js'
export type { EmbedConfig, EmbedFailure } from './embeddings.js'

// ── Mastra agent factory + caller helpers ────────────────────────────────
export { createIngestAgents, createHydeAgent } from './agent-factory.js'
export type { IngestAgents } from './agent-factory.js'
export {
  createTypedCaller,
  createStringCaller,
  withTypedUsage,
  withStringUsage,
  AGENT_RETRY_CONFIG,
  AGENT_MODEL_SETTINGS,
} from './agents/caller.js'
export type {
  UsageContext,
  UsageRecord,
  UsageRecorder,
  WithUsageOptions,
} from './agents/caller.js'
