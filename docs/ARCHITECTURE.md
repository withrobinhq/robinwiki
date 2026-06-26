# Architecture

This document describes how Robin is built: the system model, the monorepo
layout, the AI ingest pipeline, the data model, search, the MCP surface, auth,
and the background workers. It is written for contributors who want to
understand the system before changing it.

For deploy and environment setup, see the [README](../README.md) and
[`docs/DEPLOY.md`](DEPLOY.md).

## System overview

Robin is a **single-tenant, single-user** knowledge base. One instance serves
one person. Everything that user writes lives as text rows in PostgreSQL —
there is no git-backed markdown store and no filesystem repo. The server owns
auth, the REST API, the MCP endpoint, and the AI pipeline that turns raw
thoughts into structured, searchable knowledge.

The capture loop:

1. You think out loud through an AI client (Claude Desktop, the web UI, or any
   MCP client).
2. Robin captures the raw text as an **entry**.
3. A background pipeline splits the entry into **fragments** (atomic ideas),
   extracts the **people** mentioned, and classifies each fragment into a
   **wiki** (a topic cluster) by topic.
4. Affected wikis are **regenerated** into prose, with citations linking back to
   the source fragments.
5. Everything is indexed for **hybrid search** — keyword (BM25) and semantic
   (vector) fused together.

The user never organizes anything by hand. Structure emerges from the pipeline.

## Monorepo layout

The repository is a pnpm-workspace monorepo orchestrated by Turborepo:

```
core/             @robin/core    — Hono API server, MCP server, AI pipeline, workers
wiki/             @robin/wiki    — Next.js 16 web frontend (shadcn/ui)
packages/agent    @robin/agent   — LLM agents (via Mastra), person resolution
packages/queue    @robin/queue   — BullMQ producer/consumer abstractions
packages/shared   @robin/shared  — Shared types, lookup keys, slug helpers, prompts
packages/caslock  @robin/caslock — Compare-and-swap distributed locking
packages/graph    @robin/graph   — Graph edge helpers
```

`core/` is the sole application: it owns all intelligence and every external
surface. The `packages/*` workspaces have strict boundaries — each builds
independently and exposes its own entry points. They must not be flattened into
`core/` or merged together.

`wiki/` is independent tooling-wise: it has its own `tsconfig` (bundler module
resolution) and uses ESLint with `eslint-config-next` rather than Biome.

## The AI ingest pipeline

The pipeline runs as a sequence of BullMQ jobs. A capture enters through one of
two doors:

- **`log_entry`** (or `POST /entries`): raw text that needs the full pipeline.
- **`log_fragment`**: a fragment written directly to a known wiki, bypassing
  extraction and classification — the fast path for when the user already knows
  where a thought belongs.

For a full `log_entry`, the stages are:

1. **Capture** — the raw text is persisted as an entry (the canonical audit
   record of what was said).
2. **Fragment** — an LLM agent (the *Fragmenter*) splits the entry into atomic
   fragments: one idea each, fluff stripped.
3. **Classify** — for each fragment, the system runs three sub-steps:
   - **Entity extraction** (*Elfie*) surfaces every person-like mention and
     splits it into known matches versus new candidates.
   - **Wiki classification** (*Marcel*) proposes which wiki each fragment
     belongs to, with a confidence score and the verbatim citation spans the
     fragment matched on. A relevance scorer (*Judge*) gates weak matches.
   - Fragments above the confidence threshold (`WIKI_CLASSIFY_THRESHOLD`,
     default `0.65`) get a `FRAGMENT_IN_WIKI` edge.
4. **Regen** — wikis that gained fragments are regenerated. The writer agent
   (*Quill*) rewrites the wiki body from its attached fragments using a
   type-specific prompt, preserving prior edits and emitting citations.
5. **Embed** — embeddings are generated for new fragments and wikis so search
   can find them; a healing worker backfills any that failed on the first pass.

Each stage records a row in `pipeline_events` so the run is observable end to
end. The named agent personas (Fragmenter, Elfie, Marcel, Judge, Quill) are
defined in `packages/agent/src/`; the model behind each is an OpenRouter slug,
wired through Mastra.

### How workers drive it

The pipeline is not a single function call — it is a chain of BullMQ jobs
flowing through Redis. The producer enqueues an extraction job when an entry
lands; the extraction worker fragments and persists, then enqueues linking; the
linking worker classifies and writes edges, then signals regen. Regen is
**debounced** per wiki so a burst of fragments produces one rebuild rather than
many.

The workers live in `core/src/queue/`:

| Worker | Responsibility |
|---|---|
| extraction / linking worker | Fragmentation, entity extraction, classification, edge writes |
| regen worker | Single-wiki and midnight-batch wiki body regeneration |
| embedding-retry worker | 15-minute heal loop for missing or null embeddings |
| prune-pipeline-events worker | Daily prune of old `pipeline_events` rows |
| linking-recovery worker | Recovers wikis stuck mid-classification |
| fragment-relationship-backfill worker | Backfills similarity edges between fragments |
| scheduler | Registers cron jobs and debounce signals |

## Data model

Robin stores everything in **PostgreSQL with pgvector** through **Drizzle ORM**.
Migrations are generated and pushed with the `db:generate` / `db:push` /
`db:migrate` scripts under `core/`.

### Core tables

- **entries** — raw captures (the audit record of what the user said).
- **fragments** — atomic ideas extracted from entries. Carry a 1536-dim
  `embedding` (pgvector) and a `search_vector` (tsvector) for hybrid search.
- **wikis** — topic clusters. Hold the human-facing body, an embedding, the
  process state, dirty signal, and publishing fields.
- **wiki_types** — the available wiki archetypes (Belief, Decision, Skill,
  Principle, Project, Research, Voice, Log, Agent, Objective, …), each with a
  type-specific authoring framing.
- **wiki_agent_schema** — a separate retrieval-optimized representation of each
  wiki (see [Retrieval](#wiki-agent-schema-the-retrieval-layer)).
- **people** — persons mentioned across fragments, with a quarantine status (see
  [People quarantine](#people-quarantine)).
- **edges** — the graph layer connecting everything (see below).
- **pipeline_events** — per-stage observability rows.
- **usage_events** — LLM/embedding cost tracking.
- **scheduled_jobs** — heartbeat row per recurring worker.
- **audit_log** — append-only record of user-visible state changes.
- **app_settings** — single-user configuration store.
- **users / sessions / accounts** — better-auth tables.

### The graph

Relationships are modeled as rows in a single **edges** table rather than as
foreign keys. Each edge has a source, a destination, an `edge_type`, and a
free-form `attrs` JSON blob. The main edge types:

| Edge type | Connects | Notes |
|---|---|---|
| `ENTRY_HAS_FRAGMENT` | entry → fragment | Provenance of every fragment |
| `FRAGMENT_IN_WIKI` | fragment → wiki | Classification result; `attrs` carries the match score, and the top match carries `citationSpans` |
| `FRAGMENT_MENTIONS_PERSON` | fragment → person | A person mention; `attrs` carries the person's status |
| `FRAGMENT_RELATED_TO_FRAGMENT` | fragment → fragment | Similarity links discovered during regen |
| `WIKI_RELATED_TO_WIKI` | wiki → wiki | Topic adjacency surfaced during classification |
| person relationships (`KNOWS`, `RELATED_TO`, `WORKS_AT`, …) | person → person | Hand-authored relationship edges |

### Soft-delete contract

Deletion is **soft and permanent**. Rows carry a `deleted_at` timestamp; a
non-null value means deleted. Read paths filter `deleted_at IS NULL` rather than
removing rows, which keeps provenance and audit trails intact. There is no
restore flow — soft delete is one-way, and a future cleanup job can purge old
rows. Because soft delete does not fire `ON DELETE CASCADE`, code that depends on
a deletion cascading (e.g. group memberships) cleans up explicitly.

## Hybrid search

Search lives in `core/src/lib/search.ts` and fuses two retrieval methods:

- **BM25** keyword search over the `search_vector` (tsvector) columns of
  fragments, wikis, and people.
- **Vector** search over the pgvector `embedding` columns using cosine distance.

The two ranked lists are combined with **Reciprocal Rank Fusion (RRF)**, which
scores each result by `1 / (k + rank)` (with `k = 60`) and sums across lists.
RRF normalizes by rank, which sidesteps the fact that BM25 scores and cosine
distances are not directly comparable. RRF also composes to any number of input
lists, so additional retrieval surfaces slot in without changing the fusion
logic.

Search supports three modes — `hybrid` (both), `bm25` (keyword only), and
`vector` (semantic only). Person rows in the quarantine queue are excluded from
user-facing search entirely.

### wiki_agent_schema: the retrieval layer

A wiki has two representations: the **human-facing body** (the prose an operator
reads and edits) and an **agent-facing schema** (`wiki_agent_schema`) tuned for
retrieval. The body is the content surface; the agent schema is the recall
surface.

The agent schema is a multi-row table keyed by `(wiki_key, kind)`. Each `kind`
is a different representation:

- `description` — a direct embedding of the wiki's description.
- `hyde_synthetic` — a Hypothetical Document Embedding: an LLM generates a
  synthetic passage that *would* answer likely queries about the wiki, written
  in the vocabulary a user would actually use, then that passage is embedded.
  Queries and real answers often share no vocabulary; hypothetical documents and
  real answers do, so embedding a hypothetical document sharpens recall on
  natural-language queries.

Adding new representation kinds is additive — new rows, no schema migration —
and each new kind slots into the search fan-out as another vector lookup that
RRF fuses in. Writes to this table all go through a single helper so the embed
pipeline lives in one place; a background heal pass keeps the rows current as
wikis change.

## MCP server

The MCP server (`core/src/mcp/server.ts`) is Robin's **canonical capture
surface**: anything the web UI can do, MCP can do, plus a few capture-oriented
tools that only exist over MCP. It speaks streamable HTTP (no stdio) so any MCP
client — Claude Desktop, ChatGPT, others — can connect.

The registered tools cover:

- **Capture**: `log_entry` (full pipeline), `log_fragment` (direct-to-wiki fast
  path).
- **Wikis**: `create_wiki`, `edit_wiki`, `list_wikis`, `get_wiki`,
  `attach_fragments`, `publish_wiki`, `unpublish_wiki`.
- **Regeneration**: `regen_now`, `regen_status`.
- **Fragments & search**: `get_fragment`, `search` (hybrid).
- **Wiki types**: `get_wiki_types`, `create_wiki_type`.
- **People**: `create_person`, `update_person`, `find_person`, `brief_person`,
  `list_pending_persons`, `set_auto_accept_persons`, `add_relationship`.
- **Groups**: `list_groups`, `create_group`, `add_wiki_to_group`.
- **Timeline & skills**: `get_timeline`, `list_skills`.

The same server is also reachable as a REST API; the OpenAPI spec is served at
`/openapi.json` and the wiki frontend consumes a generated TypeScript client.

## Auth

Auth uses **better-auth** with the Drizzle adapter, configured in
`core/src/auth.ts`. Robin is single-user by construction: a unique constraint
enforces that exactly one user exists, and sign-up is blocked once that user is
provisioned.

The first user is provisioned just-in-time on boot from `INITIAL_USERNAME` and
`INITIAL_PASSWORD`. Sessions are cookie-based (secure cookies in production).
Administrative routes under `/admin/*` are gated behind the session cookie. A
public `/recover` endpoint lets a locked-out operator reset the password using a
server-side secret.

## Wiki state machine

Two orthogonal state machines live on the `wikis` table; they answer different
questions.

**Queue state** (`wikis.state`) is the process-pipeline state used by the
workers — `PENDING`, `LINKING`, `RESOLVED`. It is what the regen and ingest
workers read, and it is the lock target that serializes concurrent regens on the
same wiki.

**Editorial state** is the human-facing posture and is **derived, not stored**.
It is computed in `core/src/lib/wiki-editorial-state.ts` from the queue state,
the dirty signal, and the last-regen timestamp:

| Editorial state | Meaning |
|---|---|
| `empty` | never regenerated, nothing pending |
| `learning` | new content awaiting regen |
| `dreaming` | a regen is in flight |
| `filed` | clean and regenerated |

Two more columns govern regen behavior. `dirty_since` is stamped to `now()`
whenever a wiki's input set changes (a new fragment edge, an un-attach) and
cleared on successful regen; it is the authoritative "needs rebuild" signal.
`autoregen` is a per-wiki opt-in to the midnight batch regen worker — on-demand
regen via `regen_now` or `POST /wikis/:id/regenerate` always runs regardless.

### CAS locking guards regen

Concurrent regens on the same wiki are serialized by **compare-and-swap
locking** (`@robin/caslock`). The lock acquires by atomically transitioning the
wiki's state into `LINKING` only if it is not already there; a competing regen
sees the gate and backs off. Locks carry a TTL and auto-renew, so a crashed
worker's stale lock can be reclaimed rather than wedging the wiki forever.

## People quarantine

The people pipeline extracts every person-like mention but does not trust them
blindly. New persons land in a **quarantine queue** behind an operator approval
step.

Each row in `people` carries a `status`:

- `verified` — graph-visible. The default for hand-created persons.
- `pending` — in the quarantine queue, awaiting approval.
- `rejected` — operator-rejected; edges stay attached but invisible, the row
  stays for audit.

A `created_via` label records how each person entered (seeded, created via MCP,
promoted from quarantine, auto-extracted-pending, or auto-extracted-verified).
The extractor routes new candidates to `pending` by default; flipping the
instance-wide `auto_accept_persons` setting makes the extractor verify
automatically. A shared resolver helper dedups and creates persons so the same
mention produces the same outcome whether it arrived through the worker pipeline
or the MCP fast path.

Pending persons are **excluded from user-facing search entirely**. Other read
sites surface pending rows but carry the status through so consumers can render a
quarantine indicator. Approval and rejection are HTTP-only admin actions — there
is no MCP tool to approve or reject, by design; AI agents can read the queue but
the decision is a deliberate operator action.

## Observability and scheduled jobs

`scheduled_jobs` is the heartbeat surface for recurring workers. Each scheduled
worker calls `recordJobRun(...)` (`core/src/lib/scheduled-jobs.ts`) at the end of
every tick, upserting one row per job name with its timestamp, status, optional
metadata, and duration. There is no per-tick history by design — the row always
reflects the latest run, so "did the cron fire today?" is a single query.

`GET /admin/graph/stats` is a read-only operator snapshot of graph health:
person/wiki/fragment/edge counts, wiki editorial-state distribution, agent-schema
coverage, and the last 24 hours of people-extraction and regen activity. It is a
snapshot computed on demand, not a metrics service — no histograms, no alerting.
Pair it with a periodic poll to watch trends. Cost telemetry lives in
`usage_events`; per-job pipeline state lives in `pipeline_events`.

## Citation rendering

When a wiki cites a fragment, the rendered quote is the literal text the
classifier matched on — not a generic snippet. The classifier (*Marcel*) returns
`citationSpans` for each match: zero-based, half-open character offsets plus the
verbatim text. The classification stage validates each span by checking that
`fragmentContent.slice(start, end)` equals the quoted text, dropping any span
that fails (which rejects hallucinated quotes). Validated spans are written onto
the `attrs` of the top-ranked `FRAGMENT_IN_WIKI` edge.

The wiki read path resolves citations from those spans. When an edge carries no
spans — legacy edges, secondary (non-top) matches, or matches where every span
failed validation — the resolver falls back to a leading-snippet of the fragment
content. There is no historical backfill: existing fragments keep using the
fallback path; new ingest uses the precise span path, and re-classifying a
fragment upgrades it.

## Seed data

A fresh instance ships one piece of seed data: a demo wiki mirroring the
"Attention Is All You Need" abstract, so first sign-in has something concrete to
render. It is materialized from a fixture (`core/src/lib/seedFixture.ts`) on
first-user provisioning and is reproducible — the projection is pure and
re-running updates in place. A user who deletes the demo wiki does not get it
re-seeded.
