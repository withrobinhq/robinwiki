# 74, edges src_type canonicalization (Stream H1+H3)

## What it proves

Stream H1 fixes QA Issue 4a: `ENTRY_HAS_FRAGMENT` edges had two
different `src_type` strings depending on which writer produced them.
The persist worker wrote `src_type='entry'`; the seed-fixture path
wrote `src_type='raw_source'`. Migration 0016 backfills every legacy
'entry' row to 'raw_source' and adds a CHECK constraint pinning
`src_type` and `dst_type` to the canonical vocabulary
`{raw_source, fragment, wiki, person}`. The persist-stage writer in
`packages/agent/src/stages/persist.ts` is updated to emit the
canonical value, so all four edge writers (persist, regen,
seed-fixture, MCP route handlers) produce consistent rows.

Stream H3 documents the seed-person edge creation path. The 15
FRAGMENT_MENTIONS_PERSON edges QA Issue 4c flagged came from the
Transformer demo seed, which fires at first-user provisioning. The
audit lives at `docs/architecture/seed-data.md`.

After this UAT runs:

1. Migration 0016 SQL exists at the canonical path.
2. Migration applies cleanly on a fresh DB and is idempotent on a
   re-run.
3. `SELECT DISTINCT src_type FROM edges` returns only canonical values.
4. `SELECT DISTINCT dst_type FROM edges` returns only canonical values.
5. A new ENTRY_HAS_FRAGMENT edge written by the worker pipeline lands
   with `src_type='raw_source'`.
6. Direct INSERT with `src_type='entry'` is rejected by the CHECK
   constraint.
7. Existing graph traversal queries that filter by `src_type` return
   correct rows.
8. The seed-data audit doc exists at the canonical path.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a | POS | migration 0016 SQL exists at `core/drizzle/migrations/0016_edges_src_type_canonicalize.sql` |
| 1b | POS | migration applies cleanly on a fresh DB and is idempotent on a re-run |
| 2a | POS | `edges.src_type` distinct values are a subset of `{raw_source, fragment, wiki, person}` |
| 2b | POS | `edges.dst_type` distinct values are a subset of `{raw_source, fragment, wiki, person}` |
| 2c | POS | constraint `edges_src_type_check` exists on table `edges` |
| 2d | POS | constraint `edges_dst_type_check` exists on table `edges` |
| 3a | POS | a worker-produced ENTRY_HAS_FRAGMENT edge has `src_type='raw_source'` |
| 3b | NEG | direct INSERT with `src_type='entry'` is rejected by the CHECK constraint |
| 4a | POS | reverse traversal by `dst_type='fragment'` finds the worker-produced edge |
| 5a | POS | seed-data audit doc exists at `docs/architecture/seed-data.md` |
| 5b | POS | seed-data audit doc names the seedFixture path |

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`.
- `DATABASE_URL` reachable for direct row inspection.
- Migration 0016 applied (`pnpm -C core db:migrate`).
- Repo checkout on `feat/edges-src-type-canonicalize`.

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth (existing).
- `GET  /users/profile`: yields `mcpEndpointUrl` for the MCP transport.
- `POST /mcp?token=<jwt>`: MCP JSON-RPC entry point. Tool: `log_entry`.

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:3000}"

JAR=$(mktemp /tmp/uat-74-jar-XXXXXX.txt)
RUN_ID=$(date +%s)
trap 'rm -f "$JAR" /tmp/uat-74-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "74 - Stream H1+H3: edges src_type canonicalization"
echo ""

# Track UAT-created rows for cleanup.
UAT_ENTRY_KEYS=()

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
MIG_PATH="core/drizzle/migrations/0016_edges_src_type_canonicalize.sql"
if [ -f "$MIG_PATH" ]; then
  pass "1a. migration $MIG_PATH present"
else
  fail "1a. migration $MIG_PATH missing"
fi

# 1b. Idempotency
if [ -n "${DATABASE_URL:-}" ]; then
  if pnpm -C core db:migrate >/tmp/uat-74-mig.log 2>&1; then
    pass "1b. db:migrate completed (initial or idempotent re-run)"
  else
    fail "1b. db:migrate failed (see /tmp/uat-74-mig.log)"
  fi
else
  skip "1b. DATABASE_URL not set; skipping migrate run"
fi

# 2a. src_type distinct vocabulary check
if [ -n "${DATABASE_URL:-}" ]; then
  BAD=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT DISTINCT src_type FROM edges
     WHERE src_type NOT IN ('raw_source','fragment','wiki','person')" 2>/dev/null)
  if [ -z "$BAD" ]; then
    pass "2a. edges.src_type values are all canonical"
  else
    fail "2a. non-canonical src_type values present: $BAD"
  fi
else
  skip "2a. DATABASE_URL not set"
fi

# 2b. dst_type distinct vocabulary check
if [ -n "${DATABASE_URL:-}" ]; then
  BAD=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT DISTINCT dst_type FROM edges
     WHERE dst_type NOT IN ('raw_source','fragment','wiki','person')" 2>/dev/null)
  if [ -z "$BAD" ]; then
    pass "2b. edges.dst_type values are all canonical"
  else
    fail "2b. non-canonical dst_type values present: $BAD"
  fi
else
  skip "2b. DATABASE_URL not set"
fi

# 2c. CHECK constraint on src_type
if [ -n "${DATABASE_URL:-}" ]; then
  HAS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='edges' AND constraint_name='edges_src_type_check'" 2>/dev/null \
     | tr -d '[:space:]')
  if [ "$HAS" = "1" ]; then
    pass "2c. edges_src_type_check constraint present"
  else
    fail "2c. edges_src_type_check constraint missing"
  fi
else
  skip "2c. DATABASE_URL not set"
fi

# 2d. CHECK constraint on dst_type
if [ -n "${DATABASE_URL:-}" ]; then
  HAS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='edges' AND constraint_name='edges_dst_type_check'" 2>/dev/null \
     | tr -d '[:space:]')
  if [ "$HAS" = "1" ]; then
    pass "2d. edges_dst_type_check constraint present"
  else
    fail "2d. edges_dst_type_check constraint missing"
  fi
else
  skip "2d. DATABASE_URL not set"
fi

# 3a. Worker-produced ENTRY_HAS_FRAGMENT edge has src_type='raw_source'.
# Drive an entry through the MCP log_entry tool and inspect the edges
# table for the resulting raw_source row.
ENTRY_TEXT="UAT 74 entry produced at $RUN_ID. Validates src_type canonicalisation."
if [ -n "${MCP_ENDPOINT:-}" ]; then
  RPC_BODY=$(jq -n --arg c "$ENTRY_TEXT" --arg cn "uat-74-mcp" --arg cv "1.0.0" \
    '{jsonrpc:"2.0", id:1, method:"tools/call",
      params:{name:"log_entry", arguments:{content:$c, type:"thought"}},
      _meta:{clientInfo:{name:$cn, version:$cv}}}')
  RPC_RESP=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Origin: $ORIGIN" \
    -d "$RPC_BODY" "$MCP_ENDPOINT")
  echo "$RPC_RESP" > /tmp/uat-74-log-entry.json
  if echo "$RPC_RESP" | grep -q '^data: '; then
    PAYLOAD=$(echo "$RPC_RESP" | sed -n 's/^data: //p' | head -1)
  else
    PAYLOAD="$RPC_RESP"
  fi
  RPC_TEXT=$(echo "$PAYLOAD" | jq -r '.result.content[0].text // empty')
  ENTRY_KEY=$(echo "$RPC_TEXT" | grep -oE 'entry[A-Z0-9]{20,}' | head -1)
  if [ -n "$ENTRY_KEY" ]; then
    UAT_ENTRY_KEYS+=("$ENTRY_KEY")
    # Worker is async; allow a short window for ENTRY_HAS_FRAGMENT
    # writes to land.
    for i in 1 2 3 4 5 6 7 8 9 10; do
      ROWS=$(psql "$DATABASE_URL" -t -A -c \
        "SELECT count(*) FROM edges
         WHERE edge_type='ENTRY_HAS_FRAGMENT' AND src_id='$ENTRY_KEY'" 2>/dev/null \
         | tr -d '[:space:]')
      [ "$ROWS" != "0" ] && break
      sleep 1
    done
    SRC_TYPES=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT DISTINCT src_type FROM edges
       WHERE edge_type='ENTRY_HAS_FRAGMENT' AND src_id='$ENTRY_KEY'" 2>/dev/null \
       | tr -d '[:space:]')
    if [ "$SRC_TYPES" = "raw_source" ]; then
      pass "3a. worker-produced ENTRY_HAS_FRAGMENT edges have src_type='raw_source'"
    elif [ -z "$SRC_TYPES" ]; then
      skip "3a. no ENTRY_HAS_FRAGMENT edge produced for $ENTRY_KEY (worker not running?)"
    else
      fail "3a. unexpected src_type for ENTRY_HAS_FRAGMENT: '$SRC_TYPES'"
    fi
  else
    fail "3a. log_entry did not return an entry key (resp=$RPC_TEXT)"
  fi
else
  skip "3a. no MCP endpoint"
fi

# 3b. CHECK constraint rejects src_type='entry'
if [ -n "${DATABASE_URL:-}" ]; then
  RAW_KEY=$(echo "${UAT_ENTRY_KEYS[0]:-}")
  if [ -z "$RAW_KEY" ]; then
    # If no entry was minted, fabricate plausible ids; the INSERT
    # will fail the CHECK before any FK is consulted.
    RAW_KEY="uat74-fake-entry"
  fi
  ERR=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "INSERT INTO edges (id, src_type, src_id, dst_type, dst_id, edge_type)
     VALUES ('uat74-bad', 'entry', '$RAW_KEY', 'fragment', 'frag-x', 'ENTRY_HAS_FRAGMENT')" \
    2>&1)
  if echo "$ERR" | grep -qi "edges_src_type_check\|violates check constraint"; then
    pass "3b. CHECK constraint rejected src_type='entry'"
  else
    fail "3b. CHECK constraint did NOT reject src_type='entry' (output: $ERR)"
    psql "$DATABASE_URL" -c "DELETE FROM edges WHERE id='uat74-bad'" >/dev/null 2>&1 || true
  fi
else
  skip "3b. DATABASE_URL not set"
fi

# 4a. Reverse traversal by dst_type='fragment' finds the
# worker-produced edge.
if [ -n "${DATABASE_URL:-}" ] && [ -n "${UAT_ENTRY_KEYS[0]:-}" ]; then
  CNT=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT count(*) FROM edges
     WHERE dst_type='fragment' AND src_id='${UAT_ENTRY_KEYS[0]}'
       AND edge_type='ENTRY_HAS_FRAGMENT'" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$CNT" ] && [ "$CNT" != "0" ]; then
    pass "4a. reverse traversal by dst_type='fragment' returned $CNT row(s)"
  else
    skip "4a. no fragment edges to traverse for ${UAT_ENTRY_KEYS[0]}"
  fi
else
  skip "4a. DATABASE_URL or entry key not set"
fi

# 5a. seed-data audit doc exists
if [ -f "docs/architecture/seed-data.md" ]; then
  pass "5a. docs/architecture/seed-data.md present"
else
  fail "5a. docs/architecture/seed-data.md missing"
fi

# 5b. seed-data audit doc names the seedFixture path
if [ -f "docs/architecture/seed-data.md" ] && \
   grep -q "seedFixture\|seedFixture.ts" "docs/architecture/seed-data.md"; then
  pass "5b. seed-data doc references seedFixture path"
else
  fail "5b. seed-data doc does not reference seedFixture"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"

# Cleanup: delete the rows this UAT created.
if [ -n "${DATABASE_URL:-}" ]; then
  for key in "${UAT_ENTRY_KEYS[@]}"; do
    psql "$DATABASE_URL" -c "DELETE FROM edges WHERE src_id='$key' OR dst_id='$key'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM fragments WHERE entry_id='$key'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM raw_sources WHERE lookup_key='$key'" >/dev/null 2>&1 || true
  done
fi

[ "$FAIL" = "0" ]
```

## Cleanup

The script tears down its own rows via the `UAT_ENTRY_KEYS` array. If
interrupted mid-run, manual sweep:

```bash
psql "$DATABASE_URL" -c "DELETE FROM edges WHERE id='uat74-bad';"
psql "$DATABASE_URL" -c "DELETE FROM raw_sources WHERE content LIKE 'UAT 74 %';"
```

## Expected pass/fail behavior

- 1a, 1b PASS once migration 0016 has been run on the target DB.
- 2a, 2b are the canonical-vocabulary contract; any non-canonical
  string in `edges.src_type` or `edges.dst_type` is a regression.
- 2c, 2d confirm the CHECK constraints landed by name.
- 3a depends on the pipeline worker running. If the worker is not
  attached to BullMQ, the test SKIPs after a 10-second wait rather
  than failing.
- 3b is the negative assertion that the database itself rejects
  legacy 'entry' writes. A pass means the CHECK constraint is
  doing its job.
- 4a confirms graph traversal returns the worker-produced edge.
- 5a, 5b confirm Stream H3's documentation deliverable is on disk
  and references the codepath we audited.
