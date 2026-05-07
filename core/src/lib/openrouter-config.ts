import { and, eq } from 'drizzle-orm'
import { NoOpenRouterKeyError, type OpenRouterConfig } from '@robin/agent'
import { DEFAULT_MODEL, FRAGMENT_MODEL, FAST_MODEL } from '@robin/shared/prompts'
import { db } from '../db/client.js'
import { configs } from '../db/schema.js'

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

/** Embedding models known to produce 1536-dimension vectors (matches DB column width). */
export const SAFE_EMBEDDING_MODELS = [
  'openai/text-embedding-3-small', // native 1536
  'qwen/qwen3-embedding-8b',       // MRL truncated to 1536
] as const satisfies readonly string[]

/** Default model for each pipeline role (DB key → model ID). */
export const MODEL_DEFAULTS: Record<string, string> = {
  extraction: FRAGMENT_MODEL,
  classification: FAST_MODEL,
  wiki_generation: DEFAULT_MODEL,
  embedding: DEFAULT_EMBEDDING_MODEL,
}

/**
 * Loads the OpenRouter config from environment + DB.
 *
 * - API key comes from process.env.OPENROUTER_API_KEY.
 * - Per-task model preferences come from `configs` table (kind = 'model_preference').
 * - Missing DB rows fall back to hardcoded defaults.
 * - Embedding model is restricted to SAFE_EMBEDDING_MODELS (1536 dims).
 *
 * Throws NoOpenRouterKeyError when the key is missing so BullMQ workers
 * mark the job failed and apply backoff.
 */
export async function loadOpenRouterConfig(): Promise<OpenRouterConfig> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new NoOpenRouterKeyError()

  const rows = await db
    .select({ key: configs.key, value: configs.value })
    .from(configs)
    .where(
      and(
        eq(configs.scope, 'system'),
        eq(configs.kind, 'model_preference'),
      ),
    )

  const dbPrefs = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.value === 'string') {
      dbPrefs.set(row.key, row.value)
    }
  }

  function resolve(dbKey: string): string {
    const fromDb = dbPrefs.get(dbKey)
    if (!fromDb) return MODEL_DEFAULTS[dbKey] ?? ''

    // Embedding models must produce 1536-dim vectors to match our DB columns.
    if (dbKey === 'embedding') {
      return (SAFE_EMBEDDING_MODELS as readonly string[]).includes(fromDb)
        ? fromDb
        : (MODEL_DEFAULTS[dbKey] ?? '')
    }
    return fromDb
  }

  return {
    apiKey,
    models: {
      extraction: resolve('extraction'),
      classification: resolve('classification'),
      wikiGeneration: resolve('wiki_generation'),
      embedding: resolve('embedding'),
    },
  }
}
