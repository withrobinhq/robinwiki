# 51 — MCP `create_wiki` strict: require `description` and `type` (#232)

## What it proves

The MCP `create_wiki` tool used to accept a bare `title`, fill the
`description` with `''`, and infer `type` via `inferWikiType`. #232
makes both `description` and `type` required at the handler level: an
LLM client that calls the tool without them gets a clear error
identifying the missing fields and pointing at `get_wiki_types`.

The `inferWikiType` fallback path is removed from the handler so the
type is always exactly what the caller chose.

POSITIVE: a call missing `description` errors with a message that
names `description`; a call missing `type` errors with a message that
names `type` and points to `get_wiki_types`; a complete call with
both fields succeeds and `inferredType` is `undefined` in the result.

NEGATIVE: pre-fix, `handleCreateWiki` falls through to `inferWikiType`
when `type` is omitted, and the response payload exposes
`inferredType`.

## Prerequisites

- core on `http://localhost:3000`
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "51 — MCP create_wiki strict (#232)"

HANDLERS=core/src/mcp/handlers.ts
SERVER=core/src/mcp/server.ts

# ── A. Source-grep: handler no longer calls inferWikiType ──────────
if grep -qE '\binferWikiType\s*\(' "$HANDLERS" 2>/dev/null; then
  fail "A1. handleCreateWiki still calls inferWikiType (inference not removed)"
else
  pass "A1. handleCreateWiki no longer calls inferWikiType"
fi

# ── B. Handler validates description + type ────────────────────────
# The handler should return an error mentioning both fields when omitted.
if grep -qE "description is required" "$HANDLERS" 2>/dev/null; then
  pass "B1. handler returns 'description is required' for missing description"
else
  fail "B1. handler does not validate description"
fi

if grep -qE "type is required" "$HANDLERS" 2>/dev/null; then
  pass "B2. handler returns 'type is required' for missing type"
else
  fail "B2. handler does not validate type"
fi

# ── C. Tool schema declares description + type as required ─────────
# Find the line range of the create_wiki registerTool block and slice it out.
START_LN=$(grep -n "'create_wiki'" "$SERVER" | head -1 | awk -F: '{print $1}')
if [ -z "$START_LN" ]; then
  fail "C0. could not locate create_wiki registerTool block"
else
  BLOCK=$(awk -v s="$START_LN" 'NR>=s && NR<s+40' "$SERVER")
  # Slice out the inputSchema block specifically: between `inputSchema: {`
  # and the matching `},`. Compress whitespace so multi-line statements are
  # easy to scan.
  ISCHEMA=$(echo "$BLOCK" | awk '
    /inputSchema:[[:space:]]*\{/{flag=1}
    flag{print}
    /^[[:space:]]*\},[[:space:]]*$/{ if(flag){flag=0} }
  ' | tr '\n' ' ' | tr -s ' ')
  if echo "$ISCHEMA" | grep -qE 'description:[[:space:]]*z[^,}]*\.optional\(\)'; then
    fail "C1. create_wiki tool schema still marks description as optional"
  else
    pass "C1. create_wiki tool schema does not mark description as optional"
  fi
  if echo "$ISCHEMA" | grep -qE '(^|[^a-zA-Z_])type:[[:space:]]*z[^,}]*\.optional\(\)'; then
    fail "C2. create_wiki tool schema still marks type as optional"
  else
    pass "C2. create_wiki tool schema does not mark type as optional"
  fi
fi

# ── D. Vitest: handleCreateWiki rejects missing description/type ───
TEST_OUT=/tmp/uat51-vitest.txt
VITEST=core/node_modules/.bin/vitest
if [ ! -x "$VITEST" ]; then VITEST=$(command -v vitest || echo "$VITEST"); fi
if "$VITEST" run core/src/__tests__/mcp-create-wiki.test.ts > "$TEST_OUT" 2>&1; then
  pass "D1. mcp-create-wiki vitest suite passes"
else
  fail "D1. mcp-create-wiki vitest suite fails:"
  tail -40 "$TEST_OUT"
fi

# ── E. Type sanity ─────────────────────────────────────────────────
TSC_OUT=/tmp/uat51-tsc.txt
if npx --yes tsc --noEmit -p core/tsconfig.json > "$TSC_OUT" 2>&1; then
  pass "E1. core tsc clean"
else
  fail "E1. core tsc errors:"
  head -40 "$TSC_OUT"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
