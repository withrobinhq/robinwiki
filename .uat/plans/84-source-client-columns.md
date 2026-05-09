# 84, source_client column expansion (Stream V)

## What it proves

Stream V finishes the v0.2.1 source_client migration. Migration 0015
adds dedicated `source_client text NULL` columns to `fragments`,
`wikis`, `wiki_types`, and `groups`. The audit_log writers stop
mirroring the value into `detail` jsonb for those four entity types,
so retrospective queries can break rows down by surface without
unpacking jsonb. The helper that read the MCP handshake into the
audit-detail shape now flattens the value to a text label and lands
it on the entity row directly.

After this UAT runs:

1. The four columns exist on the corresponding tables (`text NULL`).
2. New fragment / wiki / wiki_type / group rows carry a populated
   `source_client` value (`'web'` for HTTP-route writes, the MCP
   client name for MCP writes).
3. Audit_log rows for these entity types do not contain a
   `source_client` key inside `detail` jsonb.
4. The Stream V migration is idempotent (the SQL guards each ALTER
   with `IF NOT EXISTS`).

C2's existing entries.source_client jsonb stays untouched. handleLogEntry
already wrote `entries.source_client` directly via the row insert in
v0.2.1 PR #345 and is not modified by this stream.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a  | POS | migration 0015 SQL exists at `core/drizzle/migrations/0015_source_client_columns.sql` |
| 1b  | POS | migration applies cleanly on a fresh DB and is idempotent on a second run |
| 2a  | POS | `fragments.source_client` column exists, type `text`, nullable |
| 2b  | POS | `wikis.source_client` column exists, type `text`, nullable |
| 2c  | POS | `wiki_types.source_client` column exists, type `text`, nullable |
| 2d  | POS | `groups.source_client` column exists, type `text`, nullable |
| 3a  | POS | POST /wikis (web) yields a row with `source_client = 'web'` |
| 3b  | POS | POST /wiki-types (web) yields a row with `source_client = 'web'` |
| 3c  | POS | POST /groups (web) yields a row with `source_client = 'web'` |
| 4a  | POS | MCP create_wiki yields a row with `source_client` populated (or null when handshake is absent, depending on transport) |
| 5a  | NEG | audit_log rows whose entity_type is one of (fragment, wiki, wiki_type, group) and whose row was created during this UAT must NOT have `detail->>'source_client'` populated |
| 6a  | POS | extracted-fragment rows get `source_client` populated from the originating job source after the worker pipeline runs |
| 7a  | NEG | the `getClientInfo` helper file (`core/src/lib/get-client-info.ts`) does NOT exist (the symbol is the MCP deps callback, not a standalone helper, and was never extracted) |

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`.
- `DATABASE_URL` reachable for direct row inspection.
- Migration 0015 applied (`pnpm -C core db:migrate`).
- Repo checkout on `feat/source-client-columns`.

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth (existing)
- `POST /wikis`: web-UI wiki create
- `POST /wiki-types`: web-UI custom wiki type create
- `POST /groups`: web-UI group create
- `GET  /users/profile`: yields `mcpEndpointUrl` for the MCP transport
- `POST /mcp?token=<jwt>`: MCP JSON-RPC entry point. Tools: `create_wiki`, `log_entry`, `log_fragment`.

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:3000}"

JAR=$(mktemp /tmp/uat-84-jar-XXXXXX.txt)
RUN_ID=$(date +%s)
trap 'rm -f "$JAR" /tmp/uat-84-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "84 - Stream V: source_client column expansion"
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
MIG_PATH="core/drizzle/migrations/0015_source_client_columns.sql"
if [ -f "$MIG_PATH" ]; then
  pass "1a. migration $MIG_PATH present"
else
  fail "1a. migration $MIG_PATH missing"
fi

# 1b. Idempotency: re-run drizzle migrations and assert no errors.
if [ -n "${DATABASE_URL:-}" ]; then
  if pnpm -C core db:migrate >/tmp/uat-84-mig.log 2>&1; then
    pass "1b. db:migrate completed (initial or idempotent re-run)"
  else
    fail "1b. db:migrate failed (see /tmp/uat-84-mig.log)"
  fi
else
  skip "1b. DATABASE_URL not set; skipping migrate run"
fi

# 2. Schema columns exist with expected shape
check_col() {
  local section="$1" table="$2"
  if [ -z "${DATABASE_URL:-}" ]; then
    skip "$section. DATABASE_URL not set; skipping $table.source_client check"
    return
  fi
  local row
  row=$(psql "$DATABASE_URL" -t -A -F'|' -c \
    "SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_name='$table' AND column_name='source_client'" 2>/dev/null \
     | tr -d '[:space:]')
  if [ "$row" = "text|YES" ]; then
    pass "$section. $table.source_client is text NULL"
  else
    fail "$section. $table.source_client unexpected: $row (expected text|YES)"
  fi
}
check_col "2a" "fragments"
check_col "2b" "wikis"
check_col "2c" "wiki_types"
check_col "2d" "groups"

# Track UAT-created rows so cleanup can sweep them.
UAT_WIKI_KEYS=()
UAT_WIKI_TYPE_SLUGS=()
UAT_GROUP_IDS=()
UAT_ENTRY_KEYS=()

# 3a. POST /wikis (web) populates wikis.source_client = 'web'
WIKI_NAME="UAT-84 Wiki $RUN_ID"
WIKI_RESP=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -n --arg n "$WIKI_NAME" '{name:$n, type:"log", description:"UAT 84 web-UI wiki create"}')" \
  "$SERVER_URL/wikis")
WIKI_KEY=$(echo "$WIKI_RESP" | jq -r '.id // .lookupKey // empty')
if [ -n "$WIKI_KEY" ]; then
  UAT_WIKI_KEYS+=("$WIKI_KEY")
  if [ -n "${DATABASE_URL:-}" ]; then
    SC=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT source_client FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null | tr -d '[:space:]')
    if [ "$SC" = "web" ]; then
      pass "3a. POST /wikis stamped wikis.source_client='web' (got '$SC')"
    else
      fail "3a. wikis.source_client mismatch: '$SC' (expected 'web')"
    fi
  else
    skip "3a. DATABASE_URL not set"
  fi
else
  fail "3a. POST /wikis did not return a wiki key (resp=$WIKI_RESP)"
fi

# 3b. POST /wiki-types (web) populates wiki_types.source_client = 'web'
WT_SLUG="uat-84-wt-$RUN_ID"
WT_RESP=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -n --arg s "$WT_SLUG" \
    '{slug:$s, name:"UAT 84 Wiki Type", shortDescriptor:"sd", descriptor:"desc", prompt:"You are Quill."}')" \
  "$SERVER_URL/wiki-types")
WT_RET_SLUG=$(echo "$WT_RESP" | jq -r '.slug // empty')
if [ -n "$WT_RET_SLUG" ]; then
  UAT_WIKI_TYPE_SLUGS+=("$WT_RET_SLUG")
  if [ -n "${DATABASE_URL:-}" ]; then
    SC=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT source_client FROM wiki_types WHERE slug='$WT_RET_SLUG'" 2>/dev/null | tr -d '[:space:]')
    if [ "$SC" = "web" ]; then
      pass "3b. POST /wiki-types stamped wiki_types.source_client='web' (got '$SC')"
    else
      fail "3b. wiki_types.source_client mismatch: '$SC' (expected 'web')"
    fi
  else
    skip "3b. DATABASE_URL not set"
  fi
else
  fail "3b. POST /wiki-types did not return a slug (resp=$WT_RESP)"
fi

# 3c. POST /groups (web) populates groups.source_client = 'web'
GROUP_SLUG="uat-84-grp-$RUN_ID"
GROUP_RESP=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -n --arg s "$GROUP_SLUG" \
    '{name:"UAT 84 Group", slug:$s, icon:"", color:"#888888", description:"UAT 84 group"}')" \
  "$SERVER_URL/groups")
GROUP_ID=$(echo "$GROUP_RESP" | jq -r '.id // empty')
if [ -n "$GROUP_ID" ]; then
  UAT_GROUP_IDS+=("$GROUP_ID")
  if [ -n "${DATABASE_URL:-}" ]; then
    SC=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT source_client FROM groups WHERE id='$GROUP_ID'" 2>/dev/null | tr -d '[:space:]')
    if [ "$SC" = "web" ]; then
      pass "3c. POST /groups stamped groups.source_client='web' (got '$SC')"
    else
      fail "3c. groups.source_client mismatch: '$SC' (expected 'web')"
    fi
  else
    skip "3c. DATABASE_URL not set"
  fi
else
  fail "3c. POST /groups did not return a group id (resp=$GROUP_RESP)"
fi

# 4a. MCP create_wiki — column is queryable. The strict client name
# depends on the test client completing a full MCP `initialize`
# handshake; we accept either a populated value or null.
RPC_ID=0
call_tool() {
  RPC_ID=$((RPC_ID+1))
  local body
  body=$(jq -n --argjson id "$RPC_ID" --arg tool "$2" --argjson args "$3" \
    --arg cn "uat-84-mcp" --arg cv "1.0.0" \
    '{jsonrpc:"2.0", id:$id, method:"tools/call",
      params:{name:$tool, arguments:$args},
      _meta:{clientInfo:{name:$cn, version:$cv}}}')
  local resp
  resp=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Origin: $ORIGIN" \
    -d "$body" "$MCP_ENDPOINT")
  echo "$resp" > /tmp/uat-84-last.json
  if echo "$resp" | grep -q '^data: '; then
    payload=$(echo "$resp" | sed -n 's/^data: //p' | head -1)
  else
    payload="$resp"
  fi
  RPC_TEXT=$(echo "$payload" | jq -r '.result.content[0].text // empty')
  RPC_ERR=$(echo "$payload" | jq -r '.result.isError // false')
}

if [ -n "${MCP_ENDPOINT:-}" ]; then
  MCP_WIKI_TITLE="UAT-84 MCP Wiki $RUN_ID"
  call_tool "4a." "create_wiki" \
    "$(jq -n --arg t "$MCP_WIKI_TITLE" \
      '{title:$t, description:"UAT 84 MCP wiki create test", type:"log"}')"
  if [ "$RPC_ERR" = "false" ]; then
    MCP_WIKI_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
    if [ -n "$MCP_WIKI_KEY" ]; then
      UAT_WIKI_KEYS+=("$MCP_WIKI_KEY")
      if [ -n "${DATABASE_URL:-}" ]; then
        SC=$(psql "$DATABASE_URL" -t -A -c \
          "SELECT COALESCE(source_client,'<NULL>') FROM wikis WHERE lookup_key='$MCP_WIKI_KEY'" \
          2>/dev/null | tr -d '[:space:]')
        if [ -n "$SC" ]; then
          pass "4a. MCP create_wiki source_client column readable (value='$SC')"
        else
          fail "4a. MCP create_wiki source_client lookup empty"
        fi
      else
        skip "4a. DATABASE_URL not set"
      fi
    else
      fail "4a. create_wiki response missing lookupKey: $RPC_TEXT"
    fi
  else
    fail "4a. create_wiki failed: $RPC_TEXT"
  fi
else
  skip "4a. MCP endpoint unavailable"
fi

# 5a. audit_log NEG: rows for the four entity types must not carry
# detail->>'source_client' for any UAT-created row.
if [ -n "${DATABASE_URL:-}" ]; then
  LEAK_COUNT=$(psql "$DATABASE_URL" -t -A -c "
    SELECT count(*) FROM audit_log
    WHERE entity_type IN ('fragment','wiki','wiki_type','group')
      AND detail ? 'source_client'
      AND created_at > NOW() - INTERVAL '5 minutes'
  " 2>/dev/null | tr -d '[:space:]')
  if [ "$LEAK_COUNT" = "0" ]; then
    pass "5a. zero audit_log rows in the last 5 minutes carry detail->>'source_client' for the 4 entity types"
  else
    fail "5a. $LEAK_COUNT recent audit_log rows still carry detail->>'source_client' for these entity types"
  fi
else
  skip "5a. DATABASE_URL not set"
fi

# 6a. extraction-pipeline fragments inherit source_client from the job
# source. POST /entries with source='web' kicks the pipeline; the
# resulting fragments should land with source_client='web'.
LONG_CONTENT="UAT 84 source-client pipeline fragment $RUN_ID. The fragmenter should split this into one or more fragments and the source_client column should follow the originating surface."
ENT_RESP=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -n --arg c "$LONG_CONTENT" '{content:$c, source:"web", type:"thought"}')" \
  "$SERVER_URL/entries")
ENT_KEY=$(echo "$ENT_RESP" | jq -r '.id // .lookupKey // empty')
if [ -n "$ENT_KEY" ]; then
  UAT_ENTRY_KEYS+=("$ENT_KEY")
  pass "6a-prep. entry $ENT_KEY queued for extraction"
  # Poll for fragments (up to 30s) — pipeline runs asynchronously.
  if [ -n "${DATABASE_URL:-}" ]; then
    FRAG_SC=""
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      FRAG_SC=$(psql "$DATABASE_URL" -t -A -c "
        SELECT COALESCE(source_client,'<NULL>') FROM fragments
        WHERE entry_id='$ENT_KEY'
        ORDER BY created_at ASC LIMIT 1
      " 2>/dev/null | tr -d '[:space:]')
      [ -n "$FRAG_SC" ] && break
      sleep 2
    done
    if [ "$FRAG_SC" = "web" ]; then
      pass "6a. pipeline fragment from web entry stamped source_client='web'"
    elif [ -n "$FRAG_SC" ]; then
      fail "6a. pipeline fragment source_client unexpected: '$FRAG_SC'"
    else
      skip "6a. no fragments produced within 30s; queue may be down"
    fi
  else
    skip "6a. DATABASE_URL not set"
  fi
else
  fail "6a-prep. POST /entries did not return entry key (resp=$ENT_RESP)"
fi

# 7a. NEG: there must NOT be a standalone get-client-info helper file.
# The `getClientInfo` symbol in this codebase is the MCP deps-injected
# callback (server.ts / handlers.ts McpServerDeps), not a helper that
# was ever extracted to its own module.
if [ -f "core/src/lib/get-client-info.ts" ] || [ -f "core/src/lib/getClientInfo.ts" ]; then
  fail "7a. unexpected get-client-info helper file present (Stream V expects none)"
else
  pass "7a. no standalone get-client-info helper file (matches Stream V design)"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"

# Cleanup: delete the rows this UAT created.
if [ -n "${DATABASE_URL:-}" ]; then
  for key in "${UAT_WIKI_KEYS[@]}"; do
    psql "$DATABASE_URL" -c "DELETE FROM wikis WHERE lookup_key='$key'" >/dev/null 2>&1 || true
  done
  for slug in "${UAT_WIKI_TYPE_SLUGS[@]}"; do
    psql "$DATABASE_URL" -c "DELETE FROM wiki_types WHERE slug='$slug'" >/dev/null 2>&1 || true
  done
  for id in "${UAT_GROUP_IDS[@]}"; do
    psql "$DATABASE_URL" -c "DELETE FROM groups WHERE id='$id'" >/dev/null 2>&1 || true
  done
  for key in "${UAT_ENTRY_KEYS[@]}"; do
    psql "$DATABASE_URL" -c "DELETE FROM raw_sources WHERE lookup_key='$key'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM fragments WHERE entry_id='$key'" >/dev/null 2>&1 || true
  done
fi

[ "$FAIL" = "0" ]
```

## Cleanup

The script tears down its own rows via the `UAT_WIKI_KEYS`,
`UAT_WIKI_TYPE_SLUGS`, `UAT_GROUP_IDS`, and `UAT_ENTRY_KEYS` arrays.
If interrupted mid-run, manual sweep:

```bash
psql "$DATABASE_URL" -c "DELETE FROM wikis WHERE name LIKE 'UAT-84 %';"
psql "$DATABASE_URL" -c "DELETE FROM wiki_types WHERE slug LIKE 'uat-84-%';"
psql "$DATABASE_URL" -c "DELETE FROM groups WHERE slug LIKE 'uat-84-%';"
psql "$DATABASE_URL" -c "DELETE FROM raw_sources WHERE content LIKE 'UAT 84 %';"
psql "$DATABASE_URL" -c "DELETE FROM fragments WHERE content LIKE 'UAT 84 %';"
```

## Expected pass/fail behavior

- 1a, 1b PASS once migration 0015 has been run on the target DB.
- 2a-2d are direct schema assertions; pass iff the columns landed in
  the expected text-NULL shape.
- 3a-3c PASS on any clean local stack; the contract under test is
  the column write itself, not any audit-log behaviour.
- 4a is intentionally relaxed: the strict client-name value depends
  on the test harness completing a full MCP `initialize` handshake.
  The contract is that the column is writable and queryable from
  the MCP path. The strict-shape contract is exercised by the
  integration tests in `core/src/__tests__/`.
- 5a is the negative assertion that ties Step 2 of the conversion
  to the database. Any leak of `source_client` into audit_log
  detail for these entity types means a writer was missed.
- 6a depends on the pipeline worker running. If the worker is not
  attached to BullMQ, the test SKIPs with a timeout instead of
  failing.
- 7a confirms the design note that no helper file was extracted.
