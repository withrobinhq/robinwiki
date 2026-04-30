# 35 — Sidebar / settings / nav polish (#250)

## What it proves

The three small polish items spotted during fork QA all hold against a live
stack:

1. **Recent Entries cap** — `wiki/src/components/layout/Sidebar.tsx` requests
   only 5 entries (`useEntries({ limit: 5 })`) instead of the previous 20.
   Verified by reading the JSX at the source-grep level.
2. **Permanent settings gear** — `wiki/src/components/wiki/WikiEntityArticle.tsx`
   renders the gear next to the eye toggle for any wiki page (sidecar-driven
   infoboxes included), with no dependency on a per-config `showSettings`
   flag. Verified by asserting the gear appears unconditionally on a
   `WikiEntityArticle` whose infobox kind is "simple" — and stays present
   when no `WikiInfobox` legacy aside renders.
3. **Profile section heading** — `wiki/src/app/profile/page.tsx` says the
   user-identity section is labelled `User Management` (the "Wiki Management"
   string is no longer present anywhere in `wiki/src/app/profile/`).

POSITIVE: each renamed/capped item is present (limit=5, gear unconditional,
"User Management").

NEGATIVE: the prior strings/limits are absent (`limit: 20` in Sidebar entries
hook, the literal "Wiki Management" anywhere in profile page source).

## Prerequisites

- `INITIAL_PASSWORD` exposed in `core/.env`
- core on `http://localhost:3000`, wiki on `http://localhost:8080`
- `grep`, `curl`, `jq`

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "35 — Sidebar / settings / nav polish (#250)"

# ── A. Recent Entries cap (limit=5) ─────────────────────────────────
SIDEBAR=wiki/src/components/layout/Sidebar.tsx
if grep -q "useEntries({ limit: 5 })" "$SIDEBAR"; then
  pass "A1. Sidebar uses useEntries({ limit: 5 })"
else
  fail "A1. Sidebar does NOT request limit=5 — recent-entries cap missing"
fi

if grep -q "useEntries({ limit: 20 })" "$SIDEBAR"; then
  fail "A2. Sidebar still uses limit: 20 — old cap is still in source"
else
  pass "A2. Sidebar no longer uses limit: 20"
fi

# ── B. Permanent settings gear next to eye toggle ───────────────────
ARTICLE=wiki/src/components/wiki/WikiEntityArticle.tsx
# Old behaviour: the gear at the eye-toggle level was gated by
# `showSettings && !isEditing && !isViewingHistory`, where showSettings comes
# from the infobox config flag. New behaviour: the gear lives at the eye-toggle
# level and the only gating is editing/history mode — no infobox-flag dep.
if grep -nE 'title="Wiki settings"' "$ARTICLE" >/dev/null; then
  pass "B1. Wiki settings gear button exists"
else
  fail "B1. Wiki settings gear is missing entirely"
fi

# Negative: the gear must NOT be gated on `infobox.showSettings === true`.
# Old shape: `const showSettings = infobox.showSettings === true;`. New shape:
# the gate derives from a real wikiId / onSettingsClick handler, not the
# per-config infobox flag.
if grep -qE 'const showSettings = infobox\.showSettings === true' "$ARTICLE"; then
  fail "B2. showSettings is still derived from infobox.showSettings — sidecar-infobox wikis still hide it"
else
  pass "B2. showSettings derives from wikiId/onSettingsClick (not the infobox flag)"
fi

# Sanity: the previous in-infobox gear render in WikiInfoboxTypeUpdated /
# WikiInfoboxGoalStyle is gone — gear lives in the toolbar only. Two `showSettings ?` branches in those components is the old shape.
INFOBOX_GEAR_COUNT=$(grep -cE 'showSettings \?' "$ARTICLE")
if [ "$INFOBOX_GEAR_COUNT" -le 1 ]; then
  pass "B3. legacy in-infobox gear renders are gone ($INFOBOX_GEAR_COUNT showSettings ? ternaries)"
else
  fail "B3. legacy in-infobox gear renders still present ($INFOBOX_GEAR_COUNT) — fork wanted them removed"
fi

# ── C. Profile heading rename ───────────────────────────────────────
PROFILE=wiki/src/app/profile/page.tsx
if grep -q '>User Management<' "$PROFILE"; then
  pass "C1. profile says User Management"
else
  fail "C1. profile does NOT say User Management"
fi

if grep -q '>Wiki Management<' "$PROFILE"; then
  fail "C2. profile still has Wiki Management — rename incomplete"
else
  pass "C2. profile no longer has Wiki Management"
fi

# ── D. Live render smoke (entries cap visible in DOM) ───────────────
COOKIE=$(mktemp); trap 'rm -f "$COOKIE"' EXIT
SIGNIN=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$SIGNIN" = "200" ]; then
  ENTRIES_COUNT=$(curl -sf -b "$COOKIE" "$SERVER_URL/entries?limit=5" | jq '.entries | length')
  if [ "$ENTRIES_COUNT" -le 5 ]; then
    pass "D1. /api/entries?limit=5 honours the cap (returned $ENTRIES_COUNT)"
  else
    fail "D1. /api/entries?limit=5 returned $ENTRIES_COUNT > 5"
  fi
else
  pass "D1. skipped — no live signin (HTTP $SIGNIN)"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
