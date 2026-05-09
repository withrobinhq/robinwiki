# Wiki Agent Schema

Robin keeps two parallel representations of every wiki: the **human-facing wiki body** that operators read, and the **agent-facing schema** that AI clients consume during retrieval and reasoning. This document describes the agent-facing layer.

> **Note (Stream S, v0.2.2):** `wiki_agent_schema` is no longer a side effect of regen. It is a service-owned layer with regen as **one of several** writers. Every write goes through `ensureAgentSchema(db, wikiKey, options)` in `core/src/lib/wiki-agent-schema.ts`. See the [Writer registry](#writer-registry) section below for the canonical caller list.

## Why two layers

Humans and agents query the knowledge base differently. A human wants the rendered prose. An agent doing retrieval wants something else: phrasings that match likely queries, vocabulary that mirrors how questions get asked, and representations stable enough to embed and search.

The cognitive analogy is brain schema. People do not store memories as verbatim transcripts. They store gist-fitted, schema-shaped representations that get reconstructed on demand. The wiki body is the transcript. `wiki_agent_schema` is the gist layer that drives recall.

## Storage

```sql
CREATE TABLE wiki_agent_schema (
  wiki_key text NOT NULL REFERENCES wikis(wiki_key) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  generated_at timestamptz NOT NULL DEFAULT now(),
  generator_version text NOT NULL,
  PRIMARY KEY (wiki_key, kind)
);

CREATE INDEX wiki_agent_schema_embedding_idx
  ON wiki_agent_schema
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX wiki_agent_schema_kind_idx ON wiki_agent_schema (kind);
```

Multi-row keyed by `(wiki_key, kind)`. Each `kind` is a different representation pathway. New representation types add rows, not columns. No schema migration needed to add new kinds in the future.

The companion change to `wiki_types`:

```sql
ALTER TABLE wiki_types ADD COLUMN internal_framing text;
```

`internal_framing` carries the type-specific authoring instruction the agent-schema generator uses. Belief wikis get framed differently than Decision wikis than Skill wikis. This column is the type-aware scaffolding.

## Currently shipped kinds (v0.2.0)

| `kind` | Purpose | How it is generated |
|---|---|---|
| `description` | Description-derived embedding for the wiki | Direct embedding of `wikis.description` |
| `hyde_synthetic` | Hypothetical document optimized for retrieval | LLM-generated using the structured HyDE template (below) |

## Future kinds (post-v0.2.0)

These compose cleanly into the same table without schema change.

| `kind` | Purpose |
|---|---|
| `hyde_questions` | Doc2query: a list of questions the wiki answers, embedded together |
| `expanded_keywords` | Vocabulary expansion across synonyms and adjacent concepts |
| `retrieval_friendly_summary` | Condensed narrative form, ~50 words |
| `archetype_brief` | Type-specific summary (Decision: what was chosen and why; Skill: when to use it; etc.) |

## HyDE template (the `hyde_synthetic` kind)

HyDE is **Hypothetical Document Embeddings**, from Gao et al. 2022. Instead of embedding the user's query directly, an LLM generates a hypothetical document that would answer the query, then we embed that. Hypothetical documents and real answers share a vocabulary distribution; queries and real answers do not. The result is sharper retrieval on natural-language queries.

A naive HyDE prompt produces three failure modes: vocabulary collapse, drift (hallucinated facts not in the source), and register mismatch across wiki types. Robin's HyDE template addresses all three through structure, grounding, and type-awareness.

### Template structure

```
[CONTEXT]
Wiki type: {wiki_type}
Title: {title}
Description: {description}
Source excerpt: {first 800 chars of body}

[TASK]
Generate a synthetic retrieval-optimized passage for this wiki. The
passage will be embedded and used to match user queries against this
wiki at search time.

The passage MUST:
- Cover 3 to 5 questions a non-expert would naturally ask about this topic
- Use the vocabulary the user would use, not the jargon in the source
- Stay grounded in claims present in the source
- Read in the register appropriate for a {wiki_type} wiki:
  {internal_framing}

The passage MUST NOT:
- Introduce claims not present in the source
- Use meta-language like "this wiki" or "this document"
- Exceed 200 words

[OUTPUT]
Write the passage now. No preamble, no headers, prose only.
```

### Per-wiki-type `internal_framing` strings (v0.2.0 set)

These ship as defaults in the wiki-types YAML and load into `wiki_types.internal_framing` on bootstrap. New wiki types created in the future supply their own framing in the same git commit that defines the type.

| Wiki type | `internal_framing` |
|---|---|
| **Belief** | Write as if explaining the position someone holds and why. Cover what they believe, the rationale, when it applies, and what would change their mind. |
| **Decision** | Write as if recounting why a choice was made. Cover what was chosen, what was rejected, the constraints, and who was involved. |
| **Skill** | Write as if teaching how to perform this. Cover the steps, the rationale, common mistakes, and when to use it. |
| **Principle** | Write as if explaining a guiding rule. Cover what the rule is, when it applies, what happens when violated, and examples. |
| **Project** | Write as if updating someone on the project's state. Cover what is being built, why, where it stands, and what is next. |
| **Research** | Write as if summarizing a literature review. Cover the question, the evidence, the sources, and the synthesis. |
| **Voice** | Write as if capturing how someone phrases things. Cover characteristic phrases, tone, and go-to framings. |
| **Log** | Write as if recounting an event or session. Cover what happened, when, who, and what was discussed. |
| **Agent** | Write as if defining an LLM agent's role. Cover the purpose, instructions, capabilities, and constraints. |
| **Objective** | Write as if articulating a goal. Cover what success looks like, the deadline, the constraints, and dependencies. |

### Concrete before/after

Naive HyDE on a Decision wiki titled "Shipping cadence: ship daily":

> Shipping cadence is an important practice in software development. It involves regularly releasing software updates to ensure that the product remains relevant and up-to-date. By shipping daily, teams can iterate quickly and respond to user feedback in a timely manner.

Generic, vocabulary-poor, fails recall on natural questions.

Templated HyDE with type-aware framing on the same wiki:

> The team chose to ship daily rather than batch releases weekly because the feedback loop matters more than rollout polish. Daily ships mean bugs surface within hours and feature drift gets caught early. The constraint was deploy infrastructure: independent rollback was required. Weekly batches were rejected because they obscure which change broke what. Common questions covered here: how to handle bugs on Friday afternoon, what about features that span multiple days, when to merge to main, how this interacts with on-call.

Covers the rationale, the alternatives, the constraints, and explicit "common questions". Recall improves on queries like "how do we ship", "why daily releases", "what about Friday bugs", and similar phrasings that share no vocabulary with the wiki body itself.

## Configuration

### Environment variable

```
RETRIEVAL_INDEX_MODEL=<openrouter-model-slug>
```

The LLM used to generate non-direct kinds (currently just `hyde_synthetic`). Defaults to the same model as the wiki writer. Operators can point this at a more capable model since agent-schema generation runs once per wiki per regen, not on every user interaction.

### Generator versioning

`generator_version` is a string column in every row of `wiki_agent_schema`. It bumps when any of the following changes:

- The structured prompt template
- A wiki type's `internal_framing`
- The embedding model
- The generator LLM

Version 1 ships as `hyde_v1`. When a v2 prompt or framing change lands, the bootstrap loader updates the canonical version and `/settings/outstanding` surfaces wikis whose stored version is below current. Backfill is incremental.

## Generation pipeline

```
Trigger: regen, manual rebuild, or generator_version bump
  ↓
Load wiki record (title, description, body, wiki_type)
  ↓
Load wiki_types.internal_framing for this wiki's type
  ↓
For each kind in [description, hyde_synthetic]:
  ↓
  description kind:
    Embed wikis.description directly
    Insert row (kind='description', content=description, embedding, version)
  ↓
  hyde_synthetic kind:
    Render template with context + task + internal_framing
    Call RETRIEVAL_INDEX_MODEL with the prompt
    Embed the LLM output
    Insert row (kind='hyde_synthetic', content=output, embedding, version)
  ↓
Done
```

Generation is idempotent per `(wiki_key, kind, generator_version)`. Re-running an already-current generation is a no-op via `INSERT ... ON CONFLICT DO NOTHING`.

## Writer registry

Stream S (v0.2.2) consolidated every `wiki_agent_schema` write path under a single helper, `ensureAgentSchema(db, wikiKey, options)` in `core/src/lib/wiki-agent-schema.ts`. The helper owns all INSERT statements; every other module calls it with a mode tag describing the calling surface. A static contract test (`core/src/__tests__/agent-schema-writer-contract.test.ts`) fails the build if a direct INSERT into `wikiAgentSchema` ever lands outside the helper.

The registered modes and their callers:

| Mode | Caller | Trigger | Writes | Notes |
|---|---|---|---|---|
| `create` | `core/src/routes/wikis.ts` POST | Wiki created | `description` | Uses `precomputedEmbedding` from the legacy wikis.embedding step. Zero extra LLM/embedding cost. |
| `refresh` | `core/src/routes/wikis.ts` PUT | Description changed | `description`, stales `hyde_synthetic` | Synchronous re-embed; stale signals the heal worker to regenerate hyde async. |
| `heal` | `core/src/queue/embedding-retry-worker.ts` | 15-minute cron | `description` and/or `hyde_synthetic` | Two passes per tick with separate batch caps (25 description, 5 hyde). |
| `regen-bump` | `core/src/lib/regen.ts` | Wiki regen completes | `description`, `hyde_synthetic` | Short-circuits when description hash matches the stored row. |
| `backfill` | `core/src/lib/backfill-runner.ts` (used by `core/scripts/backfill-wiki-agent-schema.ts` and `POST /admin/backfill/wiki-agent-schema`) | Operator one-shot | `description` | Idempotent: skips wikis whose row is already current. |

### How to add a new write path

1. Pick a mode name and add it to the `EnsureMode` union in `core/src/lib/wiki-agent-schema.ts`.
2. Add a `case` in the `ensureAgentSchema` switch describing the policy: which kinds to write, which to stale, and any short-circuit logic.
3. Update the `Writer registry` table above with the new caller, trigger, and what it writes.
4. Update the contract test only if the new caller needs to live outside `core/src/lib/wiki-agent-schema.ts`. The default expectation is that the caller invokes `ensureAgentSchema(...)` from its own module; the helper alone keeps the INSERT.
5. Add coverage in `core/src/lib/wiki-agent-schema.test.ts` for the new mode.

Do not bypass the helper. The contract test will fail the build, and the writer-registry invariant is what lets retrieval, backfill audits, and the heal worker reason about agent_schema rows without each one re-implementing the embed pipeline.

## Retrieval flow

`hybridSearch()` consumes the agent-schema table:

```
Query arrives
  ↓
Embed the query (single embedding call)
  ↓
[Parallel fan-out]
  BM25 search on wiki body
  Vector search on wiki_agent_schema WHERE kind='description'
  Vector search on wiki_agent_schema WHERE kind='hyde_synthetic'
  ↓
RRF fusion across all three input streams
  ↓
Return top N
```

When new kinds land (`hyde_questions`, `expanded_keywords`, etc.), they slot into the parallel fan-out as additional vector searches. RRF handles N inputs natively. No retrieval code changes for new kinds beyond adding the search query.

## Cost profile

Per-wiki regen with v0.2.0 agent-schema enabled:

| Stage | Wall-clock | LLM calls | Embeddings |
|---|---|---|---|
| Classifier | 2 to 5s | 1 | 0 |
| Writer (wiki body) | 5 to 15s | 1 | 0 |
| Embed description | 200 to 500ms | 0 | 1 |
| HyDE generator | 3 to 8s | 1 | 0 |
| Embed hyde_synthetic | 200 to 500ms | 0 | 1 |
| **Total** | **10 to 28s** | **3** | **2** |

Compared to the pre-v0.2.0 pipeline (no agent-schema): roughly +30 to +50% wall-clock per regen, +1 LLM call, +1 embedding. Token cost increase is approximately +20 to +25% at typical OpenRouter rates.

Search latency increase is bounded by the slowest parallel vector lookup, roughly +20 to +50ms over the pre-v0.2.0 BM25 + single-vector path. Negligible for operator and agent flows.

## Operational surface

`/settings/outstanding` is the single place operators see what is pending across the agent-schema, fragment-relationship-backfill (#258), and any other generator_version-keyed backfill operations:

- Count of wikis where `wiki_agent_schema.generator_version` is below current
- Count of fragments awaiting RELATED_TO backfill
- "Run now" CTA per row, triggers the same admin endpoint the cron uses

The cron handles passive backfill at midnight. The settings UI gives operators visibility plus manual override. The admin endpoint is the shared primitive both surfaces use.

## Migration plan

Three migrations, sequenced:

1. **`wiki_agent_schema` table creation**: schema, indexes (HNSW + kind), constraints. No backfill yet. Existing `wikis.embedding` stays in place during transition.
2. **`wiki_types.internal_framing` column**: ALTER TABLE add column, nullable. Populated on next bootstrap by the YAML loader using the v0.2.0 framing set above.
3. **Backfill cutover**: regen pipeline starts dual-writing into `wiki_agent_schema`. Retrieval reads from the new table when rows exist, falls back to `wikis.embedding` when they do not. Once 100% of wikis have rows, drop `wikis.embedding` in a follow-up migration.

## Recovery on existing instances

A deployment that ran before #69 closed the create-time and edit-time write
paths will have a long tail of wikis with no `wiki_agent_schema` rows. Two
recovery surfaces, sequenced:

1. **One-shot description backfill**:

   ```
   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts            # write
   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts -- --dry-run
   pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts -- --limit 50
   ```

   Idempotent. Re-running on a clean instance is a no-op. Only embeds and
   writes the `kind='description'` row, which is the cheap path (one
   embedding call per wiki, no LLM round-trip).

2. **Incremental HyDE heal**: the embedding-retry worker (15-minute cron,
   `core/src/queue/embedding-retry-worker.ts`) catches up missing
   `kind='hyde_synthetic'` rows in batches of 5 per tick. A 200-wiki tail
   completes in roughly 10 hours by design; bounding the per-tick LLM spend
   matters more than the recovery wall-clock here. The same worker pass
   also fixes any `kind='description'` rows whose embedding came back NULL
   on the first attempt.

The worker pass and the script use the same `findWikisMissingDescriptionRow`
and `findWikisMissingHydeRow` queries, so there is one source of truth for
"what still needs writing".

## What this is not

- Not a cache layer. The agent schema is the canonical retrieval surface. The wiki body is the human content surface. Each is authoritative for its consumer.
- Not user-facing. Operators do not directly read `wiki_agent_schema` content. They see the wiki body. The agent schema only surfaces through retrieval.
- Not derived from the body alone. The HyDE generator uses title + description + body excerpt as grounding context, with type-aware framing as an authoring instruction. It is not a summarization of the body.

## Open questions for v0.3.0+

These are deliberately deferred and noted here for the next planning cycle.

- **Multi-perspective HyDE**: generate multiple synthetic passages per wiki (different framings) and embed each. Higher recall, higher cost. Probably ships as additional `kind` rows rather than as a parallel HyDE pipeline.
- **doc2query (`hyde_questions`)**: list-of-questions phrasing. May outperform passage-form HyDE on conversational queries. Drops in as a new `kind` with no schema change.
- **Embedding model upgrade flow**: when OpenRouter publishes a better embedding model, we bump the embedding model env var. The `generator_version` column should encode this so backfill targets the right rows.
- **Cost telemetry**: per-kind token attribution in the spend dashboard, so operators can see HyDE's contribution to monthly spend separately from writer and classifier.

## Related

- Stream G plan: `.planning/v1-a-game/streams/G-reading-search-graph/PLAN.md`
- HyDE paper: Gao et al. 2022, "Precise Zero-Shot Dense Retrieval without Relevance Labels"
- Robin retrieval today: `core/src/lib/search.ts`, `core/src/mcp/server.ts` (search tool)
- Wiki types: `core/src/wiki-types/` (YAML defaults), `core/src/db/schema.ts` (wiki_types table)
