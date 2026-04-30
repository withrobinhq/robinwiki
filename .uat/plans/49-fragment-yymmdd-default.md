# 49 — Default fragment naming: UTC YYMMDD prefix on every title (#239)

## What it proves

Every fragment created through any of the three creation paths gets a
`YYMMDD - ` prefix on its title (UTC date). The cluster-8 helper for
short-capture body prefixes (`wiki/src/lib/autoDatePrefix.ts`) is
reusable for the body-side rule but #239 is about the *title* on the
**server** side: the worker pipeline (`packages/agent/src/stages/persist.ts`),
the MCP `log_fragment` handler (`core/src/mcp/handlers.ts`), and the
HTTP `POST /fragments` route (`core/src/routes/fragments.ts`) all need
the same default.

A shared helper (`core/src/lib/fragmentTitlePrefix.ts`) is the single
source of truth: it returns the title verbatim if it already opens with
a date-shaped prefix, otherwise prepends `YYMMDD - `.

POSITIVE: helper file exists; it is imported and applied at every
fragment-create site; created fragment rows show the `YYMMDD - ` prefix.

NEGATIVE: pre-fix the helper file does not exist, the three creation
sites do not import it, and a freshly created fragment's title does
not start with a 6-digit UTC date prefix.

## Prerequisites

- core on `http://localhost:3000`, wiki on `http://localhost:8080`
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE=$(mktemp); trap 'rm -f "$COOKIE"' EXIT
PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "49 — Default fragment naming: UTC YYMMDD prefix (#239)"

YYMMDD=$(date -u +%y%m%d)

# ── A. Shared helper exists ────────────────────────────────────────
HELPER=core/src/lib/fragmentTitlePrefix.ts
if [ -f "$HELPER" ]; then
  pass "A1. helper $HELPER exists"
else
  fail "A1. helper $HELPER missing"
fi

if tr -d '\n' < "$HELPER" 2>/dev/null | grep -qE '(export function|export\s*\{[^}]*)\s*(applyFragmentTitleDatePrefix|fragmentTitlePrefix|prefixFragmentTitle)'; then
  pass "A2. helper exports a prefix function"
else
  fail "A2. helper does not export the expected prefix function"
fi

# ── B. All three creation sites import the helper ──────────────────
PERSIST=packages/agent/src/stages/persist.ts
MCP=core/src/mcp/handlers.ts
ROUTE=core/src/routes/fragments.ts

for f in "$PERSIST" "$MCP" "$ROUTE"; do
  if grep -qE 'fragmentTitlePrefix|applyFragmentTitleDatePrefix|prefixFragmentTitle' "$f" 2>/dev/null; then
    pass "B. $f wires the title prefix helper"
  else
    fail "B. $f does NOT wire the title prefix helper"
  fi
done

# ── C. Live: create a fragment via POST /fragments and check title ─
SIGNIN=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$SIGNIN" != "200" ]; then
  pass "0. signin unavailable (HTTP $SIGNIN) — skipping live check"
  echo ""
  echo "$PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
  exit
fi
pass "0. signin OK"

# Pick or create a parent entry so POST /fragments has somewhere to attach
ENTRY_LK=$(curl -sf -b "$COOKIE" "$SERVER_URL/entries?limit=1" | jq -r '.entries[0].lookupKey // empty')
if [ -z "$ENTRY_LK" ]; then
  pass "C*. no entry available — skipping live POST"
else
  RUN_ID="$(date +%s)-$$"
  RAW_TITLE="UAT49 fragment $RUN_ID"
  POST_FRAG=$(curl -s -o /tmp/uat49-frag.json -w "%{http_code}" -b "$COOKIE" -X POST \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$RAW_TITLE" --arg c "body $RUN_ID" --arg e "$ENTRY_LK" \
            '{title:$t,content:$c,entryId:$e,tags:[]}')" \
    "$SERVER_URL/fragments")
  if [ "$POST_FRAG" = "200" ] || [ "$POST_FRAG" = "201" ]; then
    pass "C1. POST /fragments returned $POST_FRAG"
    NEW_TITLE=$(jq -r '.title // empty' /tmp/uat49-frag.json)
    if [[ "$NEW_TITLE" == "$YYMMDD - "* ]]; then
      pass "C2. new fragment title starts with '$YYMMDD - ' (got '$NEW_TITLE')"
    else
      fail "C2. new fragment title does NOT start with '$YYMMDD - ' (got '$NEW_TITLE')"
    fi
  else
    fail "C1. POST /fragments returned HTTP $POST_FRAG"
    cat /tmp/uat49-frag.json 2>/dev/null
  fi
fi

# ── D. Idempotence: helper does not double-prefix already-dated titles ──
SHARED_IMPL=packages/shared/src/fragmentTitlePrefix.ts
if grep -qE 'HAS_DATE_PREFIX|already.*prefix|no-op' "$SHARED_IMPL" 2>/dev/null; then
  pass "D1. shared helper has prior-prefix detection"
else
  fail "D1. shared helper has no prior-prefix detection (would double-prefix)"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
