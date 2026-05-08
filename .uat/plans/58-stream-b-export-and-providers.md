# 58 — Stream B finish: data export zip + read-only providers settings

## What it proves

PR `feat/b-export-and-providers` ships two Stream B v0.2.0 features:

1. **B3 (data export zip)**: `POST /users/export?format=zip` returns a multipart zip archive containing `manifest.json`, per-wiki markdown files, per-entry markdown files, `fragments.json`, `people.json`, and `graph.json`. The legacy JSON-only path (`?format=json` or no param) still returns the original payload shape. Graph excludes soft-deleted edges. Embeddings stripped from `fragments.json` and `people.json` to keep zip size sane.
2. **B4 (read-only providers settings)**: `/settings/providers` UI surfaces the configured OpenRouter models and last-N-chars hints of the API key (no full keys ever returned). Backend `GET /users/providers` is the data source. Page is informational, no mutations.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- Wiki dev/prod on `WIKI_URL` (default `http://localhost:8080`)
- Authenticated session: `INITIAL_USERNAME` / `INITIAL_PASSWORD`
- `pnpm -C core seed-fixture` so a Transformer wiki and some entries exist
- `unzip` and `jq` on PATH for archive inspection
- Optional: `OPENROUTER_API_KEY` set so providers page has signal

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth (existing)
- `POST /users/export?format=zip`: streams `application/zip` with `Content-Disposition: attachment; filename="robin-export.zip"`
- `POST /users/export` or `?format=json`: existing JSON shape, unchanged
- `GET  /users/providers`: read-only listing, returns `{ providers: [{ kind: 'openrouter', model: string, apiKeyHint: string, ... }] }`

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"

JAR=$(mktemp /tmp/uat-58-jar-XXXXXX.txt)
ZIP=$(mktemp /tmp/uat-58-export-XXXXXX.zip)
DIR=$(mktemp -d /tmp/uat-58-unzip-XXXXXX)
trap 'rm -rf "$JAR" "$ZIP" "$DIR" /tmp/uat-58-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "58 — Stream B finish: export zip + providers settings"
echo ""

# 1. Sign in
HTTP=$(curl -s -o /tmp/uat-58-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$HTTP" = "200" ]; then pass "sign in 200"; else fail "sign in got $HTTP"; fi

# 2. B3 — export zip downloads as application/zip
HEADERS=$(curl -s -D - -o "$ZIP" -b "$JAR" -X POST \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  "$SERVER_URL/users/export?format=zip" | tr -d '\r')
HTTP=$(echo "$HEADERS" | head -1 | awk '{print $2}')
if [ "$HTTP" = "200" ]; then pass "export?format=zip 200"; else fail "export got $HTTP"; fi

CT=$(echo "$HEADERS" | grep -i '^content-type:' | head -1 | awk '{print $2}')
if [[ "$CT" == application/zip* ]]; then pass "Content-Type application/zip"; else fail "Content-Type was $CT"; fi

CD=$(echo "$HEADERS" | grep -i '^content-disposition:' | head -1)
if echo "$CD" | grep -qi 'filename="robin-export.zip"'; then pass "Content-Disposition filename"; else fail "missing filename"; fi

# 3. B3 — zip layout is correct
unzip -q "$ZIP" -d "$DIR"
for f in manifest.json fragments.json people.json graph.json; do
  if [ -f "$DIR/$f" ]; then pass "zip contains $f"; else fail "zip missing $f"; fi
done
if [ -d "$DIR/wikis" ]; then pass "zip contains wikis/"; else fail "zip missing wikis/"; fi
if [ -d "$DIR/entries" ]; then pass "zip contains entries/"; else fail "zip missing entries/"; fi

# 4. B3 — manifest counts match payload
MAN_VER=$(jq -r '.version' "$DIR/manifest.json" 2>/dev/null)
if [ "$MAN_VER" = "1" ]; then pass "manifest.version = 1"; else fail "manifest.version was $MAN_VER"; fi

WIKI_FILES=$(ls "$DIR/wikis/" 2>/dev/null | wc -l)
WIKI_COUNT=$(jq '.counts.wikis' "$DIR/manifest.json")
if [ "$WIKI_FILES" = "$WIKI_COUNT" ]; then pass "manifest.counts.wikis matches wikis/ files ($WIKI_COUNT)"; else fail "wiki file count mismatch ($WIKI_FILES vs $WIKI_COUNT)"; fi

# 5. B3 — graph excludes deleted_at
DELETED=$(jq '[.edges[] | select(.deletedAt != null and .deletedAt != "")] | length' "$DIR/graph.json")
if [ "$DELETED" = "0" ]; then pass "graph.json excludes deleted edges"; else fail "graph.json contains $DELETED deleted edges"; fi

# 6. B3 — fragments.json strips embeddings
HAS_EMBEDDING=$(jq '[.fragments[]? | has("embedding")] | any' "$DIR/fragments.json" 2>/dev/null)
if [ "$HAS_EMBEDDING" = "false" ] || [ -z "$HAS_EMBEDDING" ]; then pass "fragments.json strips embeddings"; else fail "fragments.json contains embeddings"; fi

# 7. B3 — wiki markdown has frontmatter
FIRST_WIKI=$(ls "$DIR/wikis/"*.md 2>/dev/null | head -1)
if [ -n "$FIRST_WIKI" ]; then
  FIRST_LINE=$(head -1 "$FIRST_WIKI")
  if [ "$FIRST_LINE" = "---" ]; then pass "wiki .md starts with frontmatter"; else fail "wiki .md missing frontmatter (first line: $FIRST_LINE)"; fi
else
  skip "no wiki markdown files to inspect"
fi

# 8. B3 — JSON fallback still works
HTTP=$(curl -s -o /tmp/uat-58-json.json -w "%{http_code}" -b "$JAR" -X POST -H "Origin: $ORIGIN" "$SERVER_URL/users/export")
if [ "$HTTP" = "200" ]; then pass "export (JSON fallback) 200"; else fail "JSON fallback got $HTTP"; fi
JSON_VALID=$(jq 'type' /tmp/uat-58-json.json 2>/dev/null)
if [ -n "$JSON_VALID" ]; then pass "JSON fallback returns parseable JSON"; else fail "JSON fallback was not valid JSON"; fi

# 9. B4 — providers endpoint
HTTP=$(curl -s -o /tmp/uat-58-prov.json -w "%{http_code}" -b "$JAR" "$SERVER_URL/users/providers")
if [ "$HTTP" = "200" ]; then pass "/users/providers 200"; else fail "/users/providers got $HTTP"; fi

PROV_TYPE=$(jq -r '.providers | type' /tmp/uat-58-prov.json 2>/dev/null)
if [ "$PROV_TYPE" = "array" ]; then pass "providers is an array"; else fail "providers shape unexpected"; fi

# 10. B4 — API key is hinted, never full
FULL_KEY_LEAK=$(jq -r '[.providers[]? | .apiKeyHint // ""] | map(length > 32) | any' /tmp/uat-58-prov.json)
if [ "$FULL_KEY_LEAK" = "false" ]; then pass "no full API keys in /users/providers"; else fail "API key hint suspiciously long, possible full-key leak"; fi

# 11. B4 — anon access rejected
ANON_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/users/providers")
if [ "$ANON_HTTP" = "401" ] || [ "$ANON_HTTP" = "403" ]; then pass "anon GET /users/providers rejected ($ANON_HTTP)"; else fail "anon got $ANON_HTTP, expected 401/403"; fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Cleanup

No persistent state created. Temp files cleaned by trap.

## Expected pass/fail behavior

All steps PASS on a clean local stack. Step 9 to 11 will exercise B4. Step 10 is the security check: any provider entry whose `apiKeyHint` is longer than 32 chars is suspicious.
