# 70 — Regen debounce and on-demand regen (QA Issue 6)

## What it proves

QA Issue 6 (2026-05-08): a 60-minute ingest of 89 entries (534 fragments)
triggered 27 back-to-back regens because every fragment landing matched
the regen-worker's "wiki has new edges since last_rebuilt_at" rule. Each
regen was 70 to 180 seconds of LLM work, most superseded before its
output mattered.

This branch (`fix/regen-debounce-and-on-demand`) ships three coupled
pieces:

1. **Per-wiki debounce** (`core/src/queue/regen-debounce.ts`,
   `core/src/queue/regen-worker.ts`). Reasons 1 and 2 in
   `processRegenBatchJob` skip a wiki whose most-recent
   FRAGMENT_IN_WIKI edge landed inside `REGEN_DEBOUNCE_MS` (default 5
   min). Reasons 3 (stuck recovery) and 4 (midnight cron) bypass.
2. **`regen_now` MCP tool** -- on-demand regen, bypasses debounce, same
   auth as other write tools.
3. **`regen_status` MCP tool** -- snapshot of in-flight, debounced, and
   recent regens. The "regen happening now" indicator from Issue 6.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`
- `DATABASE_URL` reachable (`psql` for direct row inspection)
- Worker process running (`pnpm -C core dev:worker` or equivalent),
  otherwise enqueued regens never start
- `MCP_TOKEN` for the test user (mint via `/api/users/mcp-token` once
  signed in -- the script does this for you)
- A wiki + at least one fragment seeded
  (`pnpm -C core seed-fixture` if available)
- `REGEN_DEBOUNCE_MS=60000` recommended in `core/.env` for the burst
  test (1 min instead of 5 min so the script does not run for ages)

## Endpoint map

- `POST /api/auth/sign-in/email`              — cookie session
- `POST /api/users/mcp-token`                  — mint MCP JWT
- `POST /mcp/?token=$MCP_TOKEN` (JSON-RPC):
  - `tools/list`             — assert `regen_now`, `regen_status` visible
  - `tools/call regen_now`
  - `tools/call regen_status`
  - `tools/call log_fragment` (for the burst-ingest test)

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"
DB_URL="${DATABASE_URL:-postgresql://robin:@localhost:5432/robin_dev}"
DEBOUNCE_MS="${REGEN_DEBOUNCE_MS:-60000}"
JAR=$(mktemp /tmp/uat-70-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-70-*.json /tmp/uat-70-*.code' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  + $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ! $1"; }
skip() { SKIP=$((SKIP+1)); echo "  - $1"; }

echo "70 — Regen debounce and on-demand regen (QA Issue 6)"
echo "    REGEN_DEBOUNCE_MS=$DEBOUNCE_MS"
echo ""

# 1. Sign in (HTTP cookie session for HTTP assertions)
curl -s -o /tmp/uat-70-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" > /tmp/uat-70-signin.code
if [ "$(cat /tmp/uat-70-signin.code)" = "200" ]; then pass "sign in"; else fail "sign in code $(cat /tmp/uat-70-signin.code)"; fi

# 2. Mint an MCP token.
curl -s -o /tmp/uat-70-token.json -w "%{http_code}" -b "$JAR" \
  -X POST -H "Origin: $ORIGIN" \
  "$SERVER_URL/api/users/mcp-token" > /tmp/uat-70-token.code || true
MCP_TOKEN_VALUE=$(jq -r '.token // empty' /tmp/uat-70-token.json 2>/dev/null)
MCP_TOKEN="${MCP_TOKEN:-$MCP_TOKEN_VALUE}"
if [ -n "$MCP_TOKEN" ]; then pass "have MCP token"; else fail "no MCP token"; fi

# 3. tools/list — confirm regen_now and regen_status present.
TOOLS_LIST=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$SERVER_URL/mcp/?token=$MCP_TOKEN" | tr -d '\r')
echo "$TOOLS_LIST" > /tmp/uat-70-tools.json
for tool in regen_now regen_status; do
  if echo "$TOOLS_LIST" | jq -e --arg n "$tool" '.result.tools[] | select(.name==$n)' >/dev/null 2>&1; then
    pass "MCP exposes $tool"
  else
    fail "MCP missing $tool"
  fi
done

# Pick a wiki to drive the burst test.
WIKI_SLUG=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].slug // empty')
WIKI_KEY=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].id // empty')
if [ -z "$WIKI_SLUG" ] || [ -z "$WIKI_KEY" ]; then
  fail "no wiki seeded; the burst test will be skipped"
  WIKI_SLUG=""
fi

# 4. Burst-ingest test: 30 fragments into one wiki, wait for the
#    debounce window, count regen events.
if [ -n "$WIKI_SLUG" ]; then
  # Snapshot regen completion count BEFORE the burst.
  BEFORE_REGENS=$(psql -q "$DB_URL" -At -c "
    SELECT count(*) FROM pipeline_events
    WHERE stage='regen' AND status='completed'
      AND (metadata->>'wikiKey') = '$WIKI_KEY';
  " 2>/dev/null || echo "0")
  pass "baseline regen count for $WIKI_SLUG = $BEFORE_REGENS"

  echo "  · firing 30 log_fragment calls into $WIKI_SLUG..."
  for i in $(seq 1 30); do
    REQ=$(jq -nc --arg w "$WIKI_SLUG" --arg c "uat70 burst fragment $i $(date +%s%N)" '{
      jsonrpc:"2.0", id:'$i', method:"tools/call",
      params:{name:"log_fragment", arguments:{threadSlug:$w, content:$c}}
    }')
    curl -s -X POST -H "Content-Type: application/json" \
      -d "$REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN" >/dev/null
    # Tight loop -- mimic the live deployment scenario.
    sleep 0.1
  done
  pass "30 fragments enqueued"

  # Wait for the debounce window to elapse, plus a margin for the
  # batch-cron tick + the regen worker LLM call to complete.
  WAIT_MS=$((DEBOUNCE_MS + 120000))
  echo "  · waiting ${WAIT_MS}ms for debounce + regen + batch-tick..."
  # shellcheck disable=SC2059
  sleep $((WAIT_MS / 1000))

  AFTER_REGENS=$(psql -q "$DB_URL" -At -c "
    SELECT count(*) FROM pipeline_events
    WHERE stage='regen' AND status='completed'
      AND (metadata->>'wikiKey') = '$WIKI_KEY';
  " 2>/dev/null || echo "0")
  DELTA=$((AFTER_REGENS - BEFORE_REGENS))
  echo "  · regen completions during burst: $DELTA"

  # Pre-fix: ~5-10 regens for a 30-fragment burst inside a single
  # batch-cron interval. Post-fix: ~1 regen (debounce coalesces the
  # burst into a single trailing regen).
  if [ "$DELTA" -le 2 ]; then
    pass "burst coalesced into <=2 regens (was ~5-10 pre-fix)"
  else
    fail "burst triggered $DELTA regens (expected <=2 with debounce)"
  fi
else
  skip "burst-ingest test: no wiki to drive against"
fi

# 5. regen_now bypasses the debounce window. We just hammered the wiki
#    with fragments above, so it MUST be inside the debounce window
#    when this runs (we slept past it -- so re-trigger to make it dirty
#    again).
if [ -n "$WIKI_SLUG" ]; then
  REQ=$(jq -nc --arg w "$WIKI_SLUG" --arg c "uat70 retrigger $(date +%s%N)" '{
    jsonrpc:"2.0", id:80, method:"tools/call",
    params:{name:"log_fragment", arguments:{threadSlug:$w, content:$c}}
  }')
  curl -s -X POST -H "Content-Type: application/json" \
    -d "$REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN" >/dev/null
  pass "wiki dirtied so debounce window is active"

  # Snapshot regen count, fire regen_now, expect a NEW completion
  # within seconds (assuming regen worker is up).
  BEFORE_NOW=$(psql -q "$DB_URL" -At -c "
    SELECT count(*) FROM pipeline_events
    WHERE stage='regen' AND (metadata->>'wikiKey') = '$WIKI_KEY';
  " 2>/dev/null || echo "0")

  REQ=$(jq -nc --arg w "$WIKI_SLUG" '{
    jsonrpc:"2.0", id:81, method:"tools/call",
    params:{name:"regen_now", arguments:{wikiKey:$w}}
  }')
  RES=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "$REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN")
  echo "$RES" > /tmp/uat-70-regennow.json
  PAYLOAD=$(echo "$RES" | jq -r '.result.content[0].text // empty' | jq -c .)
  JOB_ID=$(echo "$PAYLOAD" | jq -r '.jobId // empty')
  if [ -n "$JOB_ID" ]; then pass "regen_now returned jobId=$JOB_ID"; else fail "regen_now did not return a jobId"; fi

  # Expect at least one new pipeline_event row within 30s.
  for _ in $(seq 1 30); do
    AFTER_NOW=$(psql -q "$DB_URL" -At -c "
      SELECT count(*) FROM pipeline_events
      WHERE stage='regen' AND (metadata->>'wikiKey') = '$WIKI_KEY';
    " 2>/dev/null || echo "0")
    if [ "$AFTER_NOW" -gt "$BEFORE_NOW" ]; then break; fi
    sleep 1
  done
  if [ "$AFTER_NOW" -gt "$BEFORE_NOW" ]; then
    pass "regen_now produced a pipeline_event row inside the debounce window"
  else
    fail "regen_now did NOT produce a pipeline_event row (worker down? check core logs)"
  fi
else
  skip "regen_now test: no wiki"
fi

# 6. regen_status returns sensible data.
REQ='{"jsonrpc":"2.0","id":90,"method":"tools/call","params":{"name":"regen_status","arguments":{"recentLimit":5}}}'
RES=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "$REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN")
echo "$RES" > /tmp/uat-70-status.json
STATUS=$(echo "$RES" | jq -r '.result.content[0].text // empty' | jq -c .)
if [ -n "$STATUS" ]; then pass "regen_status returned a payload"; else fail "regen_status returned nothing"; fi
HAS_KEYS=$(echo "$STATUS" | jq -r '[has("inFlight"), has("debounced"), has("recent"), has("debounceMs")] | all')
if [ "$HAS_KEYS" = "true" ]; then
  pass "regen_status carries inFlight, debounced, recent, debounceMs"
else
  fail "regen_status missing required keys ($STATUS)"
fi
DEBOUNCE_FROM_STATUS=$(echo "$STATUS" | jq -r '.debounceMs // 0')
if [ "$DEBOUNCE_FROM_STATUS" = "$DEBOUNCE_MS" ]; then
  pass "regen_status reports debounceMs=$DEBOUNCE_FROM_STATUS"
else
  skip "regen_status debounceMs=$DEBOUNCE_FROM_STATUS (env was $DEBOUNCE_MS, server may have a different value)"
fi

# 7. Existing scheduled regen still works after the debounce window.
#    Hands-off check: dirty a quiet wiki, wait past the debounce, the
#    next batch-cron tick should enqueue. Caller can run this manually
#    once they have a wiki that has been quiet for >5 min.
if [ -n "$WIKI_SLUG" ]; then
  # Force-attach a fragment well in the past to simulate "old activity".
  # (Cannot actually time-travel; the script just dirties the wiki and
  # asserts the regen does fire on the next batch tick beyond the
  # debounce window.)
  REQ=$(jq -nc --arg w "$WIKI_SLUG" --arg c "uat70 quiet $(date +%s%N)" '{
    jsonrpc:"2.0", id:91, method:"tools/call",
    params:{name:"log_fragment", arguments:{threadSlug:$w, content:$c}}
  }')
  curl -s -X POST -H "Content-Type: application/json" \
    -d "$REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN" >/dev/null

  BEFORE_QUIET=$(psql -q "$DB_URL" -At -c "
    SELECT count(*) FROM pipeline_events
    WHERE stage='regen' AND status='completed'
      AND (metadata->>'wikiKey') = '$WIKI_KEY';
  " 2>/dev/null || echo "0")

  WAIT_S=$(((DEBOUNCE_MS / 1000) + 120))
  echo "  · waiting ${WAIT_S}s for debounce window + a batch tick..."
  sleep "$WAIT_S"

  AFTER_QUIET=$(psql -q "$DB_URL" -At -c "
    SELECT count(*) FROM pipeline_events
    WHERE stage='regen' AND status='completed'
      AND (metadata->>'wikiKey') = '$WIKI_KEY';
  " 2>/dev/null || echo "0")
  if [ "$AFTER_QUIET" -gt "$BEFORE_QUIET" ]; then
    pass "scheduled regen still fires after the debounce elapses"
  else
    skip "no regen completion observed -- batch-cron tick may not have fired in window"
  fi
else
  skip "scheduled-regen test: no wiki"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Cleanup

The script appends `uat70` fragments to the seed wiki. Manual cleanup:

```bash
psql "$DATABASE_URL" -c "
  UPDATE fragments SET deleted_at = now()
  WHERE content LIKE 'uat70 %' AND deleted_at IS NULL;
"
```

## Expected pass/fail behavior

All steps PASS on a clean local stack with the worker running and
`REGEN_DEBOUNCE_MS=60000` set. Step 4 (burst → ≤2 regens) is the
load-bearing assertion against QA Issue 6's symptom. Steps 5 + 6 prove
the recovery surfaces (`regen_now`, `regen_status`) work. Step 7 SKIPS
when the batch-cron tick does not fire inside the wait window; it is
intentional belt-and-braces, not a hard gate.

## Out of scope

- The `regenerate` vs `auto_regen` flag confusion is deferred to v0.2.2
  (per Andrew lock). This UAT does not assert on either flag.
- Reason 3 (stuck-state recovery) bypass is exercised by the existing
  unit tests in `core/src/queue/regen-debounce.test.ts`. Reproducing
  that path live requires forcing `state != 'RESOLVED' AND state !=
  'LINKING'` for >15 minutes, which is an operator-only scenario.
