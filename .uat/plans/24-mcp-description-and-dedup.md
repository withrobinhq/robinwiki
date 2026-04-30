# 24 — MCP description persistence + fragment dedup

## What it proves

PR #187 fixes two MCP write-path defects against a live core:

- **#168** — `create_wiki` accepts a `description` field that previously fed
  only `inferWikiType()` and was discarded before INSERT. Post-fix, the
  trimmed description is persisted on `wikis.description` for every code
  path: explicit type + description, inferred type + description, and
  description omitted (column is non-null with `DEFAULT ''`). Tool-input
  schema text in `core/src/mcp/server.ts` is also updated to advertise the
  dual role.
- **#184** — `log_fragment` short-circuits on identical content. The handler
  computes the SHA-256 of the trimmed/whitespace-collapsed content
  (`computeContentHash` in `core/src/db/dedup.ts`) **before** insert, looks
  up an existing fragment via `findDuplicateFragment`, and on hit returns
  `Duplicate: fragment <lookupKey> already contains this content` as plain
  text content (no `isError` flag). On miss, the fragment row is written
  with `dedupHash` populated so the next attempt collapses. The new
  `fragments_dedup_hash_idx` keeps that lookup O(1).

The plan also pins three negative invariants the diff implies but doesn't
spell out: (1) dedup must NOT collapse meaningfully different content,
(2) the duplicate response must NOT create a second DB row, and (3) the
dedup hash must be insensitive to leading/trailing/internal whitespace
runs (matches the normalisation in `computeContentHash`).

## Prerequisites

- Plan 22 has run (Transformer fixture seeded — `transformer-architecture`
  wiki resolvable by slug).
- Core running on `SERVER_URL`. `INITIAL_USERNAME` / `INITIAL_PASSWORD` set
  in `core/.env` so the cookie sign-in + JWT mint succeed.
- `jq` installed.
- `psql` available with `DATABASE_URL` configured (this plan's primary DB
  invariants degrade to SKIP without it, but several core assertions —
  description column read, dedup row count, index presence — require it).
- Migration `0000_init.sql` and PR #187's `fragments_dedup_hash_idx` index
  applied (drizzle migrations run on boot).

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-24-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

# Per-run salt for content-dedup'd inputs. Without it, re-running the
# plan in the same DB causes step 3a to fail (the "fresh" content
# collides with the prior run's row, which now looks like a duplicate).
RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "24 — MCP description persistence + fragment dedup"
echo ""

# ── 0. Sign in + mint MCP JWT ───────────────────────────────
# Same shape as plan 98: web sign-in with cookie, then fetch
# /users/profile to extract the EdDSA-signed token from
# mcpEndpointUrl. The MCP route at /mcp authenticates on ?token=,
# not on the cookie.

curl -s -o /dev/null -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email"

if [ -s "$COOKIE_JAR" ]; then
  pass "0a. sign-in established a session cookie"
else
  fail "0a. sign-in failed — all MCP steps will be skipped"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

PROFILE=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/users/profile")
MCP_URL=$(echo "$PROFILE" | jq -r '.mcpEndpointUrl // empty')
if [ -z "$MCP_URL" ]; then
  fail "0b. /users/profile.mcpEndpointUrl empty — user has no keypair"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
MCP_TOKEN=$(echo "$MCP_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')
if [ -z "$MCP_TOKEN" ]; then
  fail "0c. could not parse token out of mcpEndpointUrl: $MCP_URL"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "0b. minted MCP JWT for the signed-in user"

MCP_ENDPOINT="$SERVER_URL/mcp?token=$MCP_TOKEN"

# ── Helper: call_tool <step> <tool> <args-json> [expect-error]
# Mirrors plan 98 — JSON-RPC 2.0 envelope, optional SSE framing,
# stashes parsed text + error flag in $RPC_TEXT / $RPC_ERR.
RPC_ID=0
call_tool() {
  local step="$1" tool="$2" args="$3" expect="${4:-}"
  RPC_ID=$((RPC_ID+1))
  local body
  body=$(jq -n --argjson id "$RPC_ID" --arg tool "$tool" --argjson args "$args" \
    '{jsonrpc:"2.0", id:$id, method:"tools/call",
      params:{name:$tool, arguments:$args}}')
  local resp
  resp=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Origin: http://localhost:3000" \
    -d "$body" \
    "$MCP_ENDPOINT")
  echo "$resp" > /tmp/uat-24-last.json

  local payload
  if echo "$resp" | grep -q '^data: '; then
    payload=$(echo "$resp" | sed -n 's/^data: //p' | head -1)
  else
    payload="$resp"
  fi

  RPC_TEXT=$(echo "$payload" | jq -r '.result.content[0].text // empty')
  RPC_ERR=$(echo "$payload" | jq -r '.result.isError // false')

  if [ "$expect" = "expect-error" ]; then
    if [ "$RPC_ERR" = "true" ]; then
      pass "$step $tool returned isError=true as expected"
    else
      fail "$step $tool expected isError=true but got isError=$RPC_ERR (text=${RPC_TEXT:0:120})"
    fi
  fi
}

# Track UAT-created rows so the cleanup section reverses them.
UAT_WIKI_KEYS=()
UAT_FRAGMENT_KEYS=()

# ── 1. Schema + migration prerequisites (#168 + #184) ──────
# Both bug fixes depend on backing schema. Without these the live
# fixes silently degrade (description silently dropped, dedup hash
# never indexed → table-scan).

if [ -n "${DATABASE_URL:-}" ]; then
  HAS_DESC_COL=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT 1 FROM information_schema.columns WHERE table_name='wikis' AND column_name='description'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$HAS_DESC_COL" = "1" ]; then
    pass "1a. wikis.description column exists (migration 0007 applied)"
  else
    fail "1a. wikis.description column missing — #168 fix has nothing to write to"
  fi

  HAS_DEDUP_COL=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT 1 FROM information_schema.columns WHERE table_name='fragments' AND column_name='dedup_hash'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$HAS_DEDUP_COL" = "1" ]; then
    pass "1b. fragments.dedup_hash column exists (baseColumns from 0000_init)"
  else
    fail "1b. fragments.dedup_hash column missing — #184 fix has nothing to lookup against"
  fi

  HAS_DEDUP_IDX=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT 1 FROM pg_indexes WHERE tablename='fragments' AND indexname='fragments_dedup_hash_idx'" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$HAS_DEDUP_IDX" = "1" ]; then
    pass "1c. fragments_dedup_hash_idx index present (PR #187 migration applied)"
  else
    fail "1c. fragments_dedup_hash_idx missing — dedup lookup will table-scan at scale"
  fi

  # ── 1d. Partial dedup index used by hot-path query ──
  # Existence of the index (1c) is necessary but not sufficient. The
  # index in core/src/db/schema.ts:225-227 is PARTIAL (`WHERE deleted_at
  # IS NULL`). For Postgres to use it, the planner needs the predicate
  # `deleted_at IS NULL` IN the query. findDuplicateFragment in
  # core/src/db/dedup.ts:42-49 currently emits only
  # `WHERE dedup_hash = $1` — no deleted_at filter — so the planner
  # falls back to a Seq Scan. This regression fires until #223 is
  # closed by adding `isNull(fragments.deletedAt)` to the .where()
  # chain.
  # `enable_seqscan = off` is critical: on a tiny `fragments` table the
  # planner picks Seq Scan even when the index is fully usable (cost
  # ~6.51 vs index ~8.15). Forcing the planner to consider indices
  # decouples the assertion from row count — if the partial-index
  # predicates aren't met, the planner STILL won't use it (it picks Seq
  # Scan with disable-cost ~1e10), and we score that as a fail. With
  # the deleted_at predicate added (post-#223), the same query flips to
  # `Index Scan using fragments_dedup_hash_idx`.
  EXPLAIN_HASH="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff${RUN_ID:0:2}"
  # psql -t -A still emits a `SET` line for the SET command before the
  # JSON body — strip everything before the opening `[` so jq parses
  # only the EXPLAIN payload.
  EXPLAIN_RAW=$(psql "$DATABASE_URL" -t -A -c \
    "SET enable_seqscan=off; EXPLAIN (FORMAT JSON) SELECT * FROM fragments WHERE dedup_hash = '$EXPLAIN_HASH'" \
    2>/dev/null)
  EXPLAIN_JSON=$(echo "$EXPLAIN_RAW" | sed -n '/^\[/,$p')

  if [ -n "$EXPLAIN_JSON" ]; then
    NODE_TYPE=$(echo "$EXPLAIN_JSON" | jq -r '.[0].Plan."Node Type" // empty' 2>/dev/null)
    INDEX_NAME=$(echo "$EXPLAIN_JSON" | jq -r '
      [.[0].Plan."Index Name",
       (.[0].Plan.Plans // [])[]?."Index Name"]
      | map(select(. != null and . != ""))
      | .[0] // empty' 2>/dev/null)

    case "$NODE_TYPE" in
      "Index Scan"|"Index Only Scan"|"Bitmap Heap Scan")
        if [ "$INDEX_NAME" = "fragments_dedup_hash_idx" ]; then
          pass "1d. findDuplicateFragment hot-path uses fragments_dedup_hash_idx ($NODE_TYPE) — partial index hit"
        else
          fail "1d. plan is $NODE_TYPE on '$INDEX_NAME' (expected fragments_dedup_hash_idx) — wrong index chosen"
        fi
        ;;
      "Seq Scan")
        fail "1d. findDuplicateFragment hot-path is Seq Scan — partial index unused (#223 — handler missing isNull(fragments.deletedAt) so planner can't match the WHERE deleted_at IS NULL partial)"
        ;;
      "")
        echo "$EXPLAIN_JSON" > /tmp/uat-24-explain.json
        skip "1d. EXPLAIN returned no parseable JSON — see /tmp/uat-24-explain.json"
        ;;
      *)
        fail "1d. unexpected plan node type '$NODE_TYPE' (index='$INDEX_NAME') — investigate EXPLAIN manually"
        ;;
    esac
  else
    skip "1d. EXPLAIN query returned empty — psql/jq unavailable or fragments table absent"
  fi
else
  skip "1a. DATABASE_URL unset — wikis.description column check skipped"
  skip "1b. DATABASE_URL unset — fragments.dedup_hash column check skipped"
  skip "1c. DATABASE_URL unset — fragments_dedup_hash_idx check skipped"
  skip "1d. DATABASE_URL unset — partial-index hot-path EXPLAIN skipped"
fi

# ── 2. create_wiki tool description text mentions persistence (#168) ──
# Server-side schema describer change. This is what tells callers the
# description is more than a type-inference hint. tools/list returns the
# advertised inputSchema; we grep its `description` text for the new
# wording from `core/src/mcp/server.ts:108`.

LIST_BODY=$(jq -n '{jsonrpc:"2.0", id:99, method:"tools/list"}')
TOOLS_RESP=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Origin: http://localhost:3000" \
  -d "$LIST_BODY" \
  "$MCP_ENDPOINT")
echo "$TOOLS_RESP" > /tmp/uat-24-tools-list.json

TOOLS_PAYLOAD=$(if echo "$TOOLS_RESP" | grep -q '^data: '; then \
  echo "$TOOLS_RESP" | sed -n 's/^data: //p' | head -1; \
else echo "$TOOLS_RESP"; fi)

DESC_TEXT=$(echo "$TOOLS_PAYLOAD" | jq -r \
  '.result.tools[] | select(.name=="create_wiki") | .inputSchema.properties.description.description // empty')

if echo "$DESC_TEXT" | grep -qi "persisted on the wiki row"; then
  pass "2a. create_wiki.description schema text advertises persistence (PR #187 wording)"
else
  fail "2a. create_wiki.description schema text missing 'persisted on the wiki row' wording (got: ${DESC_TEXT:0:160})"
fi

# ── 3. create_wiki — explicit type + description (#168 happy path) ──
# Closes #168 acceptance test #1: {title, description} → inserted row has
# description === input.description. Use an explicit valid type so the
# inference path is not the load-bearing one — we are isolating the
# persistence fix.

DESC_2A="UAT 24 ${RUN_ID} — written by an MCP caller and expected to land on the row."
call_tool "3a." create_wiki \
  "$(jq -n --arg t "UAT 24 wiki w/ description $RUN_ID" --arg d "$DESC_2A" \
    '{title:$t, description:$d, type:"decision"}')"
W3_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
W3_SLUG=$(echo "$RPC_TEXT" | jq -r '.slug // empty')

if [ -n "$W3_KEY" ] && [ -n "$W3_SLUG" ]; then
  pass "3a. create_wiki(title, description, type=decision) → lookupKey=$W3_KEY slug=$W3_SLUG"
  UAT_WIKI_KEYS+=("$W3_KEY")
else
  fail "3a. create_wiki returned malformed result: $RPC_TEXT"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$W3_KEY" ]; then
  DB_DESC=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT description FROM wikis WHERE lookup_key='$W3_KEY' AND deleted_at IS NULL" \
    2>/dev/null)
  if [ "$DB_DESC" = "$DESC_2A" ]; then
    pass "3b. wikis.description on $W3_KEY matches input verbatim"
  else
    fail "3b. wikis.description mismatch — expected '${DESC_2A:0:60}…' got '${DB_DESC:0:60}…'"
  fi
else
  skip "3b. DATABASE_URL unset — description column readback skipped"
fi

# ── 4. create_wiki — title only, no description (#168 default) ──
# Closes #168 acceptance test #2: {title, type} (no description) → the
# inserted row has description === '' (column is non-null with DEFAULT ''
# in schema.ts:235). Confirms the optional-field shape lands the right
# default.

call_tool "4a." create_wiki \
  "$(jq -n --arg t "UAT 24 wiki no desc $RUN_ID" \
    '{title:$t, type:"log"}')"
W4_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
W4_SLUG=$(echo "$RPC_TEXT" | jq -r '.slug // empty')

if [ -n "$W4_KEY" ]; then
  pass "4a. create_wiki(title, type=log) → lookupKey=$W4_KEY"
  UAT_WIKI_KEYS+=("$W4_KEY")
else
  fail "4a. create_wiki without description returned malformed result: $RPC_TEXT"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$W4_KEY" ]; then
  DB_DESC4=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT description FROM wikis WHERE lookup_key='$W4_KEY' AND deleted_at IS NULL" \
    2>/dev/null)
  if [ "$DB_DESC4" = "" ]; then
    pass "4b. wikis.description on $W4_KEY is empty string (column default honored, not NULL)"
  else
    fail "4b. wikis.description should be '' when omitted but got '${DB_DESC4:0:60}…'"
  fi
else
  skip "4b. DATABASE_URL unset — description default check skipped"
fi

# ── 5. create_wiki — inferred type still persists description (#168 regression guard) ──
# Closes #168 acceptance test #3: when inference path is taken, description
# must be persisted AND fed to inferWikiType. handleCreateWiki branches
# on input.type — without it, resolvedType = inferWikiType(description ?? '')
# AND the column write must still fire. This is the regression-guard case
# the PR's diff hits with a single one-liner.

DESC_5A="a chronological synthesis of events and observations $RUN_ID"
call_tool "5a." create_wiki \
  "$(jq -n --arg t "UAT 24 inferred $RUN_ID" --arg d "$DESC_5A" \
    '{title:$t, description:$d}')"
W5_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
W5_TYPE=$(echo "$RPC_TEXT" | jq -r '.type // empty')
W5_INFERRED=$(echo "$RPC_TEXT" | jq -r '.inferredType // empty')

if [ -n "$W5_KEY" ] && [ "$W5_TYPE" = "$W5_INFERRED" ]; then
  pass "5a. inference path: type=$W5_TYPE inferredType=$W5_INFERRED (match — both populated)"
  UAT_WIKI_KEYS+=("$W5_KEY")
else
  fail "5a. inference path returned mismatched type/inferredType: type='$W5_TYPE' inferredType='$W5_INFERRED'"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$W5_KEY" ]; then
  DB_DESC5=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT description FROM wikis WHERE lookup_key='$W5_KEY' AND deleted_at IS NULL" \
    2>/dev/null)
  if [ "$DB_DESC5" = "$DESC_5A" ]; then
    pass "5b. inference-path description persisted verbatim — both purposes served"
  else
    fail "5b. inference-path description not persisted — expected '${DESC_5A:0:60}…' got '${DB_DESC5:0:60}…'"
  fi
else
  skip "5b. DATABASE_URL unset — inference-path description check skipped"
fi

# ── 6. log_fragment — first call lands a row (#184 baseline) ──
# Establish a baseline fragment that step 7 will attempt to dedup against.
# threadSlug is the seeded Transformer wiki from plan 22.

DEDUP_BODY="UAT 24 dedup canary $RUN_ID — same content twice should not double-write."
call_tool "6a." log_fragment \
  "$(jq -n --arg c "$DEDUP_BODY" '{content:$c, threadSlug:"transformer-architecture"}')"
F6_KEY=$(echo "$RPC_TEXT" | jq -r '.fragmentKey // empty')
F6_SLUG=$(echo "$RPC_TEXT" | jq -r '.fragmentSlug // empty')

if [ -n "$F6_KEY" ] && [ -n "$F6_SLUG" ]; then
  pass "6a. log_fragment first call → fragmentKey=$F6_KEY"
  UAT_FRAGMENT_KEYS+=("$F6_KEY")
else
  fail "6a. log_fragment first call returned malformed result: $RPC_TEXT"
fi

# Capture the dedupHash + DB row count for step 7's invariants.
if [ -n "${DATABASE_URL:-}" ] && [ -n "$F6_KEY" ]; then
  F6_HASH=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT dedup_hash FROM fragments WHERE lookup_key='$F6_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ -n "$F6_HASH" ] && [ "$F6_HASH" != "null" ]; then
    pass "6b. fragments.dedup_hash populated for $F6_KEY (hash=${F6_HASH:0:12}…)"
  else
    fail "6b. fragments.dedup_hash NULL — handler did not set hash on insert"
  fi
else
  skip "6b. DATABASE_URL unset — dedup_hash readback skipped"
fi

# ── 7. log_fragment — identical content collapses (#184 happy path) ──
# Closes #184 acceptance: identical content → handler short-circuits with
# `Duplicate: fragment <lookupKey> already contains this content` and DOES
# NOT emit isError=true (per the diff: the duplicate response uses
# `content: [{ type: 'text', text: ... }]` with no `isError` flag — it is
# a successful duplicate notice, not a tool error). DB row count for the
# canary content stays at 1.

call_tool "7a." log_fragment \
  "$(jq -n --arg c "$DEDUP_BODY" '{content:$c, threadSlug:"transformer-architecture"}')"

if [ "$RPC_ERR" = "false" ] && echo "$RPC_TEXT" | grep -q "^Duplicate: fragment "; then
  pass "7a. duplicate response is the documented 'Duplicate: fragment <key>' text (not an isError)"
else
  fail "7a. duplicate response wrong shape — isError=$RPC_ERR text='${RPC_TEXT:0:160}'"
fi

# 7b. The duplicate notice references the original fragment's lookupKey,
# not a new one. Handler emits the existing row's lookupKey.
if echo "$RPC_TEXT" | grep -q "fragment $F6_KEY"; then
  pass "7b. duplicate notice points back at the original fragmentKey ($F6_KEY)"
else
  fail "7b. duplicate notice did not reference original lookupKey $F6_KEY: $RPC_TEXT"
fi

# 7c. DB invariant — only one fragment row exists for that hash.
if [ -n "${DATABASE_URL:-}" ] && [ -n "${F6_HASH:-}" ]; then
  ROW_COUNT=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT count(*) FROM fragments WHERE dedup_hash='$F6_HASH' AND deleted_at IS NULL" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$ROW_COUNT" = "1" ]; then
    pass "7c. fragments table still has exactly 1 row for the dedup hash (no double-write)"
  else
    fail "7c. duplicate call inserted a second row — count=$ROW_COUNT (expected 1)"
  fi
else
  skip "7c. DATABASE_URL unset or hash missing — duplicate-row count check skipped"
fi

# ── 8. log_fragment — whitespace-normalised dedup ──────────
# computeContentHash trims outer whitespace and collapses runs of internal
# whitespace to a single space before hashing. Therefore "  $DEDUP_BODY  "
# with extra inner spaces must hash to the same value as the canary and
# trigger the same duplicate notice. This locks the normalisation contract
# the PR inherits from db/dedup.ts.

NOISY_BODY="   UAT 24    dedup canary  $RUN_ID  —    same content   twice   should not    double-write.   "
call_tool "8a." log_fragment \
  "$(jq -n --arg c "$NOISY_BODY" '{content:$c, threadSlug:"transformer-architecture"}')"

if echo "$RPC_TEXT" | grep -q "^Duplicate: fragment $F6_KEY"; then
  pass "8a. whitespace-noisy variant collapsed to original (normalisation honored)"
else
  fail "8a. whitespace-noisy variant was treated as new content: $RPC_TEXT"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "${F6_HASH:-}" ]; then
  ROW_COUNT2=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT count(*) FROM fragments WHERE dedup_hash='$F6_HASH' AND deleted_at IS NULL" \
    2>/dev/null | tr -d '[:space:]')
  [ "$ROW_COUNT2" = "1" ] \
    && pass "8b. row count remains 1 after whitespace-variant submission" \
    || fail "8b. whitespace-variant inserted a row — count=$ROW_COUNT2"
else
  skip "8b. DATABASE_URL unset — whitespace-variant row count skipped"
fi

# ── 9. log_fragment — distinct content does NOT collapse (#184 negative) ──
# Critical guardrail. If dedup hashed too coarsely (e.g. only the first N
# chars, or stripped punctuation), real differing fragments would silently
# vanish. Submit content that differs by exactly one character and assert
# the handler returns a fresh fragmentKey + a new DB row.

DISTINCT_BODY="UAT 24 dedup canary $RUN_ID — same content twice should not double-write!"
call_tool "9a." log_fragment \
  "$(jq -n --arg c "$DISTINCT_BODY" '{content:$c, threadSlug:"transformer-architecture"}')"
F9_KEY=$(echo "$RPC_TEXT" | jq -r '.fragmentKey // empty')

if [ -n "$F9_KEY" ] && [ "$F9_KEY" != "$F6_KEY" ]; then
  pass "9a. distinct-content fragment got a new lookupKey ($F9_KEY ≠ $F6_KEY)"
  UAT_FRAGMENT_KEYS+=("$F9_KEY")
else
  fail "9a. distinct-content fragment was wrongly deduped — got '$F9_KEY' (canary was $F6_KEY)"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$F9_KEY" ]; then
  F9_HASH=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT dedup_hash FROM fragments WHERE lookup_key='$F9_KEY'" \
    2>/dev/null | tr -d '[:space:]')
  if [ -n "$F9_HASH" ] && [ "$F9_HASH" != "${F6_HASH:-}" ]; then
    pass "9b. distinct content produced a distinct dedup_hash (≠ canary hash)"
  else
    fail "9b. distinct content shared the canary hash — false-positive dedup"
  fi
else
  skip "9b. DATABASE_URL unset — distinct-hash check skipped"
fi

# ── Cleanup — soft-delete UAT-created rows ─────────────────
# Same shape as plan 98's cleanup: per-key soft-delete via DB, plus a
# UAT-named sweep so an earlier failed run doesn't bleed into the next
# replay. Description in the wikis cleanup matches the names from steps
# 3/4/5; the fragment cleanup keys off the lookupKey we tracked.

if [ -n "${DATABASE_URL:-}" ]; then
  CLEANED=0
  for key in "${UAT_WIKI_KEYS[@]}"; do
    [ -z "$key" ] && continue
    psql "$DATABASE_URL" -c "UPDATE wikis SET deleted_at=now(), updated_at=now() WHERE lookup_key='$key'" >/dev/null 2>&1 \
      && CLEANED=$((CLEANED+1)) || true
  done
  for key in "${UAT_FRAGMENT_KEYS[@]}"; do
    [ -z "$key" ] && continue
    psql "$DATABASE_URL" -c "UPDATE fragments SET deleted_at=now(), updated_at=now() WHERE lookup_key='$key'" >/dev/null 2>&1 \
      && CLEANED=$((CLEANED+1)) || true
  done
  # Belt + braces: anything matching the UAT 24 name prefix that escaped
  # the per-key tracking gets swept too.
  psql "$DATABASE_URL" -c "UPDATE wikis SET deleted_at=now(), updated_at=now() WHERE name LIKE 'UAT 24 %' AND deleted_at IS NULL" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -c "UPDATE fragments SET deleted_at=now(), updated_at=now() WHERE content LIKE 'UAT 24 %' AND deleted_at IS NULL" >/dev/null 2>&1 || true
  pass "Cleanup. soft-deleted $CLEANED tracked UAT row(s) + UAT-24 sweep"
else
  skip "Cleanup. DATABASE_URL unset — UAT rows left in place; downstream plans may see them"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0 | Web sign-in establishes cookie; `/users/profile.mcpEndpointUrl` yields a JWT for the MCP transport | `routes/users.ts`, `mcp/jwt.ts` |
| 1a | `wikis.description` column exists in DB (migration 0007 applied) | #168 dependency |
| 1b | `fragments.dedup_hash` column exists (`baseColumns()` in `0000_init.sql`) | #184 dependency |
| 1c | `fragments_dedup_hash_idx` index exists (PR #187 schema diff) | PR #187 |
| 1d | `findDuplicateFragment` hot-path query is planned as Index Scan over `fragments_dedup_hash_idx` (not Seq Scan) — partial index actually used | #223 — `core/src/db/dedup.ts:42-49` vs `schema.ts:225-227` |
| 2a | `tools/list` advertises the new `description` schema text containing 'persisted on the wiki row' | PR #187 — `core/src/mcp/server.ts:108` |
| 3a | `create_wiki` with explicit valid `type` + `description` returns `{slug, lookupKey, type, inferredType: undefined}` | #168 acceptance test #1 |
| 3b | DB row's `description` column matches input verbatim | #168 acceptance test #1 |
| 4a | `create_wiki` with `type` and no `description` succeeds | #168 acceptance test #2 |
| 4b | DB row's `description` column equals `''` (column default, not NULL) | #168 acceptance test #2 |
| 5a | `create_wiki` with `description` and no `type` infers type AND `inferredType === type` | #168 acceptance test #3 + existing inference contract |
| 5b | DB row's `description` is the input verbatim — inference path also persists | #168 acceptance test #3 |
| 6a | `log_fragment` first call returns a `{fragmentKey, fragmentSlug, threadSlug, wikiKey}` shape | `handleLogFragment` happy path |
| 6b | DB row's `dedup_hash` column populated on insert | PR #187 — handler now writes `dedupHash: hash` |
| 7a | Identical-content second call returns plain text `Duplicate: fragment <key> already contains this content` with `isError !== true` | PR #187 diff — duplicate response shape |
| 7b | Duplicate notice references the original fragment's `lookupKey` | `findDuplicateFragment` returning the existing row |
| 7c | Only one row exists in `fragments` for the dedup hash (no double-write) | #184 — retry must not duplicate |
| 8a | Whitespace-noisy variant of identical content collapses to the same dedup notice (`computeContentHash` normalisation) | `core/src/db/dedup.ts:16-19` |
| 8b | Row count for the canary hash is still 1 after the noisy submission | `computeContentHash` trim + collapse contract |
| 9a | Content differing by one character returns a NEW `fragmentKey` | dedup negative invariant |
| 9b | New row's `dedup_hash` differs from the canary hash | dedup hash collision absence |
| Cleanup | All UAT-created wikis + fragments soft-deleted via per-key + name-sweep | replayability |

---

## Notes

- **§1d is expected to FAIL until #223 is fixed.** `core/src/db/dedup.ts:42-49`
  filters only on `dedup_hash`. The index at `core/src/db/schema.ts:225-227`
  is partial `WHERE deleted_at IS NULL`, so the planner needs
  `deleted_at IS NULL` in the query predicate to use it. Fix is one
  line: add `isNull(fragments.deletedAt)` to the `.where()` chain
  (with an `and(...)` wrapper). After fix, EXPLAIN emits
  `Index Scan using fragments_dedup_hash_idx`. Asserting on planner
  shape — not raw timing — keeps the signal stable across DB sizes
  and `random_page_cost` tuning.
- **§1d uses `SET enable_seqscan=off`.** Live confirmation against
  the `.dev/postgres` instance with a tiny `fragments` table showed
  Seq Scan for both query shapes (cost ~6.51) — the planner is too
  cheap on small tables to pick the index regardless of predicate
  fitness. With `enable_seqscan=off`, the planner is forced to
  consider indices; if the partial-index predicate `deleted_at IS NULL`
  is missing from the query, the planner has no usable index and
  falls back to Seq Scan with disable-cost ~1e10. With the predicate
  present, the same query flips to `Index Scan using
  fragments_dedup_hash_idx` (cost ~8.15). This makes §1d deterministic
  on any DB size including a freshly-bootstrapped staging DB.
- **Tools/list-as-contract.** Step 2 leans on `tools/list` to assert the
  schema-text change in `core/src/mcp/server.ts:108`. If a future change
  inlines or rephrases that text, step 2a regresses — update the grep
  pattern in lockstep.
- **Duplicate response is NOT an error.** Step 7 explicitly checks
  `isError !== true`. The PR's diff returns the `Duplicate: ...` text
  inside a normal `content[]` payload. If a follow-up hardens this to
  `isError: true` for stricter clients, step 7a flips and the assertion
  needs to be updated; the row-count invariant in 7c is the more durable
  signal.
- **Read-side description is invisible through MCP.** PR #187 persists
  `wikis.description` on insert, but `listWikis` and `getWiki` resolvers
  in `core/src/mcp/resolvers.ts:457` and `:530` do NOT project the
  `description` column today (`thread` returns `{lookupKey, slug, name,
  type, state, lastRebuiltAt}` only). This plan therefore reads the
  description back via `psql` — there is no MCP read path that would
  surface it. Filed as **drift** below.
- **Dedup window is unbounded.** PR #187 short-circuits on any prior
  fragment with the same hash, regardless of age. Issue #184 proposed an
  optional client idempotency key + a 5-minute / 24-hour window
  fallback; the merged fix opted for a simpler unconditional content
  hash. Re-running this plan in the same DB without `RUN_ID` salt would
  trip dedup on step 6a — that's why the canary content embeds
  `$RUN_ID`.
- **No `entries` (`log_entry`) coverage.** PR #187 only modifies
  `handleLogFragment`. `handleLogEntry` already had an entry-side
  dedup path via `findDuplicateEntry` independent of this PR. Out of
  scope here; covered by plan 17 / future work tied to #184's broader
  scope.
- **Cleanup soft-deletes** the three UAT wikis and two UAT fragments by
  `lookupKey` plus a name-prefix sweep so a partial-failure replay
  doesn't accumulate clutter. The Transformer fixture from plan 22 is
  not touched.
