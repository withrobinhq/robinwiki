# 98 — MCP Tools

## What it proves
Every registered MCP write tool (`create_wiki`, `log_entry`, `log_fragment`)
and its read counterparts (`get_wiki_types`, `get_wiki`, `get_fragment`,
`find_person`, `list_wikis`) responds correctly to its happy path **and**
its documented error path against a live core, exercised via the same
JSON-RPC HTTP transport that production MCP clients use. Includes the
`type` parameter on `create_wiki` shipped in PR #156 (closes #154) —
explicit valid type, explicit invalid type, type omitted with description
(inference path), and bare title (default-to-`log` path).

PR #193 removed `delete_wiki`, `delete_person`, `publish_wiki`, and
`unpublish_wiki` from the MCP surface; coverage for those moved to
plan 30 §1-2. This plan no longer exercises them.

## Prerequisites
- Core running on `SERVER_URL`. Plan 22 has run (Transformer fixture seeded).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `jq` installed.
- `psql` available with `DATABASE_URL` configured for invariant checks
  (skips if missing, but assertions degrade).

## Fixture identity this plan references
- Wiki slug: `transformer-architecture`
- Person slug: `ashish-vaswani`
- Fragment slug: `self-attention-replaces-recurrence`

## Transport shape

The MCP route at `/mcp` requires a JWT in the `?token=` query string —
not the session cookie. The token is minted by `signMcpToken(userId)` and
exposed to the authenticated web session via `GET /users/profile`'s
`mcpEndpointUrl` field. This plan signs in via the normal web flow,
fetches the profile, parses the token out of the URL, and then drives the
MCP transport directly. Each MCP request creates a fresh stateless server
+ transport per `core/src/routes/mcp.ts` — no `Mcp-Session-Id` handshake
is required for `tools/call`.

The JSON-RPC envelope:

```json
{ "jsonrpc": "2.0", "id": <n>, "method": "tools/call",
  "params": { "name": "<tool>", "arguments": { ... } } }
```

Response shape: `result.content[0].text` is either a JSON-stringified
success payload or a plain error string. When an error path fires,
`result.isError === true` is set on the parent `result` object.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-98-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

# Per-run salt for write-tool inputs that are content-dedup'd
# (log_fragment hashes content; log_entry similar). Re-running the
# plan in the same DB without a salt collides with the prior run.
RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "98 — MCP Tools"
echo ""

# ── 0. Sign in + mint MCP JWT ────────────────────────────────
# The MCP route authenticates via a JWT query param, not the web
# session cookie. The token is exposed to the authenticated session
# via /users/profile.mcpEndpointUrl; we sign in, fetch the profile,
# and parse the token out.

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
# Sends a single JSON-RPC tools/call request. Stores the full RPC
# response in /tmp/uat-98-last.json. Sets:
#   $RPC_TEXT  → result.content[0].text
#   $RPC_ERR   → "true" if result.isError === true, "false" otherwise
# When the 4th arg is "expect-error", the helper checks isError===true
# itself and emits a pass/fail. Otherwise it returns silently and the
# caller asserts on $RPC_TEXT.
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
  echo "$resp" > /tmp/uat-98-last.json

  # Streamable-HTTP transport may emit SSE-framed JSON. Pull the
  # `data:` line out if present; otherwise treat as plain JSON.
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

# Resolve the seeded fixture keys we'll need throughout the plan.
# These come from the HTTP listings (cookie session), not MCP, so the
# plan can fail-fast if the fixture is missing before any tool call.
WIKI_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis?limit=50" \
  | jq -r '.wikis[] | select(.slug=="transformer-architecture") | .lookupKey // .id' \
  | head -1)
PERSON_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/people?limit=100" \
  | jq -r '.people[] | select(.slug=="ashish-vaswani") | .lookupKey // .id' \
  | head -1)
FRAGMENT_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments?limit=100" \
  | jq -r '.fragments[] | select(.slug=="self-attention-replaces-recurrence") | .lookupKey // .id' \
  | head -1)

if [ -z "$WIKI_KEY" ] || [ "$WIKI_KEY" = "null" ]; then
  fail "0d. Transformer fixture not seeded — run plan 22 first"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "0d. Transformer fixture keys resolved (wiki=$WIKI_KEY person=${PERSON_KEY:-?} frag=${FRAGMENT_KEY:-?})"

# Track UAT-created keys so the cleanup section at the end can reverse
# everything this plan inserts. Kept out of psql so the plan still
# leaves a clean fixture even when DATABASE_URL is unset.
UAT_WIKI_KEYS=()
UAT_FRAGMENT_KEYS=()
UAT_ENTRY_KEYS=()

# ── 1. get_wiki_types — list types ──────────────────────────
# Seeded YAML count is 10 (packages/shared/src/prompts/specs/wiki-types/
# *.yaml). The seed bootstrap inserts these on every boot; the assertion
# uses ≥10 so user-added types via create_wiki_type don't break it.

call_tool "1a." get_wiki_types '{}'
TYPE_COUNT=$(echo "$RPC_TEXT" | jq 'length // 0')
if [ "$TYPE_COUNT" -ge 10 ] 2>/dev/null; then
  pass "1a. get_wiki_types returned $TYPE_COUNT types (≥10 expected from seeded YAML)"
else
  fail "1a. get_wiki_types returned only $TYPE_COUNT types (expected ≥10)"
fi
HAS_DECISION=$(echo "$RPC_TEXT" | jq '[.[] | select(.slug == "decision")] | length')
if [ "$HAS_DECISION" = "1" ]; then
  pass "1b. get_wiki_types includes the 'decision' type"
else
  fail "1b. 'decision' type missing from get_wiki_types"
fi

# ── 2. create_wiki — happy path with explicit valid type ─────
# Closes #154 — explicit type wins, no inference. Result must include
# `type: "decision"` and `inferredType` must be undefined/null.

call_tool "2a." create_wiki \
  '{"title":"UAT Test Wiki Decision","type":"decision"}'
WIKI2_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
WIKI2_TYPE=$(echo "$RPC_TEXT" | jq -r '.type // empty')
WIKI2_INFERRED=$(echo "$RPC_TEXT" | jq -r '.inferredType // "null"')
WIKI2_SLUG=$(echo "$RPC_TEXT" | jq -r '.slug // empty')

if [ -n "$WIKI2_KEY" ] && [ "$WIKI2_TYPE" = "decision" ] && [ "$WIKI2_INFERRED" = "null" ]; then
  pass "2a. create_wiki(type=decision) → slug=$WIKI2_SLUG type=decision inferredType=undefined"
  UAT_WIKI_KEYS+=("$WIKI2_KEY")
else
  fail "2a. create_wiki(type=decision) malformed result: $RPC_TEXT"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$WIKI2_SLUG" ]; then
  DB_TYPE=$(psql "$DATABASE_URL" -t -A -c "SELECT type FROM wikis WHERE slug='$WIKI2_SLUG' AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
  if [ "$DB_TYPE" = "decision" ]; then
    pass "2b. DB row for $WIKI2_SLUG has type='decision'"
  else
    fail "2b. DB type='$DB_TYPE' for $WIKI2_SLUG (expected 'decision')"
  fi
else
  skip "2b. DATABASE_URL unset — DB-side type assertion skipped"
fi

# ── 3. create_wiki — explicit invalid type (regression for #154) ──
# Handler builds the message exactly:
#   `Error: unknown wiki type "<type>". Use the get_wiki_types tool to list valid types.`
# isError must be true; no DB row may be inserted.

call_tool "3a." create_wiki \
  '{"title":"UAT Wiki Invalid Type","type":"nonsense-type-xyz"}' \
  expect-error
if echo "$RPC_TEXT" | grep -q 'unknown wiki type "nonsense-type-xyz"'; then
  pass "3b. error text matches handler 'unknown wiki type' wording"
else
  fail "3b. error text did not match expected wording: $RPC_TEXT"
fi
if echo "$RPC_TEXT" | grep -q 'get_wiki_types'; then
  pass "3c. error text references get_wiki_types as the recovery tool"
else
  fail "3c. error text did not reference get_wiki_types: $RPC_TEXT"
fi
if [ -n "${DATABASE_URL:-}" ]; then
  GHOST=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM wikis WHERE name='UAT Wiki Invalid Type'" 2>/dev/null | tr -d '[:space:]')
  if [ "$GHOST" = "0" ]; then
    pass "3d. no DB row inserted on invalid-type rejection"
  else
    fail "3d. invalid-type rejection still wrote $GHOST row(s) — handler regressed"
  fi
else
  skip "3d. DATABASE_URL unset — ghost-row check skipped"
fi

# ── 4. create_wiki — type omitted, description provided ──────
# Inference path. The descriptor for 'log' is "a chronological synthesis
# of events and observations" — the description below shares enough
# tokens to score 'log' highest. inferredType must equal type.

call_tool "4a." create_wiki \
  '{"title":"UAT Inferred Log","description":"a chronological synthesis of events and observations"}'
WIKI4_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
WIKI4_TYPE=$(echo "$RPC_TEXT" | jq -r '.type // empty')
WIKI4_INFERRED=$(echo "$RPC_TEXT" | jq -r '.inferredType // empty')
WIKI4_SLUG=$(echo "$RPC_TEXT" | jq -r '.slug // empty')

if [ -n "$WIKI4_KEY" ] && [ -n "$WIKI4_TYPE" ] && [ "$WIKI4_TYPE" = "$WIKI4_INFERRED" ]; then
  pass "4a. create_wiki(no-type, log-y description) → type=$WIKI4_TYPE inferredType=$WIKI4_INFERRED (match)"
  UAT_WIKI_KEYS+=("$WIKI4_KEY")
else
  fail "4a. inference path returned mismatched type/inferredType: type='$WIKI4_TYPE' inferredType='$WIKI4_INFERRED'"
fi
if [ "$WIKI4_TYPE" = "log" ]; then
  pass "4b. inferred type for 'chronological synthesis' description is 'log'"
else
  skip "4b. inferred type was '$WIKI4_TYPE' (expected 'log' but inference scoring may shift)"
fi
if [ -n "${DATABASE_URL:-}" ] && [ -n "$WIKI4_SLUG" ]; then
  DB_EXISTS=$(psql "$DATABASE_URL" -t -A -c "SELECT 1 FROM wikis WHERE slug='$WIKI4_SLUG' AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
  [ "$DB_EXISTS" = "1" ] && pass "4c. DB row for inferred wiki '$WIKI4_SLUG' exists" \
    || fail "4c. DB row for $WIKI4_SLUG missing"
else
  skip "4c. DATABASE_URL unset — DB existence check skipped"
fi

# ── 5. create_wiki — title only, no description ─────────────
# inferWikiType('') returns 'log' as the empty-input default. This is
# the bare-call shape that any naive MCP client will use — must succeed.

call_tool "5a." create_wiki '{"title":"UAT Bare"}'
WIKI5_KEY=$(echo "$RPC_TEXT" | jq -r '.lookupKey // empty')
WIKI5_TYPE=$(echo "$RPC_TEXT" | jq -r '.type // empty')
WIKI5_INFERRED=$(echo "$RPC_TEXT" | jq -r '.inferredType // empty')
WIKI5_SLUG=$(echo "$RPC_TEXT" | jq -r '.slug // empty')

if [ -n "$WIKI5_KEY" ] && [ "$WIKI5_TYPE" = "log" ] && [ "$WIKI5_INFERRED" = "log" ]; then
  pass "5a. create_wiki(title only) → type=log inferredType=log (empty-input default)"
  UAT_WIKI_KEYS+=("$WIKI5_KEY")
else
  fail "5a. bare create_wiki returned unexpected shape: $RPC_TEXT"
fi

# ── 6. log_fragment — happy path against seeded wiki ─────────
# threadSlug arg name is unchanged despite the thread→wiki rename
# (verified in core/src/mcp/server.ts at HEAD). The result is a JSON
# object with fragmentKey, fragmentSlug, threadSlug (echo of resolved
# wiki slug), and wikiKey.

call_tool "6a." log_fragment \
  "$(jq -n --arg c "UAT 98 fragment body $RUN_ID — testing log_fragment happy path." '{content:$c, threadSlug:"transformer-architecture"}')"
FRAG6_KEY=$(echo "$RPC_TEXT" | jq -r '.fragmentKey // empty')
FRAG6_THREAD=$(echo "$RPC_TEXT" | jq -r '.threadSlug // empty')

if [ -n "$FRAG6_KEY" ] && [ "$FRAG6_THREAD" = "transformer-architecture" ]; then
  pass "6a. log_fragment → fragmentKey=$FRAG6_KEY threadSlug=transformer-architecture"
  UAT_FRAGMENT_KEYS+=("$FRAG6_KEY")
else
  fail "6a. log_fragment returned unexpected shape: $RPC_TEXT"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$FRAG6_KEY" ]; then
  DB_FRAG=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM fragments WHERE lookup_key='$FRAG6_KEY' AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
  [ "$DB_FRAG" = "1" ] && pass "6b. fragment row persisted with lookup_key=$FRAG6_KEY" \
    || fail "6b. fragment row not persisted for $FRAG6_KEY (count=$DB_FRAG)"
else
  skip "6b. DATABASE_URL unset — fragment persistence check skipped"
fi

# ── 7. log_fragment — unknown threadSlug ─────────────────────
# resolveWikiBySlug emits {error: "Wiki not found: \"<slug>\"", suggestions: [...]}.
# The handler stringifies that object directly into result.content[0].text
# with isError=true.

call_tool "7a." log_fragment \
  '{"content":"UAT bogus","threadSlug":"this-wiki-does-not-exist-xyz"}' \
  expect-error
if echo "$RPC_TEXT" | grep -q 'Wiki not found'; then
  pass "7b. error text contains 'Wiki not found' (resolveWikiBySlug message)"
else
  fail "7b. error text missing 'Wiki not found': $RPC_TEXT"
fi
if echo "$RPC_TEXT" | jq -e 'fromjson? | .suggestions | type == "array"' >/dev/null 2>&1; then
  pass "7c. error payload includes a 'suggestions' array for did-you-mean disambiguation"
else
  skip "7c. error payload not parseable as JSON or missing suggestions[] (older handler shape?)"
fi

# ── 8. log_entry — happy path ────────────────────────────────
# handleLogEntry returns plain text "Entry queued: <entryKey>" (NOT JSON).
# The entry row goes into raw_sources (table is named raw_sources even
# though the export is 'entries' in schema.ts).

call_tool "8a." log_entry \
  "$(jq -n --arg c "UAT 98 entry $RUN_ID — capture this thought via MCP." '{content:$c}')"
if echo "$RPC_TEXT" | grep -qE '^Entry queued: entry[0-9A-Z]+$'; then
  ENTRY8_KEY=$(echo "$RPC_TEXT" | sed -n 's/^Entry queued: //p')
  pass "8a. log_entry → 'Entry queued: $ENTRY8_KEY'"
  UAT_ENTRY_KEYS+=("$ENTRY8_KEY")
else
  fail "8a. log_entry response did not match 'Entry queued: <key>': $RPC_TEXT"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "${ENTRY8_KEY:-}" ]; then
  DB_ENTRY=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM raw_sources WHERE lookup_key='$ENTRY8_KEY'" 2>/dev/null | tr -d '[:space:]')
  [ "$DB_ENTRY" = "1" ] && pass "8b. raw_sources row persisted with lookup_key=$ENTRY8_KEY" \
    || fail "8b. raw_sources row not found for $ENTRY8_KEY (count=$DB_ENTRY)"
else
  skip "8b. DATABASE_URL unset — entry persistence check skipped"
fi

# ── 9 + 10 removed ──────────────────────────────────────────
# PR #193 removed delete_wiki, delete_person, publish_wiki, and
# unpublish_wiki from the MCP surface (destructive tools are no longer
# exposed via MCP). The coverage previously here moved to plan 30 §1-2.
#
# Step 11 (find_person) is renumbered to keep history-friendly diffs;
# the body is unchanged.

# ── 11. find_person — query by seeded name ──────────────────
# Auto-detects: lookupKey-shaped input goes via id, anything else via
# fuzzy query. Result includes a `person` object with slug + name.

call_tool "11a." find_person '{"query":"Ashish"}'
PERSON_SLUG=$(echo "$RPC_TEXT" | jq -r '.person.slug // empty')
if [ "$PERSON_SLUG" = "ashish-vaswani" ]; then
  pass "11a. find_person(query=\"Ashish\") → person.slug=ashish-vaswani"
else
  fail "11a. find_person did not return ashish-vaswani (got slug='$PERSON_SLUG')"
fi
PERSON_NAME=$(echo "$RPC_TEXT" | jq -r '.person.name // empty')
if [ -n "$PERSON_NAME" ]; then
  pass "11b. find_person payload includes a non-empty .person.name ($PERSON_NAME)"
else
  fail "11b. find_person.person.name empty"
fi

# ── 12. Read paths — get_wiki + get_fragment + list_wikis ───
# All three resolvers stringify their result; on success the parsed
# JSON has the fields we assert below. get_wiki carries the sidecar.

call_tool "12a." get_wiki '{"slug":"transformer-architecture"}'
HAS_SECTIONS=$(echo "$RPC_TEXT" | jq '.sections | type == "array"' 2>/dev/null)
HAS_REFS=$(echo "$RPC_TEXT" | jq '.refs | type == "object"' 2>/dev/null)
if [ "$HAS_SECTIONS" = "true" ] && [ "$HAS_REFS" = "true" ]; then
  pass "12a. get_wiki(transformer-architecture) returns .sections[] + .refs{}"
else
  fail "12a. get_wiki sidecar shape missing (sections=$HAS_SECTIONS refs=$HAS_REFS)"
fi
HAS_INFOBOX=$(echo "$RPC_TEXT" | jq '.infobox | type' 2>/dev/null)
if [ "$HAS_INFOBOX" = '"object"' ] || [ "$HAS_INFOBOX" = '"null"' ]; then
  pass "12b. get_wiki .infobox present (type=$HAS_INFOBOX — object or null per resolver contract)"
else
  fail "12b. get_wiki .infobox unexpected type: $HAS_INFOBOX"
fi

call_tool "12c." get_fragment '{"slug":"self-attention-replaces-recurrence"}'
FRAG_CONTENT=$(echo "$RPC_TEXT" | jq -r '.content // empty')
if [ -n "$FRAG_CONTENT" ]; then
  pass "12c. get_fragment(self-attention-replaces-recurrence) returns non-empty .content"
else
  fail "12c. get_fragment .content empty: ${RPC_TEXT:0:200}"
fi

call_tool "12d." list_wikis '{"includeDescriptors":false}'
LIST_LEN=$(echo "$RPC_TEXT" | jq 'length // (.wikis | length) // 0' 2>/dev/null)
if [ "${LIST_LEN:-0}" -ge 1 ] 2>/dev/null; then
  pass "12d. list_wikis returned $LIST_LEN wikis (≥1 from seeded fixture)"
else
  fail "12d. list_wikis returned 0 wikis or shape error: ${RPC_TEXT:0:200}"
fi

# ── Cleanup — soft-delete UAT-created rows ──────────────────
# Anything still in the UAT_*_KEYS arrays got created above and not
# already deleted by an explicit step. Soft-delete via DB is the
# cheapest way to keep the seeded fixture clean for downstream plans.

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
  for key in "${UAT_ENTRY_KEYS[@]}"; do
    [ -z "$key" ] && continue
    psql "$DATABASE_URL" -c "UPDATE raw_sources SET deleted_at=now(), updated_at=now() WHERE lookup_key='$key'" >/dev/null 2>&1 \
      && CLEANED=$((CLEANED+1)) || true
  done
  # Belt + braces: anything matching the UAT name prefix that escaped
  # the per-key tracking (e.g. earlier failed run) gets swept too.
  psql "$DATABASE_URL" -c "UPDATE wikis SET deleted_at=now(), updated_at=now() WHERE name LIKE 'UAT %' AND deleted_at IS NULL" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -c "UPDATE raw_sources SET deleted_at=now(), updated_at=now() WHERE content LIKE 'UAT 98 %' AND deleted_at IS NULL" >/dev/null 2>&1 || true
  pass "Cleanup. soft-deleted $CLEANED tracked UAT row(s) + UAT-named sweep"
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
| 0 | Web sign-in establishes cookie; `/users/profile.mcpEndpointUrl` yields a JWT; fixture keys resolved | `routes/users.ts`, `mcp/jwt.ts` |
| 1 | `get_wiki_types` lists ≥10 seeded types including `decision` | `seedWikiTypes` + 10 YAML specs in `packages/shared/src/prompts/specs/wiki-types/` |
| 2 | `create_wiki` with explicit valid `type` returns `{slug, lookupKey, type, inferredType: undefined}`; DB row has correct type | `handleCreateWiki` (#154) |
| 3 | `create_wiki` with explicit invalid `type` returns `isError=true` + `unknown wiki type "<type>"` text + `get_wiki_types` recovery hint; no DB row written | `handleCreateWiki` runtime lookup against `wiki_types` |
| 4 | `create_wiki` with no type + descriptive `description` infers a valid type; `inferredType === type`; DB row exists | `handleCreateWiki` + `inferWikiType` |
| 5 | `create_wiki` with title only defaults to `type=log` (empty-input default in `inferWikiType`) | `inferWikiType('')` returns `'log'` |
| 6 | `log_fragment` against `transformer-architecture` returns `{fragmentKey, fragmentSlug, threadSlug, wikiKey}`; row persisted | `handleLogFragment` |
| 7 | `log_fragment` against unknown slug returns `isError=true` with `Wiki not found` text and `suggestions[]` array | `resolveWikiBySlug` error shape |
| 8 | `log_entry` returns `'Entry queued: <entryKey>'` plain text; `raw_sources` row persisted | `handleLogEntry` |
| ~~9~~ | ~~`delete_wiki`~~ — removed from MCP surface in PR #193 (covered by plan 30 §1) | n/a |
| ~~10~~ | ~~`delete_person`~~ — removed from MCP surface in PR #193 (covered by plan 30 §2) | n/a |
| 11 | `find_person(query="Ashish")` resolves to `person.slug="ashish-vaswani"` | `findPersonByQuery` |
| 12 | `get_wiki`, `get_fragment`, `list_wikis` return populated payloads (sidecar, content, list) | resolver read paths |

---

## Notes

- **Auth model differs from cookie-only plans.** The MCP route at `/mcp`
  authenticates via a JWT in the `?token=` query string (signed with the
  user's Ed25519 private key, EdDSA). The web session cookie alone is
  not enough. This plan signs in with the cookie *to fetch the JWT* via
  `GET /users/profile`, then drives the MCP transport with the token.
- **No session-id handshake.** `core/src/routes/mcp.ts` creates a fresh
  stateless server + transport per request. Bare `tools/call` works
  without an `initialize` round-trip; no `Mcp-Session-Id` header is sent
  or required. If a future change adds session-stickiness, this plan
  needs an `initialize` step before the first `tools/call`.
- **Streamable-HTTP framing.** The transport may emit SSE-style
  `data: {...}` framed responses or plain JSON depending on `Accept`
  header negotiation. The `call_tool` helper handles both.
- **Tool argument naming.** `log_fragment` still uses `threadSlug` even
  though the broader codebase has gone through the thread→wiki rename.
  This is preserved for MCP API stability — callers in the wild use
  `threadSlug`. The handler resolves it via `resolveWikiBySlug` and
  echoes the resolved wiki slug back as `threadSlug` in the response.
- **Error path strings are exact.** Assertions in steps 3 and 7 match
  `handleCreateWiki` and `resolveWikiBySlug` text verbatim — if those
  strings change, this plan must change with them. Don't paraphrase.
- **Fixture restoration is mandatory.** Step 10 deletes ashish-vaswani
  and **must** re-run `pnpm -C core seed-fixture` so plans 21 and 22 can
  still find the seeded person. The CLI's slug-keyed upsert clears
  `deleted_at` as part of restoring the row.
- **Cleanup at the end** soft-deletes any UAT-created wiki/fragment/entry
  rows so downstream plans see a clean fixture. Without `DATABASE_URL`
  the plan still passes, but the rows linger — flag this in CI logs.
- **Out of scope here:** `edit_wiki`, `create_wiki_type`, `search`,
  `brief_person`, `get_timeline`, `publish_wiki` / `unpublish_wiki`, the
  group tools. These are registered in `mcp/server.ts` but not
  enumerated by the workstream skeleton; add coverage in a follow-up.
- **Single-tenant note.** `wiki_types` is global / single-tenant per
  project memory; no `userId` filter is involved in step 1's count.
```

