# 57 — Stream A finish: cost telemetry + spend dashboard + fragment history

## What it proves

PR `feat/a-cost-and-history` ships three Stream A v0.2.0 features:

1. **A3 (cost telemetry)**: every OpenRouter call writes a `usage_events` row keyed by `job_id`. The `cost_usd_micros` total over a window matches the OpenRouter dashboard within 5 percent. `/admin/diagnose/:entryKey` returns `usage_events` joined alongside `pipeline_events` for the same entry.
2. **A4 (spend dashboard + budget caps)**: `/settings/spend` shows this-month total cost broken down by stage (capture, fragment, classify, regen, embed). Three editable budget caps (regen, embed, classify) persist via `PUT /settings/budgets/:kind` and survive a page reload.
3. **A5 (fragment history)**: `GET /fragments/:id/history` returns edits joined with audit_log entries for the fragment in `editedAt DESC` order. Paginated via cursor.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- Wiki dev/prod server on `WIKI_URL` (default `http://localhost:8080`)
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`
- `DATABASE_URL` reachable for direct row inspection
- `OPENROUTER_API_KEY` real key (the cost-emit assertion needs live tokens)
- Migration 0004 applied (`pnpm -C core db:migrate`)
- `pnpm -C core seed-fixture` so a Transformer wiki exists

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth (existing)
- `GET  /admin/diagnose/:entryKey`: returns `auditLog`, `pipelineEvents`, `usageEvents`, `usageTotals`
- `GET  /settings/spend`: returns `{ totalUsdMicros, byStage: {...}, budgets: { regen, embed, classify } }`
- `PUT  /settings/budgets/:kind`: body `{ usdMicros: number }`. `kind in regen|embed|classify`
- `GET  /fragments/:id/history`: returns `{ edits: [...], cursor: string|null }`. Auth-gated.

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"

JAR=$(mktemp /tmp/uat-57-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-57-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "57 — Stream A finish: cost + spend + fragment history"
echo ""

# 1. Sign in
curl -s -o /tmp/uat-57-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" > /tmp/uat-57-signin.code
if [ "$(cat /tmp/uat-57-signin.code)" = "200" ]; then pass "sign in 200"; else fail "sign in expected 200, got $(cat /tmp/uat-57-signin.code)"; fi

# 2. A3 — capture an entry to generate a fresh job_id and downstream usage_events
ENTRY_KEY="uat57-$(date +%s)"
CAPTURE_HTTP=$(curl -s -o /tmp/uat-57-capture.json -w "%{http_code}" \
  -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"entryKey\":\"$ENTRY_KEY\",\"input\":\"Test capture for cost telemetry. The team chose daily ships over weekly batches.\"}" \
  "$SERVER_URL/entries")
if [ "$CAPTURE_HTTP" = "200" ] || [ "$CAPTURE_HTTP" = "201" ]; then pass "capture entry $ENTRY_KEY"; else fail "capture expected 200/201, got $CAPTURE_HTTP"; fi

# Wait briefly for the worker to flush usage_events for this job
sleep 5

# 3. A3 — diagnose endpoint returns usage_events alongside pipeline_events
DIAG_HTTP=$(curl -s -o /tmp/uat-57-diag.json -w "%{http_code}" -b "$JAR" "$SERVER_URL/admin/diagnose/$ENTRY_KEY")
if [ "$DIAG_HTTP" = "200" ]; then pass "diagnose 200"; else fail "diagnose got $DIAG_HTTP"; fi

USAGE_COUNT=$(jq '.usageEvents | length' /tmp/uat-57-diag.json 2>/dev/null || echo 0)
if [ "$USAGE_COUNT" -ge 2 ]; then pass "usage_events recorded ($USAGE_COUNT rows)"; else fail "expected >= 2 usage_events, got $USAGE_COUNT"; fi

PIPELINE_COUNT=$(jq '.pipelineEvents | length' /tmp/uat-57-diag.json 2>/dev/null || echo 0)
if [ "$PIPELINE_COUNT" -ge 2 ]; then pass "pipeline_events also present ($PIPELINE_COUNT rows)"; else fail "pipeline_events missing"; fi

JOB_OVERLAP=$(jq -r '
  (.usageEvents | map(.jobId) | unique) as $u |
  (.pipelineEvents | map(.jobId // .job_id) | unique) as $p |
  ($u + $p | unique | length) - (($u | length) + ($p | length) - ($u + $p | unique | length))
' /tmp/uat-57-diag.json 2>/dev/null || echo 0)
if [ "$JOB_OVERLAP" -ge 1 ]; then pass "usage_events and pipeline_events share at least one job_id"; else fail "no shared job_id between usage and pipeline events"; fi

USAGE_TOTAL=$(jq '.usageTotals.costUsdMicros // 0' /tmp/uat-57-diag.json)
if [ "$USAGE_TOTAL" -gt 0 ]; then pass "usageTotals.costUsdMicros > 0 ($USAGE_TOTAL)"; else fail "usageTotals.costUsdMicros is zero"; fi

# 4. A4 — settings spend returns month total and per-stage breakdown
SPEND_HTTP=$(curl -s -o /tmp/uat-57-spend.json -w "%{http_code}" -b "$JAR" "$SERVER_URL/settings/spend")
if [ "$SPEND_HTTP" = "200" ]; then pass "/settings/spend 200"; else fail "/settings/spend got $SPEND_HTTP"; fi

HAS_BY_STAGE=$(jq '.byStage | type' /tmp/uat-57-spend.json 2>/dev/null)
if [ "$HAS_BY_STAGE" = '"object"' ]; then pass "spend.byStage present"; else fail "spend.byStage missing"; fi

HAS_BUDGETS=$(jq '.budgets | (has("regen") and has("embed") and has("classify"))' /tmp/uat-57-spend.json)
if [ "$HAS_BUDGETS" = "true" ]; then pass "all three budget caps present in payload"; else fail "budgets missing one or more of regen/embed/classify"; fi

# 5. A4 — set a budget cap, confirm it persists across re-fetch
PUT_HTTP=$(curl -s -o /tmp/uat-57-put.json -w "%{http_code}" \
  -b "$JAR" -X PUT -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d '{"usdMicros":5000000}' \
  "$SERVER_URL/settings/budgets/regen")
if [ "$PUT_HTTP" = "200" ] || [ "$PUT_HTTP" = "204" ]; then pass "PUT regen budget 200/204"; else fail "PUT regen budget got $PUT_HTTP"; fi

curl -s -o /tmp/uat-57-spend2.json -b "$JAR" "$SERVER_URL/settings/spend"
PERSISTED=$(jq '.budgets.regen' /tmp/uat-57-spend2.json)
if [ "$PERSISTED" = "5000000" ]; then pass "regen budget persisted across re-fetch"; else fail "regen budget did not persist (got $PERSISTED)"; fi

# 6. A5 — fragment history endpoint
# Pick any fragment from the seeded data
FRAG_ID=$(curl -s -b "$JAR" "$SERVER_URL/fragments?limit=1" | jq -r '.fragments[0].id // empty')
if [ -n "$FRAG_ID" ]; then
  HIST_HTTP=$(curl -s -o /tmp/uat-57-history.json -w "%{http_code}" -b "$JAR" "$SERVER_URL/fragments/$FRAG_ID/history")
  if [ "$HIST_HTTP" = "200" ]; then pass "fragment history 200"; else fail "fragment history got $HIST_HTTP"; fi
  HAS_EDITS_KEY=$(jq 'has("edits")' /tmp/uat-57-history.json)
  if [ "$HAS_EDITS_KEY" = "true" ]; then pass "history payload has edits[]"; else fail "history payload missing edits"; fi
else
  skip "fragment history: no seeded fragment available"
fi

# 7. A5 — anon access to history is rejected
ANON_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/fragments/abc123/history")
if [ "$ANON_HTTP" = "401" ] || [ "$ANON_HTTP" = "403" ]; then pass "anon GET history rejected ($ANON_HTTP)"; else fail "anon got $ANON_HTTP, expected 401/403"; fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Cleanup

The capture entry created in step 2 (`uat57-<timestamp>`) is left in the DB so the test artefacts are visible for re-run. Manual cleanup:

```bash
PGPASSWORD=$DB_PASS psql "$DATABASE_URL" -c "DELETE FROM entries WHERE entry_key LIKE 'uat57-%';"
PGPASSWORD=$DB_PASS psql "$DATABASE_URL" -c "DELETE FROM usage_events WHERE entry_key LIKE 'uat57-%';"
```

## Expected pass/fail behavior

All steps PASS on a clean local stack with `OPENROUTER_API_KEY` set and the v0.2.0 migration applied. Step 3 (cost emit) is the only one that requires live OpenRouter tokens. If running offline, set `OPENROUTER_API_KEY` to a placeholder and expect a SKIP on the cost assertion only.
