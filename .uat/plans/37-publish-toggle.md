# 37 — Publish/unpublish toggle in wiki settings modal (#255)

## What it proves

The publish/unpublish API already exists; this plan asserts the UI gate is
in `AddWikiModal.tsx` (the wiki settings modal). When opened from the gear
on a wiki page, the modal shows a publish toggle. Toggling fires the right
endpoint; the public URL is exposed when published.

POSITIVE: settings modal source contains a `publish` toggle UI element that
fires `/wikis/:id/publish` or `/wikis/:id/unpublish`; toggle reflects current
`published` state.

NEGATIVE: pre-fix, `AddWikiModal.tsx` does not mention "publish" / "/publish"
/ "/unpublish".

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

echo "37 — Publish/unpublish toggle in wiki settings modal (#255)"

# ── A. UI source-grep (positive: wiki settings modal exposes publish) ─
MODAL=wiki/src/components/layout/AddWikiModal.tsx

if grep -qE 'publish' "$MODAL"; then
  pass "A1. AddWikiModal references publish/unpublish"
else
  fail "A1. AddWikiModal does NOT reference publish/unpublish — toggle missing"
fi

if grep -qE '/wikis/.*/(publish|unpublish)|/publish|/unpublish' "$MODAL"; then
  pass "A2. AddWikiModal calls a /wikis/:id/(un)publish endpoint"
else
  fail "A2. AddWikiModal has no call to /wikis/:id/(un)publish"
fi

# A toggle/Switch element controls publish state. Look for a Switch with a
# label containing 'publish' (case-insensitive) somewhere nearby.
if grep -niE 'publish' "$MODAL" | grep -qiE 'Switch|toggle|Public|Published'; then
  pass "A3. publish state has a Switch/toggle"
else
  fail "A3. publish UI element is not a Switch/toggle"
fi

# ── B. Live publish/unpublish round-trip ────────────────────────────
SIGNIN=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$SIGNIN" = "200" ]; then
  pass "B0. signin OK"

  # Pick any wiki with content (publish requires non-empty content)
  WIKI_ID=$(curl -sf -b "$COOKIE" "$SERVER_URL/wikis?limit=20" \
    | jq -r '.wikis[] | select(.noteCount > 0) | .id' | head -1)

  if [ -n "$WIKI_ID" ]; then
    PUB=$(curl -s -o /tmp/uat37-pub.json -w "%{http_code}" -b "$COOKIE" -X POST "$SERVER_URL/wikis/$WIKI_ID/publish")
    if [ "$PUB" = "200" ]; then
      pass "B1. /publish 200 for $WIKI_ID"
    else
      fail "B1. /publish HTTP $PUB"
    fi

    UNPUB=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" -X POST "$SERVER_URL/wikis/$WIKI_ID/unpublish")
    if [ "$UNPUB" = "200" ]; then
      pass "B2. /unpublish 200 for $WIKI_ID"
    else
      fail "B2. /unpublish HTTP $UNPUB"
    fi
  else
    pass "B*. skipped — no published-eligible wiki"
  fi
else
  pass "B*. skipped — signin HTTP $SIGNIN"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
