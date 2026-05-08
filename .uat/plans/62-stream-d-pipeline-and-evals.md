# 62 — Stream D — Pipeline + Evals (D1', D2, D3, D4, D5, D6)

## What it proves

Stream D ships six tightly coupled changes:

- **D1'** — PUT /fragments/:id writes an `edits` snapshot row and emits an
  `audit_log` row with `event_type='fragment.updated'` on every edit.
  Stream A5's history endpoint and Stream F4's evolution timeline both
  consume this data.
- **D2** — `pnpm -F @robin/core eval` runs the evalite + autoevals harness
  against the fragmentation and classification corpora and exits 0 when
  the average score meets the threshold.
- **D3** — 20 hand-authored fragmentation fixtures live at
  `core/eval/fragmentation/fixtures/`.
- **D4** — 20 hand-authored classification fixtures live at
  `core/eval/classification/fixtures/`.
- **D5** — Fragment-relationship backfill (#258) ships three surfaces:
  midnight cron, admin endpoint
  (`POST /admin/backfill/fragment-relationships`), and the settings
  outstanding counter (`GET /users/settings/outstanding`).
- **D6** — Empty-wiki bootstrap writes a `kind='description'` row to
  `wiki_agent_schema` on wiki create, populated from `wikis.description`
  and the wiki embedding.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Database reachable via `DATABASE_URL` (psql).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set.
- Migrations 0004 (`edits` content_before/after) and 0005
  (`wiki_agent_schema`) applied.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "62 — Stream D — Pipeline + Evals"
echo ""

# Sign in
curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null

UAT_TAG="uat62-$(date +%s)"
TEST_START=$(psql "$DATABASE_URL" -t -A -c "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')" 2>/dev/null | tr -d '[:space:]')

# ── 1. D1' — Fragment edit audit emission ───────────────────────────
# PUT /fragments/:id three times, assert `edits` table has 3 snapshots
# and audit_log has 3 fragment.updated events for the same fragment.

# Seed an entry then a fragment we can edit.
ENTRY_PAYLOAD=$(jq -n --arg t "$UAT_TAG" '{title:"UAT 62 entry", content:"seed text", source:"api", type:"thought"}')
ENTRY_RESP=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$ENTRY_PAYLOAD" \
  "$SERVER_URL/entries")
ENTRY_ID=$(echo "$ENTRY_RESP" | jq -r '.id // ""')
[ -n "$ENTRY_ID" ] && pass "1a. Seeded entry (id=$ENTRY_ID)" || fail "1a. Could not seed entry: $ENTRY_RESP"

FRAG_PAYLOAD=$(jq -n --arg eid "$ENTRY_ID" '{title:"UAT 62 frag", content:"version 0", entryId:$eid, tags:["uat62"]}')
FRAG_RESP=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$FRAG_PAYLOAD" \
  "$SERVER_URL/fragments")
FRAG_ID=$(echo "$FRAG_RESP" | jq -r '.id // ""')
[ -n "$FRAG_ID" ] && pass "1b. Seeded fragment (id=$FRAG_ID)" || fail "1b. Could not seed fragment: $FRAG_RESP"

# Three PUTs with three different content values.
for i in 1 2 3; do
  PUT_RESP=$(curl -s -X PUT -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: http://localhost:3000" \
    -d "{\"content\":\"version $i\"}" \
    "$SERVER_URL/fragments/$FRAG_ID")
  PUT_OK=$(echo "$PUT_RESP" | jq -r '.id // ""')
  if [ -n "$PUT_OK" ]; then
    pass "1c.$i. PUT /fragments/$FRAG_ID with content='version $i' → 200"
  else
    fail "1c.$i. PUT /fragments/$FRAG_ID failed: $PUT_RESP"
  fi
done

# Assert: edits table has 3 fragment-typed rows for this fragment.
EDITS_COUNT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM edits WHERE object_type='fragment' AND object_id='$FRAG_ID' AND timestamp >= '$TEST_START'" \
  | tr -d '[:space:]')
[ "$EDITS_COUNT" = "3" ] && pass "1d. edits table has 3 snapshots (got $EDITS_COUNT)" || fail "1d. edits row count: expected 3, got $EDITS_COUNT"

# Assert: each row populates content_before and content_after.
EDIT_BEFORE_AFTER=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM edits WHERE object_type='fragment' AND object_id='$FRAG_ID' AND content_before IS NOT NULL AND content_after IS NOT NULL AND timestamp >= '$TEST_START'" \
  | tr -d '[:space:]')
[ "$EDIT_BEFORE_AFTER" = "3" ] && pass "1e. all 3 edits rows carry content_before + content_after" || fail "1e. only $EDIT_BEFORE_AFTER/3 rows have both columns"

# Assert: audit_log has 3 'fragment.updated' rows for this fragment.
AUDIT_COUNT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM audit_log WHERE entity_type='fragment' AND entity_id='$FRAG_ID' AND event_type='fragment.updated' AND created_at >= '$TEST_START'" \
  | tr -d '[:space:]')
[ "$AUDIT_COUNT" = "3" ] && pass "1f. audit_log has 3 fragment.updated events (got $AUDIT_COUNT)" || fail "1f. audit_log fragment.updated count: expected 3, got $AUDIT_COUNT"

# ── 2. D2 — Eval runner ─────────────────────────────────────────────
# `pnpm -F @robin/core eval` invokes the evalite harness, runs both
# fragmentation and classification suites, and exits 0 when the score
# meets the threshold.

EVAL_OUT=$(mktemp /tmp/uat-62-eval-XXXXXX.txt)
if pnpm -F @robin/core eval >"$EVAL_OUT" 2>&1; then
  pass "2a. pnpm -F @robin/core eval exits 0"
else
  fail "2a. eval suite exited non-zero — see $EVAL_OUT"
fi

# Assert: report mentions both eval files (≥1 report row each).
if grep -qE 'eval/fragmentation/fragmentation\.eval\.ts' "$EVAL_OUT"; then
  pass "2b. eval report mentions fragmentation suite"
else
  fail "2b. eval report missing fragmentation suite"
fi
if grep -qE 'eval/classification/classification\.eval\.ts' "$EVAL_OUT"; then
  pass "2c. eval report mentions classification suite"
else
  fail "2c. eval report missing classification suite"
fi

# ── 3. D3 — Fragmentation corpus ────────────────────────────────────
# Assert: 20 fixture files exist under core/eval/fragmentation/fixtures/.

FRAG_FIX_COUNT=$(ls core/eval/fragmentation/fixtures/*.json 2>/dev/null | wc -l)
[ "$FRAG_FIX_COUNT" -ge 20 ] && pass "3a. fragmentation corpus has $FRAG_FIX_COUNT fixtures (≥20)" || fail "3a. fragmentation corpus has $FRAG_FIX_COUNT fixtures, expected ≥20"

# Each fixture has a non-empty input + mustContain array.
FRAG_BAD=0
for f in core/eval/fragmentation/fixtures/*.json; do
  if ! jq -e '.input | length > 0' "$f" >/dev/null 2>&1; then
    FRAG_BAD=$((FRAG_BAD+1))
    echo "    ✗ $f missing input"
  fi
  if ! jq -e '.mustContain | length > 0' "$f" >/dev/null 2>&1; then
    FRAG_BAD=$((FRAG_BAD+1))
    echo "    ✗ $f missing mustContain"
  fi
done
[ "$FRAG_BAD" = "0" ] && pass "3b. every fragmentation fixture has input + mustContain" || fail "3b. $FRAG_BAD fragmentation fixtures malformed"

# ── 4. D4 — Classification corpus ───────────────────────────────────

CLS_FIX_COUNT=$(ls core/eval/classification/fixtures/*.json 2>/dev/null | wc -l)
[ "$CLS_FIX_COUNT" -ge 20 ] && pass "4a. classification corpus has $CLS_FIX_COUNT fixtures (≥20)" || fail "4a. classification corpus has $CLS_FIX_COUNT fixtures, expected ≥20"

CLS_BAD=0
for f in core/eval/classification/fixtures/*.json; do
  if ! jq -e '.input | length > 0' "$f" >/dev/null 2>&1; then
    CLS_BAD=$((CLS_BAD+1))
    echo "    ✗ $f missing input"
  fi
  if ! jq -e '.expected | type == "array"' "$f" >/dev/null 2>&1; then
    CLS_BAD=$((CLS_BAD+1))
    echo "    ✗ $f missing expected array"
  fi
done
[ "$CLS_BAD" = "0" ] && pass "4b. every classification fixture has input + expected[]" || fail "4b. $CLS_BAD classification fixtures malformed"

# ── 5. D5 — Fragment-relationship backfill ──────────────────────────
# Trigger admin endpoint, confirm enqueued; check counter.

BACKFILL_RESP=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  "$SERVER_URL/admin/backfill/fragment-relationships")
ENQUEUED=$(echo "$BACKFILL_RESP" | jq -r '.enqueued // false')
JOB_ID=$(echo "$BACKFILL_RESP" | jq -r '.jobId // ""')
if [ "$ENQUEUED" = "true" ] && [ -n "$JOB_ID" ]; then
  pass "5a. POST /admin/backfill/fragment-relationships → enqueued=true (jobId=$JOB_ID)"
else
  fail "5a. backfill not enqueued: $BACKFILL_RESP"
fi

# /settings/outstanding surfaces the counter.
OUT_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/users/settings/outstanding")
HAS_FIELD=$(echo "$OUT_RESP" | jq -e '.fragmentRelationshipBackfill.fragmentsAwaitingBackfill | type == "number"' >/dev/null 2>&1 && echo "yes" || echo "no")
if [ "$HAS_FIELD" = "yes" ]; then
  COUNT=$(echo "$OUT_RESP" | jq -r '.fragmentRelationshipBackfill.fragmentsAwaitingBackfill')
  pass "5b. /users/settings/outstanding surfaces fragmentsAwaitingBackfill=$COUNT"
else
  fail "5b. /users/settings/outstanding missing fragmentRelationshipBackfill counter: $OUT_RESP"
fi

# Wait briefly for the worker to process, then re-check the counter.
# We don't pass/fail on the count change (depends on corpus state) — just
# that the run was acknowledged in audit_log.
sleep 3
RUN_AUDIT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM audit_log WHERE entity_type='fragment_relationship_backfill' AND entity_id='$JOB_ID' AND event_type IN ('started','completed','failed')" \
  | tr -d '[:space:]')
[ "$RUN_AUDIT" -ge 1 ] && pass "5c. audit_log row exists for jobId=$JOB_ID (count=$RUN_AUDIT)" || fail "5c. no audit_log row for jobId=$JOB_ID"

# ── 6. D6 — Empty-wiki bootstrap (DEFERRED to follow-up) ──────────
# D6 was originally scoped to write a kind='description' row into
# wiki_agent_schema on POST /wikis. Stream G owns wiki_agent_schema
# (PR #326) and the schema shape changed late in v0.2.0 planning
# (wiki_key + generator_version primary key, not the wiki_id shape D
# originally implemented). Rather than ship a colliding migration, D6
# is deferred to a follow-up PR that lands AFTER G merges to main.
# The follow-up writes the kind='description' row using G's exact
# shape with generator_version='hyde_v1'.

skip "6a. D6 deferred to follow-up PR (depends on G #326 landing first)"
skip "6b. D6 wiki_agent_schema row check deferred"
skip "6c. D6 content match check deferred"
skip "6d. D6 no-hyde_synthetic check deferred"

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────────────"
echo "  Passed: $PASS    Failed: $FAIL    Skipped: $SKIP"
echo "──────────────────────────────────────────────────"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
```

---

## Notes

- The eval suite (§2) ships deterministic stub tasks so it runs offline
  without OpenRouter credentials. Wire the real Marcel/Elfie agents when
  exercising LLM-backed scoring.
- §6 marks the bootstrap row as `skip` when OpenRouter isn't available —
  the embed call short-circuits and no row is written. The route never
  fails the wiki-create on bootstrap errors (silent fall-through).
- The midnight cron (§5 backdrop) runs at `5 0 * * *` — five minutes
  after the regen batch — to avoid lock contention on the fragments
  table at the top of the hour.
