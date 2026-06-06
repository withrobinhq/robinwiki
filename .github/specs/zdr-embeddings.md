# Spec: ZDR-compliant embeddings via OpenRouter

## Status

Draft

## Problem

Robin's embedding calls (`packages/agent/src/embeddings.ts`) hit OpenRouter but do not enforce Zero Data Retention. Embedding input is user knowledge (fragments, wiki descriptions, people records). Without ZDR, upstream providers may retain this data for training or logging.

Secondary issue: `embedText()` does not send `dimensions: 1536` despite the shared types comment claiming it does. Qwen3-Embedding-8B natively returns 4096 dimensions. Without the parameter, the vector either mismatches the `vector(1536)` pgvector column or silently truncates depending on provider behavior.

## Current state

- Default model: `qwen/qwen3-embedding-8b` (already ZDR-compliant on SiliconFlow and Nebius)
- Alternative: `openai/text-embedding-3-small` (ZDR-compliant on OpenAI)
- Endpoint: `POST https://openrouter.ai/api/v1/embeddings`
- Request body: `{ model, input }` — missing `dimensions` and `provider` fields
- Schema: four `vector(1536)` columns across `fragments`, `wikis`, `people`, `wiki_agent_schema`

## Changes

### 1. `packages/agent/src/embeddings.ts` — embedText()

Add `dimensions` and `provider.zdr` to the request body:

```typescript
export interface EmbedConfig {
  apiKey: string
  model: string
  zdr?: boolean   // default true in production
}

body: JSON.stringify({
  model: config.model,
  input: text,
  dimensions: EMBEDDING_DIMENSIONS,
  provider: config.zdr !== false ? { zdr: true } : undefined,
}),
```

Import `EMBEDDING_DIMENSIONS` from `@robin/shared`.

### 2. `packages/shared/src/types/embedding.ts` — model registry

Add ZDR metadata to the model registry for documentation purposes:

```typescript
export const SUPPORTED_EMBEDDING_MODELS = [
  'qwen/qwen3-embedding-8b',       // ZDR: SiliconFlow, Nebius
  'openai/text-embedding-3-small',  // ZDR: OpenAI
] as const
```

No functional change here, just documenting which providers back ZDR.

### 3. `core/src/lib/openrouter-config.ts` — config plumbing

Pass `zdr` flag through to EmbedConfig. Source from env:

```
EMBEDDING_ZDR=true          # default: true in production, false in dev
```

The config builder that creates `EmbedConfig` for callers (`persist.ts`, `embedding-retry-worker.ts`, `wiki-agent-schema.ts`, `search.ts`) adds `zdr: boolean` from this env var.

### 4. `packages/agent/src/embeddings.ts` — probeEmbeddingReachable()

The boot-time probe also needs the `dimensions` and `provider` fields. It already receives the full `EmbedConfig`, so this comes free from change #1.

## Files to change

| File | Change |
|------|--------|
| `packages/agent/src/embeddings.ts` | Add `dimensions`, `provider.zdr` to request body. Extend `EmbedConfig` with `zdr` |
| `packages/shared/src/types/embedding.ts` | ZDR comments on model list |
| `core/src/lib/openrouter-config.ts` | Read `EMBEDDING_ZDR` env var, pass through to embed config |
| `core/src/bootstrap/env.ts` | Add `EMBEDDING_ZDR` to known env vars (optional, not required) |

## ZDR-compliant embedding models (verified 2026-06-02)

Source: `https://openrouter.ai/api/v1/endpoints/zdr`

| Model | Provider | Context | Dims | Price/1M tokens |
|-------|----------|---------|------|-----------------|
| `qwen/qwen3-embedding-8b` | SiliconFlow | 32K | 4096 (MRL to 1536) | $0.04 |
| `qwen/qwen3-embedding-8b` | Nebius | 32K | 4096 (MRL to 1536) | $0.01 |
| `qwen/qwen3-embedding-4b` | DeepInfra | 32K | 2560 (MRL to 1536) | $0.02 |
| `openai/text-embedding-3-small` | OpenAI | 8K | 1536 (native) | $0.02 |
| `baai/bge-m3` | DeepInfra | 8K | 1024 (cannot reach 1536) | $0.01 |

Robin's two supported models are both ZDR-eligible. No model swap needed.

## What this does NOT change

- Embedding model selection — Qwen3-8B stays default, text-embedding-3-small stays alternative
- Vector dimensions — still 1536, no schema migration
- Retry/recovery logic — unchanged
- Search/retrieval — unchanged
- HyDE generation — unchanged (uses LLM, not embedding endpoint)

## Verification

- [ ] `embedText()` sends `dimensions: 1536` on every call
- [ ] `embedText()` sends `provider: { zdr: true }` when `config.zdr` is true
- [ ] Boot probe passes with ZDR enabled
- [ ] Returned vectors are 1536 dimensions (not 4096)
- [ ] Embedding retry worker passes ZDR config through
- [ ] `EMBEDDING_ZDR=false` disables ZDR flag (for local dev without ZDR-eligible providers)
