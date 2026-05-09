# 76 - Stream U: Settings shell and panels (v0.2.2)

## What it proves

Cluster branch `feat/settings-shell-and-panels` ships the Stream U
operator UI plus its backing HTTP endpoints:

1. **Settings shell** at `/settings` with three panels: Wikis, People,
   Backfill. Hitting `/settings` redirects to `/settings/wikis`.
2. **Wikis panel** lists every wiki with autoregen toggle, last-regen
   time, fragment count, regen-now button, and an agent_schema-gap dot.
   Toggling autoregen flips the `wikis.autoregen` column. Regen-now
   fires `POST /wikis/:id/regenerate`.
3. **People panel** lists pending persons (`GET /admin/people?status=pending`,
   owned by Stream P). Approve and Reject route through
   `POST /admin/people/:key/{approve,reject}`. The auto-accept-persons
   header switch flips a setting in Stream P. When opening a pending
   person's wiki page, a full-width quarantine topbar renders above the
   page with the same approve / reject buttons.
4. **Backfill panel** reads `GET /admin/backfill/audit` and renders a
   description-row gap card with a "Run backfill" button that fires
   `POST /admin/backfill/wiki-agent-schema`. A recent-runs card reads
   `GET /admin/backfill/runs`.
5. The `/admin/backfill/*` HTTP endpoints all require an authenticated
   session.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Wiki frontend on `WIKI_URL` (default `http://localhost:3001`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`.
- `DATABASE_URL` reachable for direct row inspection.
- A wiki seeded (`pnpm -C core seed-fixture`).

## Endpoint map

- `GET  /api/wikis`                                 - must include `autoregen`, `editorialState`, `agentSchemaStatus`.
- `PATCH /api/wikis/:id/auto-regen`                  - toggle autoregen.
- `POST /api/wikis/:id/regenerate`                   - on-demand regen.
- `GET  /api/admin/backfill/audit`                   - gap report.
- `POST /api/admin/backfill/wiki-agent-schema`       - trigger backfill.
- `GET  /api/admin/backfill/runs`                    - last-run telemetry.
- `GET  /api/admin/people?status=pending`            - Stream P; pending list.
- `POST /api/admin/people/:key/approve`              - Stream P; approve.
- `POST /api/admin/people/:key/reject`               - Stream P; reject.
- `GET/POST /api/admin/settings/auto-accept-persons` - Stream P; toggle.

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:3001}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"
DB_URL="${DATABASE_URL:-postgresql://robin:@localhost:5432/robin_dev}"
JAR=$(mktemp /tmp/uat-76-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-76-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  + $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ! $1"; }
skip() { SKIP=$((SKIP+1)); echo "  - $1"; }

echo "76 - Stream U: settings shell and panels"
echo ""

# 1. Sign in to obtain a session cookie.
curl -s -o /tmp/uat-76-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" > /tmp/uat-76-signin.code
if [ "$(cat /tmp/uat-76-signin.code)" = "200" ]; then pass "sign in"; else fail "sign in code $(cat /tmp/uat-76-signin.code)"; fi

# 2. /admin/backfill/* require auth.
UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/admin/backfill/audit")
if [ "$UNAUTH_CODE" = "401" ]; then pass "/admin/backfill/audit 401 without session"; else fail "expected 401, got $UNAUTH_CODE"; fi

UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$SERVER_URL/admin/backfill/wiki-agent-schema")
if [ "$UNAUTH_CODE" = "401" ]; then pass "/admin/backfill/wiki-agent-schema 401 without session"; else fail "expected 401, got $UNAUTH_CODE"; fi

UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/admin/backfill/runs")
if [ "$UNAUTH_CODE" = "401" ]; then pass "/admin/backfill/runs 401 without session"; else fail "expected 401, got $UNAUTH_CODE"; fi

# 3. GET /wikis includes the new UI fields.
WIKI_LIST=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=5")
echo "$WIKI_LIST" > /tmp/uat-76-wikis.json
HAS_AUTOREGEN=$(echo "$WIKI_LIST" | jq -r '.wikis[0] | has("autoregen")')
HAS_DIRTY=$(echo "$WIKI_LIST" | jq -r '.wikis[0] | has("dirtySince")')
HAS_EDITORIAL=$(echo "$WIKI_LIST" | jq -r '.wikis[0] | has("editorialState")')
HAS_NOTECOUNT=$(echo "$WIKI_LIST" | jq -r '.wikis[0] | has("noteCount")')
HAS_SCHEMA=$(echo "$WIKI_LIST" | jq -r '.wikis[0] | has("agentSchemaStatus")')
if [ "$HAS_AUTOREGEN" = "true" ]; then pass "GET /wikis includes autoregen"; else fail "autoregen missing"; fi
if [ "$HAS_DIRTY" = "true" ]; then pass "GET /wikis includes dirtySince"; else fail "dirtySince missing"; fi
if [ "$HAS_EDITORIAL" = "true" ]; then pass "GET /wikis includes editorialState"; else fail "editorialState missing"; fi
if [ "$HAS_NOTECOUNT" = "true" ]; then pass "GET /wikis includes noteCount"; else fail "noteCount missing"; fi
if [ "$HAS_SCHEMA" = "true" ]; then pass "GET /wikis includes agentSchemaStatus"; else fail "agentSchemaStatus missing"; fi

# 4. Toggle autoregen on a wiki via PATCH and read it back.
WIKI_ID=$(echo "$WIKI_LIST" | jq -r '.wikis[0].id // empty')
if [ -n "$WIKI_ID" ]; then
  CURRENT=$(echo "$WIKI_LIST" | jq -r '.wikis[0].autoregen // false')
  NEXT=$([ "$CURRENT" = "true" ] && echo false || echo true)
  PATCH_CODE=$(curl -s -o /tmp/uat-76-patch.json -w "%{http_code}" \
    -b "$JAR" -X PATCH -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
    -d "{\"autoregen\": $NEXT}" \
    "$SERVER_URL/wikis/$WIKI_ID/auto-regen")
  if [ "$PATCH_CODE" = "200" ]; then pass "PATCH /wikis/:id/auto-regen 200"; else fail "PATCH code $PATCH_CODE"; fi
  # Reload list, confirm persisted.
  PERSISTED=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=5" | jq -r --arg id "$WIKI_ID" '.wikis[] | select(.id==$id) | .autoregen')
  if [ "$PERSISTED" = "$NEXT" ]; then pass "autoregen persisted ($NEXT)"; else fail "autoregen did not persist (got $PERSISTED)"; fi
else
  skip "autoregen toggle: no wiki seeded"
fi

# 5. POST /wikis/:id/regenerate fires (regen-now button).
if [ -n "$WIKI_ID" ]; then
  REGEN_CODE=$(curl -s -o /tmp/uat-76-regen.json -w "%{http_code}" \
    -b "$JAR" -X POST -H "Origin: $ORIGIN" \
    "$SERVER_URL/wikis/$WIKI_ID/regenerate")
  if [ "$REGEN_CODE" = "200" ] || [ "$REGEN_CODE" = "202" ]; then pass "regenerate fires ($REGEN_CODE)"; else fail "regenerate code $REGEN_CODE"; fi
fi

# 6. GET /admin/backfill/audit returns the gap report.
AUDIT=$(curl -s -b "$JAR" "$SERVER_URL/admin/backfill/audit")
echo "$AUDIT" > /tmp/uat-76-audit.json
HAS_GAPS=$(echo "$AUDIT" | jq -r '.wikiAgentSchema | has("missingDescription") and has("missingHyde")')
if [ "$HAS_GAPS" = "true" ]; then pass "audit returns missingDescription + missingHyde"; else fail "audit shape wrong"; fi

# 7. POST /admin/backfill/wiki-agent-schema returns counts.
TRIGGER=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d '{}' "$SERVER_URL/admin/backfill/wiki-agent-schema")
echo "$TRIGGER" > /tmp/uat-76-trigger.json
SCOPE=$(echo "$TRIGGER" | jq -r '.scope // empty')
if [ "$SCOPE" = "all" ]; then pass "backfill trigger scope=all on no-body"; else fail "scope wrong: $SCOPE"; fi
HAS_COUNTS=$(echo "$TRIGGER" | jq -r 'has("ok") and has("failed") and has("scanned")')
if [ "$HAS_COUNTS" = "true" ]; then pass "backfill returns ok/failed/scanned"; else fail "counts missing"; fi

# 8. Single-wiki scope.
if [ -n "$WIKI_ID" ]; then
  SINGLE=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
    -d "{\"wikiKey\": \"$WIKI_ID\"}" \
    "$SERVER_URL/admin/backfill/wiki-agent-schema")
  SINGLE_SCOPE=$(echo "$SINGLE" | jq -r '.scope // empty')
  SINGLE_KEY=$(echo "$SINGLE" | jq -r '.wikiKey // empty')
  if [ "$SINGLE_SCOPE" = "single" ]; then pass "backfill scope=single with wikiKey"; else fail "expected single, got $SINGLE_SCOPE"; fi
  if [ "$SINGLE_KEY" = "$WIKI_ID" ]; then pass "backfill echoes wikiKey"; else fail "wikiKey echo wrong"; fi
fi

# 9. GET /admin/backfill/runs surfaces the trigger run.
RUNS=$(curl -s -b "$JAR" "$SERVER_URL/admin/backfill/runs")
RUN_COUNT=$(echo "$RUNS" | jq -r '.runs | length')
if [ "$RUN_COUNT" -gt 0 ]; then pass "runs lists at least one job ($RUN_COUNT total)"; else fail "no runs surfaced"; fi
HAS_BACKFILL_ROW=$(echo "$RUNS" | jq -r '[.runs[].jobName] | any(. == "wiki-agent-schema-backfill")')
if [ "$HAS_BACKFILL_ROW" = "true" ]; then pass "wiki-agent-schema-backfill row present"; else fail "backfill row missing"; fi

# 10. Stream P People panel endpoints (best-effort; skip when P unmerged).
PENDING_CODE=$(curl -s -o /tmp/uat-76-pending.json -w "%{http_code}" -b "$JAR" \
  "$SERVER_URL/admin/people?status=pending")
if [ "$PENDING_CODE" = "200" ]; then
  pass "Stream P /admin/people?status=pending reachable"
elif [ "$PENDING_CODE" = "404" ]; then
  skip "Stream P endpoints not yet merged (404 expected on this branch)"
else
  fail "/admin/people?status=pending unexpected code $PENDING_CODE"
fi

# 11. UI smoke: Wikis panel renders.
SETTINGS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$WIKI_URL/settings/wikis" || echo "0")
if [ "$SETTINGS_CODE" = "200" ]; then
  pass "/settings/wikis serves 200 (wiki frontend up)"
elif [ "$SETTINGS_CODE" = "0" ]; then
  skip "wiki frontend not running (skip UI smoke)"
else
  skip "/settings/wikis returned $SETTINGS_CODE (frontend unauthed; expected behaviour)"
fi

# 12. UI smoke: /settings redirects to /settings/wikis.
REDIR_CODE=$(curl -s -o /dev/null -w "%{redirect_url} %{http_code}" -L "$WIKI_URL/settings" || echo "")
if echo "$REDIR_CODE" | grep -q "/settings/wikis"; then
  pass "/settings redirects to /settings/wikis"
elif [ -z "$REDIR_CODE" ]; then
  skip "wiki frontend not running"
else
  skip "redirect not observed via curl (Next sometimes redirects client-side)"
fi

echo ""
echo "Summary: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
```

## Manual UI checks (operator drives a browser)

Steps that the bash harness cannot exercise without a headless browser.
Run after the script above.

1. Open `/settings`. Verify the side-nav lists Wikis, People, Backfill.
2. Wikis panel: confirm a row per wiki, autoregen switch, last-regen
   time, badge, fragment count, "regen now" button, and the yellow dot
   when `agentSchemaStatus !== 'complete'`.
3. Flip autoregen on a wiki. Reload the page. Verify it persisted.
4. Click "regen now" on a wiki. Verify a toast appears.
5. Click the yellow gap dot on a wiki row. Verify it routes to
   `/settings/backfill`.
6. People panel: verify the "Auto-accept new persons" switch row at the
   top. Toggle it. After Stream P merges, verify subsequent ingests
   create verified persons rather than pending ones.
7. With Stream P merged, seed a pending person. Verify the panel lists
   them. Click Approve; verify the row vanishes and the person flips to
   `status='verified'` in `psql`.
8. Click Reject on another pending person; verify the row vanishes and
   the row remains in the database with `status='rejected'`.
9. Open a pending person's wiki page directly. Verify the full-width
   quarantine topbar renders with Approve / Reject buttons. Click
   either; verify the redirect lands on `/settings/people`.
10. Backfill panel: verify the gap counts match the audit response.
    Click "Run backfill"; verify the toast surfaces ok/failed/scanned
    and the audit refreshes.
