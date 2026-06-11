# Plan 005: Make wiki deletion atomic and close the classify-vs-delete race that creates zombie edges

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 21533c8..HEAD -- core/src/routes/wikis.ts core/src/lib/regen.ts core/src/db/dedup.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-restore-verification-baseline.md (the regen test cluster must be green first)
- **Category**: bug
- **Planned at**: commit `21533c8`, 2026-06-11

## Why this matters

Two cooperating defects let `FRAGMENT_IN_WIKI` edges outlive their wiki
("zombie edges"), which the classifier then treats as live routing signal:

1. `DELETE /wikis/:id` soft-deletes the wiki row, then cascades edge
   soft-deletion in a **separate, non-transactional** statement. A crash
   between the two leaves the graph inconsistent; concurrent inserts can land
   between them.
2. The regen classifier inserts edges after an existence re-check, but the
   check and the insert are two statements — the codebase itself documents
   that this TOCTOU was observed in practice ("10c surfaced ~1 of these per
   UAT run", `core/src/lib/regen.ts:379-383`). The re-check narrowed the
   window; it didn't close it.

Zombie edges silently misroute future fragments and violate the soft-delete
contract the delete handler's own comment promises.

## Current state

- `core/src/routes/wikis.ts:1021-1060` — the delete handler. Sequential,
  no transaction:

```ts
wikisRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [wiki] = await db.select().from(wikis).where(and(eq(wikis.lookupKey, id), isNull(wikis.deletedAt)))
  if (!wiki) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  await db.update(wikis).set({ deletedAt: now, updatedAt: now }).where(eq(wikis.lookupKey, id))

  // Cascade: soft-delete every edge that references this wiki on
  // either side. ...
  await db.update(edges).set({ deletedAt: now })
    .where(and(isNull(edges.deletedAt),
      sql`(${edges.srcId} = ${id} OR ${edges.dstId} = ${id})`))

  // Hard-delete group memberships — soft-delete doesn't trigger FK CASCADE
  await db.delete(groupWikis).where(eq(groupWikis.wikiId, id))

  await emitAuditEvent(db, { ... eventType: 'deleted', ... })
  return c.body(null, 204)
})
```

- `core/src/lib/regen.ts:378-414` — classify loop, check-then-insert:

```ts
for (const edge of result.data.wikiEdges) {
  // Re-check the destination wiki right before the insert.
  // The LLM call is slow; the wiki may have been soft-
  // deleted while we were waiting. ... (10c surfaced ~1 of these per UAT run).
  const [stillLive] = await database
    .select({ key: wikis.lookupKey }).from(wikis)
    .where(and(eq(wikis.lookupKey, edge.wikiKey), isNull(wikis.deletedAt)))
    .limit(1)
  if (!stillLive) { log.warn(...); continue }
  ...
  await database.insert(edges).values({
    id: crypto.randomUUID(),
    srcType: 'fragment', srcId: frag.lookupKey,
    dstType: 'wiki', dstId: edge.wikiKey,
    edgeType: 'FRAGMENT_IN_WIKI', attrs,
  }).onConflictDoNothing()
```

- Transaction exemplar in this repo: `core/src/db/dedup.ts:89-100`
  (`db.transaction(async (tx) => { ... })`, drizzle over postgres-js).
  The `db` client is `drizzle(postgres(DATABASE_URL))` —
  `core/src/db/client.ts` (8 lines).
- There is a second, simpler edge-insert loop on wiki creation
  (`core/src/routes/wikis.ts:275-288`, quick-classify) — same conditional-
  insert treatment applies there.
- Existing tests around this area: `core/src/__tests__/regen-worker.test.ts`,
  `core/src/routes/wikis.regen.lock.test.ts`, and the `regenerateWiki` suites
  (fixed by plan 001). Core tests mock the DB heavily — see how
  `wikis.regen.lock.test.ts` mocks module dependencies.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm --filter @robin/core typecheck` | exit 0 |
| Tests | `pnpm --filter @robin/core test` | exit 0 |
| Lint | `pnpm --filter @robin/core lint` | exit 0 |

## Scope

**In scope**:
- `core/src/routes/wikis.ts` — delete handler (lines ~1021-1060) and the
  quick-classify insert loop (~275-288)
- `core/src/lib/regen.ts` — the classify insert site (~378-414)
- New/updated tests in `core/src/__tests__/`

**Out of scope** (do NOT touch):
- The regen lock machinery (`packages/caslock`, `wikiRegenLock` usage) — the
  lock serializes regens per wiki; it does not and should not guard deletes.
- `createRelatedToEdges` (regen.ts:181-244) — fragment-to-fragment edges
  don't have this failure mode (fragments aren't deleted by this handler).
- Schema changes (`core/src/db/schema.ts`) — no new columns or indexes.
- Backfill/cleanup of pre-existing zombie edges in live databases — note it
  as a follow-up in your report; do not write a migration here.

## Git workflow

- Branch: `advisor/005-wiki-delete-zombie-edges`
- Commits: `fix(wikis): make delete cascade transactional`, then
  `fix(regen): insert FRAGMENT_IN_WIKI edges conditionally on live wiki`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Wrap the delete cascade in a transaction

In the DELETE handler, move the wiki soft-delete, the edge cascade, and the
`groupWikis` hard-delete into one `db.transaction(async (tx) => { ... })`
(pattern: `core/src/db/dedup.ts:89-100`), replacing `db` with `tx` inside.
Keep `emitAuditEvent` **outside** the transaction (after commit) — audit
emission failure must not roll back a completed delete.

**Verify**: `pnpm --filter @robin/core typecheck` → exit 0; `pnpm --filter @robin/core test` → exit 0.

### Step 2: Make the classifier's edge insert conditional in SQL

In `regen.ts` (~378-414), replace the select-then-insert pair with a single
atomic statement: `INSERT INTO edges (...) SELECT ... WHERE EXISTS (SELECT 1
FROM wikis WHERE lookup_key = $wikiKey AND deleted_at IS NULL) ON CONFLICT DO
NOTHING`, via drizzle's `sql` template (the codebase already drops to raw
`sql` for the `NOT IN` subquery at `wikis.ts:264-267` — match that style).
Use `.returning()` or the row count to preserve the current behavior: when the
wiki is gone, log the same `'skipping FRAGMENT_IN_WIKI insert: wiki was
soft-deleted during LLM call'` warning and `continue` (so `llmFiled` and the
subsequent `createRelatedToEdges` call are skipped exactly as today).

Apply the same conditional-insert shape to the quick-classify loop at
`wikis.ts:275-288` (it has no existence re-check at all today).

**Verify**: `pnpm --filter @robin/core typecheck` → exit 0; `pnpm --filter @robin/core test` → exit 0.

### Step 3: Tests

Add `core/src/__tests__/wiki-delete-cascade.test.ts`:

1. Delete handler runs wiki update + edge cascade + groupWikis delete within
   one transaction (assert via a mocked `db.transaction` that all three
   statements execute on the `tx` object, not on `db`).
2. Audit event is emitted after the transaction resolves; if `emitAuditEvent`
   rejects, the handler's transaction still committed (deletion not rolled
   back).
3. Classify insert: when the conditional insert reports 0 rows (wiki
   soft-deleted), the loop logs the skip warning, does not increment the filed
   count, and does not call `createRelatedToEdges`.

Model the mocking style on `core/src/routes/wikis.regen.lock.test.ts`.

**Verify**: `pnpm --filter @robin/core test` → exit 0 including the new file.

## Test plan

See Step 3. Regression net: the `regenerateWiki` suites and
`wikis.regen.lock.test.ts` (green after plan 001) must pass unchanged — they
pin the lock-wrapping and state-machine behavior this plan must not disturb.

## Done criteria

- [ ] `pnpm --filter @robin/core typecheck` exits 0
- [ ] `pnpm --filter @robin/core test` exits 0; `wiki-delete-cascade.test.ts` exists with the 3 cases
- [ ] The delete handler contains exactly one `db.transaction` call covering wiki update, edge cascade, and groupWikis delete
- [ ] `grep -n 'stillLive' core/src/lib/regen.ts` returns no matches (check-then-insert replaced)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts (drift).
- The mocked-DB test setup can't represent `db.transaction` without
  restructuring shared helpers used by other suites.
- You find the conditional `INSERT ... SELECT ... WHERE EXISTS` can't express
  the `attrs` JSON payload through drizzle's `sql` template — report the
  blocker rather than switching to a different concurrency strategy
  (e.g. advisory locks) on your own.
- Any previously passing regen/lock test fails after Step 2 and the fix isn't
  obvious within two attempts.

## Maintenance notes

- Residual window: an insert that commits while the delete transaction is
  in-flight can still survive if it lands after the cascade statement's
  snapshot under READ COMMITTED. The conditional insert plus transactional
  cascade shrinks this to near-zero; if zombie edges ever reappear in UAT,
  the next escalation is a `SELECT ... FOR SHARE` on the wiki row inside the
  insert, or a periodic sweep worker — deferred deliberately.
- Follow-up (out of scope here): one-off cleanup of zombie edges in existing
  deployments — `UPDATE edges SET deleted_at = now() WHERE deleted_at IS NULL
  AND dst_type='wiki' AND dst_id IN (SELECT lookup_key FROM wikis WHERE
  deleted_at IS NOT NULL)` (and the src-side mirror).
- Reviewer focus: audit event ordering (must be post-commit) and that the
  skip path still suppresses `createRelatedToEdges`.
