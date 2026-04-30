# 38 — Add Entry: send-direct + auto-date prefix (#235)

## What it proves

The `AddEntryModal` exposes both capture levers:

1. **Robin files it** (default) — the existing classify path through
   `POST /entries`.
2. **Send directly to a wiki** — picks a target wiki and posts to a
   classifier-bypass endpoint (`POST /fragments/log`) which routes the
   fragment straight to that wiki, mirroring the MCP `log_fragment` tool.

Plus auto-date-prefix on short captures: when the user picks a specific wiki
and types a body shorter than ~120 chars with no leading date, the system
prepends `YYMMDD: ` so chronological-table wiki types render the line.

POSITIVE: `POST /fragments/log` accepts `{ content, threadSlug }` and
returns the new fragment key wired into the chosen wiki; `AddEntryModal`
renders a wiki-picker control and an auto-date-prefix path.

NEGATIVE: pre-fix the `/fragments/log` route does not exist (404), and the
`AddEntryModal` source contains no wiki-picker control.

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

echo "38 — Add Entry: send-direct + auto-date prefix (#235)"

# ── A. UI source-grep ───────────────────────────────────────────────
MODAL=wiki/src/components/layout/AddEntryModal.tsx

if grep -qE 'Robin files it|filesItForYou|robinFiles' "$MODAL"; then
  pass "A1. modal exposes 'Robin files it' default option"
else
  fail "A1. modal does NOT expose 'Robin files it' option"
fi

if grep -qE 'Send.*directly|targetWiki|threadSlug|wiki picker|destination' "$MODAL"; then
  pass "A2. modal exposes wiki picker / send-direct option"
else
  fail "A2. modal has no wiki-picker / send-direct affordance"
fi

# ── B. /fragments/log endpoint exists ───────────────────────────────
SIGNIN=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$SIGNIN" != "200" ]; then
  fail "0. signin failed (HTTP $SIGNIN) — abort"
  echo "$PASS passed, $FAIL failed"; exit 1
fi
pass "0. signin OK"

# Pick any existing wiki for the smoke
THREAD_SLUG=$(curl -sf -b "$COOKIE" "$SERVER_URL/wikis?limit=5" | jq -r '.wikis[0].slug // empty')
if [ -z "$THREAD_SLUG" ]; then
  pass "B*. skipped — no existing wiki to log into"
else
  RUN_ID="$(date +%s)-$$"
  CONTENT="UAT38 direct fragment $RUN_ID"
  POST_LOG=$(curl -s -o /tmp/uat38-log.json -w "%{http_code}" -b "$COOKIE" -X POST \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$CONTENT" --arg s "$THREAD_SLUG" '{content:$c,threadSlug:$s}')" \
    "$SERVER_URL/fragments/log")
  if [ "$POST_LOG" = "200" ] || [ "$POST_LOG" = "201" ]; then
    pass "B1. POST /fragments/log returns $POST_LOG"
  else
    fail "B1. POST /fragments/log returned HTTP $POST_LOG"
    cat /tmp/uat38-log.json 2>/dev/null
  fi

  # Response shape mirrors handleLogFragment: fragmentKey + threadSlug.
  if jq -e '.fragmentKey // .fragment // empty' /tmp/uat38-log.json >/dev/null 2>&1; then
    pass "B2. response carries fragmentKey"
  else
    fail "B2. response does not carry fragmentKey — body: $(cat /tmp/uat38-log.json)"
  fi
fi

# ── C. Auto-date prefix helper ──────────────────────────────────────
# Implementation lives in the wiki frontend (formats short captures). We grep
# for the YYMMDD prefix string in the relevant module — fork commit aca5853.
if grep -rqE 'YYMMDD|datePrefix|prefixWithDate|autoDate' wiki/src/ 2>/dev/null; then
  pass "C1. auto-date prefix helper present in wiki/src"
else
  fail "C1. auto-date prefix helper missing"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
