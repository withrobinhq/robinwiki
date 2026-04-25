# 23 — Pipeline state after regen + LINKING guard

## What it proves

PR #186 (closes #170) fixes the pipeline so wikis transition to `RESOLVED`
after `regenerateWiki()` finishes — instead of staying `PENDING` / `LINKING`
forever and being re-picked-up every midnight batch (which is what caused the
"regen creates a new wiki" symptom in #170: the same wiki was re-processed
endlessly, fragments shifted between wikis, and stuck-state look-ups produced
duplicate-looking results in the UI). This plan exercises the three new
behaviors end-to-end: (a) the final `.set()` writes `state: 'RESOLVED'`,
(b) the function-entry optimistic `LINKING` lock causes concurrent regen
calls on the same wiki to no-op instead of double-processing, and (c) the
batch worker's Reason-3 stuck-wiki query now respects the lock and only
picks up `LINKING` wikis older than 15 minutes (stale-lock recovery).

## Prerequisites
- Plan 22 has run (Transformer demo wiki seeded — `slug = transformer-architecture`).
- Stack up: core on `SERVER_URL`, Postgres reachable via `DATABASE_URL`.
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `OPENROUTER_API_KEY` set — regen makes a live LLM call. Without it the
  end-to-end positive assertions (1, 2) skip; the SQL-only invariants (3, 4, 6)
  still run.
- `psql` and `jq` available on PATH.

## Fixture identity this plan references
- Wiki slug: `transformer-architecture`

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-23-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

# Per-run salt so re-running the plan against the same DB doesn't collide
# with a prior run (we create a throwaway wiki for the LINKING-lock test).
RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "23 — Pipeline state after regen + LINKING guard"
echo ""

# ── 0. Sign in + resolve fixture ─────────────────────────────
SIGNIN_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")

if [ "$SIGNIN_HTTP" = "200" ] && [ -s "$COOKIE_JAR" ]; then
  pass "0a. sign-in established a session cookie"
else
  fail "0a. sign-in failed (HTTP $SIGNIN_HTTP) — cannot exercise regen routes"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

WIKI_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis?limit=50" \
  | jq -r '.wikis[] | select(.slug=="transformer-architecture") | .lookupKey // .id' \
  | head -1)

if [ -z "$WIKI_KEY" ] || [ "$WIKI_KEY" = "null" ]; then
  fail "0b. Transformer fixture not seeded — run plan 22 first"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "0b. resolved Transformer wiki key ($WIKI_KEY)"

if [ -z "${DATABASE_URL:-}" ]; then
  fail "0c. DATABASE_URL not set — every state-column assertion will be unverifiable"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "0c. DATABASE_URL set — state-column assertions enabled"

# 0d. The seeded fixture has wikis.regenerate=false, but every assertion in
# §1 below assumes regen actually runs and writes state='RESOLVED'. Capture
# the original value so we can restore it on exit, then flip it to true so
# regenerateWiki() proceeds rather than no-op'ing on the gate.
ORIG_REGENERATE=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT regenerate FROM wikis WHERE slug='transformer-architecture' AND deleted_at IS NULL" \
  2>/dev/null | tr -d '[:space:]')
psql "$DATABASE_URL" -t -A -c \
  "UPDATE wikis SET regenerate=true WHERE slug='transformer-architecture' AND deleted_at IS NULL" \
  >/dev/null 2>&1
NEW_REGENERATE=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT regenerate FROM wikis WHERE slug='transformer-architecture' AND deleted_at IS NULL" \
  2>/dev/null | tr -d '[:space:]')
if [ "$NEW_REGENERATE" = "t" ]; then
  pass "0d. wikis.regenerate flipped to true for the run (was '$ORIG_REGENERATE'); will restore on exit"
else
  fail "0d. could not flip wikis.regenerate to true (got '$NEW_REGENERATE') — §1 will likely fail"
fi

HAS_OPENROUTER=0
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  HAS_OPENROUTER=1
fi

# Helper: poll wikis.state until it equals $1 (or timeout)
poll_state() {
  local target="$1" key="$2" timeout="${3:-60}" elapsed=0 cur=""
  while [ "$elapsed" -lt "$timeout" ]; do
    cur=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT state FROM wikis WHERE lookup_key='$key' AND deleted_at IS NULL" \
      2>/dev/null | tr -d '[:space:]')
    if [ "$cur" = "$target" ]; then
      echo "$cur"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "$cur"
  return 1
}

# ── 1. Manual regen drives wiki to RESOLVED ──────────────────
# Core PR #186 claim: every regen call must set state='RESOLVED' on the
# final UPDATE. Pre-fix the column was never written, so wikis stayed
# PENDING (or LINKING) forever. We seed an explicit non-RESOLVED state
# first so an already-resolved fixture doesn't trivially pass.

# 1a. Force wiki into PENDING so the assertion has signal.
psql "$DATABASE_URL" -t -A -c \
  "UPDATE wikis SET state='PENDING', updated_at=NOW() WHERE lookup_key='$WIKI_KEY'" \
  >/dev/null 2>&1
PRE_STATE=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT state FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
if [ "$PRE_STATE" = "PENDING" ]; then
  pass "1a. Pre-condition met: wiki forced to PENDING"
else
  fail "1a. Could not force pre-condition (state=$PRE_STATE)"
fi

if [ "$HAS_OPENROUTER" = "0" ]; then
  skip "1b. POST /wikis/:id/regenerate — OPENROUTER_API_KEY not set, skipping live regen"
  skip "1c. wiki transitions to RESOLVED — depends on 1b"
  skip "1d. wiki state does NOT remain in LINKING — depends on 1b"
  skip "1e. wiki state does NOT remain in PENDING — depends on 1b"
  skip "1f. lastRebuiltAt updated — depends on 1b"
else
  # 1b. POST /wikis/:id/regenerate runs synchronously (the route handler
  # awaits regenerateWiki). 2xx means the final UPDATE has already
  # committed by the time the response arrives.
  REGEN_HTTP=$(curl -s -o /tmp/uat-23-regen.json -w "%{http_code}" \
    -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    -X POST "$SERVER_URL/wikis/$WIKI_KEY/regenerate")
  if [ "$REGEN_HTTP" = "200" ]; then
    pass "1b. POST /wikis/:id/regenerate → 200"
  else
    fail "1b. POST /wikis/:id/regenerate → $REGEN_HTTP (body=$(head -c 200 /tmp/uat-23-regen.json))"
  fi

  # 1c. State must be RESOLVED. The route awaits regen completion, so
  # this is a direct read — no polling needed.
  POST_STATE=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT state FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
  if [ "$POST_STATE" = "RESOLVED" ]; then
    pass "1c. wiki.state = RESOLVED after regen"
  else
    fail "1c. wiki.state = '$POST_STATE' (expected RESOLVED) — PR #186 fix not applied?"
  fi

  # 1d. Negative: must NOT be LINKING (would mean the lock was set but
  # never released — a different regression).
  if [ "$POST_STATE" != "LINKING" ]; then
    pass "1d. wiki.state is not LINKING (lock was released)"
  else
    fail "1d. wiki.state stuck at LINKING — the entry-lock was never cleared by the final UPDATE"
  fi

  # 1e. Negative: must NOT be PENDING (the original #170 bug).
  if [ "$POST_STATE" != "PENDING" ]; then
    pass "1e. wiki.state is not PENDING (the #170 bug is gone)"
  else
    fail "1e. wiki.state still PENDING — #170 reproduces; PR #186 not applied"
  fi

  # 1f. lastRebuiltAt must be recent (within 60s). This proves the
  # final UPDATE actually ran rather than the route returning 200 from
  # an early-bail branch.
  RECENT=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT (last_rebuilt_at > NOW() - INTERVAL '60 seconds')::int FROM wikis WHERE lookup_key='$WIKI_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$RECENT" = "1" ]; then
    pass "1f. lastRebuiltAt updated within the last 60s"
  else
    fail "1f. lastRebuiltAt did not update (recent=$RECENT) — final UPDATE may not have committed"
  fi
fi

# ── 2. LINKING guard prevents concurrent re-entry ────────────
# PR #186 adds an optimistic UPDATE … WHERE state != 'LINKING' at function
# entry. If two regen calls race on the same wiki, the second sees
# state='LINKING' (set by the first) and bails with an empty result.
# We simulate the race deterministically: pre-set state='LINKING' on the
# wiki, then call POST /wikis/:id/regenerate. The route's regenerateWiki
# call must observe the lock and skip — which means content is unchanged
# and the call returns quickly (no LLM invocation).

# 2a. Force wiki into LINKING (simulates an in-flight worker holding the lock).
PRE_CONTENT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT md5(content) FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
PRE_REBUILT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT EXTRACT(EPOCH FROM last_rebuilt_at)::int FROM wikis WHERE lookup_key='$WIKI_KEY'" \
  2>/dev/null | tr -d '[:space:]')

# IMPORTANT: bump updated_at backward by 20 minutes so the stuck-wiki
# query in section 4 doesn't re-pick this row. We restore state in 2d.
psql "$DATABASE_URL" -t -A -c \
  "UPDATE wikis SET state='LINKING', updated_at=NOW() WHERE lookup_key='$WIKI_KEY'" \
  >/dev/null 2>&1
LOCK_STATE=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT state FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
if [ "$LOCK_STATE" = "LINKING" ]; then
  pass "2a. Lock simulation: wiki forced to LINKING"
else
  fail "2a. Could not force LINKING state (got '$LOCK_STATE')"
fi

# 2b. Concurrent regen call must bail out fast (< 5s) without invoking the
# LLM. The optimistic UPDATE returns 0 rows because state='LINKING' and
# the WHERE clause excludes that case; the function returns an empty
# result ({fragmentCount: 0, content: ''}). The route handler still
# returns 200 with fragmentCount=0.
T_BEFORE=$(date +%s)
RACE_HTTP=$(curl -s -o /tmp/uat-23-race.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  -X POST "$SERVER_URL/wikis/$WIKI_KEY/regenerate")
T_AFTER=$(date +%s)
RACE_ELAPSED=$((T_AFTER - T_BEFORE))

if [ "$RACE_HTTP" = "200" ]; then
  pass "2b. Concurrent regen returned 200 (route did not throw)"
else
  fail "2b. Concurrent regen → HTTP $RACE_HTTP (expected 200; body=$(head -c 200 /tmp/uat-23-race.json))"
fi

# 2c. Bail-out must be fast — a real LLM call takes ≥5s; the lock check
# returns in milliseconds. This is the strongest proof that the guard
# fired (we never hit OpenRouter).
if [ "$RACE_ELAPSED" -le 5 ] 2>/dev/null; then
  pass "2c. Concurrent regen returned in ${RACE_ELAPSED}s (guard fired — no LLM call)"
else
  fail "2c. Concurrent regen took ${RACE_ELAPSED}s — guard did NOT short-circuit"
fi

# 2d. fragmentCount in the response is 0 — the early-bail return path.
RACE_FRAG=$(jq -r '.fragmentCount // -1' /tmp/uat-23-race.json 2>/dev/null)
if [ "$RACE_FRAG" = "0" ]; then
  pass "2d. response.fragmentCount = 0 (early-bail RegenResult observed)"
else
  fail "2d. response.fragmentCount = '$RACE_FRAG' (expected 0 from early-bail)"
fi

# 2e. Content unchanged — no UPDATE was executed beyond the lock attempt.
POST_CONTENT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT md5(content) FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
if [ "$POST_CONTENT" = "$PRE_CONTENT" ]; then
  pass "2e. Wiki content md5 unchanged across concurrent call (no double-write)"
else
  fail "2e. Wiki content changed despite LINKING lock — guard failed"
fi

# 2f. Restore: clear the simulated lock so downstream sections are sane.
psql "$DATABASE_URL" -t -A -c \
  "UPDATE wikis SET state='RESOLVED', updated_at=NOW() WHERE lookup_key='$WIKI_KEY'" \
  >/dev/null 2>&1
RESTORE_STATE=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT state FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
if [ "$RESTORE_STATE" = "RESOLVED" ]; then
  pass "2f. Lock cleared — wiki restored to RESOLVED for downstream tests"
else
  fail "2f. Could not restore wiki state (got '$RESTORE_STATE')"
fi

# ── 3. Bug autopsy: #170 inverse repro ───────────────────────
# #170 reported "regen creates a new wiki instead of updating the existing
# one." The mechanism was: a wiki stuck in PENDING got picked up every
# midnight by the stuck-state batch query (Reason 3) and re-classified
# fragments — making it look like a new wiki was being created. The fix
# closes the loop: once a wiki reaches RESOLVED it must NOT be eligible
# for the stuck-wiki batch sweep on subsequent runs.
#
# This section proves the inverse: a RESOLVED wiki is correctly excluded
# from the Reason-3 candidate set (the SQL the batch worker runs).

# 3a. The lookupKey is stable — regen never inserts a new wikis row.
ROW_COUNT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM wikis WHERE slug='transformer-architecture' AND deleted_at IS NULL" \
  2>/dev/null | tr -d '[:space:]')
if [ "$ROW_COUNT" = "1" ]; then
  pass "3a. Exactly 1 wiki row for slug='transformer-architecture' (regen did not duplicate)"
else
  fail "3a. Found $ROW_COUNT rows for the seed slug — duplicate-creation bug from #170 reproduces"
fi

# 3b. Replay the exact Reason-3 query from regen-worker.ts. After section 1
# the wiki is RESOLVED, so it must be EXCLUDED from the stuck-wiki list.
STUCK_HITS=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM wikis
   WHERE deleted_at IS NULL
     AND state != 'RESOLVED'
     AND (state != 'LINKING' OR updated_at < NOW() - INTERVAL '15 minutes')
     AND lookup_key='$WIKI_KEY'" \
  2>/dev/null | tr -d '[:space:]')
if [ "$STUCK_HITS" = "0" ]; then
  pass "3b. RESOLVED wiki excluded from stuck-wiki batch query (Reason-3 fix)"
else
  fail "3b. RESOLVED wiki still appears in stuck-wiki query — #170 root cause not closed"
fi

# 3c. Inverse: a deliberately-PENDING wiki IS eligible (proves the query
# discriminates by state, not by some unrelated column). We need a row
# we can mutate without disturbing the fixture, so create a throwaway.
TMP_NAME="UAT linking-guard ${RUN_ID}"
CREATE_BODY=$(jq -n --arg n "$TMP_NAME" '{name:$n, type:"log"}')
CREATE_HTTP=$(curl -s -o /tmp/uat-23-tmp.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -d "$CREATE_BODY" \
  "$SERVER_URL/wikis")
TMP_KEY=$(jq -r '.lookupKey // .id // ""' /tmp/uat-23-tmp.json)

if [ "$CREATE_HTTP" = "201" ] || [ "$CREATE_HTTP" = "200" ]; then
  pass "3c-pre. Created throwaway wiki ($TMP_KEY) for negative assertion"
else
  fail "3c-pre. Could not create throwaway wiki (HTTP $CREATE_HTTP)"
  TMP_KEY=""
fi

if [ -n "$TMP_KEY" ] && [ "$TMP_KEY" != "null" ]; then
  psql "$DATABASE_URL" -t -A -c \
    "UPDATE wikis SET state='PENDING', updated_at=NOW() WHERE lookup_key='$TMP_KEY'" \
    >/dev/null 2>&1

  PENDING_HITS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM wikis
     WHERE deleted_at IS NULL
       AND state != 'RESOLVED'
       AND (state != 'LINKING' OR updated_at < NOW() - INTERVAL '15 minutes')
       AND lookup_key='$TMP_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$PENDING_HITS" = "1" ]; then
    pass "3c. PENDING wiki IS in stuck-wiki query (sanity: query discriminates by state)"
  else
    fail "3c. PENDING wiki not picked up (hits=$PENDING_HITS) — query is overcorrected"
  fi
else
  skip "3c. Throwaway wiki not available — sanity assertion skipped"
fi

# ── 4. Stale-lock recovery (Reason-3 LINKING window) ─────────
# PR #186 also tightens Reason-3: the batch only picks up LINKING wikis
# that have been stuck > 15 minutes. This prevents the batch from
# stomping on a wiki that's actively being regenerated (a fresh LINKING
# row), while still allowing recovery from a crashed worker (an old
# LINKING row).

if [ -n "$TMP_KEY" ] && [ "$TMP_KEY" != "null" ]; then
  # 4a. Fresh LINKING (updated_at = NOW) → must be EXCLUDED.
  psql "$DATABASE_URL" -t -A -c \
    "UPDATE wikis SET state='LINKING', updated_at=NOW() WHERE lookup_key='$TMP_KEY'" \
    >/dev/null 2>&1
  FRESH_HITS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM wikis
     WHERE deleted_at IS NULL
       AND state != 'RESOLVED'
       AND (state != 'LINKING' OR updated_at < NOW() - INTERVAL '15 minutes')
       AND lookup_key='$TMP_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$FRESH_HITS" = "0" ]; then
    pass "4a. Fresh LINKING wiki excluded from batch (active worker not stomped)"
  else
    fail "4a. Fresh LINKING wiki picked up by batch — would race with active worker (hits=$FRESH_HITS)"
  fi

  # 4b. Stale LINKING (updated_at = 20 min ago) → must be INCLUDED for recovery.
  psql "$DATABASE_URL" -t -A -c \
    "UPDATE wikis SET state='LINKING', updated_at=NOW() - INTERVAL '20 minutes' WHERE lookup_key='$TMP_KEY'" \
    >/dev/null 2>&1
  STALE_HITS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM wikis
     WHERE deleted_at IS NULL
       AND state != 'RESOLVED'
       AND (state != 'LINKING' OR updated_at < NOW() - INTERVAL '15 minutes')
       AND lookup_key='$TMP_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$STALE_HITS" = "1" ]; then
    pass "4b. Stale LINKING wiki (>15 min) IS picked up — crashed-worker recovery works"
  else
    fail "4b. Stale LINKING wiki not recovered (hits=$STALE_HITS) — stuck wikis would never be cleared"
  fi

  # 4c. The boundary case: exactly at 15-minute threshold. The query uses
  # strict `<` so 14:59 stays held, 15:01 becomes recoverable. Test the
  # below-threshold case (14 min) to lock down the ">15 min" semantic.
  psql "$DATABASE_URL" -t -A -c \
    "UPDATE wikis SET state='LINKING', updated_at=NOW() - INTERVAL '14 minutes' WHERE lookup_key='$TMP_KEY'" \
    >/dev/null 2>&1
  BELOW_HITS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM wikis
     WHERE deleted_at IS NULL
       AND state != 'RESOLVED'
       AND (state != 'LINKING' OR updated_at < NOW() - INTERVAL '15 minutes')
       AND lookup_key='$TMP_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$BELOW_HITS" = "0" ]; then
    pass "4c. LINKING wiki at 14 min still excluded (threshold is >15 min, not >=14)"
  else
    fail "4c. LINKING wiki at 14 min included — threshold is too aggressive (hits=$BELOW_HITS)"
  fi
else
  skip "4. Throwaway wiki not available — stale-lock window untested"
fi

# ── 5. Test mock parity (regen.test.ts contract) ─────────────
# PR #186 also updates the regen.test.ts mock so .returning() is reachable
# on the wikis update chain, and adds positive assertions that
# state='RESOLVED' is present on the content-update payload. This is a
# unit-level safeguard: if the production regen.ts ever stops setting
# state='RESOLVED' or stops calling .returning() on the lock UPDATE, the
# unit test catches it before code review.

if command -v npx >/dev/null 2>&1; then
  TEST_OUT=$(cd core && npx vitest run src/lib/regen.test.ts --reporter=basic 2>&1 || true)
  cd "${PROJECT_ROOT:-.}" 2>/dev/null || true
  echo "$TEST_OUT" > /tmp/uat-23-vitest.log

  # 5a. All tests pass. Per PR #186 test plan: 10 tests should pass.
  if echo "$TEST_OUT" | grep -qE "Tests +([0-9]+) passed" ; then
    pass "5a. regen.test.ts vitest run reports tests passed"
  else
    fail "5a. regen.test.ts vitest run did not report a clean pass (see /tmp/uat-23-vitest.log)"
  fi

  # 5b. The new state='RESOLVED' assertion is present in the test source.
  # If a future refactor strips the assertion, this catches the silent
  # coverage loss.
  if grep -q "contentUpdate.state.*RESOLVED" core/src/lib/regen.test.ts 2>/dev/null; then
    pass "5b. regen.test.ts asserts contentUpdate.state === 'RESOLVED'"
  else
    fail "5b. regen.test.ts no longer asserts contentUpdate.state — coverage regression"
  fi

  # 5c. The mock supports .returning() — required by the new LINKING lock.
  if grep -q "returning:" core/src/lib/regen.test.ts 2>/dev/null; then
    pass "5c. regen.test.ts mock exposes .returning() (matches lock-UPDATE chain)"
  else
    fail "5c. regen.test.ts mock missing .returning() — test would skip the lock path"
  fi
else
  skip "5. npx unavailable — vitest assertion skipped"
fi

# ── 6. Code-presence guard (defense in depth) ────────────────
# Belt-and-suspenders: grep the production source for the exact lines
# PR #186 introduces. If a future refactor removes them, this plan still
# fires. Pure file-level checks — no DB or HTTP needed, so they run
# even in the OPENROUTER_API_KEY-missing path.

# 6a. The final UPDATE sets state: 'RESOLVED'.
if grep -q "state: 'RESOLVED'" core/src/lib/regen.ts 2>/dev/null; then
  pass "6a. regen.ts contains state: 'RESOLVED' in final update"
else
  fail "6a. regen.ts no longer sets state: 'RESOLVED' — fix has regressed"
fi

# 6b. The optimistic LINKING lock at function entry is present.
if grep -qE "set\(\{ state: 'LINKING' \}\)" core/src/lib/regen.ts 2>/dev/null; then
  pass "6b. regen.ts contains the LINKING optimistic-lock UPDATE"
else
  fail "6b. regen.ts missing the LINKING lock — concurrent calls will double-process"
fi

# 6c. Reason-3 batch query respects the 15-minute LINKING window.
if grep -q "INTERVAL '15 minutes'" core/src/queue/regen-worker.ts 2>/dev/null; then
  pass "6c. regen-worker.ts contains the 15-minute LINKING window"
else
  fail "6c. regen-worker.ts missing the LINKING-window guard — batch would stomp active workers"
fi

# ── Cleanup ──────────────────────────────────────────────────
# Soft-delete the throwaway wiki so downstream plans see a clean fixture.
if [ -n "$TMP_KEY" ] && [ "$TMP_KEY" != "null" ]; then
  curl -s -o /dev/null -X DELETE -b "$COOKIE_JAR" \
    -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$TMP_KEY" || true
fi

# Make sure the seed wiki is RESOLVED on exit (we forced it through
# PENDING → LINKING → RESOLVED during the run).
psql "$DATABASE_URL" -t -A -c \
  "UPDATE wikis SET state='RESOLVED', updated_at=NOW() WHERE lookup_key='$WIKI_KEY' AND state != 'RESOLVED'" \
  >/dev/null 2>&1 || true

# Restore wikis.regenerate to its pre-run value (see §0d).
if [ "$ORIG_REGENERATE" = "t" ] || [ "$ORIG_REGENERATE" = "f" ]; then
  RESTORE_VAL="false"
  [ "$ORIG_REGENERATE" = "t" ] && RESTORE_VAL="true"
  psql "$DATABASE_URL" -t -A -c \
    "UPDATE wikis SET regenerate=$RESTORE_VAL WHERE slug='transformer-architecture' AND deleted_at IS NULL" \
    >/dev/null 2>&1 || true
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0a | Sign-in establishes session cookie | prerequisite |
| 0b | Transformer fixture wiki resolvable | plan 22 dependency |
| 0c | DATABASE_URL set for state-column reads | psql convention |
| 1a | Pre-condition: wiki forced to PENDING | test setup |
| 1b | POST `/wikis/:id/regenerate` → 200 | route exists, awaits regenerateWiki |
| 1c | wiki.state = RESOLVED after regen | PR #186 body — final `.set()` writes RESOLVED |
| 1d | wiki.state ≠ LINKING after regen (lock released) | PR #186 — concurrency claim |
| 1e | wiki.state ≠ PENDING after regen | issue #170 inverse |
| 1f | lastRebuiltAt updated within 60s | proves final UPDATE actually ran |
| 2a | Pre-condition: wiki forced to LINKING | concurrency setup |
| 2b | Concurrent regen returns 200 (no throw) | PR #186 — LINKING guard |
| 2c | Concurrent regen short-circuits in ≤5s | guard fires before LLM call |
| 2d | Response.fragmentCount = 0 (early-bail RegenResult) | PR #186 diff lines 312–315 |
| 2e | Content md5 unchanged across concurrent call | guard prevents double-write |
| 2f | Lock cleared after test | cleanup |
| 3a | Exactly 1 row for `transformer-architecture` slug | issue #170 — "creates new wiki" inverse |
| 3b | RESOLVED wiki excluded from Reason-3 batch query | PR #186 — Reason-3 SQL change |
| 3c | PENDING wiki IS in batch query (sanity) | confirms query discriminates by state |
| 4a | Fresh LINKING wiki excluded from batch | PR #186 — `OR updated_at < NOW() - 15 min` |
| 4b | Stale LINKING wiki (>15 min) recoverable | PR #186 — crashed-worker recovery |
| 4c | LINKING wiki at 14 min still excluded (boundary) | PR #186 — `>15 min` semantic |
| 5a | `regen.test.ts` vitest run passes | PR #186 test plan checkbox 2 |
| 5b | Test asserts `contentUpdate.state === 'RESOLVED'` | PR #186 diff (regen.test.ts +3 lines) |
| 5c | Test mock exposes `.returning()` | PR #186 diff (mock chain update) |
| 6a | Source contains `state: 'RESOLVED'` in final update | code-presence regression guard |
| 6b | Source contains LINKING optimistic-lock UPDATE | code-presence regression guard |
| 6c | Worker source contains 15-minute LINKING window | code-presence regression guard |

---

## Notes

- **Drift adapted**: PR #186 body talks about an "optimistic LINKING lock" but the diff shows `set({ state: 'LINKING' }).where(... ne(state, 'LINKING'))` — i.e. a conditional UPDATE, not a row-level Postgres lock. Section 2 frames this correctly: the second caller's UPDATE returns 0 rows because the WHERE clause excludes already-LINKING rows, and `[lockedWiki]` is `undefined`, so the function returns the empty-RegenResult shape (`fragmentCount: 0`). The "guard" is the `if (!lockedWiki) return …` branch, not a database lock primitive.
- **Issue #170 framing**: The issue body is one sentence and has no acceptance checklist. The plan reads it as "regen must update the existing row, not create a new one." The PR's own description names the actual root cause (PENDING-forever → re-processed every midnight → fragments shifting between wikis), so the inverse-repro is split across sections 1 (state reaches RESOLVED so it stays out of the batch), 3a (no duplicate row) and 3b (RESOLVED row excluded from Reason-3).
- **Why `psql` polling rather than HTTP polling**: the regenerate route is synchronous — it `await`s `regenerateWiki(db, id)` before returning 200 — so the state column is committed by the time the HTTP response lands. The `poll_state` helper is defined for completeness but section 1 reads state directly. Sections 3 and 4 use direct SQL because they assert on the exact query the batch worker runs (no HTTP entry point exposes "what would the batch pick up?").
- **Why we run vitest in section 5**: section 6's grep-for-string assertions catch deletion of the fix; section 5 catches behavioral regressions where the line is still there but the surrounding control flow no longer reaches it. The two together pin both code presence and code semantics.
- **Known trap**: section 2c uses a 5-second budget for the early-bail. If the local dev box is heavily loaded (heavy Postgres latency, slow auth middleware) this could false-fail. The 5s budget is still ~10x faster than a real LLM call (15-30s) so the gap is meaningful, but a CI runner with cold caches may need to bump it. Document, not fix.
- **Cleanup is best-effort**: the throwaway wiki gets DELETEd and the seed wiki gets restored to RESOLVED. If the run is killed mid-way, downstream plans will see a non-RESOLVED seed wiki — plan 22 step 7a will then fail with a useful error pointing at this plan's interrupted state.
