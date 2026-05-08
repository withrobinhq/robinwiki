/**
 * Typed caller factory for Mastra agents.
 *
 * Creates DI-friendly functions backed by Mastra agents. Stages receive these
 * as deps, they never import Agent directly, keeping Mastra as an
 * implementation detail and tests simple (mock the function, return typed data).
 *
 * Retry contract:
 *   Mastra layer: 2 retries for transient errors (429, 500, 502, 503)
 *   BullMQ layer: handles persistent failures (outages, DB errors)
 *   See .planning/mastra-agents-plan.md for full retry design.
 */

import type { Agent } from '@mastra/core/agent'
import type { ZodType } from 'zod'

/** Retry config for Mastra agent calls. */
export const AGENT_RETRY_CONFIG = {
  maxRetries: 2,
  retryableStatuses: [429, 500, 502, 503],
  backoff: { initial: 1000, multiplier: 3 }, // 1s, 3s
} as const

/**
 * Output token cap shared by every agent.generate() call.
 *
 * Sonnet 4.6 supports 16k output tokens; the OpenRouter SDK default is
 * ~4096, which silently truncated long wiki regen output (issue #257).
 * Raising the cap globally is safe because shorter prompts simply finish
 * sooner, the cap is an upper bound, not a target length.
 */
export const AGENT_MAX_OUTPUT_TOKENS = 16000

/** Model settings passed to every agent.generate() call. */
export const AGENT_MODEL_SETTINGS = {
  maxRetries: AGENT_RETRY_CONFIG.maxRetries,
  maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
} as const

/**
 * Telemetry context passed to a usage recorder. Phase A3: every OpenRouter
 * call writes one usage_events row keyed by job_id so cost correlates with
 * pipeline_events for the same job.
 */
export interface UsageContext {
  /** Pipeline stage (capture | fragment | classify | regen | embed). */
  stage: string
  /** BullMQ job id, correlates to pipeline_events.job_id. */
  jobId?: string | null
  entryKey?: string | null
  wikiKey?: string | null
  fragmentKey?: string | null
  userId?: string | null
  sourceClient?: string | null
  /** Model id (e.g. 'anthropic/claude-sonnet-4.6'). */
  model: string
}

/**
 * Token counts surfaced by Mastra's `result.usage`. Provider names vary
 * (some report `prompt_tokens`, some `inputTokens`); the wrap helper
 * normalises both shapes before invoking the recorder.
 */
export interface UsageRecord {
  promptTokens: number
  completionTokens: number
  durationMs: number
  /** Optional extra detail (retry count, model fallback, etc.). */
  metadata?: Record<string, unknown>
}

/** Recorder function. Implementations live in core (DB access required). */
export type UsageRecorder = (
  context: UsageContext,
  record: UsageRecord
) => Promise<void> | void

/**
 * Pull `result.usage` into a normalised shape. Mastra and the OpenRouter
 * SDK each surface different field names depending on version; this
 * helper consolidates them so the recorder always sees the same keys.
 *
 * Returns null when no usage info is present (older provider responses,
 * or a structured-output retry that the SDK swallowed).
 */
function extractUsage(result: unknown): {
  promptTokens: number
  completionTokens: number
} | null {
  if (!result || typeof result !== 'object') return null
  const usage = (result as { usage?: Record<string, unknown> }).usage
  if (!usage || typeof usage !== 'object') return null
  // Mastra (newer): { inputTokens, outputTokens }
  // OpenRouter SDK: { prompt_tokens, completion_tokens, total_tokens }
  // Anthropic native: { input_tokens, output_tokens }
  const promptTokens = Number(
    usage.promptTokens ??
      usage.prompt_tokens ??
      usage.inputTokens ??
      usage.input_tokens ??
      0
  )
  const completionTokens = Number(
    usage.completionTokens ??
      usage.completion_tokens ??
      usage.outputTokens ??
      usage.output_tokens ??
      0
  )
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null
  }
  return { promptTokens, completionTokens }
}

/**
 * Default no-op recorder. Tests and contexts that do not pass a recorder
 * (legacy callers, fixtures) still work; cost is simply not logged.
 */
const noopRecorder: UsageRecorder = () => {}

/**
 * Creates a typed caller for structured JSON output.
 * The Zod schema validates the LLM response; the caller returns the parsed object.
 */
export function createTypedCaller<T>(agent: Agent, schema: ZodType<T>) {
  return async (system: string, user: string): Promise<T> => {
    const result = await agent.generate(user, {
      system,
      structuredOutput: { schema },
      modelSettings: AGENT_MODEL_SETTINGS,
    })
    return result.object as T
  }
}

/**
 * Creates a string caller for free-form text output (wiki regen, person synthesis).
 * No schema validation, returns the raw text response.
 */
export function createStringCaller(agent: Agent) {
  return async (system: string, user: string): Promise<string> => {
    const result = await agent.generate(user, {
      system,
      modelSettings: AGENT_MODEL_SETTINGS,
    })
    return result.text
  }
}

/**
 * withUsage — Phase A3 cost telemetry decorator.
 *
 * Wraps a typed or string caller with usage-event emission. The wrapped
 * function captures `result.usage` from `agent.generate()`, normalises
 * the token counts, and hands them to `recordUsage()` along with the
 * caller-supplied context. Errors during recording are swallowed so
 * cost-logging failures never block the LLM result.
 *
 * Usage:
 *   const fragCall = withUsage(
 *     createTypedCaller(agents.fragmenter, fragmentationSchema),
 *     {
 *       agent: agents.fragmenter,
 *       context: () => ({ stage: 'fragment', jobId, entryKey, model: 'gemini' }),
 *       record: emitUsageEvent,
 *     },
 *   )
 *
 * The context callback is invoked PER CALL so streaming-fragment paths
 * can stamp each fragment's lookupKey on its own row.
 */
export interface WithUsageOptions {
  /** Mastra agent so we can re-issue agent.generate() and capture usage. */
  agent: Agent
  /** Per-call context resolver (jobId, entryKey, etc. evolve as fragments stream). */
  context: () => UsageContext
  /** DB recorder, supplied by core. Falls back to noop when undefined. */
  record?: UsageRecorder
}

export function withTypedUsage<T>(
  schema: ZodType<T>,
  options: WithUsageOptions,
): (system: string, user: string) => Promise<T> {
  const recorder = options.record ?? noopRecorder
  return async (system, user) => {
    const t0 = performance.now()
    const result = await options.agent.generate(user, {
      system,
      structuredOutput: { schema },
      modelSettings: AGENT_MODEL_SETTINGS,
    })
    const durationMs = Math.round(performance.now() - t0)
    const usage = extractUsage(result)
    if (usage) {
      try {
        await recorder(options.context(), {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          durationMs,
        })
      } catch {
        // Cost-logging must not block the LLM result. Swallow.
      }
    }
    return result.object as T
  }
}

export function withStringUsage(
  options: WithUsageOptions,
): (system: string, user: string) => Promise<string> {
  const recorder = options.record ?? noopRecorder
  return async (system, user) => {
    const t0 = performance.now()
    const result = await options.agent.generate(user, {
      system,
      modelSettings: AGENT_MODEL_SETTINGS,
    })
    const durationMs = Math.round(performance.now() - t0)
    const usage = extractUsage(result)
    if (usage) {
      try {
        await recorder(options.context(), {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          durationMs,
        })
      } catch {
        // see withTypedUsage
      }
    }
    return result.text
  }
}
