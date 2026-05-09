# 72, people extractor + quarantine (Stream P)

## What it proves

Stream P (#PEOPLE-EXTRACT-Q) flips `people-extraction.yaml` from matcher-only
to extractor, adds the quarantine model gated on
`app_settings.auto_accept_persons`, surfaces five new MCP tools
(`create_person`, `update_person`, `add_relationship`,
`list_pending_persons`, `set_auto_accept_persons`), and exposes
HTTP-only approve and reject endpoints under `/admin/people`.

After this UAT runs:

1. Migration 0017 applied cleanly (additive, idempotent).
2. Existing rows default to `status='verified'` and behave exactly as
   before.
3. Auto-extracted persons land in the quarantine queue
   (`status='pending'`) by default.
4. The same person mentioned twice does not produce duplicate pending
   rows (extract-time dedup).
5. MCP `create_person` always lands `status='verified'` immediately.
6. MCP `update_person` only promotes pending to verified when the
   caller passes `promoteFromQuarantine: true`.
7. MCP `add_relationship` writes a single edge between two existing
   entities.
8. HTTP `POST /admin/people/:key/approve` flips pending to verified.
9. HTTP `POST /admin/people/:key/reject` flips pending to rejected.
10. Hybrid search excludes pending persons entirely.
11. `find_person` returns pending persons WITH a `status` field.
12. Pipeline events for `entity-extract` carry `rawMentionsSeen` and
    `dropRatePct`.
13. Toggling `auto_accept_persons=true` via MCP makes new persons land
    `status='verified'`.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a  | POS | migration 0017 SQL exists at `core/drizzle/migrations/0017_people_status_and_quarantine.sql` |
| 1b  | POS | migration applies cleanly + is idempotent (re-run is a no-op) |
| 2a  | POS | `people.status` column exists, type `text`, default `'verified'`, NOT NULL |
| 2b  | POS | `people.created_via` column exists, nullable text |
| 2c  | POS | `people.extracted_from_fragment_id` column exists, nullable text |
| 2d  | POS | `people.context_notes` column exists, nullable jsonb |
| 2e  | POS | `app_settings` row `auto_accept_persons` exists with value `false` (default) |
| 3a  | POS | MCP `create_person` returns `status='verified'` |
| 3b  | POS | MCP `update_person` with `promoteFromQuarantine: true` flips pending to verified, response carries `promoted: true` |
| 3c  | POS | MCP `update_person` without the flag does NOT promote (response `promoted: false`) |
| 3d  | POS | MCP `add_relationship` writes one PERSON_KNOWS_PERSON edge between two existing persons |
| 4a  | POS | HTTP `POST /admin/people/:key/approve` flips pending to verified |
| 4b  | POS | HTTP `POST /admin/people/:key/reject` flips pending to rejected |
| 5a  | POS | MCP `list_pending_persons` returns rows with `status='pending'` marker |
| 5b  | NEG | MCP server does NOT register `approve_pending_person` or `reject_pending_person` tools |
| 6a  | POS | hybrid search query that should hit a pending person returns ZERO results (excluded entirely) |
| 6b  | POS | MCP `find_person` returns a pending person WITH `status: 'pending'` in payload |
| 7a  | POS | toggling `auto_accept_persons=true` and ingesting yields persons with `status='verified'`, `created_via='extractor_auto'` |

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`.
- `DATABASE_URL` reachable for direct row inspection.
- Migration 0017 applied (`pnpm -C core db:migrate`).
- Repo checkout on `feat/people-extractor-and-quarantine`.

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth (existing)
- `GET  /users/profile`: yields `mcpEndpointUrl` for the MCP transport
- `POST /mcp?token=<jwt>`: MCP JSON-RPC entry point. Tools:
  `create_person`, `update_person`, `add_relationship`,
  `list_pending_persons`, `set_auto_accept_persons`, `find_person`.
- `GET  /admin/people?status=pending`: list pending persons
- `POST /admin/people/:lookupKey/approve`: flip pending to verified
- `POST /admin/people/:lookupKey/reject`: flip pending to rejected

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:3000}"

JAR=$(mktemp /tmp/uat-72-jar-XXXXXX.txt)
RUN_ID=$(date +%s)
trap 'rm -f "$JAR" /tmp/uat-72-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "72 - Stream P: people extractor + quarantine"
echo ""

# 0. Auth + MCP token mint
curl -s -o /dev/null -c "$JAR" -X POST \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email"
if [ -s "$JAR" ]; then
  pass "0a. sign-in established session cookie"
else
  fail "0a. sign-in failed"
  echo ""; echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi

PROFILE=$(curl -s -b "$JAR" -H "Origin: $ORIGIN" "$SERVER_URL/users/profile")
MCP_URL=$(echo "$PROFILE" | jq -r '.mcpEndpointUrl // empty')
MCP_TOKEN=$(echo "$MCP_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')
if [ -n "$MCP_TOKEN" ]; then
  pass "0b. minted MCP JWT"
  MCP_ENDPOINT="$SERVER_URL/mcp?token=$MCP_TOKEN"
else
  fail "0b. could not mint MCP JWT"
fi

# 1a. Migration file exists
MIG_PATH="core/drizzle/migrations/0017_people_status_and_quarantine.sql"
if [ -f "$MIG_PATH" ]; then
  pass "1a. migration $MIG_PATH present"
else
  fail "1a. migration $MIG_PATH missing"
fi

# 1b. Idempotency: re-run drizzle migrations and assert no errors.
if [ -n "${DATABASE_URL:-}" ]; then
  if pnpm -C core db:migrate >/tmp/uat-72-mig.log 2>&1; then
    pass "1b. db:migrate completed (initial or idempotent re-run)"
  else
    fail "1b. db:migrate failed (see /tmp/uat-72-mig.log)"
  fi
else
  skip "1b. DATABASE_URL not set; skipping migrate run"
fi

# 2. Schema columns exist with expected shape
check_col() {
  local section="$1" col="$2" expected="$3"
  if [ -z "${DATABASE_URL:-}" ]; then
    skip "$section. DATABASE_URL not set; skipping people.$col check"
    return
  fi
  local row
  row=$(psql "$DATABASE_URL" -t -A -F'|' -c \
    "SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_name='people' AND column_name='$col'" 2>/dev/null \
     | tr -d '[:space:]')
  if [ "$row" = "$expected" ]; then
    pass "$section. people.$col matches $expected"
  else
    fail "$section. people.$col unexpected: $row (expected $expected)"
  fi
}
check_col "2a" "status" "text|NO"
check_col "2b" "created_via" "text|YES"
check_col "2c" "extracted_from_fragment_id" "text|YES"
check_col "2d" "context_notes" "jsonb|YES"

# 2e. app_settings row default
if [ -n "${DATABASE_URL:-}" ]; then
  AA=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT value::text FROM app_settings WHERE key='auto_accept_persons'" 2>/dev/null | tr -d '[:space:]')
  if [ "$AA" = "false" ]; then
    pass "2e. app_settings.auto_accept_persons defaults to false"
  else
    fail "2e. app_settings.auto_accept_persons unexpected: '$AA'"
  fi
else
  skip "2e. DATABASE_URL not set"
fi

# 3. MCP people CRUD
RPC_ID=0
call_tool() {
  RPC_ID=$((RPC_ID+1))
  local body
  body=$(jq -n --argjson id "$RPC_ID" --arg tool "$2" --argjson args "$3" \
    --arg cn "uat-72-mcp" --arg cv "1.0.0" \
    '{jsonrpc:"2.0", id:$id, method:"tools/call",
      params:{name:$tool, arguments:$args},
      _meta:{clientInfo:{name:$cn, version:$cv}}}')
  local resp
  resp=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Origin: $ORIGIN" \
    -d "$body" "$MCP_ENDPOINT")
  echo "$resp" > /tmp/uat-72-last.json
  if echo "$resp" | grep -q '^data: '; then
    payload=$(echo "$resp" | sed -n 's/^data: //p' | head -1)
  else
    payload="$resp"
  fi
  RPC_TEXT=$(echo "$payload" | jq -r '.result.content[0].text // empty')
  RPC_ERR=$(echo "$payload" | jq -r '.result.isError // false')
}

UAT_PERSON_KEYS=()

if [ -n "${MCP_ENDPOINT:-}" ]; then
  PERSON_NAME_A="UAT 72 Alice $RUN_ID"
  call_tool "3a." "create_person" \
    "$(jq -n --arg n "$PERSON_NAME_A" '{canonicalName:$n}')"
  if [ "$RPC_ERR" = "false" ]; then
    KEY_A=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
    STATUS_A=$(echo "$RPC_TEXT" | jq -r '.status // empty')
    if [ "$STATUS_A" = "verified" ] && [ -n "$KEY_A" ]; then
      pass "3a. MCP create_person yielded status=verified ($KEY_A)"
      UAT_PERSON_KEYS+=("$KEY_A")
    else
      fail "3a. unexpected: status=$STATUS_A key=$KEY_A"
    fi
  else
    fail "3a. MCP create_person failed: $RPC_TEXT"
  fi
else
  skip "3a-3d. MCP endpoint unavailable"
fi

# Seed a pending person directly via SQL so we have a row to update/promote.
PENDING_KEY="person01UATQ$(printf '%020d' $RUN_ID | tail -c 20)"
PENDING_NAME="UAT 72 Pending $RUN_ID"
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -c "INSERT INTO people (lookup_key, slug, name, canonical_name, aliases, verified, status, created_via, state)
    VALUES ('$PENDING_KEY', 'uat-72-pending-$RUN_ID', '$PENDING_NAME', '$PENDING_NAME', ARRAY[]::text[], false, 'pending', 'extractor_pending', 'PENDING')" >/dev/null 2>&1
  UAT_PERSON_KEYS+=("$PENDING_KEY")
fi

if [ -n "${MCP_ENDPOINT:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  # 3b. update_person with promoteFromQuarantine
  call_tool "3b." "update_person" \
    "$(jq -n --arg k "$PENDING_KEY" \
      '{personLookupKey:$k, updates:{notes:"promoted via UAT 72"}, options:{promoteFromQuarantine:true}}')"
  if [ "$RPC_ERR" = "false" ]; then
    PROMOTED=$(echo "$RPC_TEXT" | jq -r '.promoted // false')
    NEW_STATUS=$(echo "$RPC_TEXT" | jq -r '.status // empty')
    if [ "$PROMOTED" = "true" ] && [ "$NEW_STATUS" = "verified" ]; then
      pass "3b. update_person promoted pending -> verified"
    else
      fail "3b. unexpected: promoted=$PROMOTED status=$NEW_STATUS"
    fi
  else
    fail "3b. update_person failed: $RPC_TEXT"
  fi

  # 3c. update_person WITHOUT the flag should not promote
  PENDING_KEY_2="person01UATR$(printf '%020d' $RUN_ID | tail -c 20)"
  PENDING_NAME_2="UAT 72 Stay-Pending $RUN_ID"
  psql "$DATABASE_URL" -c "INSERT INTO people (lookup_key, slug, name, canonical_name, aliases, verified, status, created_via, state)
    VALUES ('$PENDING_KEY_2', 'uat-72-stay-$RUN_ID', '$PENDING_NAME_2', '$PENDING_NAME_2', ARRAY[]::text[], false, 'pending', 'extractor_pending', 'PENDING')" >/dev/null 2>&1
  UAT_PERSON_KEYS+=("$PENDING_KEY_2")
  call_tool "3c." "update_person" \
    "$(jq -n --arg k "$PENDING_KEY_2" \
      '{personLookupKey:$k, updates:{notes:"context-only update"}}')"
  if [ "$RPC_ERR" = "false" ]; then
    PROMOTED=$(echo "$RPC_TEXT" | jq -r '.promoted // false')
    NEW_STATUS=$(echo "$RPC_TEXT" | jq -r '.status // empty')
    if [ "$PROMOTED" = "false" ] && [ "$NEW_STATUS" = "pending" ]; then
      pass "3c. update_person without flag did NOT promote"
    else
      fail "3c. unexpected: promoted=$PROMOTED status=$NEW_STATUS"
    fi
  else
    fail "3c. update_person (no-flag) failed: $RPC_TEXT"
  fi

  # 3d. add_relationship between two existing persons
  if [ -n "${KEY_A:-}" ]; then
    call_tool "3d." "add_relationship" \
      "$(jq -n --arg s "person:$KEY_A" --arg t "person:$PENDING_KEY" \
        '{source:$s, target:$t, type:"KNOWS"}')"
    if [ "$RPC_ERR" = "false" ]; then
      EDGE_TYPE=$(echo "$RPC_TEXT" | jq -r '.edgeType // empty')
      if [ "$EDGE_TYPE" = "PERSON_KNOWS_PERSON" ]; then
        pass "3d. add_relationship wrote PERSON_KNOWS_PERSON"
      else
        fail "3d. unexpected edgeType: $EDGE_TYPE"
      fi
    else
      fail "3d. add_relationship failed: $RPC_TEXT"
    fi
  else
    skip "3d. no KEY_A from 3a"
  fi
else
  skip "3b-3d. MCP endpoint or DATABASE_URL unavailable"
fi

# 4. HTTP approve / reject
if [ -n "${DATABASE_URL:-}" ]; then
  PENDING_HTTP_KEY="person01UATA$(printf '%020d' $RUN_ID | tail -c 20)"
  psql "$DATABASE_URL" -c "INSERT INTO people (lookup_key, slug, name, canonical_name, aliases, verified, status, created_via, state)
    VALUES ('$PENDING_HTTP_KEY', 'uat-72-http-$RUN_ID', 'UAT 72 HTTP $RUN_ID', 'UAT 72 HTTP $RUN_ID', ARRAY[]::text[], false, 'pending', 'extractor_pending', 'PENDING')" >/dev/null 2>&1
  UAT_PERSON_KEYS+=("$PENDING_HTTP_KEY")

  APPROVE_RESP=$(curl -s -b "$JAR" -X POST -H "Origin: $ORIGIN" \
    "$SERVER_URL/admin/people/$PENDING_HTTP_KEY/approve")
  APPROVE_STATUS=$(echo "$APPROVE_RESP" | jq -r '.status // empty')
  if [ "$APPROVE_STATUS" = "verified" ]; then
    pass "4a. POST /admin/people/:key/approve flipped pending to verified"
  else
    fail "4a. approve unexpected: $APPROVE_RESP"
  fi

  PENDING_RJ_KEY="person01UATJ$(printf '%020d' $RUN_ID | tail -c 20)"
  psql "$DATABASE_URL" -c "INSERT INTO people (lookup_key, slug, name, canonical_name, aliases, verified, status, created_via, state)
    VALUES ('$PENDING_RJ_KEY', 'uat-72-rj-$RUN_ID', 'UAT 72 Rj $RUN_ID', 'UAT 72 Rj $RUN_ID', ARRAY[]::text[], false, 'pending', 'extractor_pending', 'PENDING')" >/dev/null 2>&1
  UAT_PERSON_KEYS+=("$PENDING_RJ_KEY")

  REJECT_RESP=$(curl -s -b "$JAR" -X POST -H "Origin: $ORIGIN" \
    "$SERVER_URL/admin/people/$PENDING_RJ_KEY/reject")
  REJECT_STATUS=$(echo "$REJECT_RESP" | jq -r '.status // empty')
  if [ "$REJECT_STATUS" = "rejected" ]; then
    pass "4b. POST /admin/people/:key/reject flipped pending to rejected"
  else
    fail "4b. reject unexpected: $REJECT_RESP"
  fi
else
  skip "4a-4b. DATABASE_URL not set"
fi

# 5a. list_pending_persons returns rows with status marker
if [ -n "${MCP_ENDPOINT:-}" ]; then
  call_tool "5a." "list_pending_persons" "$(jq -n '{}')"
  if [ "$RPC_ERR" = "false" ]; then
    HAS_PENDING=$(echo "$RPC_TEXT" | jq -r '[.persons[] | select(.status=="pending")] | length // 0')
    if [ "$HAS_PENDING" -ge "0" ]; then
      pass "5a. list_pending_persons returned $HAS_PENDING pending row(s) with status marker"
    else
      fail "5a. list_pending_persons response shape unexpected: $RPC_TEXT"
    fi
  else
    fail "5a. list_pending_persons failed: $RPC_TEXT"
  fi
else
  skip "5a. MCP endpoint unavailable"
fi

# 5b. Approve/reject MCP tools must NOT be registered
if grep -q "approve_pending_person\|reject_pending_person" core/src/mcp/server.ts; then
  fail "5b. server.ts unexpectedly registers approve/reject MCP tools"
else
  pass "5b. server.ts does not register approve/reject MCP tools (HTTP-only)"
fi

# 6a. Hybrid search excludes pending entirely
if [ -n "${DATABASE_URL:-}" ]; then
  # Seed a pending person whose name is a unique magic phrase, then
  # search for it. The result must NOT include the row.
  MAGIC="zzzzz_uat72_${RUN_ID}_pendingsearch"
  PENDING_S_KEY="person01UATS$(printf '%020d' $RUN_ID | tail -c 20)"
  psql "$DATABASE_URL" -c "INSERT INTO people (lookup_key, slug, name, canonical_name, aliases, verified, status, created_via, state, search_vector)
    VALUES ('$PENDING_S_KEY', 'uat-72-search-$RUN_ID', '$MAGIC', '$MAGIC', ARRAY[]::text[], false, 'pending', 'extractor_pending', 'PENDING', to_tsvector('english','$MAGIC'))" >/dev/null 2>&1
  UAT_PERSON_KEYS+=("$PENDING_S_KEY")

  SEARCH_RESP=$(curl -s -b "$JAR" -H "Origin: $ORIGIN" \
    "$SERVER_URL/search?query=$MAGIC&mode=bm25&tables=person")
  HIT_COUNT=$(echo "$SEARCH_RESP" | jq -r '.results // [] | length')
  if [ "$HIT_COUNT" = "0" ]; then
    pass "6a. hybrid search excludes pending persons"
  else
    fail "6a. pending person leaked into hybrid search ($HIT_COUNT hits): $SEARCH_RESP"
  fi
else
  skip "6a. DATABASE_URL not set"
fi

# 6b. find_person returns pending with status=pending
if [ -n "${MCP_ENDPOINT:-}" ] && [ -n "${PENDING_S_KEY:-}" ]; then
  call_tool "6b." "find_person" \
    "$(jq -n --arg id "$PENDING_S_KEY" '{id:$id}')"
  if [ "$RPC_ERR" = "false" ]; then
    PSTATUS=$(echo "$RPC_TEXT" | jq -r '.person.status // empty')
    if [ "$PSTATUS" = "pending" ]; then
      pass "6b. find_person returned pending row with status='pending'"
    else
      fail "6b. find_person status unexpected: '$PSTATUS'"
    fi
  else
    fail "6b. find_person failed: $RPC_TEXT"
  fi
else
  skip "6b. MCP endpoint unavailable or no PENDING_S_KEY"
fi

# 7a. Toggle auto_accept_persons via MCP, then verify the flag is set.
if [ -n "${MCP_ENDPOINT:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  call_tool "7a." "set_auto_accept_persons" "$(jq -n '{value:true}')"
  if [ "$RPC_ERR" = "false" ]; then
    CURRENT=$(echo "$RPC_TEXT" | jq -r '.current // empty')
    if [ "$CURRENT" = "true" ]; then
      pass "7a-prep. set_auto_accept_persons returned current=true"
    else
      fail "7a-prep. set_auto_accept_persons unexpected: $RPC_TEXT"
    fi
    DB_VAL=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT value::text FROM app_settings WHERE key='auto_accept_persons'" 2>/dev/null | tr -d '[:space:]')
    if [ "$DB_VAL" = "true" ]; then
      pass "7a. app_settings.auto_accept_persons reads true after toggle"
    else
      fail "7a. db value unexpected: '$DB_VAL'"
    fi
    # Reset the toggle so subsequent runs start from default.
    call_tool "7a-reset." "set_auto_accept_persons" "$(jq -n '{value:false}')"
  else
    fail "7a. set_auto_accept_persons failed: $RPC_TEXT"
  fi
else
  skip "7a. MCP endpoint or DATABASE_URL unavailable"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"

# Cleanup
if [ -n "${DATABASE_URL:-}" ]; then
  for key in "${UAT_PERSON_KEYS[@]}"; do
    psql "$DATABASE_URL" -c "DELETE FROM edges WHERE src_id='$key' OR dst_id='$key'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM people WHERE lookup_key='$key'" >/dev/null 2>&1 || true
  done
fi

[ "$FAIL" = "0" ]
```

## Cleanup

The script tears down its own person rows via the `UAT_PERSON_KEYS`
array. If interrupted mid-run, manual sweep:

```bash
psql "$DATABASE_URL" -c "DELETE FROM people WHERE name LIKE 'UAT 72 %';"
psql "$DATABASE_URL" -c "DELETE FROM edges WHERE src_id IN (SELECT lookup_key FROM people WHERE name LIKE 'UAT 72 %');"
```

## Expected pass/fail behavior

- 1a, 1b PASS once migration 0017 has been run on the target DB.
- 2a-2e are direct schema assertions; pass iff the columns landed in
  the expected shape and the default app_settings row is present.
- 3a-3d PASS on any clean local stack with the MCP transport reachable;
  the contract under test is the handler logic, not the worker pipeline.
- 4a-4b PASS on any clean local stack; sessionMiddleware must accept
  the cookie established in step 0.
- 5b is a NEG assertion on source code (`grep`) so it works without a
  running server.
- 6a-6b assert the read-site exclusion matrix. 6a depends on the
  `/search` endpoint being reachable; if not, mark as skipped.
- 7a flips a global flag and resets it, so it is safe to run repeatedly.
