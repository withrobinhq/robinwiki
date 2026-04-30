# 36 — Person dedup UX (#234)

## What it proves

Person dedup gets the three operational legs spelled out in the issue:

1. **Delete** — the existing soft-delete `DELETE /people/:id` is exposed in
   `PersonSettingsModal`. The button removes the person row and the page
   stays accessible until the redirect.
2. **Merge** — `POST /people/:id/merge { targetPersonId }` repoints
   `FRAGMENT_MENTIONS_PERSON` edges, appends source aliases to the target,
   rewrites `[[person:<source-slug>]]` references in non-deleted wiki bodies,
   soft-deletes the source, and writes an audit event. The UI exposes a
   merge action selecting a target.
3. **Manual Add Person** — `POST /people` accepts `{ name, aliases?,
   relationship? }`, returns 201 with the new row (verified=true,
   state=RESOLVED), 409 on canonical-name collision; the +Add Person UI
   surface fires it.

POSITIVE: each endpoint returns 2xx and the rows behave per-spec; the
PersonSettingsModal renders Delete + Merge buttons; AddPersonModal renders.

NEGATIVE: pre-fix, none of the three endpoints exist (404), and no
"Add Person" / "Merge" / "Delete" affordance appears in person UI source.

## Prerequisites

- core on `http://localhost:3000`, wiki on `http://localhost:8080`
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`
- `jq`, `curl`

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

echo "36 — Person dedup UX (#234)"

# Sign in
SIGNIN=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$SIGNIN" != "200" ]; then
  fail "0. signin failed (HTTP $SIGNIN) — abort"
  echo "$PASS passed, $FAIL failed"
  exit 1
fi
pass "0. signin OK"

# ── A. POST /people manual create ───────────────────────────────────
RUN_ID="$(date +%s)-$$"
NAME_A="UAT_PA_$RUN_ID"
NAME_B="UAT_PB_$RUN_ID"

CREATE_A=$(curl -s -o /tmp/uat36-a.json -w "%{http_code}" -b "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg n "$NAME_A" '{name:$n,aliases:["alpha"],relationship:"Colleague"}')" \
  "$SERVER_URL/people")
if [ "$CREATE_A" = "201" ] || [ "$CREATE_A" = "200" ]; then
  pass "A1. POST /people created person A (HTTP $CREATE_A)"
else
  fail "A1. POST /people returned HTTP $CREATE_A (want 201)"
fi

CREATE_A_VERIFIED=$(jq -r '.verified // empty' /tmp/uat36-a.json 2>/dev/null)
CREATE_A_STATE=$(jq -r '.state // empty' /tmp/uat36-a.json 2>/dev/null)
if [ "$CREATE_A_VERIFIED" = "true" ] && [ "$CREATE_A_STATE" = "RESOLVED" ]; then
  pass "A2. created row is verified=true state=RESOLVED"
else
  fail "A2. created row has verified=$CREATE_A_VERIFIED state=$CREATE_A_STATE"
fi

PERSON_A_ID=$(jq -r '.id // .lookupKey // empty' /tmp/uat36-a.json 2>/dev/null)

# 409 on duplicate
DUP_A=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg n "$NAME_A" '{name:$n}')" \
  "$SERVER_URL/people")
if [ "$DUP_A" = "409" ]; then
  pass "A3. duplicate name returns 409"
else
  fail "A3. duplicate name returned HTTP $DUP_A (want 409)"
fi

# Person B for merge
CREATE_B=$(curl -s -o /tmp/uat36-b.json -w "%{http_code}" -b "$COOKIE" -X POST \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg n "$NAME_B" '{name:$n,aliases:["beta"]}')" \
  "$SERVER_URL/people")
PERSON_B_ID=$(jq -r '.id // .lookupKey // empty' /tmp/uat36-b.json 2>/dev/null)

# ── B. POST /people/:id/merge ───────────────────────────────────────
if [ -n "$PERSON_A_ID" ] && [ -n "$PERSON_B_ID" ]; then
  MERGE=$(curl -s -o /tmp/uat36-merge.json -w "%{http_code}" -b "$COOKIE" -X POST \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$PERSON_A_ID" '{targetPersonId:$t}')" \
    "$SERVER_URL/people/$PERSON_B_ID/merge")
  if [ "$MERGE" = "200" ] || [ "$MERGE" = "204" ]; then
    pass "B1. POST /people/:id/merge OK (HTTP $MERGE)"
  else
    fail "B1. POST /people/:id/merge returned HTTP $MERGE"
    cat /tmp/uat36-merge.json 2>/dev/null
  fi

  # Source person should now be soft-deleted (404 on GET)
  GET_B=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" "$SERVER_URL/people/$PERSON_B_ID")
  if [ "$GET_B" = "404" ]; then
    pass "B2. merged source is soft-deleted (404 on GET)"
  else
    fail "B2. merged source returns HTTP $GET_B (want 404)"
  fi

  # Target should now have the source's aliases appended
  GET_A=$(curl -s -b "$COOKIE" "$SERVER_URL/people/$PERSON_A_ID")
  if echo "$GET_A" | jq -e '.aliases | index("beta")' >/dev/null; then
    pass "B3. target gained merged alias 'beta'"
  else
    fail "B3. target did NOT gain alias 'beta'"
  fi
else
  fail "B*. cannot test merge — A or B ID missing"
fi

# ── C. DELETE /people/:id (regression) ──────────────────────────────
if [ -n "$PERSON_A_ID" ]; then
  DEL=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" -X DELETE "$SERVER_URL/people/$PERSON_A_ID")
  if [ "$DEL" = "204" ]; then
    pass "C1. DELETE /people/:id returns 204"
  else
    fail "C1. DELETE /people/:id returned HTTP $DEL"
  fi
fi

# ── D. UI source-grep (modal exposes Delete + Merge + AddPerson) ────
PMODAL=wiki/src/components/layout/PersonSettingsModal.tsx
if grep -qE 'Delete' "$PMODAL"; then
  pass "D1. PersonSettingsModal has Delete affordance"
else
  fail "D1. PersonSettingsModal has no Delete affordance"
fi
if grep -qE 'Merge' "$PMODAL"; then
  pass "D2. PersonSettingsModal has Merge affordance"
else
  fail "D2. PersonSettingsModal has no Merge affordance"
fi

if [ -f wiki/src/components/layout/AddPersonModal.tsx ]; then
  pass "D3. AddPersonModal.tsx exists"
else
  fail "D3. AddPersonModal.tsx missing"
fi

# Header / +Add menu wires the new modal
if grep -rq "AddPersonModal" wiki/src/ 2>/dev/null; then
  pass "D4. AddPersonModal is referenced from another component"
else
  fail "D4. AddPersonModal is not wired up to any +Add affordance"
fi

# ── E. NEGATIVE — old fork before fix would have no merge endpoint ──
# Already covered by B1 going 200/204. But also confirm the schema file
# has createPersonBodySchema (added by the fix).
if grep -q "createPersonBodySchema" core/src/schemas/people.schema.ts; then
  pass "E1. createPersonBodySchema is exported from schemas/people"
else
  fail "E1. createPersonBodySchema absent from schemas/people"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
