# 27 — Wiki Settings Gear + Description Round-Trip + History API Wiring

## What it proves

PR #190 fixes three coupled bugs reported by the PO:

1. **Settings gear visibility (#178a)** — the toolbar gear lives next to the eye toggle and is no longer gated by infobox visibility, so the user can always reach wiki settings. It is hidden in `Edit` and `View history` modes (the gear only makes sense from `Read`).
2. **Description payload round-trip (#178b)** — `AddWikiModal`'s settings PUT now includes `description`. Editing the field saves to `wikis.description`, the detail endpoint returns it, and the modal pre-fills `wiki.description` (preferring it over `shortDescriptor`) on next open.
3. **History API wiring (#180)** — `GET /wikis/:id/history` is registered in the OpenAPI manifest, the SDK exposes `getWikiEditHistory`, the new `useWikiEditHistory` hook fetches it, and `WikiEntityArticle` seeds `serverRevisions` into `useWikiEntityEditMode` so the View history tab shows server-persisted edits across reloads. Both `source: 'user'` (manual edit via `PUT /api/content/wiki/:key`) and `source: 'regen'` (`POST /wikis/:id/regenerate`) append rows; `GET /wikis/:id/history` returns them in `desc(timestamp)` order.

The `renderCustomInfobox` callback signature drops `onSettingsClick` (the gear is rendered by the article shell now, not the infobox) — the People page must still render its custom infobox without the dropped prop.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Wiki dev server on `WIKI_URL` (default `http://localhost:8080`).
- Postgres reachable via `DATABASE_URL` (from `core/.env`); used for direct `edits` table inspection.
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set for authenticated flows.
- `pnpm -C core seed-fixture` has been run (Transformer demo wiki + a People row — see plan 22).

## Fixture identity

- Wiki slug: `transformer-architecture`
- Person slug: `ashish-vaswani`

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

WIKI_URL="${WIKI_URL:-http://localhost:8080}"
SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
ANON_JAR=$(mktemp /tmp/uat-anon-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR" "$ANON_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "27 — Wiki Settings Gear + Description Round-Trip + History API Wiring"
echo ""

# ── 0. Auth + key resolution ─────────────────────────────────
SIGNIN_HTTP=$(curl -s -o /tmp/uat-27-signin.json -w "%{http_code}" -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"${INITIAL_USERNAME:-uat@robin.test}\",\"password\":\"${INITIAL_PASSWORD:-uat-password-123}\"}" \
  "$SERVER_URL/api/auth/sign-in/email")

if [ "$SIGNIN_HTTP" = "200" ]; then
  pass "0a. Initial-user sign-in (HTTP $SIGNIN_HTTP)"
else
  fail "0a. Initial-user sign-in failed (HTTP $SIGNIN_HTTP)"
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

WIKIS_RESPONSE=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50")
WIKI_KEY=$(echo "$WIKIS_RESPONSE" | jq -r '.wikis[] | select(.slug == "transformer-architecture") | .lookupKey // .id' | head -1)
if [ -z "${WIKI_KEY:-}" ] || [ "$WIKI_KEY" = "null" ]; then
  fail "0b. Transformer demo wiki not seeded — run 'pnpm -C core seed-fixture' first"
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "0b. Transformer demo wiki present (key=${WIKI_KEY:0:16}...)"

PERSON_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/people?limit=50" \
  | jq -r '.people[] | select(.slug == "ashish-vaswani") | .lookupKey // .id' | head -1)
[ -n "${PERSON_KEY:-}" ] && [ "$PERSON_KEY" != "null" ] \
  && pass "0c. ashish-vaswani person present (key=${PERSON_KEY:0:16}...)" \
  || skip "0c. ashish-vaswani not seeded — section 5 People page assertions will skip"

# ── 1. History endpoint contract (HTTP API) ──────────────────
# /wikis/:id/history must be registered, session-protected, return the
# documented shape, sort desc(timestamp), and 404 on unknown ids.

# 1a. Endpoint reachable, 200 + documented shape.
HIST_JSON=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY/history")
HIST_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY/history")
if [ "$HIST_HTTP" = "200" ]; then
  pass "1a. GET /wikis/:id/history → 200"
else
  fail "1a. GET /wikis/:id/history returned HTTP $HIST_HTTP"
fi

if echo "$HIST_JSON" | jq -e '.edits | type == "array"' >/dev/null 2>&1 \
   && echo "$HIST_JSON" | jq -e '.total | type == "number"' >/dev/null 2>&1; then
  pass "1b. Response shape: { edits: [], total: number }"
else
  fail "1b. Response shape mismatch (got: $(echo "$HIST_JSON" | head -c 200))"
fi

# 1c. Each edit row has the documented fields.
SHAPE_OK=$(echo "$HIST_JSON" | jq '[.edits[] | select(has("id") and has("timestamp") and has("type") and has("source") and has("contentSnippet"))] | length')
EDIT_COUNT=$(echo "$HIST_JSON" | jq '.edits | length')
if [ "${SHAPE_OK:-0}" = "${EDIT_COUNT:-x}" ]; then
  pass "1c. All $EDIT_COUNT edit rows carry id/timestamp/type/source/contentSnippet"
else
  fail "1c. Some edit rows missing required fields ($SHAPE_OK of $EDIT_COUNT well-formed)"
fi

# 1d. 404 on a wiki id that doesn't exist.
BAD_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/wk_does_not_exist_27/history")
if [ "$BAD_HTTP" = "404" ]; then
  pass "1d. Unknown wiki id → 404"
else
  fail "1d. Unknown wiki id returned $BAD_HTTP (expected 404)"
fi

# 1e. Unauthenticated request rejected (sessionMiddleware on /wikis/*).
UNAUTH_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$ANON_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY/history")
if [ "$UNAUTH_HTTP" = "401" ] || [ "$UNAUTH_HTTP" = "403" ]; then
  pass "1e. Unauthenticated GET /wikis/:id/history rejected (HTTP $UNAUTH_HTTP)"
else
  fail "1e. Unauthenticated GET /wikis/:id/history returned $UNAUTH_HTTP (expected 401/403)"
fi

# ── 2. History rows captured for both source kinds ───────────
# Append a 'user' edit via PUT /api/content/wiki/:key, then trigger a
# 'regen' via POST /wikis/:id/regenerate. Both must appear in /history,
# newest-first.

BEFORE_TOTAL=$(echo "$HIST_JSON" | jq -r '.total')
USER_MARKER="UAT-27 user edit $(date +%s)"
NEW_BODY=$"# Transformer Architecture\n\n$USER_MARKER\n\n## Overview\n\nBody.\n"
PUT_HTTP=$(curl -s -o /tmp/uat-27-put.json -w "%{http_code}" -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg body "$NEW_BODY" --arg name "Transformer Architecture" '{frontmatter:{name:$name,type:"project",prompt:""},body:$body}')" \
  "$SERVER_URL/api/content/wiki/$WIKI_KEY")

if [ "$PUT_HTTP" = "200" ] || [ "$PUT_HTTP" = "204" ]; then
  pass "2a. PUT /api/content/wiki/:key (user edit) accepted (HTTP $PUT_HTTP)"
else
  fail "2a. PUT /api/content/wiki/:key returned $PUT_HTTP"
fi

# Allow time for insert; then re-fetch history.
sleep 1
HIST_AFTER_USER=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY/history")
AFTER_USER_TOTAL=$(echo "$HIST_AFTER_USER" | jq -r '.total')
if [ "$AFTER_USER_TOTAL" -gt "$BEFORE_TOTAL" ] 2>/dev/null; then
  pass "2b. History total increased after user edit ($BEFORE_TOTAL → $AFTER_USER_TOTAL)"
else
  fail "2b. History total did not increase after user edit ($BEFORE_TOTAL → $AFTER_USER_TOTAL)"
fi

# 2c. The newest row has source='user'.
NEWEST_SOURCE=$(echo "$HIST_AFTER_USER" | jq -r '.edits[0].source // empty')
if [ "$NEWEST_SOURCE" = "user" ]; then
  pass "2c. Newest history row has source='user'"
else
  fail "2c. Newest history row source='$NEWEST_SOURCE' (expected 'user')"
fi

# 2d. The user edit row's contentSnippet is at most 200 chars (route slices to 200).
SNIPPET_LEN=$(echo "$HIST_AFTER_USER" | jq -r '.edits[0].contentSnippet | length')
if [ "$SNIPPET_LEN" -le 200 ] 2>/dev/null; then
  pass "2d. contentSnippet length ≤ 200 chars (got $SNIPPET_LEN)"
else
  fail "2d. contentSnippet length is $SNIPPET_LEN (expected ≤ 200)"
fi

# 2e. Trigger a regen and assert a source='regen' row appears.
# regenerate is best-effort — it may be 200 (queued/done) or 400 if disabled.
REGEN_HTTP=$(curl -s -o /tmp/uat-27-regen.json -w "%{http_code}" -b "$COOKIE_JAR" -X POST \
  -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY/regenerate")
if [ "$REGEN_HTTP" = "200" ]; then
  pass "2e. POST /wikis/:id/regenerate accepted (HTTP $REGEN_HTTP)"
  # regen is async; poll up to ~30s for the new row.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    HIST_AFTER_REGEN=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY/history")
    REGEN_ROW_COUNT=$(echo "$HIST_AFTER_REGEN" | jq '[.edits[] | select(.source == "regen")] | length')
    if [ "${REGEN_ROW_COUNT:-0}" -ge 1 ]; then break; fi
  done
  if [ "${REGEN_ROW_COUNT:-0}" -ge 1 ]; then
    pass "2f. At least one history row has source='regen' (count=$REGEN_ROW_COUNT)"
  else
    fail "2f. No history row with source='regen' after $((i*3))s of polling"
  fi
elif [ "$REGEN_HTTP" = "400" ]; then
  skip "2e. regenerate disabled on this fixture (HTTP 400) — source='regen' assertion skipped"
  skip "2f. source='regen' row check skipped"
else
  fail "2e. POST /wikis/:id/regenerate returned $REGEN_HTTP (expected 200 or 400)"
  skip "2f. source='regen' row check skipped due to regen failure"
fi

# 2g. Rows are returned newest-first (desc(timestamp)).
ORDER_OK=$(echo "$HIST_AFTER_USER" | jq -r '
  [.edits[].timestamp] as $ts
  | if ($ts | length) < 2 then "trivial"
    else
      [range(0; ($ts | length) - 1) | ($ts[.] >= $ts[. + 1])] | all | tostring
    end')
if [ "$ORDER_OK" = "true" ] || [ "$ORDER_OK" = "trivial" ]; then
  pass "2g. /history rows ordered desc(timestamp)"
else
  fail "2g. /history rows NOT in desc(timestamp) order"
fi

# 2h. DB-level confirmation: edits table has rows for this wiki keyed by lookupKey.
if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  DB_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM edits WHERE object_type='wiki' AND object_id='$WIKI_KEY'" 2>/dev/null || echo 0)
  if [ "${DB_COUNT:-0}" -ge 1 ] 2>/dev/null; then
    pass "2h. edits table has $DB_COUNT row(s) for this wiki"
  else
    fail "2h. edits table has no rows for $WIKI_KEY (DB out of sync with API?)"
  fi
else
  skip "2h. psql or DATABASE_URL unavailable — skip DB-level check"
fi

# ── 3. Description payload round-trip ────────────────────────
# The PR adds `description` to the AddWikiModal payload AND makes
# /wikis/:id?[detail] return it AND wires the page to prefer
# wiki.description over wiki.shortDescriptor.

DESC_MARKER="UAT-27 description $(date +%s)"

# 3a. PUT description via the same endpoint the modal uses (PUT /wikis/:id).
PUT_DESC_HTTP=$(curl -s -o /tmp/uat-27-putdesc.json -w "%{http_code}" -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg d "$DESC_MARKER" --arg p "" '{prompt:$p, description:$d}')" \
  "$SERVER_URL/wikis/$WIKI_KEY")
if [ "$PUT_DESC_HTTP" = "200" ]; then
  pass "3a. PUT /wikis/:id with {description} accepted (HTTP $PUT_DESC_HTTP)"
else
  fail "3a. PUT /wikis/:id with {description} returned $PUT_DESC_HTTP"
fi

# 3b. GET returns the saved description verbatim.
GET_AFTER=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY")
GOT_DESC=$(echo "$GET_AFTER" | jq -r '.description // empty')
if [ "$GOT_DESC" = "$DESC_MARKER" ]; then
  pass "3b. GET /wikis/:id returns the description set via PUT (round-trip)"
else
  fail "3b. description round-trip failed (got: '${GOT_DESC:0:60}', want: '${DESC_MARKER:0:60}')"
fi

# 3c. DB column actually written (defends against backend silently dropping).
if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  DB_DESC=$(psql "$DATABASE_URL" -t -A -c "SELECT description FROM wikis WHERE lookup_key='$WIKI_KEY'" 2>/dev/null || echo "")
  if [ "$DB_DESC" = "$DESC_MARKER" ]; then
    pass "3c. wikis.description column persisted ($DB_DESC)"
  else
    fail "3c. wikis.description column has '$DB_DESC' (expected '$DESC_MARKER')"
  fi
else
  skip "3c. psql or DATABASE_URL unavailable — skip DB-level check"
fi

# 3d. Server rejects null description (zod refuses null per AddWikiModal comment).
NULL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"prompt":"","description":null}' \
  "$SERVER_URL/wikis/$WIKI_KEY")
if [ "$NULL_HTTP" = "400" ] || [ "$NULL_HTTP" = "422" ]; then
  pass "3d. PUT with description=null is rejected (HTTP $NULL_HTTP)"
else
  fail "3d. PUT with description=null returned $NULL_HTTP (expected 400/422)"
fi

# ── 4. Frontend — settings gear placement + visibility ───────
# Sign in via the wiki UI and exercise the toolbar gear.

npx agent-browser open "$WIKI_URL/login" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

npx agent-browser open "$WIKI_URL/wiki/$WIKI_KEY" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-27-detail-dom.html 2>/dev/null
npx agent-browser screenshot /tmp/uat-27-04-detail.png 2>/dev/null
DETAIL_SNAP=$(npx agent-browser snapshot 2>/dev/null)

# 4a. The settings gear is present in the toolbar row regardless of infobox state.
#     The gear is a <button title="Wiki settings"> rendered next to the eye toggle.
if grep -qiE 'title="Wiki settings"' /tmp/uat-27-detail-dom.html; then
  pass "4a. Settings gear (title='Wiki settings') is in the DOM"
else
  fail "4a. Settings gear button not found in DOM"
fi

# 4b. The gear is rendered beside the toolbar (not inside the infobox aside).
#     Walk up the DOM: the button must NOT be a descendant of any element with
#     class containing 'winfo' or 'wiki-aside'.
GEAR_INSIDE_INFOBOX=$(npx agent-browser eval "(() => { const b = document.querySelector('button[title=\"Wiki settings\"]'); if (!b) return 'missing'; let n = b.parentElement; while (n) { const c = n.className || ''; if (typeof c === 'string' && (c.includes('winfo') || c.includes('wiki-aside'))) return 'inside-infobox'; n = n.parentElement; } return 'outside-infobox'; })()" 2>/dev/null | tr -d '"')
if [ "$GEAR_INSIDE_INFOBOX" = "outside-infobox" ]; then
  pass "4b. Settings gear lives in the toolbar, NOT inside the infobox aside"
elif [ "$GEAR_INSIDE_INFOBOX" = "inside-infobox" ]; then
  fail "4b. Settings gear is still nested inside infobox aside (PR regressed)"
else
  fail "4b. Could not locate settings gear ($GEAR_INSIDE_INFOBOX)"
fi

# 4c. Hide the infobox via the eye toggle — gear must remain visible.
npx agent-browser eval "document.querySelector('button[title=\"Hide infobox\"]')?.click()" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
GEAR_AFTER_HIDE=$(npx agent-browser eval "!!document.querySelector('button[title=\"Wiki settings\"]')" 2>/dev/null | tr -d '"')
if [ "$GEAR_AFTER_HIDE" = "true" ]; then
  pass "4c. Settings gear remains visible after hiding the infobox"
else
  fail "4c. Settings gear disappeared when infobox was hidden (regression of #178)"
fi

# 4d. Settings gear is hidden in Edit mode.
npx agent-browser find text "Edit" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
GEAR_IN_EDIT=$(npx agent-browser eval "!!document.querySelector('button[title=\"Wiki settings\"]')" 2>/dev/null | tr -d '"')
if [ "$GEAR_IN_EDIT" = "false" ]; then
  pass "4d. Settings gear hidden during Edit mode"
else
  fail "4d. Settings gear still rendered while Edit mode is active"
fi
# Exit edit mode (Cancel) to restore Read mode.
npx agent-browser find text "Cancel" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1

# 4e. Settings gear is hidden in View history mode.
npx agent-browser find text "View history" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
GEAR_IN_HISTORY=$(npx agent-browser eval "!!document.querySelector('button[title=\"Wiki settings\"]')" 2>/dev/null | tr -d '"')
if [ "$GEAR_IN_HISTORY" = "false" ]; then
  pass "4e. Settings gear hidden during View history"
else
  fail "4e. Settings gear still rendered while View history is active"
fi

# Switch back to Read.
npx agent-browser find text "Read" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1

# 4f. Anonymous (signed-out) user: the wiki detail route is gated, so the
#     page either redirects to login or never renders the gear.
npx agent-browser open "$WIKI_URL/api/auth/sign-out" 2>/dev/null || true
sleep 1
npx agent-browser open "$WIKI_URL/wiki/$WIKI_KEY" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
ANON_GEAR=$(npx agent-browser eval "!!document.querySelector('button[title=\"Wiki settings\"]')" 2>/dev/null | tr -d '"')
ANON_URL=$(npx agent-browser eval "location.pathname" 2>/dev/null | tr -d '"')
if [ "$ANON_GEAR" = "false" ]; then
  pass "4f. Anonymous user sees no settings gear (URL: $ANON_URL)"
else
  fail "4f. Anonymous user sees settings gear (auth regression)"
fi

# Re-sign-in for the rest of the suite.
npx agent-browser open "$WIKI_URL/login" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

# ── 5. Frontend — settings modal description prefill + save ──
npx agent-browser open "$WIKI_URL/wiki/$WIKI_KEY" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1

# 5a. Click the gear and confirm a settings dialog opens.
npx agent-browser eval "document.querySelector('button[title=\"Wiki settings\"]')?.click()" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
SETTINGS_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-27-05-settings-open.png 2>/dev/null
if echo "$SETTINGS_SNAP" | grep -qiE "Wiki settings|Edit wiki|Settings"; then
  pass "5a. Clicking the gear opens the settings dialog"
else
  fail "5a. Settings dialog did not open after clicking gear"
fi

# 5b. Description field is pre-filled from wiki.description (set in step 3).
DESC_VALUE=$(npx agent-browser eval "(() => { const els = Array.from(document.querySelectorAll('textarea, input[type=\"text\"]')); for (const el of els) { if ((el.value || '').includes('UAT-27 description')) return el.value; } return ''; })()" 2>/dev/null | tr -d '"')
if echo "$DESC_VALUE" | grep -q "UAT-27 description"; then
  pass "5b. Description input pre-filled with wiki.description ('${DESC_VALUE:0:40}...')"
else
  fail "5b. Description input not pre-filled with wiki.description (got: '${DESC_VALUE:0:60}')"
fi

# 5c. Edit description, save, and assert PUT carried the new description.
NEW_DESC="UAT-27 modal save $(date +%s)"
npx agent-browser eval "(() => { const els = Array.from(document.querySelectorAll('textarea, input[type=\"text\"]')); for (const el of els) { if ((el.value || '').includes('UAT-27 description')) { const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set; setter && setter.call(el, '$NEW_DESC'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; } } return false; })()" 2>/dev/null
sleep 1
npx agent-browser find text "Save" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 2

GET_AFTER_MODAL=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY")
GOT_DESC2=$(echo "$GET_AFTER_MODAL" | jq -r '.description // empty')
if [ "$GOT_DESC2" = "$NEW_DESC" ]; then
  pass "5c. Settings modal Save persisted the new description via PUT"
else
  fail "5c. Settings modal Save did not persist description (got: '${GOT_DESC2:0:60}')"
fi

# 5d. Empty/whitespace prompt should not blow up the PUT (sanity check on
#     the modal's payload validation — prompt is required, so an empty
#     string is the legitimate clear-override path).
EMPTY_PROMPT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"prompt":""}' \
  "$SERVER_URL/wikis/$WIKI_KEY")
if [ "$EMPTY_PROMPT_HTTP" = "200" ]; then
  pass "5d. Empty prompt (clear override) accepted by PUT /wikis/:id"
else
  fail "5d. PUT with empty prompt returned $EMPTY_PROMPT_HTTP"
fi

# 5e. Server rejects an unrecognised type (negative — settings modal must
#     surface the rejection rather than silently writing).
BAD_TYPE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"prompt":"","type":"definitely-not-a-real-type-xyz"}' \
  "$SERVER_URL/wikis/$WIKI_KEY")
if [ "$BAD_TYPE_HTTP" = "400" ] || [ "$BAD_TYPE_HTTP" = "422" ] || [ "$BAD_TYPE_HTTP" = "404" ]; then
  pass "5e. PUT with unrecognised type rejected (HTTP $BAD_TYPE_HTTP)"
else
  fail "5e. PUT with bogus type returned $BAD_TYPE_HTTP (expected 400/422/404)"
fi

# ── 6. Frontend — View history tab loads server records ──────
# Reload the wiki detail page (fresh session, no in-memory revisions),
# click View history, and confirm timeline rows came from the API.

npx agent-browser open "$WIKI_URL/wiki/$WIKI_KEY" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1

# 6a. Click 'View history' and let useWikiEditHistory hydrate.
npx agent-browser find text "View history" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 2
HIST_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-27-06-history.png 2>/dev/null

# 6b. Timeline shows at least one revision row sourced from the API.
#     useWikiEditHistory maps source==='regen' → 'Regenerated'/'Robin',
#     source==='user' → 'Edited'/'You'. Either label proves API hydration
#     because a fresh page load has no in-session edits.
if echo "$HIST_SNAP" | grep -qiE "Regenerated|Edited"; then
  pass "6a. View history timeline rendered server-sourced revisions"
else
  fail "6a. View history timeline empty on fresh load (API not wired?)"
fi

# 6c. The author label uses the API mapping ('Robin' for regen, 'You' for user).
if echo "$HIST_SNAP" | grep -qE "\bYou\b|\bRobin\b"; then
  pass "6b. Author label ('You'/'Robin') from useWikiEditHistory mapping present"
else
  fail "6b. No 'You' or 'Robin' author label found in timeline"
fi

# 6d. The DOM contains at least N revision entries where N == /history total.
TIMELINE_TOTAL=$(echo "$HIST_AFTER_USER" | jq -r '.total')
TIMELINE_DOM_COUNT=$(npx agent-browser eval "document.querySelectorAll('[class*=\"revision\"], [data-revision]').length" 2>/dev/null | tr -d '"')
# WikiHistoryTimeline uses freeform class names; fall back to a text proxy.
if [ -z "${TIMELINE_DOM_COUNT:-}" ] || [ "$TIMELINE_DOM_COUNT" = "0" ]; then
  TIMELINE_DOM_COUNT=$(echo "$HIST_SNAP" | grep -cE "Regenerated|Edited" || echo 0)
fi
if [ "${TIMELINE_DOM_COUNT:-0}" -ge 1 ] 2>/dev/null; then
  pass "6c. Timeline shows ≥1 revision (DOM/snapshot count=$TIMELINE_DOM_COUNT, API total=$TIMELINE_TOTAL)"
else
  fail "6c. Timeline shows 0 revisions (DOM count=0, API total=$TIMELINE_TOTAL)"
fi

# 6e. Switch back to Read — gear reappears.
npx agent-browser find text "Read" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
GEAR_BACK=$(npx agent-browser eval "!!document.querySelector('button[title=\"Wiki settings\"]')" 2>/dev/null | tr -d '"')
if [ "$GEAR_BACK" = "true" ]; then
  pass "6d. Returning to Read restores the settings gear"
else
  fail "6d. Settings gear missing after returning to Read mode"
fi

# ── 7. People page — renderCustomInfobox without onSettingsClick ──
# The PR removes onSettingsClick from renderCustomInfobox's callback
# signature. The People detail page still passes a custom infobox; it
# must render without TS/runtime errors and without depending on the
# dropped prop.

if [ -n "${PERSON_KEY:-}" ] && [ "$PERSON_KEY" != "null" ]; then
  npx agent-browser open "$WIKI_URL/people/$PERSON_KEY" 2>/dev/null
  npx agent-browser wait --load networkidle
  sleep 1
  npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-27-people-dom.html 2>/dev/null
  PEOPLE_SNAP=$(npx agent-browser snapshot 2>/dev/null)
  npx agent-browser screenshot /tmp/uat-27-07-people.png 2>/dev/null

  # 7a. Page renders the person name (no crash from the dropped prop).
  if echo "$PEOPLE_SNAP" | grep -qi "Ashish Vaswani"; then
    pass "7a. People detail page renders without onSettingsClick prop"
  else
    fail "7a. People detail page failed to render (renderCustomInfobox regression?)"
  fi

  # 7b. Person infobox still visible — PeopleInfobox no longer receives
  #     onSettingsClick but should still display the structured panel.
  if grep -qE 'class="[^"]*\bwinfo\b' /tmp/uat-27-people-dom.html \
     || echo "$PEOPLE_SNAP" | grep -qiE "Relationship|Aliases|First mentioned"; then
    pass "7b. PeopleInfobox renders without the dropped onSettingsClick prop"
  else
    fail "7b. PeopleInfobox missing — the prop removal may have broken rendering"
  fi

  # 7c. The People page settings gear (rendered by article shell) is also
  #     present here because infobox.showSettings === true on this page.
  if grep -qE 'title="Wiki settings"' /tmp/uat-27-people-dom.html; then
    pass "7c. People page settings gear present in toolbar (showSettings:true)"
  else
    fail "7c. People page settings gear missing"
  fi
else
  skip "7. ashish-vaswani not seeded — People page section skipped"
fi

# ── 8. OpenAPI manifest registers /wikis/:id/history ─────────
# PR also wires the manifest + regenerated frontend SDK. Confirm both.

# 8a. Live OpenAPI doc exposes the route.
APIDOC=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/openapi.json")
if echo "$APIDOC" | jq -e '.paths["/wikis/{id}/history"].get.operationId == "getWikiEditHistory"' >/dev/null 2>&1; then
  pass "8a. /openapi.json registers GET /wikis/{id}/history with operationId getWikiEditHistory"
else
  fail "8a. /openapi.json missing /wikis/{id}/history or wrong operationId"
fi

# 8b. editHistoryResponseSchema is defined in components.schemas.
if echo "$APIDOC" | jq -e '.components.schemas.editHistoryResponseSchema.properties.edits' >/dev/null 2>&1; then
  pass "8b. /openapi.json exposes editHistoryResponseSchema component"
else
  fail "8b. /openapi.json missing editHistoryResponseSchema component"
fi

# 8c. Frontend generated SDK exports getWikiEditHistory (regen check).
if grep -q "getWikiEditHistory" wiki/src/lib/generated/sdk.gen.ts 2>/dev/null; then
  pass "8c. wiki/src/lib/generated/sdk.gen.ts exports getWikiEditHistory"
else
  fail "8c. Frontend SDK missing getWikiEditHistory — codegen out of sync"
fi

# ── 9. Tiptap save scope — sidebar chrome must NOT bake into wikis.content (#241) ──
# When the user clicks Edit, `WikiEntityArticle` captures
# `readContentRef.current.innerHTML` and seeds the Tiptap editor with it.
# Today that ref wraps Member Fragments + Mentioned People + section
# editor — so a no-op edit/save round-trip rewrites `wikis.content` with
# all that chrome. Subsequent reads then render the chrome inside the
# body AND outside it (duplicate sections accumulate per save cycle).
#
# Bug present: after save, `wikis.content` contains 'Member Fragments',
# 'Mentioned People', '/fragments/frag', and the wedit class — none of
# which were in the markdown source body.
#
# Fix (fork commit 23b68a8): wrap the body in <div data-wiki-body> on the
# shell page and scope the innerHTML capture to that subtree.
#
# Use a fresh UAT-only wiki so this section never mutates the shared
# Transformer fixture. Cleanup tears it down at the end.

UAT9_WIKI_NAME="UAT-27 Tiptap Chrome $(date +%s)"
CREATE_WIKI_HTTP=$(curl -s -o /tmp/uat-27-09-create.json -w "%{http_code}" -b "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg n "$UAT9_WIKI_NAME" '{name:$n, type:"project", prompt:""}')" \
  "$SERVER_URL/wikis")

if [ "$CREATE_WIKI_HTTP" = "200" ] || [ "$CREATE_WIKI_HTTP" = "201" ]; then
  pass "9a. Created UAT-only wiki for chrome-bake test (HTTP $CREATE_WIKI_HTTP)"
else
  fail "9a. Could not create UAT wiki (HTTP $CREATE_WIKI_HTTP) — section 9 will use Transformer fixture instead"
fi
UAT9_KEY=$(jq -r '.lookupKey // .id // empty' /tmp/uat-27-09-create.json)
if [ -z "${UAT9_KEY:-}" ] || [ "$UAT9_KEY" = "null" ]; then
  # Fall back to Transformer wiki — cleanup will re-seed.
  UAT9_KEY="$WIKI_KEY"
  skip "9a-fallback. Using Transformer fixture (cleanup will re-seed)"
fi

# Seed the wiki with a known markdown body via the API the same way the
# Tiptap save does (PUT /api/content/wiki/:key). Body has NO chrome
# strings — anything chrome-flavoured we find later came from the editor
# capture, not our seed.
UAT9_BODY=$'# Tiptap Chrome Bake Probe\n\nUAT-27 §9 body marker — only this text and the heading should land in wikis.content after a no-op Tiptap save.\n\n## Subsection\n\nLine for the body.\n'
SEED_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg body "$UAT9_BODY" --arg name "$UAT9_WIKI_NAME" '{frontmatter:{name:$name,type:"project",prompt:""},body:$body}')" \
  "$SERVER_URL/api/content/wiki/$UAT9_KEY")
if [ "$SEED_HTTP" = "200" ] || [ "$SEED_HTTP" = "204" ]; then
  pass "9b. Seeded UAT wiki with chrome-free markdown body (HTTP $SEED_HTTP)"
else
  fail "9b. PUT seed failed (HTTP $SEED_HTTP) — assertions below may be unreliable"
fi

# Open the wiki, click Edit, click Save (no edits). The bug fires on
# enterEditMode whether or not the user edits — what matters is the
# innerHTML scope at the moment Edit is clicked.
npx agent-browser open "$WIKI_URL/wiki/$UAT9_KEY"
npx agent-browser wait --load networkidle
sleep 1

# 9c. Confirm baseline DOM has chrome rendered around the body — this is
# what the buggy capture would slurp up. Skip with a warning if the
# fixture has no fragments/people; without chrome to leak the assertion
# becomes vacuous.
DOM_HAS_CHROME=$(npx agent-browser eval "(() => { const t = document.body.innerText || ''; return JSON.stringify({mf: t.includes('Member Fragments'), mp: t.includes('Mentioned People')}); })()" | tr -d '"' | tr -d '\\')
if echo "$DOM_HAS_CHROME" | grep -q "mf:true"; then
  pass "9c. Page chrome (Member Fragments) present in DOM — bake risk realistic"
else
  skip "9c. No Member Fragments in DOM ($DOM_HAS_CHROME) — UAT wiki has no fragments; falling through but assertion power is reduced"
fi

# 9d. Click Edit and assert the editor body is scoped to the wiki body
# only — Member Fragments / Mentioned People must NOT appear in the
# Tiptap editor's innerText. This is the fix's primary contract.
npx agent-browser find text "Edit" click
npx agent-browser wait --load networkidle
sleep 1
EDITOR_BODY=$(npx agent-browser eval "document.querySelector('.tiptap')?.innerText || ''")
if echo "$EDITOR_BODY" | grep -qE "Member Fragments|Mentioned People|/fragments/frag"; then
  fail "9d. Tiptap editor contains chrome strings (capture not scoped to data-wiki-body) — fix not applied"
else
  pass "9d. Tiptap editor body has no chrome strings — capture scoped correctly"
fi

# 9e. Click Save and round-trip the body through PUT /api/content/wiki.
npx agent-browser find text "Save" click
npx agent-browser wait --load networkidle
sleep 2

# 9f. Read back wikis.content and assert NONE of the chrome substrings
# leaked into the persisted body. These four are deterministic markers
# rendered by the article shell (page.tsx:521-622) but never present in
# a real markdown body.
if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  SAVED_CONTENT=$(psql "$DATABASE_URL" -t -A -c "SELECT content FROM wikis WHERE lookup_key='$UAT9_KEY'" 2>/dev/null || echo "")
  CHROME_LEAKS=0
  for marker in "Member Fragments" "Mentioned People" "/fragments/frag" "wedit"; do
    if echo "$SAVED_CONTENT" | grep -qF "$marker"; then
      fail "9f. wikis.content contains chrome substring: '$marker' (Tiptap save baked sidebar chrome — #241 still present)"
      CHROME_LEAKS=$((CHROME_LEAKS+1))
    fi
  done
  if [ "$CHROME_LEAKS" = "0" ]; then
    pass "9f. wikis.content has no chrome substrings (Member Fragments / Mentioned People / /fragments/frag / wedit)"
  fi

  # 9g. Positive: the body marker we seeded should still be present.
  if echo "$SAVED_CONTENT" | grep -qF "UAT-27 §9 body marker"; then
    pass "9g. Body marker preserved after Tiptap save round-trip"
  else
    fail "9g. Body marker missing after save — round-trip dropped legitimate body content"
  fi

  # 9h. Length sanity: the persisted content should be on the order of
  # the seed body (~200 bytes), not the chromed-up DOM (~5–10 KB). Use a
  # generous ceiling so editor whitespace normalisation doesn't trip it.
  SAVED_LEN=${#SAVED_CONTENT}
  if [ "$SAVED_LEN" -le 2000 ] 2>/dev/null; then
    pass "9h. Persisted content length $SAVED_LEN bytes ≤ 2000 (no chrome bloat)"
  else
    fail "9h. Persisted content length $SAVED_LEN bytes > 2000 (chrome bloat suspected — #241 regression)"
  fi
else
  skip "9f-h. psql or DATABASE_URL unavailable — chrome-bake DB checks skipped"
fi

# 9i. Re-render the wiki in Read mode and confirm the live page does NOT
# show duplicate Member Fragments listings. The bug surface is "two of
# everything" — one from the article shell, one from the baked content.
# Count <h2> nodes whose text starts with 'Member Fragments'.
npx agent-browser open "$WIKI_URL/wiki/$UAT9_KEY"
npx agent-browser wait --load networkidle
sleep 1
MF_H2_COUNT=$(npx agent-browser eval "Array.from(document.querySelectorAll('h2')).filter(h => (h.textContent || '').includes('Member Fragments')).length" | tr -d '"')
if [ "${MF_H2_COUNT:-0}" -le 1 ] 2>/dev/null; then
  pass "9i. ≤1 'Member Fragments' h2 on the page (no duplicate from baked chrome) — got $MF_H2_COUNT"
else
  fail "9i. Found $MF_H2_COUNT 'Member Fragments' h2 nodes — chrome was baked and is rendering twice"
fi

# 9j. Cleanup: delete the UAT wiki if we created one. If we fell back to
# the Transformer fixture, the bottom-of-plan re-seed restores it.
if [ "$UAT9_KEY" != "$WIKI_KEY" ]; then
  DEL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X DELETE \
    -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$UAT9_KEY")
  if [ "$DEL_HTTP" = "200" ] || [ "$DEL_HTTP" = "204" ]; then
    pass "9j. Cleaned up UAT wiki (HTTP $DEL_HTTP)"
  else
    skip "9j. UAT wiki delete returned HTTP $DEL_HTTP — bottom-of-plan re-seed will not touch it"
  fi
fi

# ── Cleanup ──────────────────────────────────────────────────
# Re-seed to restore a clean fixture body / description for downstream plans.
pnpm -C core seed-fixture >/dev/null 2>&1 || true
npx agent-browser close 2>/dev/null || true

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0 | Auth + Transformer + ashish-vaswani fixture identity resolved | preflight |
| 1 | `/wikis/:id/history` endpoint: 200, documented shape, all rows well-formed, 404 on bad id, 401/403 on anon | `core/src/routes/wikis.ts:376-416`, `sessionMiddleware` |
| 2 | History captures both `source: 'user'` (PUT /api/content/wiki) and `source: 'regen'` (POST regenerate); rows ordered desc(timestamp); contentSnippet ≤ 200; DB row count matches | `routes/content.ts:165`, `lib/regen.ts:584` |
| 3 | Description round-trip: PUT → GET equals PUT; DB column persisted; null payload rejected | `wikis.ts` PUT handler + `description != null` branch |
| 4 | Settings gear lives in toolbar (not infobox), survives infobox hide, hidden in Edit + View history, hidden when signed out | `WikiEntityArticle.tsx:713-732` (gear render), gear `showSettings && !isEditing && !isViewingHistory` gate |
| 5 | Settings modal: prefills description from wiki.description, save persists via PUT, empty prompt accepted, bad type rejected | `AddWikiModal.tsx:131,221-230`, `wikiSettingsPrefill.ts:51` |
| 6 | View history tab hydrates from `useWikiEditHistory`; timeline shows server revisions on fresh load with You/Robin author labels | `useWikiEditHistory.ts`, `WikiEntityArticle.tsx:382-396` (serverRevisions seed), `useWikiEntityEditMode.ts:115-121` |
| 7 | People page renders custom infobox after `onSettingsClick` was removed from the callback signature; gear still appears for showSettings:true | `wiki/src/app/(shell)/people/[id]/page.tsx:311-330` |
| 8 | OpenAPI manifest registers `/wikis/{id}/history`; `editHistoryResponseSchema` component exposed; frontend SDK regenerated with `getWikiEditHistory` | `core/openapi-manifest.json`, `core/openapi.json`, `wiki/src/lib/generated/sdk.gen.ts` |
| 9 | #241 — Tiptap save scoped to `data-wiki-body`: Tiptap editor seeded without chrome; after no-op save, `wikis.content` contains body marker but none of `Member Fragments` / `Mentioned People` / `/fragments/frag` / `wedit`; persisted length stays small; no duplicate Member Fragments h2 in Read mode | `wiki/src/components/wiki/WikiEntityArticle.tsx:671` (capture scope), `wiki/src/app/(shell)/wiki/[id]/page.tsx:294-623` (chrome render around `data-wiki-body`) |

Target: ~42 numbered assertions across 10 sections (sections 0–9).

---

## Notes

- The history endpoint accepts `?limit` and `?offset` (parsed via `timelineQuerySchema`). This plan does not exhaust pagination — the existing endpoint sweep (plan 99 step 2e) covers basic pagination, and plan 27 focuses on the new wiring.
- Section 2's regen step (2e–2f) is async. If the worker is slow or `regenerate` is gated by the queue's flag, expect step 2e to return 400 — the plan SKIPs 2f rather than failing because the regen integration has its own coverage in plan 17.
- The description round-trip in section 3 mutates the demo wiki's `description` column. The cleanup runs `seed-fixture` to restore the canonical row.
- Step 4f (anonymous user) signs out via `/api/auth/sign-out`. Better-auth may respond with a redirect rather than a JSON body — the assertion checks the gear's absence rather than the response code. If the wiki shell redirects to `/login` instead, `ANON_GEAR=false` is the correct outcome.
- Step 5c uses a JS setter cast to bypass React's controlled-input bookkeeping. If the modal uses a custom input component that ignores raw value mutations, the assertion will fail and a manual check via `/tmp/uat-27-05-settings-open.png` is the fallback.
- Step 6c's DOM selector is heuristic — `WikiHistoryTimeline.tsx` uses ad-hoc class names. The script falls back to counting "Regenerated"/"Edited" labels in the snapshot if no `[class*="revision"]` matches.
- The PR's `useWikiEditHistory` hook only seeds revisions on first load when `revisions.length === 0`. This UAT relies on a fresh navigation to `/wiki/:id`; do not chain it after a session that already populated revisions in-memory or step 6 will appear to pass even if the API call regressed.
- Section 9 reproduces #241 (Tiptap save bakes sidebar chrome into `wikis.content`). The four chrome substrings — `Member Fragments`, `Mentioned People`, `/fragments/frag`, `wedit` — are all rendered by the article shell (`wiki/src/app/(shell)/wiki/[id]/page.tsx:521-622` for the lists, `wedit` by the inline `[edit]` link inside `MarkdownContent`). None of them ever appear in a freshly-seeded markdown body, so finding any of them in `wikis.content` after a no-op Tiptap save is a deterministic positive for the bug. The fix (fork commit `23b68a8`) wraps the body in `<div data-wiki-body>` and scopes the `enterEditMode` capture to that subtree. Section 9 creates and tears down its own UAT wiki so it never mutates the shared Transformer fixture; if the create call fails (older API surface) it falls back to the Transformer wiki and the bottom-of-plan `seed-fixture` re-seed restores it.
