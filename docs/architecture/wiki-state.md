# Wiki State

Two orthogonal state machines live on the `wikis` table. They look related, but they answer different questions, run on different cadences, and are owned by different parts of the codebase.

## Queue state (`wikis.state`)

Process-pipeline state. One of `PENDING`, `LINKING`, `RESOLVED`, `ATTACHED`. Owned by the regen worker and the ingest worker. The CAS gate on `state != 'LINKING'` is what serialises concurrent regens on the same wiki.

This is the column the workers read, not the column the UI surfaces.

## Editorial state (derived, not persisted)

Human-facing posture. One of `empty`, `learning`, `dreaming`, `filed`. As of v0.2.2 (T4-bundle), this is **not stored**. It is derived in app code from `{state, dirty_since, last_rebuilt_at}`:

| Editorial state | Condition |
| --- | --- |
| `dreaming` | `state = 'LINKING'` (regen in flight) |
| `learning` | `dirty_since IS NOT NULL` and `state != 'LINKING'` (new content awaiting regen) |
| `empty`    | `last_rebuilt_at IS NULL` and `dirty_since IS NULL` and `state != 'LINKING'` (never regenned, nothing to regen) |
| `filed`    | `state = 'RESOLVED'` and `dirty_since IS NULL` and `last_rebuilt_at IS NOT NULL` (clean, regenned) |

Read this in code via `editorialStateOf(...)` from `core/src/lib/wiki-editorial-state.ts`. Read it in SQL via the `editorialStateWhere` fragment library so the derivation lives in one place rather than scattered across `where` clauses.

## Regen flag (`wikis.autoregen`)

Per-wiki opt-in to the midnight batch worker. Default `false`. The flag governs the batch worker's ingest-driven candidate set (Reasons 1, 2, 4 in `processRegenBatchJob`). It does **not** govern on-demand regen via `POST /wikis/:id/regenerate` or the `regen_now` MCP tool, which always run when invoked.

## Dirty signal (`wikis.dirty_since`)

A `timestamptz` stamped to `now()` on every event that mutates the wiki's input set: a new `FRAGMENT_IN_WIKI` edge, an un-attach, a quick-classify on wiki create. Cleared to `NULL` on successful regen completion. Replaces the v0.2.1 `MAX(edges.created_at)` query-time derivation.

## Migration story

Migration 0014 is **BREAKING**. It drops `wikis.regenerate` and `wikis.lifecycle_state`, renames `auto_regen` to `autoregen`, and adds `dirty_since`.

Operators have three paths:

1. Plain `pnpm -C core db:migrate`. Existing wikis end up with `autoregen=false`. Operators flip the ones they want kept automatic via `PATCH /wikis/:id/auto-regen`.
2. `MIGRATION_PRESERVE_EXISTING=true` (or `--preserve-existing` to `scripts/migrate-with-preserve.ts`). Before the migration runs, every wiki where `regenerate=true` flips to `autoregen=true`, preserving the prior cron behaviour.
3. Skip the migration. Not recommended; column drift will trip drift detection on the next deploy.

The wrapper script also prints a one-shot operator warning showing the count of wikis whose effective regen behaviour just changed.

## Why this shape

Before T4-bundle, the table carried two near-overlapping state surfaces and a confusingly named flag: every transition wrote the same fact into both `lifecycle_state` and (implicitly) `state`, the de-facto regen gate (`regenerate`) was named the opposite of what it gated, and the cron-only opt-in (`auto_regen`) was named as if it were the gate. This shape collapses to one queue state, one dirty signal, and one regen toggle. Editorial state is derived where it is read.
