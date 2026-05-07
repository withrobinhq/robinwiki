import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { usageEvents } from './schema.js'

/**
 * Stage taxonomy for usage_events.stage. Mirrors pipeline_events.stage so
 * the dashboard can join the two by job_id and surface "this regen took
 * 47s, 12k tokens, $0.018, 3 stages" without ambiguity. `search` is
 * reserved for the future MCP search-cost tracking.
 */
export type UsageStage =
  | 'capture'
  | 'fragment'
  | 'classify'
  | 'regen'
  | 'embed'
  | 'search'

/**
 * Hardcoded model pricing table for v0.2.0. Costs are in USD per 1M tokens
 * (the OpenRouter dashboard format). v0.3.0 will fetch /models on boot
 * and cache 24h; for now, prices drift with provider changes — operators
 * should bump these when they notice the dashboard total drifting from
 * the OpenRouter ledger.
 *
 * Each entry has separate prompt and completion rates because most
 * providers charge differently per direction. Embedding models use the
 * `prompt` rate (input only — there is no completion).
 *
 * TODO(v0.3.0): replace with a /models fetch + 24h cache.
 */
interface ModelPricing {
  /** USD per 1M prompt (input) tokens. */
  promptPer1M: number
  /** USD per 1M completion (output) tokens. Zero for embeddings. */
  completionPer1M: number
  /** Provider tag used for usage_events.provider. */
  provider: string
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Default wiki-writer (Sonnet 4.6, used by regen + entity extract paths).
  'anthropic/claude-sonnet-4.6': {
    promptPer1M: 3,
    completionPer1M: 15,
    provider: 'anthropic',
  },
  // Classification / fast paths (Haiku 4.5).
  'anthropic/claude-haiku-4.5': {
    promptPer1M: 1,
    completionPer1M: 5,
    provider: 'anthropic',
  },
  // Fragmentation (Gemini 2.5 Pro).
  'google/gemini-2.5-pro': {
    promptPer1M: 1.25,
    completionPer1M: 10,
    provider: 'google',
  },
  // Embedding default.
  'openai/text-embedding-3-small': {
    promptPer1M: 0.02,
    completionPer1M: 0,
    provider: 'openai',
  },
  // Future-safe (#221): qwen 1536-MRL.
  'qwen/qwen3-embedding-8b': {
    promptPer1M: 0.05,
    completionPer1M: 0,
    provider: 'qwen',
  },
}

/**
 * Compute cost in 1e-6 USD (micros) for a given token mix on a given
 * model. Returns 0 when the model is unknown — callers should still
 * insert the row so token counts are not lost; only cost rolls up wrong.
 */
export function computeCostUsdMicros(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  // (tokens / 1_000_000) * (USD per 1M) * 1_000_000 (USD → micros) cancels
  // the 1M divisor. So: tokens × pricing × 1 = whole micros directly.
  // Round to keep the column integer-safe.
  const promptMicros = Math.round(promptTokens * pricing.promptPer1M)
  const completionMicros = Math.round(completionTokens * pricing.completionPer1M)
  return promptMicros + completionMicros
}

/** Resolve provider tag for a model string. Falls back to 'openrouter'. */
export function providerForModel(model: string): string {
  return MODEL_PRICING[model]?.provider ?? 'openrouter'
}

export interface EmitUsageEventParams {
  entryKey?: string | null
  wikiKey?: string | null
  fragmentKey?: string | null
  userId?: string | null
  sourceClient?: string | null
  stage: UsageStage
  model: string
  provider?: string
  promptTokens: number
  completionTokens: number
  durationMs?: number | null
  jobId?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * Insert one row into usage_events. Best-effort — caller should NOT block
 * the LLM call result on this insert succeeding. The wrap helper in
 * packages/agent/src/agents/caller.ts already handles failure suppression
 * at the call site.
 */
export async function emitUsageEvent(
  db: PostgresJsDatabase,
  params: EmitUsageEventParams
): Promise<void> {
  const totalTokens = params.promptTokens + params.completionTokens
  const costUsdMicros = computeCostUsdMicros(
    params.model,
    params.promptTokens,
    params.completionTokens
  )
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    entryKey: params.entryKey ?? null,
    wikiKey: params.wikiKey ?? null,
    fragmentKey: params.fragmentKey ?? null,
    userId: params.userId ?? null,
    sourceClient: params.sourceClient ?? null,
    stage: params.stage,
    model: params.model,
    provider: params.provider ?? providerForModel(params.model),
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens,
    costUsdMicros,
    durationMs: params.durationMs ?? null,
    jobId: params.jobId ?? null,
    metadata: params.metadata ?? null,
  })
}

/** Aggregate cost over a time range. Used by /usage/summary in A4. */
export async function sumCostByStage(
  db: PostgresJsDatabase,
  sinceIso: string
): Promise<Array<{ stage: string; costUsdMicros: number; totalTokens: number }>> {
  const rows = (await db.execute(
    sql`SELECT stage,
               COALESCE(SUM(cost_usd_micros), 0)::bigint AS cost_usd_micros,
               COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
        FROM usage_events
        WHERE created_at >= ${sinceIso}::timestamp
        GROUP BY stage
        ORDER BY stage`
  )) as Array<{ stage: string; cost_usd_micros: string | number; total_tokens: string | number }>
  return rows.map((r) => ({
    stage: r.stage,
    costUsdMicros: Number(r.cost_usd_micros),
    totalTokens: Number(r.total_tokens),
  }))
}
