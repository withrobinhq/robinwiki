# 64 — Stream I: Control Surface (v0.2.0)

## What it proves

Cluster branch `feat/i-control-surface` ships the Stream I MCP / publish
control-surface v0.2.0 work:

1. **I3** -- new MCP `attach_fragments` tool. Bulk-attaches fragments to
   a target wiki by slug, returns `{ attached, alreadyAttached, notFound }`,
   marks the wiki PENDING for the next regen, emits one audit row per
   attached fragment.
2. **I4** -- publish refactor. `POST /wikis/:id/publish` (HTTP) and the
   reinstated `publish_wiki` MCP tool both flow through
   `core/src/services/publish.ts`. The response carries
   `publishedOrigin` so the UI can build a clickable absolute URL.
   `unpublish_wiki` symmetrically rotates the slug.
3. **I5+I6** -- `skill_pack_aliases` table exists (migration 0010).
   The MCP server's alias resolver registers each row as a virtual
   tool at tool-list time, so `/short-capture` surfaces under that
   name in the client while the canonical `log_entry` keeps working.
4. **I7** -- alias install/remove API (`installPack`, `removePack`,
   `listPackAliases`) so a freshly-registered alias surfaces in the
   next MCP tool list.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`
- `DATABASE_URL` reachable for direct row inspection (alias verification)
- Migration `0010_skill_pack_aliases` and `0004_wikis_published_origin`
  applied (`pnpm -C core db:migrate` or via the boot path)
- A wiki + at least one fragment seeded (`pnpm -C core seed-fixture`)
- A valid MCP JWT (`MCP_TOKEN`) for the test user. Generate via the
  /settings page or `core/scripts/mint-mcp-token.ts` if available.

## Endpoint map

- `POST /api/wikis/:id/publish`        — HTTP publish, includes `publishedOrigin` in response
- `POST /api/wikis/:id/unpublish`       — HTTP unpublish
- `POST /mcp/?token=$MCP_TOKEN`         — MCP JSON-RPC. Tools used:
  - `tools/list`            — assert canonical + alias names visible
  - `tools/call attach_fragments`
  - `tools/call publish_wiki`
  - `tools/call unpublish_wiki`

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"
DB_URL="${DATABASE_URL:-postgresql://robin:@localhost:5432/robin_dev}"
JAR=$(mktemp /tmp/uat-64-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-64-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  + $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ! $1"; }
skip() { SKIP=$((SKIP+1)); echo "  - $1"; }

echo "64 — Stream I: control surface"
echo ""

# 1. Sign in (HTTP cookie session for HTTP assertions)
curl -s -o /tmp/uat-64-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" > /tmp/uat-64-signin.code
if [ "$(cat /tmp/uat-64-signin.code)" = "200" ]; then pass "sign in"; else fail "sign in code $(cat /tmp/uat-64-signin.code)"; fi

# 2. Mint an MCP token (requires the user signed in via #1 above).
curl -s -o /tmp/uat-64-token.json -w "%{http_code}" -b "$JAR" \
  -X POST -H "Origin: $ORIGIN" \
  "$SERVER_URL/api/users/mcp-token" > /tmp/uat-64-token.code || true
MCP_TOKEN_VALUE=$(jq -r '.token // empty' /tmp/uat-64-token.json 2>/dev/null)
MCP_TOKEN="${MCP_TOKEN:-$MCP_TOKEN_VALUE}"
if [ -n "$MCP_TOKEN" ]; then pass "have MCP token"; else fail "no MCP token (set MCP_TOKEN env or fix mint endpoint)"; fi

# 3. List tools — alias canonicals must include the new ones.
TOOLS_LIST=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$SERVER_URL/mcp/?token=$MCP_TOKEN" | tr -d '\r')
echo "$TOOLS_LIST" > /tmp/uat-64-tools.json

for tool in attach_fragments publish_wiki unpublish_wiki log_entry log_fragment; do
  if echo "$TOOLS_LIST" | jq -e --arg n "$tool" '.result.tools[] | select(.name==$n)' >/dev/null 2>&1; then
    pass "MCP exposes $tool"
  else
    fail "MCP missing $tool"
  fi
done

# 4. I3 — attach_fragments happy path.
# Pick a wiki + a fragment slug from the API.
WIKI_SLUG=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].slug // empty')
FRAG_SLUG=$(curl -s -b "$JAR" "$SERVER_URL/fragments?limit=1" | jq -r '.fragments[0].slug // empty')
if [ -n "$WIKI_SLUG" ] && [ -n "$FRAG_SLUG" ]; then
  ATTACH_REQ=$(jq -nc --arg w "$WIKI_SLUG" --arg f "$FRAG_SLUG" '{
    jsonrpc:"2.0", id:2, method:"tools/call",
    params:{name:"attach_fragments", arguments:{wikiSlug:$w, fragmentSlugs:[$f]}}
  }')
  ATTACH_RES=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "$ATTACH_REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN")
  echo "$ATTACH_RES" > /tmp/uat-64-attach.json
  ATTACH_PAYLOAD=$(echo "$ATTACH_RES" | jq -r '.result.content[0].text // empty' | jq -c .)
  ATT_LEN=$(echo "$ATTACH_PAYLOAD" | jq -r '(.attached + .alreadyAttached) | length')
  if [ "$ATT_LEN" -ge 1 ]; then pass "attach_fragments returns attached or alreadyAttached"; else fail "attach_fragments empty result"; fi
else
  skip "attach_fragments: no wiki/fragment seeded"
fi

# 5. I4 — publish via HTTP, response carries publishedOrigin
WIKI_ID=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].id // empty')
if [ -n "$WIKI_ID" ]; then
  PUB_HTTP=$(curl -s -o /tmp/uat-64-pub.json -w "%{http_code}" \
    -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
    "$SERVER_URL/wikis/$WIKI_ID/publish")
  if [ "$PUB_HTTP" = "200" ]; then pass "HTTP publish 200"; else fail "HTTP publish $PUB_HTTP"; fi
  HAS_ORIGIN=$(jq 'has("publishedOrigin")' /tmp/uat-64-pub.json)
  ORIGIN_NONNULL=$(jq -r '.publishedOrigin // empty' /tmp/uat-64-pub.json)
  if [ "$HAS_ORIGIN" = "true" ]; then pass "publish response carries publishedOrigin"; else fail "publish response missing publishedOrigin"; fi
  if [ -n "$ORIGIN_NONNULL" ]; then pass "publishedOrigin non-null after HTTP publish ($ORIGIN_NONNULL)"; else skip "publishedOrigin null (request had no recoverable origin)"; fi

  # 6. I4 — publish via MCP idempotently re-uses the slug.
  PUB_REQ=$(jq -nc --arg w "$WIKI_SLUG" '{jsonrpc:"2.0", id:3, method:"tools/call",
    params:{name:"publish_wiki", arguments:{wikiSlug:$w}}}')
  MCP_PUB_RES=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "$PUB_REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN")
  MCP_PAYLOAD=$(echo "$MCP_PUB_RES" | jq -r '.result.content[0].text // empty' | jq -c .)
  if echo "$MCP_PAYLOAD" | jq -e '.published == true' >/dev/null; then pass "MCP publish_wiki sets published=true"; else fail "MCP publish_wiki failed"; fi

  # 7. I4 — unpublish nulls slug
  UNP_REQ=$(jq -nc --arg w "$WIKI_SLUG" '{jsonrpc:"2.0", id:4, method:"tools/call",
    params:{name:"unpublish_wiki", arguments:{wikiSlug:$w}}}')
  MCP_UNP_RES=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "$UNP_REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN")
  MCP_UNP_PAYLOAD=$(echo "$MCP_UNP_RES" | jq -r '.result.content[0].text // empty' | jq -c .)
  if echo "$MCP_UNP_PAYLOAD" | jq -e '.published == false' >/dev/null; then pass "MCP unpublish_wiki sets published=false"; else fail "MCP unpublish_wiki failed"; fi
else
  skip "publish: no wiki seeded"
fi

# 8. I5+6 — alias registry table exists with expected shape.
ALIAS_COUNT=$(psql -q "$DB_URL" -At -c "SELECT count(*) FROM skill_pack_aliases;" 2>/dev/null || echo "")
if [ -n "$ALIAS_COUNT" ]; then pass "skill_pack_aliases table reachable (count=$ALIAS_COUNT)"; else fail "skill_pack_aliases table missing"; fi

# 9. I7 — programmatic install via direct INSERT (Stream C will call
#    services/skill-pack-aliases.installPack()), then re-list tools to
#    confirm the alias surfaces.
PACK_NAME="uat64-test-pack"
ALIAS_NAME="uat64-test-alias"
psql -q "$DB_URL" -c "DELETE FROM skill_pack_aliases WHERE pack='$PACK_NAME';" >/dev/null 2>&1 || true
psql -q "$DB_URL" -c "INSERT INTO skill_pack_aliases (id, pack, alias_name, mcp_tool_name, args_template) VALUES ('uat64row', '$PACK_NAME', '$ALIAS_NAME', 'log_entry', '{\"source\":\"mcp\"}'::jsonb);" >/dev/null 2>&1
if [ "$?" = "0" ]; then pass "alias row inserted via DB"; else fail "alias row insert failed"; fi

# Re-list tools -- alias must surface on a fresh MCP session because
# attachAliases runs per-request.
TOOLS_LIST_2=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/list"}' \
  "$SERVER_URL/mcp/?token=$MCP_TOKEN")
if echo "$TOOLS_LIST_2" | jq -e --arg n "$ALIAS_NAME" '.result.tools[] | select(.name==$n)' >/dev/null 2>&1; then
  pass "alias surfaces in MCP tool list after install"
else
  fail "alias did not appear in tool list"
fi

# 10. I7 — calling the alias forwards to log_entry with merged args.
ALIAS_REQ=$(jq -nc --arg n "$ALIAS_NAME" '{jsonrpc:"2.0", id:6, method:"tools/call",
  params:{name:$n, arguments:{content:"uat64 alias call test"}}}')
ALIAS_RES=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "$ALIAS_REQ" "$SERVER_URL/mcp/?token=$MCP_TOKEN")
if echo "$ALIAS_RES" | jq -e '.result.content[0].text | contains("Entry queued")' >/dev/null 2>&1; then
  pass "alias call lands in log_entry"
else
  fail "alias call did not land (check args merge)"
fi

# Cleanup
psql -q "$DB_URL" -c "DELETE FROM skill_pack_aliases WHERE pack='$PACK_NAME';" >/dev/null 2>&1 || true

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Cleanup

The script removes the test alias row at the end. The publish/unpublish
cycle leaves the seed wiki in unpublished state; manual cleanup if
desired:

```bash
psql "$DATABASE_URL" -c "UPDATE wikis SET published=false, published_slug=null, published_origin=null WHERE id IN (SELECT lookup_key FROM wikis ORDER BY updated_at DESC LIMIT 1);"
```

## Expected pass/fail behavior

All steps PASS on a clean local stack with both migrations applied and a
fresh `seed-fixture`. Step 4 (`attach_fragments`) skips if no fragments
exist; step 5 (publishedOrigin) skips when the request URL doesn't have
a recoverable origin and `SERVER_PUBLIC_URL` is unset. Steps 9 + 10 are
the I7 alias-roundtrip proof points.
