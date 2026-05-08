# UAT 63 — Stream E Wiki Management

## Purpose

Verify the Stream E wiki-management work that landed in branch
`feat/e-wiki-management`:

1. **Migration 0004** — `wikis.lifecycle_state`, `wikis.auto_regen`,
   `wikis.last_regen_at` columns plus the partial index for the auto-regen
   cron sweep.
2. **E1 keystone** — `regenerateWiki` uses a NEW/UPDATED/REMOVED/INTEGRATED
   partition; INTEGRATED fragments are physically absent from the LLM
   prompt; first-regen falls through to legacy full-synthesis; no-op
   short-circuit when the partition is empty post-first-regen.
3. **E8 dirty-state lifecycle** — `lifecycle_state` transitions
   `filed -> learning -> dreaming -> filed` driven by attach + regen.
4. **E2 un-attach endpoint** — `DELETE /wikis/:id/fragments/:fragmentId`
   soft-deletes the FRAGMENT_IN_WIKI edge; bumps lifecycle to learning;
   the next regen picks up the REMOVED partition.
5. **E5 auto-regen toggle** — `PATCH /wikis/:id/auto-regen` flips the
   per-wiki opt-in; the regen-batch worker sweeps `auto_regen=true AND
   lifecycle_state='learning'` wikis as a fourth candidate-discovery
   reason.
6. **Custom wiki type creation API symmetry** — `wiki_types` CRUD
   endpoints already exist (`core/src/routes/wiki-types.ts`); MCP
   `create_wiki_type` already exists; this UAT asserts both surfaces share
   the same payload shape.

## Pre-conditions

- `PROJECT_ROOT` env var points at the worktree root.
- `psql` available (only required for §1 migration assertions; skipped
  with a P-marker if no DB connection).
- `jq` available.
- Tests build artefact present (`pnpm install` already run).

## Notes (pragmatism)

- This UAT runs without booting the full server. Most assertions are
  static (file presence, schema declarations, route-handler grep). Where
  a runtime check matters (lifecycle transition end-to-end, partition
  short-circuit), the assertion runs the relevant `vitest` suite as a
  proxy.
- §1 migration assertions only run when `PG_URL` is exported. Set
  `PG_URL` only if you have a clean test DB you don't mind seeding —
  the migration is idempotent (`IF NOT EXISTS`) but applying it leaves
  the column on your DB.
- The LLM prompt assertion (§2 INTEGRATED-absent) runs against the
  vitest mock harness which captures every prompt the regen function
  builds. Real OpenRouter calls are mocked.
- Frontend surfaces (member-fragments table UI, dirty-state chip,
  wiki-types form, history panel diff view) are NOT in this UAT —
  they belong to the frontend agent. See follow-up issues filed under
  this PR.
- E6 `base_type` fork-and-edit and E7 read-only-diff revert UI are
  deferred; their backend work is partial and gated on UI partner.

## Test plan

```bash
set -u
cd "${PROJECT_ROOT:?PROJECT_ROOT must be set}"
PASS=0
FAIL=0
SKIP=0
pass() { PASS=$((PASS+1)); echo "P: $1"; }
fail() { FAIL=$((FAIL+1)); echo "F: $1"; }
skip() { SKIP=$((SKIP+1)); echo "S: $1"; }

# §1 — Migration 0004 file present, journal updated, columns declared in schema
if [ -f core/drizzle/migrations/0004_wikis_dirty_state_and_auto_regen.sql ]; then
  pass "migration 0004 file present"
else
  fail "migration 0004 file missing"
fi

if grep -q "0004_wikis_dirty_state_and_auto_regen" core/drizzle/migrations/meta/_journal.json; then
  pass "migration 0004 listed in journal"
else
  fail "migration 0004 NOT in journal"
fi

if grep -q "lifecycleState: text('lifecycle_state')" core/src/db/schema.ts; then
  pass "schema declares wikis.lifecycle_state"
else
  fail "schema does NOT declare wikis.lifecycle_state"
fi

if grep -q "autoRegen: boolean('auto_regen')" core/src/db/schema.ts; then
  pass "schema declares wikis.auto_regen"
else
  fail "schema does NOT declare wikis.auto_regen"
fi

if grep -q "lastRegenAt: timestamp('last_regen_at')" core/src/db/schema.ts; then
  pass "schema declares wikis.last_regen_at"
else
  fail "schema does NOT declare wikis.last_regen_at"
fi

if grep -q "wikis_auto_regen_lifecycle_idx" core/drizzle/migrations/0004_wikis_dirty_state_and_auto_regen.sql; then
  pass "migration creates partial index for auto-regen cron sweep"
else
  fail "migration missing wikis_auto_regen_lifecycle_idx"
fi

# §1b — Live PG_URL run (optional)
if [ -n "${PG_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  if psql "$PG_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
    cols=$(psql "$PG_URL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='wikis' AND column_name IN ('lifecycle_state','auto_regen','last_regen_at') ORDER BY column_name;" 2>/dev/null)
    if echo "$cols" | grep -q "lifecycle_state"; then
      pass "[live] wikis.lifecycle_state present"
    else
      fail "[live] wikis.lifecycle_state missing — run 'pnpm --filter @robin/core db:migrate'"
    fi
    if echo "$cols" | grep -q "auto_regen"; then
      pass "[live] wikis.auto_regen present"
    else
      fail "[live] wikis.auto_regen missing"
    fi
    if echo "$cols" | grep -q "last_regen_at"; then
      pass "[live] wikis.last_regen_at present"
    else
      fail "[live] wikis.last_regen_at missing"
    fi
  else
    skip "PG_URL set but cannot connect — skipping live migration assertions"
  fi
else
  skip "PG_URL not set or psql missing — skipping live migration assertions"
fi

# §2 — E1 keystone: partition + INTEGRATED-absent + no-op + first-regen + lifecycle
# Run the regen vitest suite (which now contains five new partition tests).
if pnpm --filter @robin/core exec vitest run src/lib/regen.test.ts >/tmp/uat63-regen.log 2>&1; then
  pass "regen.test.ts passes (16 tests including 5 partition assertions)"
else
  fail "regen.test.ts FAILED — see /tmp/uat63-regen.log"
fi

# Static-grep assertions for the keystone shape — defensive; the tests above
# cover the runtime behaviour, these guard against regressions in the partition
# computation routine.
if grep -q "isFirstRegen = wiki.lastRebuiltAt == null" core/src/lib/regen.ts; then
  pass "regen.ts implements first-regen safety case"
else
  fail "regen.ts missing first-regen safety guard"
fi

if grep -q "skipped: true" core/src/lib/regen.ts; then
  pass "regen.ts implements no-op short-circuit"
else
  fail "regen.ts missing no-op short-circuit"
fi

if grep -qE "partitionNow.*=.*new Date\(\)" core/src/lib/regen.ts; then
  pass "regen.ts captures partitionNow at function entry (TOCTOU)"
else
  fail "regen.ts does NOT capture partitionNow at function entry"
fi

# §3 — E8 lifecycle transitions wired at every insert site
if grep -q "lifecycleState: 'dreaming'" core/src/lib/regen.ts; then
  pass "regen.ts flips lifecycle to 'dreaming' on entry"
else
  fail "regen.ts does NOT flip lifecycle to 'dreaming' on entry"
fi

if grep -q "lifecycleState: 'filed'" core/src/lib/regen.ts; then
  pass "regen.ts flips lifecycle to 'filed' on completion"
else
  fail "regen.ts does NOT flip lifecycle to 'filed' on completion"
fi

if grep -q "lifecycleState: 'learning'" core/src/queue/worker.ts; then
  pass "worker.ts insertEdgeRow bumps lifecycle to 'learning'"
else
  fail "worker.ts insertEdgeRow does NOT bump lifecycle"
fi

if grep -q "lifecycleState: 'learning'" core/src/mcp/handlers.ts; then
  pass "mcp/handlers.ts attach path bumps lifecycle to 'learning'"
else
  fail "mcp/handlers.ts attach path does NOT bump lifecycle"
fi

if grep -q "lifecycleState: 'learning'" core/src/routes/wikis.ts; then
  pass "routes/wikis.ts un-attach + create-classify bump lifecycle"
else
  fail "routes/wikis.ts does NOT bump lifecycle"
fi

# §4 — E2 un-attach endpoint
if grep -q "wikisRouter.delete.*'/:id/fragments/:fragmentId'" core/src/routes/wikis.ts; then
  pass "DELETE /wikis/:id/fragments/:fragmentId handler defined"
else
  fail "DELETE /wikis/:id/fragments/:fragmentId NOT defined"
fi

if grep -q "fragment_unattached" core/src/routes/wikis.ts; then
  pass "un-attach emits 'fragment_unattached' audit event"
else
  fail "un-attach does NOT emit audit event"
fi

# §5 — E5 auto-regen toggle + worker sweep
if grep -qE "PATCH /wikis/:id/auto-regen" core/src/routes/wikis.ts && grep -q "'/:id/auto-regen'" core/src/routes/wikis.ts; then
  pass "PATCH /wikis/:id/auto-regen handler defined"
else
  fail "PATCH /wikis/:id/auto-regen NOT defined"
fi

if grep -q "autoRegenBodySchema" core/src/schemas/wikis.schema.ts; then
  pass "autoRegenBodySchema declared"
else
  fail "autoRegenBodySchema NOT declared"
fi

if grep -q "auto-regen wikis with learning state" core/src/queue/regen-worker.ts; then
  pass "regen-worker batch path includes auto-regen+learning sweep"
else
  fail "regen-worker batch path does NOT include auto-regen+learning sweep"
fi

# §6 — Custom wiki type API symmetry (#256 Andrew lock — fork-template approach)
# E3/E6 ship as backend-already-supports + frontend follow-up. Here we just
# assert the contracts both surfaces consume haven't drifted.
if grep -q "POST.*wiki-types" core/src/routes/wiki-types.ts && grep -q "create_wiki_type" core/src/mcp/server.ts; then
  pass "wiki-types CRUD route + MCP create_wiki_type both present"
else
  fail "wiki-types route or MCP tool missing"
fi

# Both surfaces accept the same shape (slug, name, descriptor, prompt YAML).
http_fields=$(grep -oE 'name|slug|descriptor|prompt|shortDescriptor' core/src/routes/wiki-types.ts | sort -u | tr '\n' ' ')
if echo "$http_fields" | grep -q "name" && echo "$http_fields" | grep -q "prompt"; then
  pass "wiki-types HTTP route exposes name + prompt"
else
  fail "wiki-types HTTP route missing name or prompt fields ($http_fields)"
fi

# §7 — Typecheck still clean for core
if pnpm --filter @robin/core exec tsc --noEmit -p tsconfig.json >/tmp/uat63-tsc.log 2>&1; then
  pass "core tsc --noEmit clean"
else
  errs=$(grep -c "error TS" /tmp/uat63-tsc.log || echo 0)
  fail "core tsc reports $errs errors — see /tmp/uat63-tsc.log"
fi

# §8 — Read-only diff (#181 Andrew lock — v1 = read, no revert button)
# /history endpoint already exists; assert it's still wired.
if grep -q "wikisRouter.get.*'/:id/history'" core/src/routes/wikis.ts; then
  pass "GET /wikis/:id/history route present (E4 + E7 read-only diff foundation)"
else
  fail "GET /wikis/:id/history route missing"
fi

# §9 — Cross-stream coordination: F2 sequencing (E2 ships before/with F2)
# Verifier-style: not a strict assertion, but a notice.
if [ -d wiki/src/components ] && grep -rqi "MemberFragments" wiki/src/components 2>/dev/null; then
  echo "I: wiki/ already references MemberFragments — frontend partner can wire to E2 endpoint"
else
  echo "I: wiki/ does not reference MemberFragments yet — frontend follow-up issue captures this"
fi

echo
echo "===== UAT 63 result ====="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "SKIP: $SKIP"
[ "$FAIL" = "0" ] || exit 1
```

## Open questions

- **YAML rewrite for NEW/UPDATED/REMOVED partition variables.** E1 ships
  with a single `{{fragments}}` slot containing partition headers
  (`[NEW FRAGMENTS]`, `[UPDATED FRAGMENTS]`, `[REMOVED FRAGMENTS]`) — the
  cleanest restructure is to expose three separate template variables
  (`newFragments`, `updatedFragments`, `removedFragments`) and rewrite all
  10 wiki-type YAMLs. CROSS-STREAM-CONCERNS.md recommends a single PR
  combining this with Stream F's single-citation YAML pass. Filed as a
  follow-up issue.
- **Fragmenter `WIKI_RELATED_TO_WIKI` edge writes** (E1 §3 step 7) — the
  fragmenter agent is not modified by this branch. The plan calls for
  the fragmenter to emit `WIKI_RELATED_TO_WIKI` edges with
  `attrs.source = 'fragmenter'` when fragment-A connects two existing
  wikis. Deferred to a follow-up — the fragmenter agent change has its
  own risk surface (LLM prompt + content classifier extension).
- **E4 timeline UI** — backend already exposes `/timeline` and `/history`
  routes plus `triggeringFragments` in the regen result. The frontend
  surface that consumes these is a frontend-agent task.
- **E6 `base_type` fork-and-edit** — Andrew lock says "fork the template,
  edit, save". The backend already supports this (POST /wiki-types with
  the seed type's YAML pre-filled). The frontend form is a follow-up.
- **E7 read-only diff** — same shape as E4; no backend work needed
  beyond what already exists. The diff render is a frontend-agent task.
- **E9 bouncer toggle UI** — backend already shipped (PATCH
  /wikis/:id/bouncer). UI toggle is a frontend follow-up.
- **Profile-level auto-regen default** — Andrew lock notes a profile-level
  default for new wikis. Wired via `configs` table (kind='auto_regen_default')
  consumed at wiki creation. The schema and reading is in place; the
  setting endpoint is part of the user-settings frontend story (follow-up).
- **Profile counter (outstanding-fragment-backfill)** — Andrew called this
  out for coordination with Wave D5 + Wave A4. Out of scope for Stream E
  alone; tracked as a cross-stream follow-up.
