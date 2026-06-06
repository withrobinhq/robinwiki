---
name: qa
description: Use when you need to run the Robin QA suite. Boots the Robin stack (postgres, redis, gateway, server), verifies health, captures logs, and reports ready status.
---

Run each step as a separate bash tool call. Steps 1-5 require `nix develop --command bash -c '...'` wrapper. Steps 6+ use standard tools (curl, jq) and do not need the wrapper.

---

## Step 1 -- Preflight check

```bash
nix develop --command bash -c '
  cd /home/me/source/.secondbrain
  command -v start >/dev/null 2>&1 || { echo "[fail] nix shell not active even after nix develop"; exit 1; }
  echo "[ok] nix dev shell active"
  echo "[info] QA run starting"
'
```

## Step 2 -- Clean previous run

```bash
pkill -f "tail -f .dev/server/server.log" 2>/dev/null || true
pkill -f "tail -f .dev/gateway/gateway.log" 2>/dev/null || true
nix develop --command bash -c '
  cd /home/me/source/.secondbrain
  rm -rf .qa/runs && mkdir -p .qa/runs
  echo "[ok] cleaned .qa/runs/"
'
```

## Step 3 -- Tear down existing services

```bash
nix develop --command bash -c '
  cd /home/me/source/.secondbrain
  stop
  echo "[ok] services stopped"
'
```

## Step 4 -- Boot infrastructure

```bash
nix develop --command bash -c '
  cd /home/me/source/.secondbrain
  start
  echo "[ok] postgres + redis started"
'
```

## Step 5 -- Boot applications

```bash
nix develop --command bash -c '
  cd /home/me/source/.secondbrain
  up
  echo "[ok] gateway + server started"
'
```

## Step 5.5 -- Verify server env (LLM keys, secrets)

```bash
# Find the tsx node process running the server
SRV_NODE_PID=$(pgrep -f 'tsx.*watch.*src/index.ts' 2>/dev/null | while read pid; do
  if grep -q 'secondbrain' /proc/$pid/cmdline 2>/dev/null; then echo "$pid"; break; fi
done)

if [ -z "$SRV_NODE_PID" ]; then
  echo "[warn] could not find server tsx process -- skipping env verification"
else
  # Extract process env and compare against apps/server/.env
  PROC_ENV=$(cat /proc/$SRV_NODE_PID/environ 2>/dev/null | tr '\0' '\n')
  DOTENV_FILE="apps/server/.env"
  MISMATCHED=""

  while IFS='=' read -r key value; do
    # Skip empty lines and comments
    [ -z "$key" ] && continue
    [[ "$key" =~ ^# ]] && continue

    # Get the value the server process actually has
    PROC_VAL=$(printf '%s\n' "$PROC_ENV" | grep "^${key}=" | head -1 | cut -d'=' -f2-)

    # Detect nix placeholder patterns
    if printf '%s\n' "$PROC_VAL" | grep -qE '(set-me|change-me|\$\{)'; then
      MISMATCHED="${MISMATCHED}  ${key}: process has '${PROC_VAL}', .env has '${value}'\n"
    fi
  done < "$DOTENV_FILE"

  if [ -n "$MISMATCHED" ]; then
    echo "[warn] server process has placeholder env vars (nix defaults shadowing .env):"
    echo -e "$MISMATCHED"
    echo "[fix] restarting server with correct env from apps/server/.env..."

    # Kill the server process tree
    SRV_PARENT_PID=$(cat .dev/server/server.pid 2>/dev/null)
    if [ -n "$SRV_PARENT_PID" ]; then
      kill "$SRV_PARENT_PID" 2>/dev/null
      sleep 1
      kill -9 "$SRV_PARENT_PID" 2>/dev/null || true
    fi
    # Also kill any remaining tsx processes for this project
    pgrep -f 'tsx.*watch.*src/index.ts' 2>/dev/null | while read pid; do
      if grep -q 'secondbrain' /proc/$pid/cmdline 2>/dev/null; then kill "$pid" 2>/dev/null; fi
    done
    sleep 1

    # Re-launch server with env vars sourced from apps/server/.env BEFORE nix gets to them
    (
      set -a
      source "$DOTENV_FILE"
      set +a
      cd apps/server && pnpm dev >> "../../.dev/server/server.log" 2>&1
    ) &
    echo $! > .dev/server/server.pid

    # Wait for server health
    for i in $(seq 1 30); do
      if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
        echo "[ok] server restarted with correct env (pid $(cat .dev/server/server.pid))"
        break
      fi
      if [ "$i" = "30" ]; then
        echo "[fail] server did not become healthy after env-fix restart"
        exit 1
      fi
      sleep 1
    done

    # Verify fix worked
    NEW_PID=$(pgrep -f 'tsx.*watch.*src/index.ts' 2>/dev/null | while read pid; do
      if grep -q 'secondbrain' /proc/$pid/cmdline 2>/dev/null; then echo "$pid"; break; fi
    done)
    if [ -n "$NEW_PID" ]; then
      STILL_BAD=$(cat /proc/$NEW_PID/environ 2>/dev/null | tr '\0' '\n' | grep -cE '(set-me|change-me)')
      if [ "$STILL_BAD" -gt 0 ]; then
        echo "[warn] ${STILL_BAD} placeholder(s) remain -- may cause LLM pipeline failures"
      else
        echo "[ok] all env vars verified clean"
      fi
    fi
  else
    echo "[ok] server env verified -- no placeholder values detected"
  fi
fi
```

## Step 6 -- Start log capture

```bash
tail -f .dev/server/server.log >> .qa/runs/server.log 2>/dev/null &
tail -f .dev/gateway/gateway.log >> .qa/runs/gateway.log 2>/dev/null &
echo "[ok] log capture started -> .qa/runs/"
```

## Step 7 -- Verify health

```bash
GW_HEALTH=$(curl -sf --max-time 5 http://localhost:9000/health 2>&1 || echo "CONNECTION_FAILED")
SRV_HEALTH=$(curl -sf --max-time 5 http://localhost:3000/health 2>&1 || echo "CONNECTION_FAILED")

if printf '%s\n' "$GW_HEALTH" | grep -q '"status":"ok"'; then
  echo "[ok] gateway -- healthy"
else
  echo "[fail] gateway -- health response: $GW_HEALTH"
  exit 1
fi

if printf '%s\n' "$SRV_HEALTH" | grep -q '"status":"ok"'; then
  echo "[ok] server -- healthy"
else
  echo "[fail] server -- health response: $SRV_HEALTH"
  exit 1
fi

pg_isready -h 127.0.0.1 -p 5432 -U robin > /dev/null 2>&1 \
  && echo "[ok] postgres -- healthy" \
  || { echo "[fail] postgres -- not accepting connections"; exit 1; }

redis-cli PING 2>/dev/null | grep -q PONG \
  && echo "[ok] redis -- healthy" \
  || { echo "[fail] redis -- no PONG response"; exit 1; }
```

## Step 8 -- Print status table

```bash
PG_PID=$(cat .dev/postgres/postgres.pid 2>/dev/null || echo "?")
RD_PID=$(cat .dev/redis/redis.pid 2>/dev/null || echo "?")
GW_PID=$(cat .dev/gateway/gateway.pid 2>/dev/null || echo "?")
SRV_PID=$(cat .dev/server/server.pid 2>/dev/null || echo "?")

printf "\nservice   | port | pid   | health\n"
printf "----------|------|-------|--------\n"
printf "postgres  | 5432 | %-5s | ok\n" "$PG_PID"
printf "redis     | 6379 | %-5s | ok\n" "$RD_PID"
printf "gateway   | 9000 | %-5s | ok\n" "$GW_PID"
printf "server    | 3000 | %-5s | ok\n" "$SRV_PID"
printf "\n[ok] all services healthy -- ready for QA\n"
```

## Step 9 -- Create QA user

```bash
COOKIE_JAR=$(mktemp /tmp/qa-cookies-XXXXXX.txt)
TS=$(date +%s)
QA_EMAIL="qa.robin.${TS}@robin.os"
QA_PASS="qa-password-${TS}"

SIGNUP_RESP=$(curl -sf -X POST http://localhost:3000/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -c "$COOKIE_JAR" \
  -d "{\"email\":\"${QA_EMAIL}\",\"password\":\"${QA_PASS}\",\"name\":\"QA Robot\"}" 2>&1 \
  || echo "SIGNUP_FAILED")

echo "[api] POST /api/auth/sign-up/email -> $SIGNUP_RESP"

if [ "$SIGNUP_RESP" = "SIGNUP_FAILED" ]; then
  echo "[fail] user signup failed"
  exit 1
fi

echo "[ok] user created: ${QA_EMAIL}"

# Wait for provision job (gitolite repo setup) to complete before vault creation
sleep 5
```

## Step 10 -- Create vaults

```bash
VAULT_WORK_RESP=$(curl -sf -X POST http://localhost:3000/vaults \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d '{"name":"Work","description":"Work-related notes and project tracking","color":"#3B82F6"}' 2>&1 \
  || echo "VAULT_FAILED")

echo "[api] POST http://localhost:3000/vaults (Work) -> $VAULT_WORK_RESP"

VAULT_WORK_ID=$(printf '%s\n' "$VAULT_WORK_RESP" | jq -r '.id // empty')
if [ -z "$VAULT_WORK_ID" ]; then
  echo "[fail] vault creation failed (Work)"
  exit 1
fi
echo "[ok] vault created: Work (${VAULT_WORK_ID})"

VAULT_PERSONAL_RESP=$(curl -sf -X POST http://localhost:3000/vaults \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d '{"name":"Personal","description":"Personal notes, goals, and interests","color":"#10B981"}' 2>&1 \
  || echo "VAULT_FAILED")

echo "[api] POST http://localhost:3000/vaults (Personal) -> $VAULT_PERSONAL_RESP"

VAULT_PERSONAL_ID=$(printf '%s\n' "$VAULT_PERSONAL_RESP" | jq -r '.id // empty')
if [ -z "$VAULT_PERSONAL_ID" ]; then
  echo "[fail] vault creation failed (Personal)"
  exit 1
fi
echo "[ok] vault created: Personal (${VAULT_PERSONAL_ID})"
```

## Step 11 -- Create threads

```bash
THREAD_WORK_RESP=$(curl -sf -X POST "http://localhost:3000/vaults/${VAULT_WORK_ID}/threads" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d '{"name":"Engineering Log","type":"log"}' 2>&1 \
  || echo "THREAD_FAILED")

echo "[api] POST /vaults/${VAULT_WORK_ID}/threads (Engineering Log) -> $THREAD_WORK_RESP"

THREAD_WORK_ID=$(printf '%s\n' "$THREAD_WORK_RESP" | jq -r '.id // empty')
if [ -z "$THREAD_WORK_ID" ]; then
  echo "[fail] thread creation failed (Engineering Log)"
  exit 1
fi
echo "[ok] thread created: Engineering Log (${THREAD_WORK_ID})"

THREAD_PERSONAL_RESP=$(curl -sf -X POST "http://localhost:3000/vaults/${VAULT_PERSONAL_ID}/threads" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d '{"name":"Home Projects","type":"project"}' 2>&1 \
  || echo "THREAD_FAILED")

echo "[api] POST /vaults/${VAULT_PERSONAL_ID}/threads (Home Projects) -> $THREAD_PERSONAL_RESP"

THREAD_PERSONAL_ID=$(printf '%s\n' "$THREAD_PERSONAL_RESP" | jq -r '.id // empty')
if [ -z "$THREAD_PERSONAL_ID" ]; then
  echo "[fail] thread creation failed (Home Projects)"
  exit 1
fi
echo "[ok] thread created: Home Projects (${THREAD_PERSONAL_ID})"
```

## Step 12 -- Create entries

```bash
# Entry 1: Work project note with vaultId
ENTRY_1_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"QA Run ${TS}: Sprint planning meeting notes. Discussed the new search indexing pipeline and assigned tasks for the gateway refactor. Key decisions: adopt HNSW for vector search, keep BM25 for keyword fallback. Action items: update Go gateway health endpoint, add fragment batch API.\",\"title\":\"Sprint Planning ${TS}\",\"vaultId\":\"${VAULT_WORK_ID}\",\"source\":\"api\",\"type\":\"thought\"}" 2>&1 \
  || echo -e "\nENTRY_FAILED")

ENTRY_1_CODE=$(printf '%s\n' "$ENTRY_1_RAW" | tail -1)
ENTRY_1_RESP=$(printf '%s\n' "$ENTRY_1_RAW" | head -n -1)
echo "[api] POST /entries (entry 1) HTTP ${ENTRY_1_CODE} -> $ENTRY_1_RESP"

ENTRY_1_ID=$(printf '%s\n' "$ENTRY_1_RESP" | jq -r '.id // empty')
if [ -z "$ENTRY_1_ID" ]; then
  echo "[fail] entry 1 creation failed"
  exit 1
fi
if [ "$ENTRY_1_CODE" = "200" ]; then
  echo "[warn] entry deduped: ${ENTRY_1_ID}"
else
  echo "[ok] entry created: ${ENTRY_1_ID}"
fi

# Entry 2: Unicode entry in Personal vault
ENTRY_2_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"QA Run ${TS}: Reading list for March 2026 → ✓ 'Designing Data-Intensive Applications' by Kleppmann ✓ 'The Art of PostgreSQL' by Fontaine α-testing notes: the search relevance model needs tuning for CJK characters (测试中文). Emoji test: 📚🚀✨\",\"title\":\"Reading List → March ${TS}\",\"vaultId\":\"${VAULT_PERSONAL_ID}\",\"source\":\"api\",\"type\":\"thought\"}" 2>&1 \
  || echo -e "\nENTRY_FAILED")

ENTRY_2_CODE=$(printf '%s\n' "$ENTRY_2_RAW" | tail -1)
ENTRY_2_RESP=$(printf '%s\n' "$ENTRY_2_RAW" | head -n -1)
echo "[api] POST /entries (entry 2 unicode) HTTP ${ENTRY_2_CODE} -> $ENTRY_2_RESP"

ENTRY_2_ID=$(printf '%s\n' "$ENTRY_2_RESP" | jq -r '.id // empty')
if [ -z "$ENTRY_2_ID" ]; then
  echo "[fail] entry 2 creation failed"
  exit 1
fi
if [ "$ENTRY_2_CODE" = "200" ]; then
  echo "[warn] entry deduped: ${ENTRY_2_ID}"
else
  echo "[ok] entry created: ${ENTRY_2_ID}"
fi

# Entry 3: Edge case — no title, no vaultId
ENTRY_3_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"QA Run ${TS}: Quick thought about improving the onboarding flow. The current signup takes too many steps. Could we reduce it to email-only with progressive profile building?\"}" 2>&1 \
  || echo -e "\nENTRY_FAILED")

ENTRY_3_CODE=$(printf '%s\n' "$ENTRY_3_RAW" | tail -1)
ENTRY_3_RESP=$(printf '%s\n' "$ENTRY_3_RAW" | head -n -1)
echo "[api] POST /entries (entry 3 edge-case) HTTP ${ENTRY_3_CODE} -> $ENTRY_3_RESP"

ENTRY_3_ID=$(printf '%s\n' "$ENTRY_3_RESP" | jq -r '.id // empty')
if [ -z "$ENTRY_3_ID" ]; then
  echo "[fail] entry 3 creation failed"
  exit 1
fi
if [ "$ENTRY_3_CODE" = "200" ]; then
  echo "[warn] entry deduped: ${ENTRY_3_ID}"
else
  echo "[ok] entry created: ${ENTRY_3_ID}"
fi
```

## Step 13 -- Poll entries to RESOLVED

```bash
wait_for_resolved() {
  local ENTRY_ID="$1"
  local MAX_WAIT=120
  local INTERVAL=3
  local ELAPSED=0
  echo "[poll] waiting for entry ${ENTRY_ID} to reach RESOLVED state..."
  while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATE=$(curl -sf -b "$COOKIE_JAR" "http://localhost:3000/entries/${ENTRY_ID}" 2>/dev/null | jq -r '.state // "UNKNOWN"')
    if [ "$STATE" = "RESOLVED" ]; then
      echo "[ok] entry ${ENTRY_ID} -> RESOLVED (${ELAPSED}s)"
      return 0
    fi
    echo "[poll] entry ${ENTRY_ID} state=${STATE}, waiting ${INTERVAL}s..."
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
  done
  echo "[warn] entry ${ENTRY_ID} did not reach RESOLVED after ${MAX_WAIT}s (last state=${STATE})"
  return 1
}

wait_for_resolved "$ENTRY_1_ID" || true
wait_for_resolved "$ENTRY_2_ID" || true
wait_for_resolved "$ENTRY_3_ID" || true
echo "[ok] entry polling complete"
```

## Step 14 -- Create fragments

```bash
# Fragment 1: Q1 Planning Notes — linked to Entry 1 (Work vault context)
# Wiki-links to: [[Engineering Log]], [[Weekly Standup Notes]]
FRAG_1_RESP=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "{\"title\":\"Q1 Planning Notes\",\"content\":\"Planning for Q1 2026. See [[Engineering Log]] for context and [[Weekly Standup Notes]] for action items.\nKey initiatives:\n- Adopt HNSW for vector search\n- Refactor gateway health endpoint\n- Launch beta by end of quarter\",\"entryId\":\"${ENTRY_1_ID}\",\"tags\":[\"planning\",\"productivity\",\"work\"]}" 2>&1 \
  || echo "FRAG_FAILED")

echo "[api] POST /fragments (Q1 Planning Notes) -> $FRAG_1_RESP"

FRAG_1_ID=$(printf '%s\n' "$FRAG_1_RESP" | jq -r '.id // empty')
if [ -z "$FRAG_1_ID" ]; then
  echo "[fail] fragment creation failed (Q1 Planning Notes)"
  exit 1
fi
echo "[ok] fragment created: ${FRAG_1_ID} -- \"Q1 Planning Notes\""

# Fragment 2: Engineering Log — linked to Entry 1 (Work vault context)
# Wiki-links back to: [[Q1 Planning Notes]]
FRAG_2_RESP=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "{\"title\":\"Engineering Log\",\"content\":\"Engineering log entry for QA run ${TS}. Referenced from [[Q1 Planning Notes]].\nRecent work:\n- Gateway HMAC auth implementation\n- BullMQ queue naming fix (hyphens not colons)\n- Content hash dedup on entries and fragments\",\"entryId\":\"${ENTRY_1_ID}\",\"tags\":[\"engineering\",\"productivity\",\"notes\"]}" 2>&1 \
  || echo "FRAG_FAILED")

echo "[api] POST /fragments (Engineering Log) -> $FRAG_2_RESP"

FRAG_2_ID=$(printf '%s\n' "$FRAG_2_RESP" | jq -r '.id // empty')
if [ -z "$FRAG_2_ID" ]; then
  echo "[fail] fragment creation failed (Engineering Log)"
  exit 1
fi
echo "[ok] fragment created: ${FRAG_2_ID} -- \"Engineering Log\""

# Fragment 3: Weekly Standup Notes — linked to Entry 2 (Personal vault context)
# Wiki-links to: [[Q1 Planning Notes]]
FRAG_3_RESP=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "{\"title\":\"Weekly Standup Notes\",\"content\":\"Standup notes for QA run ${TS}. Follow-up on [[Q1 Planning Notes]].\nDiscussed:\n- Reading list progress (see personal vault)\n- Search relevance tuning for CJK characters\n- Onboarding flow simplification ideas\",\"entryId\":\"${ENTRY_2_ID}\",\"tags\":[\"meetings\",\"productivity\",\"notes\"]}" 2>&1 \
  || echo "FRAG_FAILED")

echo "[api] POST /fragments (Weekly Standup Notes) -> $FRAG_3_RESP"

FRAG_3_ID=$(printf '%s\n' "$FRAG_3_RESP" | jq -r '.id // empty')
if [ -z "$FRAG_3_ID" ]; then
  echo "[fail] fragment creation failed (Weekly Standup Notes)"
  exit 1
fi
echo "[ok] fragment created: ${FRAG_3_ID} -- \"Weekly Standup Notes\""

# Fragment 4: Reading Goals — linked to Entry 2 (Personal vault context)
# Edge case: empty tags array
# Wiki-links to: [[Weekly Standup Notes]]
FRAG_4_RESP=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "{\"title\":\"Reading Goals\",\"content\":\"Personal reading goals for ${TS}. Tracking progress on technical books and papers. See also [[Weekly Standup Notes]] for discussion context.\",\"entryId\":\"${ENTRY_2_ID}\",\"tags\":[]}" 2>&1 \
  || echo "FRAG_FAILED")

echo "[api] POST /fragments (Reading Goals) -> $FRAG_4_RESP"

FRAG_4_ID=$(printf '%s\n' "$FRAG_4_RESP" | jq -r '.id // empty')
if [ -z "$FRAG_4_ID" ]; then
  echo "[fail] fragment creation failed (Reading Goals)"
  exit 1
fi
echo "[ok] fragment created: ${FRAG_4_ID} -- \"Reading Goals\""
```

## Step 15 -- Write fixture manifests

```bash
# Write fixtures.json — programmatic manifest for downstream test phases
cat > .qa/runs/fixtures.json << EOF
{
  "runId": "qa-${TS}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "cookieJarPath": "${COOKIE_JAR}",
  "user": {
    "email": "${QA_EMAIL}",
    "password": "${QA_PASS}",
    "response": ${SIGNUP_RESP}
  },
  "vaults": [
    { "name": "Work", "id": "${VAULT_WORK_ID}", "response": ${VAULT_WORK_RESP} },
    { "name": "Personal", "id": "${VAULT_PERSONAL_ID}", "response": ${VAULT_PERSONAL_RESP} }
  ],
  "threads": [
    { "name": "Engineering Log", "type": "log", "vaultId": "${VAULT_WORK_ID}", "id": "${THREAD_WORK_ID}", "response": ${THREAD_WORK_RESP} },
    { "name": "Home Projects", "type": "project", "vaultId": "${VAULT_PERSONAL_ID}", "id": "${THREAD_PERSONAL_ID}", "response": ${THREAD_PERSONAL_RESP} }
  ],
  "entries": [
    { "label": "work-project-note", "id": "${ENTRY_1_ID}", "originalBody": {"content":"QA Run ${TS}: Sprint planning meeting notes. Discussed the new search indexing pipeline and assigned tasks for the gateway refactor. Key decisions: adopt HNSW for vector search, keep BM25 for keyword fallback. Action items: update Go gateway health endpoint, add fragment batch API.","title":"Sprint Planning ${TS}","vaultId":"${VAULT_WORK_ID}","source":"api","type":"thought"}, "response": ${ENTRY_1_RESP} },
    { "label": "unicode-reading-list", "id": "${ENTRY_2_ID}", "originalBody": {"content":"QA Run ${TS}: Reading list for March 2026 → ✓ 'Designing Data-Intensive Applications' by Kleppmann ✓ 'The Art of PostgreSQL' by Fontaine α-testing notes: the search relevance model needs tuning for CJK characters (测试中文). Emoji test: 📚🚀✨","title":"Reading List → March ${TS}","vaultId":"${VAULT_PERSONAL_ID}","source":"api","type":"thought"}, "response": ${ENTRY_2_RESP} },
    { "label": "edge-case-no-title", "id": "${ENTRY_3_ID}", "originalBody": {"content":"QA Run ${TS}: Quick thought about improving the onboarding flow. The current signup takes too many steps. Could we reduce it to email-only with progressive profile building?"}, "response": ${ENTRY_3_RESP} }
  ],
  "fragments": [
    { "title": "Q1 Planning Notes", "id": "${FRAG_1_ID}", "entryId": "${ENTRY_1_ID}", "tags": ["planning","productivity","work"], "response": ${FRAG_1_RESP} },
    { "title": "Engineering Log", "id": "${FRAG_2_ID}", "entryId": "${ENTRY_1_ID}", "tags": ["engineering","productivity","notes"], "response": ${FRAG_2_RESP} },
    { "title": "Weekly Standup Notes", "id": "${FRAG_3_ID}", "entryId": "${ENTRY_2_ID}", "tags": ["meetings","productivity","notes"], "response": ${FRAG_3_RESP} },
    { "title": "Reading Goals", "id": "${FRAG_4_ID}", "entryId": "${ENTRY_2_ID}", "tags": [], "response": ${FRAG_4_RESP} }
  ]
}
EOF

# Validate and pretty-print — warn but do not abort on jq failure
jq . .qa/runs/fixtures.json > .qa/runs/fixtures.json.tmp 2>/dev/null \
  && mv .qa/runs/fixtures.json.tmp .qa/runs/fixtures.json \
  || { echo "[warn] fixtures.json may contain invalid JSON"; rm -f .qa/runs/fixtures.json.tmp; }

echo "[ok] fixtures.json written -> .qa/runs/fixtures.json"
```

## Step 16 -- Verify fixture manifest (FIXT-06)

```bash
# Validate fixture manifest written by Step 15
FIXTURES=$(cat .qa/runs/fixtures.json 2>/dev/null || echo "")
if [ -z "$FIXTURES" ]; then
  echo "[fail] fixtures.json missing or empty -- re-run Phase 2"
  exit 1
fi

VAULT_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.vaults | length')
THREAD_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.threads | length')
ENTRY_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.entries | length')
FRAG_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.fragments | length')

echo "[ok] fixture manifest verified:"
echo "  vaults:    ${VAULT_COUNT}"
echo "  threads:   ${THREAD_COUNT}"
echo "  entries:   ${ENTRY_COUNT}"
echo "  fragments: ${FRAG_COUNT}"
echo "[ok] FIXT-06 complete"
```

## Step 17 -- Initialize capture validation results

```bash
# Load fixtures from Phase 2
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')

# Verify cookie jar exists
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[fail] cookie jar not found at ${COOKIE_JAR} — re-run full QA"
  exit 1
fi

# Load entity IDs from fixtures
ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id')
ENTRY_2_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[1].id')
ENTRY_3_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[2].id')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id')
FRAG_2_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[1].id')
FRAG_3_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[2].id')
FRAG_4_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[3].id')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[0].id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[1].id')

# Load original entry content for dedup tests (exact content from Phase 2 fixture)
ENTRY_1_CONTENT=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.content')
ENTRY_1_TITLE=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.title')
ENTRY_1_VAULT=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.vaultId')
ENTRY_1_LOOKUPKEY=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.lookupKey')

# Load original fragment content for dedup tests
FRAG_1_CONTENT=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].response.content')
FRAG_1_TITLE=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].response.title')
FRAG_1_ENTRY_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].entryId')
FRAG_1_TAGS=$(printf '%s\n' "$FIXTURES" | jq -c '.fragments[0].tags')
FRAG_1_LOOKUPKEY=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].response.lookupKey')

# Initialize results array
RESULTS='[]'

# Write shared helpers to file
cat > .qa/runs/helpers.sh << 'HELPERSEOF'
record_result() {
  RESULTS=$(printf '%s\n' "$RESULTS" | jq --arg r "$1" --arg s "$2" --arg d "$3" --argjson resp "${4:-null}" \
    '. += [{"reqId": $r, "status": $s, "detail": $d, "response": $resp}]')
}
check_hard_failure() {
  if [ "$1" = "000" ] || [ "$1" = "500" ] || [ "$1" = "502" ] || [ "$1" = "503" ]; then
    echo "[halt] hard failure at $2: HTTP $1"
    printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/capture-storage-results.json
    exit 1
  fi
}
HELPERSEOF

source .qa/runs/helpers.sh

echo "[ok] capture validation initialized — ${ENTRY_1_ID}, ${ENTRY_2_ID}, ${ENTRY_3_ID}"
echo "[ok] cookie jar: ${COOKIE_JAR}"
```

## Step 18 -- Capture happy-path tests (CAPT-01, CAPT-03, CAPT-04)

```bash
TS=$(date +%s)

# --- CAPT-01: POST /entries returns 202 with status 'queued' ---
CAPT01_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"Phase 3 capture test ${TS}: validating entry submission returns 202 with queued status.\",\"title\":\"Capture Test ${TS}\",\"vaultId\":\"${VAULT_WORK_ID}\",\"source\":\"api\",\"type\":\"thought\"}")

CAPT01_CODE=$(printf '%s\n' "$CAPT01_RAW" | tail -1)
CAPT01_RESP=$(printf '%s\n' "$CAPT01_RAW" | head -n -1)
CAPT01_STATUS=$(printf '%s\n' "$CAPT01_RESP" | jq -r '.status // empty')
CAPT01_ID=$(printf '%s\n' "$CAPT01_RESP" | jq -r '.id // empty')

check_hard_failure "$CAPT01_CODE" "CAPT-01 POST /entries"

if [ "$CAPT01_CODE" = "202" ] && [ "$CAPT01_STATUS" = "queued" ]; then
  echo "[ok] CAPT-01: POST /entries -> 202, status=queued, id=${CAPT01_ID}"
  record_result "CAPT-01" "pass" "POST /entries returned 202 with status=queued" "$CAPT01_RESP"
else
  echo "[fail] CAPT-01: expected 202/queued, got ${CAPT01_CODE}/${CAPT01_STATUS}"
  record_result "CAPT-01" "failure" "Expected 202/queued, got ${CAPT01_CODE}/${CAPT01_STATUS}" "$CAPT01_RESP"
fi

# Store for CAPT-03 and CAPT-04 (need to let the entry resolve first)
CAPT_TEST_ENTRY_ID="$CAPT01_ID"
CAPT_TEST_CONTENT="Phase 3 capture test ${TS}: validating entry submission returns 202 with queued status."

# Brief wait for entry to be processed
sleep 3

# --- CAPT-03: Entry appears in GET /entries list ---
CAPT03_RAW=$(curl -sf http://localhost:3000/entries \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

CAPT03_CODE=$(printf '%s\n' "$CAPT03_RAW" | tail -1)
CAPT03_RESP=$(printf '%s\n' "$CAPT03_RAW" | head -n -1)

check_hard_failure "$CAPT03_CODE" "CAPT-03 GET /entries"

CAPT03_FOUND=$(printf '%s\n' "$CAPT03_RESP" | jq --arg id "$CAPT_TEST_ENTRY_ID" '.entries[] | select(.id == $id) | .id' 2>/dev/null)

if [ "$CAPT03_CODE" = "200" ] && [ -n "$CAPT03_FOUND" ]; then
  echo "[ok] CAPT-03: entry ${CAPT_TEST_ENTRY_ID} found in GET /entries list"
  record_result "CAPT-03" "pass" "Entry ${CAPT_TEST_ENTRY_ID} found in GET /entries list" "$CAPT03_RESP"
else
  echo "[fail] CAPT-03: entry ${CAPT_TEST_ENTRY_ID} not found in GET /entries (HTTP ${CAPT03_CODE})"
  record_result "CAPT-03" "failure" "Entry not found in list (HTTP ${CAPT03_CODE})" "$CAPT03_RESP"
fi

# --- CAPT-04: Content preserved exactly as submitted ---
CAPT04_RAW=$(curl -sf "http://localhost:3000/entries/${CAPT_TEST_ENTRY_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

CAPT04_CODE=$(printf '%s\n' "$CAPT04_RAW" | tail -1)
CAPT04_RESP=$(printf '%s\n' "$CAPT04_RAW" | head -n -1)

check_hard_failure "$CAPT04_CODE" "CAPT-04 GET /entries/:id"

CAPT04_CONTENT=$(printf '%s\n' "$CAPT04_RESP" | jq -r '.content // empty')

if [ "$CAPT04_CODE" = "200" ] && [ "$CAPT04_CONTENT" = "$CAPT_TEST_CONTENT" ]; then
  echo "[ok] CAPT-04: content preserved exactly as submitted"
  record_result "CAPT-04" "pass" "Content preserved verbatim in GET /entries/:id" "$CAPT04_RESP"
else
  echo "[fail] CAPT-04: content mismatch or bad status (HTTP ${CAPT04_CODE})"
  record_result "CAPT-04" "failure" "Content mismatch or bad HTTP status ${CAPT04_CODE}" "$CAPT04_RESP"
fi

# Append new capture test entry to fixtures.json (D-14 pattern)
FIXTURES=$(cat .qa/runs/fixtures.json)
printf '%s\n' "$FIXTURES" | jq --arg id "$CAPT_TEST_ENTRY_ID" --argjson resp "$CAPT01_RESP" \
  '.entries += [{"label": "phase3-capture-test", "id": $id, "response": $resp}]' \
  > .qa/runs/fixtures.json.tmp \
  && mv .qa/runs/fixtures.json.tmp .qa/runs/fixtures.json

echo "[ok] Step 18 complete — CAPT-01, CAPT-03, CAPT-04 checked"
```

## Step 19 -- Dedup verification (CAPT-02)

```bash
# === Dedup Verification Section (D-05) ===

# Re-load fixtures in case this step runs in a new shell
FIXTURES=$(cat .qa/runs/fixtures.json)
ENTRY_1_LOOKUPKEY=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.lookupKey')
ENTRY_1_TITLE=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.title')
ENTRY_1_VAULT=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].response.vaultId')
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
source .qa/runs/helpers.sh

# --- CAPT-02: Entry dedup — re-POST identical content ---
# Re-submit exact ORIGINAL body from Phase 2 entry[0] (D-01)
# Uses originalBody (pre-pipeline) not response (post-pipeline) to avoid
# title/field mutations from the agent pipeline breaking the dedup test.
CAPT02_BODY=$(printf '%s\n' "$FIXTURES" | jq '.entries[0].originalBody')

CAPT02_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "$CAPT02_BODY")

CAPT02_CODE=$(printf '%s\n' "$CAPT02_RAW" | tail -1)
CAPT02_RESP=$(printf '%s\n' "$CAPT02_RAW" | head -n -1)
CAPT02_STATUS=$(printf '%s\n' "$CAPT02_RESP" | jq -r '.status // empty')
CAPT02_LOOKUPKEY=$(printf '%s\n' "$CAPT02_RESP" | jq -r '.lookupKey // empty')

check_hard_failure "$CAPT02_CODE" "CAPT-02 entry dedup"

if [ "$CAPT02_CODE" = "200" ] && [ "$CAPT02_STATUS" = "duplicate" ] && [ "$CAPT02_LOOKUPKEY" = "$ENTRY_1_LOOKUPKEY" ]; then
  echo "[ok] CAPT-02: dedup detected — 200, status=duplicate, lookupKey matches original (${ENTRY_1_LOOKUPKEY})"
  record_result "CAPT-02" "pass" "Dedup returned 200, status=duplicate, lookupKey=${ENTRY_1_LOOKUPKEY}" "$CAPT02_RESP"
elif [ "$CAPT02_CODE" = "200" ] && [ "$CAPT02_STATUS" = "duplicate" ]; then
  echo "[concern] CAPT-02: dedup detected but lookupKey mismatch — got ${CAPT02_LOOKUPKEY}, expected ${ENTRY_1_LOOKUPKEY}"
  record_result "CAPT-02" "concern" "Dedup 200 but lookupKey mismatch: got ${CAPT02_LOOKUPKEY}, expected ${ENTRY_1_LOOKUPKEY}" "$CAPT02_RESP"
else
  echo "[fail] CAPT-02: expected 200/duplicate, got ${CAPT02_CODE}/${CAPT02_STATUS}"
  record_result "CAPT-02" "failure" "Expected 200/duplicate, got ${CAPT02_CODE}/${CAPT02_STATUS}" "$CAPT02_RESP"
fi

# --- Near-miss dedup test (D-03) — same title, different content ---
NEARMISS_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"Near-miss dedup test: this body is entirely different from the original entry but shares the same title. Content hash should NOT match because the body text is unique.\",\"title\":\"${ENTRY_1_TITLE}\",\"vaultId\":\"${ENTRY_1_VAULT}\",\"source\":\"api\",\"type\":\"thought\"}")

NEARMISS_CODE=$(printf '%s\n' "$NEARMISS_RAW" | tail -1)
NEARMISS_RESP=$(printf '%s\n' "$NEARMISS_RAW" | head -n -1)
NEARMISS_STATUS=$(printf '%s\n' "$NEARMISS_RESP" | jq -r '.status // empty')

check_hard_failure "$NEARMISS_CODE" "near-miss dedup"

if [ "$NEARMISS_CODE" = "202" ] && [ "$NEARMISS_STATUS" = "queued" ]; then
  echo "[ok] near-miss: same title + different content -> new entry (202/queued), not duplicate"
  record_result "CAPT-02-nearmiss" "pass" "Near-miss correctly created as new entry (202/queued)" "$NEARMISS_RESP"
else
  echo "[concern] near-miss: expected 202/queued for different content, got ${NEARMISS_CODE}/${NEARMISS_STATUS}"
  record_result "CAPT-02-nearmiss" "concern" "Expected 202/queued, got ${NEARMISS_CODE}/${NEARMISS_STATUS}" "$NEARMISS_RESP"
fi

echo "[ok] Step 19 complete — dedup verification done"
```

## Step 20 -- MCP entry path (CAPT-05)

```bash
# --- CAPT-05: MCP entry path via log_entry tool ---

# Defensive re-load for cross-session safety (gap fix: helpers dependency)
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
source .qa/runs/helpers.sh

# D-07: Get MCP URL from user profile
PROFILE_RAW=$(curl -sf http://localhost:3000/users/profile \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

PROFILE_CODE=$(printf '%s\n' "$PROFILE_RAW" | tail -1)
PROFILE_RESP=$(printf '%s\n' "$PROFILE_RAW" | head -n -1)

check_hard_failure "$PROFILE_CODE" "CAPT-05 GET /users/profile"

MCP_URL=$(printf '%s\n' "$PROFILE_RESP" | jq -r '.mcpEndpointUrl // empty')

if [ -z "$MCP_URL" ]; then
  echo "[fail] CAPT-05: no mcpEndpointUrl in profile response"
  record_result "CAPT-05" "failure" "No mcpEndpointUrl in GET /users/profile response" "$PROFILE_RESP"
else
  echo "[ok] MCP URL obtained: ${MCP_URL}"

  # D-08: Construct JSON-RPC payload for log_entry tool
  MCP_CONTENT="MCP test entry from Phase 3 QA run $(date +%s): validating MCP capture path creates entries visible via REST API."

  # D-06: Full MCP protocol — POST JSON-RPC to MCP endpoint
  MCP_RAW=$(curl -sf -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -w "\n%{http_code}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"log_entry\",\"arguments\":{\"content\":\"${MCP_CONTENT}\",\"source\":\"mcp\"}}}")

  MCP_CODE=$(printf '%s\n' "$MCP_RAW" | tail -1)
  MCP_RESP=$(printf '%s\n' "$MCP_RAW" | head -n -1)

  check_hard_failure "$MCP_CODE" "CAPT-05 MCP tools/call"

  if [ "$MCP_CODE" = "200" ]; then
    # D-09: Extract entry ID from MCP response text
    # MCP returns { content: [{ type: "text", text: "..." }] } or JSON-RPC result wrapper
    MCP_TEXT=$(printf '%s\n' "$MCP_RESP" | jq -r '.result.content[0].text // .content[0].text // empty' 2>/dev/null)
    # Lookup key format: {prefix}{ULID} — no hyphen, 26-char Crockford Base32
    # Canonical pattern from packages/shared/src/identity.ts LOOKUP_KEY_RE
    MCP_ENTRY_ID=$(printf '%s\n' "$MCP_TEXT" | grep -oP 'entry[0-9A-Z]{26}' | head -1)

    if [ -z "$MCP_ENTRY_ID" ]; then
      # Fallback: try to find entry lookup key anywhere in response
      MCP_ENTRY_ID=$(printf '%s\n' "$MCP_RESP" | grep -oP 'entry[0-9A-Z]{26}' | head -1)
    fi

    if [ -n "$MCP_ENTRY_ID" ]; then
      # Verify MCP entry via REST GET /entries/:id
      sleep 2
      MCP_VERIFY_RAW=$(curl -sf "http://localhost:3000/entries/${MCP_ENTRY_ID}" \
        -H "Origin: http://localhost:3000" \
        -b "$COOKIE_JAR" \
        -w "\n%{http_code}")

      MCP_VERIFY_CODE=$(printf '%s\n' "$MCP_VERIFY_RAW" | tail -1)
      MCP_VERIFY_RESP=$(printf '%s\n' "$MCP_VERIFY_RAW" | head -n -1)

      if [ "$MCP_VERIFY_CODE" = "200" ]; then
        echo "[ok] CAPT-05: MCP entry ${MCP_ENTRY_ID} verified via GET /entries/:id"
        record_result "CAPT-05" "pass" "MCP log_entry created ${MCP_ENTRY_ID}, verified via REST GET" "$MCP_VERIFY_RESP"
      else
        echo "[concern] CAPT-05: MCP entry ${MCP_ENTRY_ID} created but GET returned ${MCP_VERIFY_CODE}"
        record_result "CAPT-05" "concern" "MCP entry created but REST GET returned ${MCP_VERIFY_CODE}" "$MCP_VERIFY_RESP"
      fi
    else
      echo "[concern] CAPT-05: MCP returned 200 but could not extract entry ID from response"
      record_result "CAPT-05" "concern" "MCP 200 but no entry-ULID in response text" "$MCP_RESP"
    fi
  else
    echo "[fail] CAPT-05: MCP tools/call returned HTTP ${MCP_CODE}"
    record_result "CAPT-05" "failure" "MCP tools/call returned HTTP ${MCP_CODE}" "$MCP_RESP"
  fi
fi

# Write final capture-storage results to file
printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/capture-storage-results.json

echo "[ok] Step 20 complete — MCP entry path tested"
echo "[ok] capture-storage-results.json written -> .qa/runs/capture-storage-results.json"
```

## Step 21 -- Fragment lifecycle tests (STOR-01, STOR-02, STOR-03, STOR-04)

```bash
# Re-load fixtures and helpers in case this step runs in a new shell
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id')
RESULTS='[]'
source .qa/runs/helpers.sh

# --- STOR-01: Fragment creation via POST /fragments ---
STOR01_RAW=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"title\":\"Storage Test Fragment\",\"content\":\"Phase 3 storage test: validating fragment creation returns 201 with correct schema. See [[Q1 Planning Notes]] for cross-reference.\",\"entryId\":\"${ENTRY_1_ID}\",\"tags\":[\"test\",\"storage\"]}")

STOR01_CODE=$(printf '%s\n' "$STOR01_RAW" | tail -1)
STOR01_RESP=$(printf '%s\n' "$STOR01_RAW" | head -n -1)
STOR01_ID=$(printf '%s\n' "$STOR01_RESP" | jq -r '.id // empty')
STOR01_SLUG=$(printf '%s\n' "$STOR01_RESP" | jq -r '.slug // empty')

check_hard_failure "$STOR01_CODE" "STOR-01 POST /fragments"

# Check required fields exist in response
STOR01_HAS_FIELDS=$(printf '%s\n' "$STOR01_RESP" | jq 'has("id") and has("lookupKey") and has("slug") and has("title") and has("content") and has("tags") and has("state") and has("repoPath")')

if [ "$STOR01_CODE" = "201" ] && [ "$STOR01_HAS_FIELDS" = "true" ]; then
  echo "[ok] STOR-01: POST /fragments -> 201, all schema fields present, id=${STOR01_ID}"
  record_result "STOR-01" "pass" "Fragment created with 201, all schema fields present" "$STOR01_RESP"
else
  echo "[fail] STOR-01: expected 201 with all fields, got ${STOR01_CODE}, fields_ok=${STOR01_HAS_FIELDS}"
  record_result "STOR-01" "failure" "Expected 201 + all fields, got ${STOR01_CODE}, fields=${STOR01_HAS_FIELDS}" "$STOR01_RESP"
fi

# --- STOR-02: Wiki-link [[Title]] preserved in content ---
# Read back the fragment we just created — it has [[Q1 Planning Notes]] in content
STOR02_RAW=$(curl -sf "http://localhost:3000/fragments/${STOR01_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

STOR02_CODE=$(printf '%s\n' "$STOR02_RAW" | tail -1)
STOR02_RESP=$(printf '%s\n' "$STOR02_RAW" | head -n -1)
STOR02_CONTENT=$(printf '%s\n' "$STOR02_RESP" | jq -r '.content // empty')

check_hard_failure "$STOR02_CODE" "STOR-02 GET /fragments/:id"

if printf '%s\n' "$STOR02_CONTENT" | grep -q '\[\[Q1 Planning Notes\]\]'; then
  echo "[ok] STOR-02: wiki-link [[Q1 Planning Notes]] preserved in fragment content"
  record_result "STOR-02" "pass" "Wiki-link [[Q1 Planning Notes]] preserved in content round-trip" "$STOR02_RESP"
else
  echo "[fail] STOR-02: wiki-link [[Q1 Planning Notes]] not found in content"
  record_result "STOR-02" "failure" "Wiki-link not found in content: ${STOR02_CONTENT}" "$STOR02_RESP"
fi

# --- STOR-04: Fragment GET returns content from gateway ---
# Use Phase 2 fragment (FRAG_1_ID) to verify content read from gateway
STOR04_RAW=$(curl -sf "http://localhost:3000/fragments/${FRAG_1_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

STOR04_CODE=$(printf '%s\n' "$STOR04_RAW" | tail -1)
STOR04_RESP=$(printf '%s\n' "$STOR04_RAW" | head -n -1)
STOR04_CONTENT=$(printf '%s\n' "$STOR04_RESP" | jq -r '.content // empty')

check_hard_failure "$STOR04_CODE" "STOR-04 GET /fragments/:id"

if [ "$STOR04_CODE" = "200" ] && [ -n "$STOR04_CONTENT" ] && [ "$STOR04_CONTENT" != "null" ]; then
  echo "[ok] STOR-04: GET /fragments/${FRAG_1_ID} returned content from gateway (${#STOR04_CONTENT} chars)"
  record_result "STOR-04" "pass" "Fragment detail returned content from gateway (${#STOR04_CONTENT} chars)" "$STOR04_RESP"
elif [ "$STOR04_CODE" = "200" ] && [ -z "$STOR04_CONTENT" ]; then
  echo "[observation] STOR-04: GET /fragments/${FRAG_1_ID} returned empty content (gateway may have failed during write)"
  record_result "STOR-04" "observation" "Fragment returned but content is empty (fail-open gateway read)" "$STOR04_RESP"
else
  echo "[fail] STOR-04: GET /fragments/${FRAG_1_ID} returned HTTP ${STOR04_CODE}"
  record_result "STOR-04" "failure" "Fragment GET returned HTTP ${STOR04_CODE}" "$STOR04_RESP"
fi

# --- STOR-03: Fragment PUT update reflects in subsequent GET ---
STOR03_RAW=$(curl -sf -X PUT "http://localhost:3000/fragments/${STOR01_ID}" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d '{"title":"Storage Test Fragment (Updated)","content":"UPDATED: Phase 3 storage test content after PUT. See [[Q1 Planning Notes]] still.","tags":["test","storage","updated"]}')

STOR03_PUT_CODE=$(printf '%s\n' "$STOR03_RAW" | tail -1)
STOR03_PUT_RESP=$(printf '%s\n' "$STOR03_RAW" | head -n -1)

check_hard_failure "$STOR03_PUT_CODE" "STOR-03 PUT /fragments/:id"

# Re-read to verify update
STOR03_GET_RAW=$(curl -sf "http://localhost:3000/fragments/${STOR01_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

STOR03_GET_CODE=$(printf '%s\n' "$STOR03_GET_RAW" | tail -1)
STOR03_GET_RESP=$(printf '%s\n' "$STOR03_GET_RAW" | head -n -1)
STOR03_GET_TITLE=$(printf '%s\n' "$STOR03_GET_RESP" | jq -r '.title // empty')
STOR03_GET_CONTENT=$(printf '%s\n' "$STOR03_GET_RESP" | jq -r '.content // empty')

if [ "$STOR03_PUT_CODE" = "200" ] && printf '%s\n' "$STOR03_GET_TITLE" | grep -q "(Updated)"; then
  echo "[ok] STOR-03: PUT updated title reflected in GET — '${STOR03_GET_TITLE}'"
  record_result "STOR-03" "pass" "PUT /fragments/:id update reflected in GET (title contains '(Updated)')" "$STOR03_GET_RESP"
else
  echo "[fail] STOR-03: PUT ${STOR03_PUT_CODE}, GET title='${STOR03_GET_TITLE}' — update not reflected"
  record_result "STOR-03" "failure" "PUT ${STOR03_PUT_CODE}, GET title=${STOR03_GET_TITLE}" "$STOR03_GET_RESP"
fi

# Save STOR01_ID for Step 22 (dedup test needs a fragment to re-post)
echo "$STOR01_ID" > /tmp/qa-stor01-id.txt

# Flush STOR results to capture-storage-results.json (gap fix: STOR data loss)
if [ -f .qa/runs/capture-storage-results.json ]; then
  _PRIOR=$(cat .qa/runs/capture-storage-results.json)
else
  _PRIOR='[]'
fi
_MERGED=$(printf '%s\n' "$_PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
printf '%s\n' "$_MERGED" | jq '.' > .qa/runs/capture-storage-results.json.tmp \
  && mv .qa/runs/capture-storage-results.json.tmp .qa/runs/capture-storage-results.json \
  || echo "[warn] Step 21 results flush failed"

echo "[ok] Step 21 complete — STOR-01, STOR-02, STOR-03, STOR-04 checked"
```

## Step 22 -- Fragment dedup and slug collision tests (STOR-05, STOR-06)

```bash
# Re-load fixtures and helpers in case this step runs in a new shell
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id')
FRAG_1_LOOKUPKEY=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].response.lookupKey')
RESULTS='[]'
source .qa/runs/helpers.sh

# --- STOR-05: Fragment dedup — re-POST identical content (D-02) ---
# Must include content field to trigger dedup check
STOR05_BODY=$(printf '%s\n' "$FIXTURES" | jq '{
  title: .fragments[0].response.title,
  content: .fragments[0].response.content,
  entryId: .fragments[0].entryId,
  tags: .fragments[0].tags
}')

STOR05_RAW=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "$STOR05_BODY")

STOR05_CODE=$(printf '%s\n' "$STOR05_RAW" | tail -1)
STOR05_RESP=$(printf '%s\n' "$STOR05_RAW" | head -n -1)
STOR05_LOOKUPKEY=$(printf '%s\n' "$STOR05_RESP" | jq -r '.lookupKey // empty')

check_hard_failure "$STOR05_CODE" "STOR-05 fragment dedup"

if [ "$STOR05_CODE" = "200" ] && [ "$STOR05_LOOKUPKEY" = "$FRAG_1_LOOKUPKEY" ]; then
  echo "[ok] STOR-05: fragment dedup detected — 200, lookupKey matches original (${FRAG_1_LOOKUPKEY})"
  record_result "STOR-05" "pass" "Fragment dedup returned 200, lookupKey=${FRAG_1_LOOKUPKEY}" "$STOR05_RESP"
elif [ "$STOR05_CODE" = "200" ]; then
  echo "[concern] STOR-05: fragment dedup 200 but lookupKey mismatch — got ${STOR05_LOOKUPKEY}, expected ${FRAG_1_LOOKUPKEY}"
  record_result "STOR-05" "concern" "Dedup 200 but lookupKey mismatch: ${STOR05_LOOKUPKEY} vs ${FRAG_1_LOOKUPKEY}" "$STOR05_RESP"
else
  echo "[fail] STOR-05: expected 200 for duplicate, got ${STOR05_CODE}"
  record_result "STOR-05" "failure" "Expected 200 for duplicate, got ${STOR05_CODE}" "$STOR05_RESP"
fi

# --- STOR-06: Slug collision tests — BOTH entries AND fragments (D-11, D-12, D-13) ---
COLLISION_TITLE="Collision Test Alpha"

# Entry slug collisions — 3 entries with identical title, different content
EC1_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"Entry collision body 1 — unique content for slug test alpha\",\"title\":\"${COLLISION_TITLE}\",\"source\":\"api\",\"type\":\"thought\"}")
EC1_CODE=$(printf '%s\n' "$EC1_RAW" | tail -1)
EC1_RESP=$(printf '%s\n' "$EC1_RAW" | head -n -1)
EC1_SLUG=$(printf '%s\n' "$EC1_RESP" | jq -r '.slug // empty')
EC1_ID=$(printf '%s\n' "$EC1_RESP" | jq -r '.id // empty')
check_hard_failure "$EC1_CODE" "STOR-06 entry collision 1"

EC2_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"Entry collision body 2 — different content same title for slug dedup test\",\"title\":\"${COLLISION_TITLE}\",\"source\":\"api\",\"type\":\"thought\"}")
EC2_CODE=$(printf '%s\n' "$EC2_RAW" | tail -1)
EC2_RESP=$(printf '%s\n' "$EC2_RAW" | head -n -1)
EC2_SLUG=$(printf '%s\n' "$EC2_RESP" | jq -r '.slug // empty')
EC2_ID=$(printf '%s\n' "$EC2_RESP" | jq -r '.id // empty')
check_hard_failure "$EC2_CODE" "STOR-06 entry collision 2"

EC3_RAW=$(curl -sf -X POST http://localhost:3000/entries \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"content\":\"Entry collision body 3 — third distinct body to trigger slug suffix\",\"title\":\"${COLLISION_TITLE}\",\"source\":\"api\",\"type\":\"thought\"}")
EC3_CODE=$(printf '%s\n' "$EC3_RAW" | tail -1)
EC3_RESP=$(printf '%s\n' "$EC3_RAW" | head -n -1)
EC3_SLUG=$(printf '%s\n' "$EC3_RESP" | jq -r '.slug // empty')
EC3_ID=$(printf '%s\n' "$EC3_RESP" | jq -r '.id // empty')
check_hard_failure "$EC3_CODE" "STOR-06 entry collision 3"

echo "[info] entry slugs: ${EC1_SLUG}, ${EC2_SLUG}, ${EC3_SLUG}"

# Verify entry slug pattern: base, base-2, base-3
ENTRY_SLUG_OK="false"
if printf '%s\n' "$EC2_SLUG" | grep -q '\-2$' && printf '%s\n' "$EC3_SLUG" | grep -q '\-3$'; then
  ENTRY_SLUG_OK="true"
fi

# D-13: Verify each entry is independently retrievable
EC1_GET=$(curl -sf "http://localhost:3000/entries/${EC1_ID}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" -w "\n%{http_code}")
EC2_GET=$(curl -sf "http://localhost:3000/entries/${EC2_ID}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" -w "\n%{http_code}")
EC3_GET=$(curl -sf "http://localhost:3000/entries/${EC3_ID}" -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" -w "\n%{http_code}")
EC1_GET_CODE=$(printf '%s\n' "$EC1_GET" | tail -1)
EC2_GET_CODE=$(printf '%s\n' "$EC2_GET" | tail -1)
EC3_GET_CODE=$(printf '%s\n' "$EC3_GET" | tail -1)
ENTRY_GET_OK="false"
if [ "$EC1_GET_CODE" = "200" ] && [ "$EC2_GET_CODE" = "200" ] && [ "$EC3_GET_CODE" = "200" ]; then
  ENTRY_GET_OK="true"
fi

# Fragment slug collisions — 3 fragments with identical title, different content
FC1_RAW=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"title\":\"${COLLISION_TITLE}\",\"content\":\"Fragment collision body 1 — unique for slug test\",\"entryId\":\"${ENTRY_1_ID}\",\"tags\":[\"collision-test\"]}")
FC1_CODE=$(printf '%s\n' "$FC1_RAW" | tail -1)
FC1_RESP=$(printf '%s\n' "$FC1_RAW" | head -n -1)
FC1_SLUG=$(printf '%s\n' "$FC1_RESP" | jq -r '.slug // empty')
FC1_ID=$(printf '%s\n' "$FC1_RESP" | jq -r '.id // empty')
check_hard_failure "$FC1_CODE" "STOR-06 fragment collision 1"

FC2_RAW=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"title\":\"${COLLISION_TITLE}\",\"content\":\"Fragment collision body 2 — different content same title\",\"entryId\":\"${ENTRY_1_ID}\",\"tags\":[\"collision-test\"]}")
FC2_CODE=$(printf '%s\n' "$FC2_RAW" | tail -1)
FC2_RESP=$(printf '%s\n' "$FC2_RAW" | head -n -1)
FC2_SLUG=$(printf '%s\n' "$FC2_RESP" | jq -r '.slug // empty')
FC2_ID=$(printf '%s\n' "$FC2_RESP" | jq -r '.id // empty')
check_hard_failure "$FC2_CODE" "STOR-06 fragment collision 2"

FC3_RAW=$(curl -sf -X POST http://localhost:3000/fragments \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "{\"title\":\"${COLLISION_TITLE}\",\"content\":\"Fragment collision body 3 — third distinct for slug suffix\",\"entryId\":\"${ENTRY_1_ID}\",\"tags\":[\"collision-test\"]}")
FC3_CODE=$(printf '%s\n' "$FC3_RAW" | tail -1)
FC3_RESP=$(printf '%s\n' "$FC3_RAW" | head -n -1)
FC3_SLUG=$(printf '%s\n' "$FC3_RESP" | jq -r '.slug // empty')
FC3_ID=$(printf '%s\n' "$FC3_RESP" | jq -r '.id // empty')
check_hard_failure "$FC3_CODE" "STOR-06 fragment collision 3"

echo "[info] fragment slugs: ${FC1_SLUG}, ${FC2_SLUG}, ${FC3_SLUG}"

FRAG_SLUG_OK="false"
if printf '%s\n' "$FC2_SLUG" | grep -q '\-2$' && printf '%s\n' "$FC3_SLUG" | grep -q '\-3$'; then
  FRAG_SLUG_OK="true"
fi

# Combined STOR-06 result
if [ "$ENTRY_SLUG_OK" = "true" ] && [ "$FRAG_SLUG_OK" = "true" ] && [ "$ENTRY_GET_OK" = "true" ]; then
  echo "[ok] STOR-06: slug collisions resolved — entries: ${EC1_SLUG}/${EC2_SLUG}/${EC3_SLUG}, fragments: ${FC1_SLUG}/${FC2_SLUG}/${FC3_SLUG}"
  record_result "STOR-06" "pass" "Entry slugs ${EC1_SLUG}/${EC2_SLUG}/${EC3_SLUG}, fragment slugs ${FC1_SLUG}/${FC2_SLUG}/${FC3_SLUG}, all retrievable" "null"
else
  echo "[fail] STOR-06: slug collision pattern incorrect — entry_slugs=${ENTRY_SLUG_OK} frag_slugs=${FRAG_SLUG_OK} entry_get=${ENTRY_GET_OK}"
  record_result "STOR-06" "failure" "entry_slugs_ok=${ENTRY_SLUG_OK}, frag_slugs_ok=${FRAG_SLUG_OK}, entry_gets_ok=${ENTRY_GET_OK}. Entry: ${EC1_SLUG}/${EC2_SLUG}/${EC3_SLUG}. Frag: ${FC1_SLUG}/${FC2_SLUG}/${FC3_SLUG}" "null"
fi

# D-14: Append collision-test entities to fixtures.json
FIXTURES=$(cat .qa/runs/fixtures.json)
printf '%s\n' "$FIXTURES" | jq \
  --arg ec1 "$EC1_ID" --arg ec2 "$EC2_ID" --arg ec3 "$EC3_ID" \
  --arg fc1 "$FC1_ID" --arg fc2 "$FC2_ID" --arg fc3 "$FC3_ID" \
  '.entries += [{"label":"collision-entry-1","id":$ec1},{"label":"collision-entry-2","id":$ec2},{"label":"collision-entry-3","id":$ec3}] | .fragments += [{"label":"collision-frag-1","id":$fc1},{"label":"collision-frag-2","id":$fc2},{"label":"collision-frag-3","id":$fc3}]' \
  > .qa/runs/fixtures.json.tmp \
  && mv .qa/runs/fixtures.json.tmp .qa/runs/fixtures.json

# Flush STOR results to capture-storage-results.json (gap fix: STOR data loss)
if [ -f .qa/runs/capture-storage-results.json ]; then
  _PRIOR=$(cat .qa/runs/capture-storage-results.json)
else
  _PRIOR='[]'
fi
_MERGED=$(printf '%s\n' "$_PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
printf '%s\n' "$_MERGED" | jq '.' > .qa/runs/capture-storage-results.json.tmp \
  && mv .qa/runs/capture-storage-results.json.tmp .qa/runs/capture-storage-results.json \
  || echo "[warn] Step 22 results flush failed"

echo "[ok] Step 22 complete — STOR-05, STOR-06 checked"
```

## Step 23 -- Thread creation and listing (STOR-07, STOR-08)

```bash
# Re-load fixtures and helpers in case this step runs in a new shell
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[0].id')
RESULTS='[]'
source .qa/runs/helpers.sh

# --- STOR-07: Thread creation via POST /vaults/:vaultId/threads ---
STOR07_RAW=$(curl -sf -X POST "http://localhost:3000/vaults/${VAULT_WORK_ID}/threads" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d '{"name":"Phase 3 Test Thread","type":"log"}')

STOR07_CODE=$(printf '%s\n' "$STOR07_RAW" | tail -1)
STOR07_RESP=$(printf '%s\n' "$STOR07_RAW" | head -n -1)
STOR07_ID=$(printf '%s\n' "$STOR07_RESP" | jq -r '.id // empty')
STOR07_STATE=$(printf '%s\n' "$STOR07_RESP" | jq -r '.state // empty')

check_hard_failure "$STOR07_CODE" "STOR-07 POST /vaults/:id/threads"

if [ "$STOR07_CODE" = "201" ] && [ "$STOR07_STATE" = "RESOLVED" ]; then
  echo "[ok] STOR-07: thread created — 201, state=RESOLVED, id=${STOR07_ID}"
  record_result "STOR-07" "pass" "Thread created with 201, state=RESOLVED, id=${STOR07_ID}" "$STOR07_RESP"
else
  echo "[fail] STOR-07: expected 201/RESOLVED, got ${STOR07_CODE}/${STOR07_STATE}"
  record_result "STOR-07" "failure" "Expected 201/RESOLVED, got ${STOR07_CODE}/${STOR07_STATE}" "$STOR07_RESP"
fi

# --- STOR-08: Thread listed in vault-scoped GET /vaults/:vaultId/threads ---
STOR08_RAW=$(curl -sf "http://localhost:3000/vaults/${VAULT_WORK_ID}/threads" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")

STOR08_CODE=$(printf '%s\n' "$STOR08_RAW" | tail -1)
STOR08_RESP=$(printf '%s\n' "$STOR08_RAW" | head -n -1)

check_hard_failure "$STOR08_CODE" "STOR-08 GET /vaults/:id/threads"

STOR08_FOUND=$(printf '%s\n' "$STOR08_RESP" | jq --arg id "$STOR07_ID" '.threads[] | select(.id == $id) | .id' 2>/dev/null)

if [ "$STOR08_CODE" = "200" ] && [ -n "$STOR08_FOUND" ]; then
  echo "[ok] STOR-08: thread ${STOR07_ID} found in vault thread list"
  record_result "STOR-08" "pass" "Thread ${STOR07_ID} found in GET /vaults/${VAULT_WORK_ID}/threads" "$STOR08_RESP"
else
  echo "[fail] STOR-08: thread ${STOR07_ID} not found in vault list (HTTP ${STOR08_CODE})"
  record_result "STOR-08" "failure" "Thread not found in vault list (HTTP ${STOR08_CODE})" "$STOR08_RESP"
fi

# --- STOR-09: Thread has git file (repoPath set after creation) ---
STOR09_CODE=$(curl -sf "http://localhost:3000/threads/${STOR07_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -o /tmp/qa-stor09.json \
  -w "%{http_code}")
STOR09_REPOPATH=$(jq -r '.repoPath // empty' /tmp/qa-stor09.json 2>/dev/null)

if [ "$STOR09_CODE" = "200" ] && printf '%s\n' "$STOR09_REPOPATH" | grep -q '^threads/.*\.md$'; then
  echo "[ok] STOR-09: thread has git file — repoPath=${STOR09_REPOPATH}"
  record_result "STOR-09" "pass" "Thread repoPath set: ${STOR09_REPOPATH}" "null"
else
  echo "[fail] STOR-09: thread repoPath empty or invalid — HTTP ${STOR09_CODE}, repoPath='${STOR09_REPOPATH}'"
  record_result "STOR-09" "failure" "Thread repoPath empty or invalid: HTTP=${STOR09_CODE} repoPath='${STOR09_REPOPATH}'" "null"
fi

# --- STOR-10: Thread PUT syncs name to git and DB ---
curl -sf -X PUT "http://localhost:3000/threads/${STOR07_ID}" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d '{"name":"Renamed QA Thread"}' > /dev/null

STOR10_CODE=$(curl -sf "http://localhost:3000/threads/${STOR07_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -o /tmp/qa-stor10.json \
  -w "%{http_code}")
STOR10_NAME=$(jq -r '.name // empty' /tmp/qa-stor10.json 2>/dev/null)

if [ "$STOR10_CODE" = "200" ] && [ "$STOR10_NAME" = "Renamed QA Thread" ]; then
  echo "[ok] STOR-10: thread PUT synced name — '${STOR10_NAME}'"
  record_result "STOR-10" "pass" "Thread name updated to '${STOR10_NAME}' via PUT and confirmed via GET" "null"
else
  echo "[fail] STOR-10: thread PUT name sync failed — HTTP ${STOR10_CODE}, name='${STOR10_NAME}'"
  record_result "STOR-10" "failure" "Expected 'Renamed QA Thread', got HTTP=${STOR10_CODE} name='${STOR10_NAME}'" "null"
fi

# Append test thread to fixtures.json
FIXTURES=$(cat .qa/runs/fixtures.json)
printf '%s\n' "$FIXTURES" | jq --arg id "$STOR07_ID" --argjson resp "$STOR07_RESP" \
  --arg vaultId "$VAULT_WORK_ID" \
  '.threads += [{"name":"Phase 3 Test Thread","type":"log","vaultId":$vaultId,"id":$id,"response":$resp}]' \
  > .qa/runs/fixtures.json.tmp \
  && mv .qa/runs/fixtures.json.tmp .qa/runs/fixtures.json

# Flush STOR results to capture-storage-results.json (gap fix: STOR data loss)
if [ -f .qa/runs/capture-storage-results.json ]; then
  _PRIOR=$(cat .qa/runs/capture-storage-results.json)
else
  _PRIOR='[]'
fi
_MERGED=$(printf '%s\n' "$_PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
printf '%s\n' "$_MERGED" | jq '.' > .qa/runs/capture-storage-results.json.tmp \
  && mv .qa/runs/capture-storage-results.json.tmp .qa/runs/capture-storage-results.json \
  || echo "[warn] Step 23 results flush failed"

echo "[ok] Step 23 complete — STOR-07, STOR-08, STOR-09, STOR-10 checked"
```

## Step 24 -- Write capture-storage results

```bash
# Read final results from file (already complete from Steps 20-23 flushes)
MERGED=$(cat .qa/runs/capture-storage-results.json 2>/dev/null || echo '[]')

TOTAL=$(printf '%s\n' "$MERGED" | jq 'length')
PASS=$(printf '%s\n' "$MERGED" | jq '[.[] | select(.status == "pass")] | length')
FAIL=$(printf '%s\n' "$MERGED" | jq '[.[] | select(.status == "failure")] | length')
CONCERN=$(printf '%s\n' "$MERGED" | jq '[.[] | select(.status == "concern")] | length')
OBS=$(printf '%s\n' "$MERGED" | jq '[.[] | select(.status == "observation")] | length')

echo ""
echo "=== Capture & Storage Validation Results ==="
echo "Total checks: ${TOTAL}"
echo "  pass:        ${PASS}"
echo "  failure:     ${FAIL}"
echo "  concern:     ${CONCERN}"
echo "  observation: ${OBS}"
echo ""
echo "Results written to: .qa/runs/capture-storage-results.json"
echo "=== Phase 3 complete ==="
```

## Step 25 -- Initialize retrieval validation results

```bash
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
USER_EMAIL=$(printf '%s\n' "$FIXTURES" | jq -r '.user.email')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Personal") | .id')
FRAG_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.fragments | length')
THREAD_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.threads | length')
RESULTS='[]'
source .qa/runs/helpers.sh

echo "[ok] retrieval validation initialized -- ${FRAG_COUNT} fragments, ${THREAD_COUNT} threads loaded"
```

## Step 26 -- Profile validation (USER-01)

```bash
PROFILE_RAW=$(curl -sf -X GET "http://localhost:3000/users/profile" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
PROFILE_CODE=$(printf '%s\n' "$PROFILE_RAW" | tail -1)
PROFILE_BODY=$(printf '%s\n' "$PROFILE_RAW" | head -n -1)

check_hard_failure "$PROFILE_CODE" "GET /users/profile"

EMAIL_MATCH=$(printf '%s\n' "$PROFILE_BODY" | jq --arg e "$USER_EMAIL" '.email == $e')
HAS_ID=$(printf '%s\n' "$PROFILE_BODY" | jq 'has("id")')
HAS_MCP_URL=$(printf '%s\n' "$PROFILE_BODY" | jq '(.mcpEndpointUrl | length) > 0')
MCP_IS_HTTP=$(printf '%s\n' "$PROFILE_BODY" | jq '.mcpEndpointUrl | startswith("http")')

if [ "$EMAIL_MATCH" = "true" ] && [ "$HAS_ID" = "true" ] && [ "$HAS_MCP_URL" = "true" ]; then
  record_result "USER-01" "pass" "profile returns id, email matches fixture, mcpEndpointUrl present (starts with http: $MCP_IS_HTTP)" "$PROFILE_BODY"
  echo "[pass] USER-01 -- profile shape valid, email matches"
else
  record_result "USER-01" "failure" "email_match=$EMAIL_MATCH has_id=$HAS_ID has_mcp=$HAS_MCP_URL" "$PROFILE_BODY"
  echo "[fail] USER-01 -- profile validation failed: email=$EMAIL_MATCH id=$HAS_ID mcp=$HAS_MCP_URL"
fi
```

## Step 27 -- Stats validation (USER-02)

```bash
STATS_RAW=$(curl -sf -X GET "http://localhost:3000/users/stats" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
STATS_CODE=$(printf '%s\n' "$STATS_RAW" | tail -1)
STATS_BODY=$(printf '%s\n' "$STATS_RAW" | head -n -1)

check_hard_failure "$STATS_CODE" "GET /users/stats"

EXPECTED_NOTES=$(printf '%s\n' "$FIXTURES" | jq '.fragments | length')
EXPECTED_THREADS=$(printf '%s\n' "$FIXTURES" | jq '.threads | length')

NOTES_MATCH=$(printf '%s\n' "$STATS_BODY" | jq --argjson n "$EXPECTED_NOTES" '.totalNotes == $n')
THREADS_MATCH=$(printf '%s\n' "$STATS_BODY" | jq --argjson n "$EXPECTED_THREADS" '.totalThreads == $n')
PEOPLE_COUNT=$(printf '%s\n' "$STATS_BODY" | jq '.peopleCount')
UNTHREADED=$(printf '%s\n' "$STATS_BODY" | jq '.unthreadedCount')

STATS_STATUS="pass"
STATS_DETAIL="totalNotes=$EXPECTED_NOTES threads=$EXPECTED_THREADS people=$PEOPLE_COUNT unthreaded=$UNTHREADED"

if [ "$NOTES_MATCH" != "true" ]; then
  STATS_STATUS="failure"
  ACTUAL_NOTES=$(printf '%s\n' "$STATS_BODY" | jq '.totalNotes')
  STATS_DETAIL="totalNotes mismatch: expected=$EXPECTED_NOTES actual=$ACTUAL_NOTES; $STATS_DETAIL"
fi
if [ "$THREADS_MATCH" != "true" ]; then
  STATS_STATUS="failure"
  ACTUAL_THREADS=$(printf '%s\n' "$STATS_BODY" | jq '.totalThreads')
  STATS_DETAIL="totalThreads mismatch: expected=$EXPECTED_THREADS actual=$ACTUAL_THREADS; $STATS_DETAIL"
fi

# peopleCount: observation-only, not asserted (AI pipeline non-determinism -- people
# are extracted by the agent pipeline from entry content, so count depends on whether
# pipeline ran and what entities it extracted. Fixture manifest has 0 people entries.)
STATS_DETAIL="$STATS_DETAIL (peopleCount=$PEOPLE_COUNT is observation-only -- AI pipeline non-determinism)"

# Note unthreaded observation (may equal totalNotes if pipeline didn't create thread edges)
if [ "$UNTHREADED" = "$EXPECTED_NOTES" ]; then
  STATS_DETAIL="$STATS_DETAIL (observation: unthreadedCount == totalNotes, likely no FRAGMENT_IN_THREAD edges)"
fi

record_result "USER-02" "$STATS_STATUS" "$STATS_DETAIL" "$STATS_BODY"
echo "[${STATS_STATUS}] USER-02 -- stats: notes_match=$NOTES_MATCH threads_match=$THREADS_MATCH people=$PEOPLE_COUNT unthreaded=$UNTHREADED"
```

## Step 28 -- Full-text search validation (RETR-01, RETR-03)

```bash
# Brief sleep to allow any async indexing to complete
sleep 3

# Extract a fixture fragment ID expected to contain "HNSW" -- per research,
# "HNSW" appears in Entry 1 content (Work vault). Look up fragment by title
# that corresponds to Entry 1 content.
EXPECTED_FRAG_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id')

SEARCH_RAW=$(curl -sf -X GET \
  "http://localhost:3000/search?q=HNSW&limit=10" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
SEARCH_CODE=$(printf '%s\n' "$SEARCH_RAW" | tail -1)
SEARCH_BODY=$(printf '%s\n' "$SEARCH_RAW" | head -n -1)

check_hard_failure "$SEARCH_CODE" "GET /search?q=HNSW"

RESULT_COUNT=$(printf '%s\n' "$SEARCH_BODY" | jq '.results | length')
FIRST_SCORE=$(printf '%s\n' "$SEARCH_BODY" | jq '.results[0].score // 0')
HAS_TITLE=$(printf '%s\n' "$SEARCH_BODY" | jq '.results[0] | has("title")')
HAS_TAGS=$(printf '%s\n' "$SEARCH_BODY" | jq '.results[0] | has("tags")')
HAS_FRAGMENT=$(printf '%s\n' "$SEARCH_BODY" | jq '.results[0] | has("fragment")')
SCORE_POSITIVE=$(printf '%s\n' "$SEARCH_BODY" | jq '.results[0].score > 0')

# D-07: Check if the expected fixture fragment ID appears in results (deterministic relevance proof)
FRAG_ID_FOUND=$(printf '%s\n' "$SEARCH_BODY" | jq --arg id "$EXPECTED_FRAG_ID" \
  '[.results[].fragmentId] | any(. == $id)')

if [ "$RESULT_COUNT" -gt 0 ] 2>/dev/null && [ "$HAS_TITLE" = "true" ] && [ "$HAS_TAGS" = "true" ] && [ "$HAS_FRAGMENT" = "true" ] && [ "$SCORE_POSITIVE" = "true" ]; then
  if [ "$FRAG_ID_FOUND" = "true" ]; then
    record_result "RETR-01" "pass" "search returned $RESULT_COUNT results, first score=$FIRST_SCORE, fields present, fixture fragment $EXPECTED_FRAG_ID found in results (D-07 relevance proof)" "$SEARCH_BODY"
    echo "[pass] RETR-01 -- search: $RESULT_COUNT results, score=$FIRST_SCORE, fixture fragment ID verified"
  else
    record_result "RETR-01" "concern" "search returned $RESULT_COUNT results with valid shape, but fixture fragment $EXPECTED_FRAG_ID NOT found in results (indexing may use different IDs)" "$SEARCH_BODY"
    echo "[concern] RETR-01 -- search results valid but expected fragment ID not found"
  fi
  record_result "RETR-03" "pass" "results include title, tags, fragment fields" "$SEARCH_BODY"
  echo "[pass] RETR-03 -- result fields present (title, tags, fragment)"
elif [ "$RESULT_COUNT" = "0" ] || [ -z "$RESULT_COUNT" ]; then
  record_result "RETR-01" "concern" "search returned 0 results for 'HNSW' -- indexing may not have completed" "$SEARCH_BODY"
  echo "[concern] RETR-01 -- search returned 0 results (indexing lag?)"
  record_result "RETR-03" "concern" "no results to validate fields against" "$SEARCH_BODY"
  echo "[concern] RETR-03 -- no results to check fields"
else
  record_result "RETR-01" "failure" "results=$RESULT_COUNT score_positive=$SCORE_POSITIVE frag_id_found=$FRAG_ID_FOUND" "$SEARCH_BODY"
  echo "[fail] RETR-01 -- search anomaly: count=$RESULT_COUNT score_pos=$SCORE_POSITIVE"
  record_result "RETR-03" "failure" "title=$HAS_TITLE tags=$HAS_TAGS fragment=$HAS_FRAGMENT" "$SEARCH_BODY"
  echo "[fail] RETR-03 -- missing fields: title=$HAS_TITLE tags=$HAS_TAGS fragment=$HAS_FRAGMENT"
fi

# Save unfiltered count for minScore comparison (Step 30)
BASELINE_COUNT=$RESULT_COUNT
```

## Step 29 -- Vault-scoped search validation (RETR-02)

```bash
# Scoped search: same broad query, restricted to Work vault
SCOPED_RAW=$(curl -sf -X GET \
  "http://localhost:3000/search?q=planning&limit=20&vaultId=${VAULT_WORK_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
SCOPED_CODE=$(printf '%s\n' "$SCOPED_RAW" | tail -1)
SCOPED_BODY=$(printf '%s\n' "$SCOPED_RAW" | head -n -1)

check_hard_failure "$SCOPED_CODE" "GET /search?q=planning&vaultId=Work"

# Unscoped search: same query, no vault filter
UNSCOPED_RAW=$(curl -sf -X GET \
  "http://localhost:3000/search?q=planning&limit=20" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
UNSCOPED_CODE=$(printf '%s\n' "$UNSCOPED_RAW" | tail -1)
UNSCOPED_BODY=$(printf '%s\n' "$UNSCOPED_RAW" | head -n -1)

check_hard_failure "$UNSCOPED_CODE" "GET /search?q=planning (unscoped)"

SCOPED_COUNT=$(printf '%s\n' "$SCOPED_BODY" | jq '.results | length')
UNSCOPED_COUNT=$(printf '%s\n' "$UNSCOPED_BODY" | jq '.results | length')

# Vault-scoped should return <= unscoped (fewer or equal results)
if [ "$SCOPED_COUNT" -le "$UNSCOPED_COUNT" ] 2>/dev/null; then
  if [ "$SCOPED_COUNT" -gt 0 ] 2>/dev/null; then
    record_result "RETR-02" "pass" "vault-scoped: $SCOPED_COUNT results vs unscoped: $UNSCOPED_COUNT (filtering works)" "null"
    echo "[pass] RETR-02 -- vault-scoped search: $SCOPED_COUNT <= $UNSCOPED_COUNT"
  elif [ "$UNSCOPED_COUNT" -gt 0 ] 2>/dev/null; then
    record_result "RETR-02" "pass" "vault-scoped: 0 results vs unscoped: $UNSCOPED_COUNT (vault has no matching fragments)" "null"
    echo "[pass] RETR-02 -- vault-scoped returned 0 (Work vault may not have 'planning' matches)"
  else
    record_result "RETR-02" "concern" "both scoped and unscoped returned 0 results -- indexing may not have completed" "null"
    echo "[concern] RETR-02 -- both queries returned 0 results"
  fi
else
  record_result "RETR-02" "failure" "scoped=$SCOPED_COUNT > unscoped=$UNSCOPED_COUNT -- filtering is broken" "null"
  echo "[fail] RETR-02 -- scoped count exceeds unscoped: $SCOPED_COUNT > $UNSCOPED_COUNT"
fi
```

## Step 30 -- minScore validation (RETR-01 supplement per D-08/D-09)

```bash
# Use HNSW query again, compare with and without minScore
MINSCORE_RAW=$(curl -sf -X GET \
  "http://localhost:3000/search?q=HNSW&limit=10&minScore=0.5" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
MINSCORE_CODE=$(printf '%s\n' "$MINSCORE_RAW" | tail -1)
MINSCORE_BODY=$(printf '%s\n' "$MINSCORE_RAW" | head -n -1)

check_hard_failure "$MINSCORE_CODE" "GET /search?q=HNSW&minScore=0.5"

MINSCORE_COUNT=$(printf '%s\n' "$MINSCORE_BODY" | jq '.results | length')

# minScore-filtered count should be <= baseline count from Step 28
if [ "$MINSCORE_COUNT" -le "$BASELINE_COUNT" ] 2>/dev/null; then
  record_result "RETR-01-minScore" "pass" "minScore=0.5 returned $MINSCORE_COUNT results vs baseline $BASELINE_COUNT (filtering works, per D-08/D-09)" "null"
  echo "[pass] RETR-01-minScore -- filtered: $MINSCORE_COUNT <= baseline: $BASELINE_COUNT"
else
  record_result "RETR-01-minScore" "failure" "minScore filtered $MINSCORE_COUNT > baseline $BASELINE_COUNT" "null"
  echo "[fail] RETR-01-minScore -- filtered count exceeds baseline: $MINSCORE_COUNT > $BASELINE_COUNT"
fi

# Write retrieval results to file
printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/retrieval-results.json
echo "[ok] retrieval-results.json written -> .qa/runs/retrieval-results.json"
echo "[ok] Phase 4 retrieval validation complete (profile + stats + search)"
```

## Step 31 -- Graph validation with full fixture mapping (RETR-04, RETR-05)

```bash
# ── Section boundary re-load (cross-session safety) ──
FIXTURES=$(cat .qa/runs/fixtures.json)
COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Personal") | .id')
FRAG_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.fragments | length')
THREAD_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.threads | length')

# Re-initialize RESULTS by loading prior results from Steps 25-30
if [ -f .qa/runs/retrieval-results.json ]; then
  RESULTS=$(cat .qa/runs/retrieval-results.json)
else
  RESULTS='[]'
fi

source .qa/runs/helpers.sh

echo "[ok] graph/relationships section re-initialized"

# ── Unscoped graph (RETR-04) ──
GRAPH_RAW=$(curl -sf -X GET "http://localhost:3000/graph" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
GRAPH_CODE=$(printf '%s\n' "$GRAPH_RAW" | tail -1)
GRAPH_BODY=$(printf '%s\n' "$GRAPH_RAW" | head -n -1)

check_hard_failure "$GRAPH_CODE" "GET /graph"

NODE_COUNT=$(printf '%s\n' "$GRAPH_BODY" | jq '.nodes | length')
EDGE_COUNT=$(printf '%s\n' "$GRAPH_BODY" | jq '.edges | length')
HAS_NODES_KEY=$(printf '%s\n' "$GRAPH_BODY" | jq 'has("nodes")')
HAS_EDGES_KEY=$(printf '%s\n' "$GRAPH_BODY" | jq 'has("edges")')

if [ "$HAS_NODES_KEY" = "true" ] && [ "$HAS_EDGES_KEY" = "true" ]; then
  if [ "$NODE_COUNT" -gt 0 ] 2>/dev/null; then
    # D-11: Full fixture mapping -- verify every fixture fragment ID appears as a graph node
    # Note: graph node IDs are lookupKeys, matching fixtures.fragments[].id
    ALL_FRAG_IDS=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[].id')
    GRAPH_NODE_IDS=$(printf '%s\n' "$GRAPH_BODY" | jq -r '[.nodes[].id] | join("\n")')
    MISSING_FRAGS=""
    FOUND_FRAGS=0
    TOTAL_FRAGS=0
    for fid in $ALL_FRAG_IDS; do
      TOTAL_FRAGS=$((TOTAL_FRAGS + 1))
      if printf '%s\n' "$GRAPH_NODE_IDS" | grep -q "$fid"; then
        FOUND_FRAGS=$((FOUND_FRAGS + 1))
      else
        MISSING_FRAGS="$MISSING_FRAGS $fid"
      fi
    done

    # D-11: Check for at least one wikilink edge (FRAGMENT_RELATED_TO_FRAGMENT in DB → wikilink in API response)
    WIKILINK_EDGES=$(printf '%s\n' "$GRAPH_BODY" | jq '[.edges[] | select(.edgeType == "wikilink")] | length')

    NODE_HAS_ID=$(printf '%s\n' "$GRAPH_BODY" | jq '.nodes[0] | has("id")')
    NODE_HAS_LABEL=$(printf '%s\n' "$GRAPH_BODY" | jq '.nodes[0] | has("label")')
    NODE_HAS_TYPE=$(printf '%s\n' "$GRAPH_BODY" | jq '.nodes[0] | has("type")')

    GRAPH_DETAIL="$NODE_COUNT nodes, $EDGE_COUNT edges, node shape (id=$NODE_HAS_ID label=$NODE_HAS_LABEL type=$NODE_HAS_TYPE), fixture frags: $FOUND_FRAGS/$TOTAL_FRAGS found, wikilink edges: $WIKILINK_EDGES"

    if [ "$FOUND_FRAGS" = "$TOTAL_FRAGS" ] && [ "$WIKILINK_EDGES" -gt 0 ] 2>/dev/null; then
      record_result "RETR-04" "pass" "graph: $GRAPH_DETAIL" "$GRAPH_BODY"
      echo "[pass] RETR-04 -- graph: all fixture fragments found, $WIKILINK_EDGES wikilink edges"
    elif [ "$FOUND_FRAGS" = "$TOTAL_FRAGS" ]; then
      record_result "RETR-04" "observation" "graph: all fragments found but 0 wikilink edges (pipeline may not have created wiki-links); $GRAPH_DETAIL" "$GRAPH_BODY"
      echo "[observation] RETR-04 -- all fragments found, 0 wikilink edges"
    elif [ "$FOUND_FRAGS" -gt 0 ] 2>/dev/null; then
      record_result "RETR-04" "concern" "graph: only $FOUND_FRAGS/$TOTAL_FRAGS fixture fragments found, missing:$MISSING_FRAGS; $GRAPH_DETAIL" "$GRAPH_BODY"
      echo "[concern] RETR-04 -- partial fixture mapping: $FOUND_FRAGS/$TOTAL_FRAGS"
    else
      record_result "RETR-04" "concern" "graph has $NODE_COUNT nodes but no fixture fragments found in nodes; $GRAPH_DETAIL" "$GRAPH_BODY"
      echo "[concern] RETR-04 -- no fixture fragments in graph nodes"
    fi
  else
    record_result "RETR-04" "concern" "graph returned 0 nodes -- pipeline may not have created edges (endpoint works, data empty)" "$GRAPH_BODY"
    echo "[concern] RETR-04 -- graph empty (0 nodes) -- pipeline edges missing?"
  fi
else
  record_result "RETR-04" "failure" "graph response missing nodes or edges key: nodes=$HAS_NODES_KEY edges=$HAS_EDGES_KEY" "$GRAPH_BODY"
  echo "[fail] RETR-04 -- graph response malformed"
fi

# ── Vault-scoped graph (RETR-05) ──
SCOPED_GRAPH_RAW=$(curl -sf -X GET "http://localhost:3000/graph?vaultId=${VAULT_WORK_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
SCOPED_GRAPH_CODE=$(printf '%s\n' "$SCOPED_GRAPH_RAW" | tail -1)
SCOPED_GRAPH_BODY=$(printf '%s\n' "$SCOPED_GRAPH_RAW" | head -n -1)

check_hard_failure "$SCOPED_GRAPH_CODE" "GET /graph?vaultId=Work"

SCOPED_NODE_COUNT=$(printf '%s\n' "$SCOPED_GRAPH_BODY" | jq '.nodes | length')
SCOPED_EDGE_COUNT=$(printf '%s\n' "$SCOPED_GRAPH_BODY" | jq '.edges | length')

# D-12: Verify all scoped nodes belong to the correct vault
WRONG_VAULT_NODES=0
ALL_BELONG="true"
if [ "$SCOPED_NODE_COUNT" -gt 0 ] 2>/dev/null; then
  # Check each node's vaultId matches VAULT_WORK_ID (nodes may have empty vaultId for non-vault entities like people/threads)
  WRONG_VAULT_NODES=$(printf '%s\n' "$SCOPED_GRAPH_BODY" | jq --arg vid "$VAULT_WORK_ID" \
    '[.nodes[] | select(.vaultId != "" and .vaultId != $vid)] | length')
  if [ "$WRONG_VAULT_NODES" -gt 0 ] 2>/dev/null; then
    ALL_BELONG="false"
  fi
fi

if [ "$SCOPED_NODE_COUNT" -le "$NODE_COUNT" ] 2>/dev/null; then
  if [ "$NODE_COUNT" -gt 0 ] 2>/dev/null && [ "$SCOPED_NODE_COUNT" -lt "$NODE_COUNT" ] 2>/dev/null; then
    if [ "$ALL_BELONG" = "true" ]; then
      record_result "RETR-05" "pass" "vault-scoped graph: $SCOPED_NODE_COUNT nodes (< full $NODE_COUNT), all nodes belong to vault (wrong_vault=$WRONG_VAULT_NODES)" "null"
      echo "[pass] RETR-05 -- scoped graph: $SCOPED_NODE_COUNT < full $NODE_COUNT, all nodes verified"
    else
      record_result "RETR-05" "concern" "vault-scoped graph: $SCOPED_NODE_COUNT nodes (< full $NODE_COUNT), but $WRONG_VAULT_NODES nodes have wrong vaultId" "null"
      echo "[concern] RETR-05 -- scoped graph has $WRONG_VAULT_NODES nodes with wrong vaultId"
    fi
  elif [ "$NODE_COUNT" = "0" ]; then
    record_result "RETR-05" "concern" "both scoped and full graph are empty (pipeline edges missing)" "null"
    echo "[concern] RETR-05 -- both graphs empty"
  else
    if [ "$ALL_BELONG" = "true" ]; then
      record_result "RETR-05" "observation" "scoped=$SCOPED_NODE_COUNT equals full=$NODE_COUNT -- all nodes may belong to Work vault, all verified to correct vaultId" "null"
      echo "[observation] RETR-05 -- scoped equals full ($SCOPED_NODE_COUNT), all nodes belong to vault"
    else
      record_result "RETR-05" "concern" "scoped=$SCOPED_NODE_COUNT equals full=$NODE_COUNT, but $WRONG_VAULT_NODES nodes have wrong vaultId" "null"
      echo "[concern] RETR-05 -- scoped equals full but $WRONG_VAULT_NODES nodes wrong vault"
    fi
  fi
else
  record_result "RETR-05" "failure" "scoped $SCOPED_NODE_COUNT > full $NODE_COUNT -- vault filtering broken" "null"
  echo "[fail] RETR-05 -- scoped exceeds full: $SCOPED_NODE_COUNT > $NODE_COUNT"
fi
```

## Step 32 -- Relationships validation (RETR-06)

```bash
# Get first fragment ID and first entry ID from fixtures (IDs are lookupKeys)
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id')
ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id')
THREAD_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.threads[0].id')

FRAG_REL_STATUS="pass"
ENTRY_REL_STATUS="pass"
THREAD_REL_STATUS="pass"

# Fragment relationships
FRAG_REL_RAW=$(curl -sf -X GET \
  "http://localhost:3000/relationships/fragment/${FRAG_1_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
FRAG_REL_CODE=$(printf '%s\n' "$FRAG_REL_RAW" | tail -1)
FRAG_REL_BODY=$(printf '%s\n' "$FRAG_REL_RAW" | head -n -1)

check_hard_failure "$FRAG_REL_CODE" "GET /relationships/fragment/:id"

FRAG_HAS_RELS=$(printf '%s\n' "$FRAG_REL_BODY" | jq 'has("relationships")')
FRAG_REL_TYPES=$(printf '%s\n' "$FRAG_REL_BODY" | jq '.relationships | keys | length')

if [ "$FRAG_HAS_RELS" != "true" ]; then
  FRAG_REL_STATUS="failure"
fi

# Entry relationships
ENTRY_REL_RAW=$(curl -sf -X GET \
  "http://localhost:3000/relationships/entry/${ENTRY_1_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
ENTRY_REL_CODE=$(printf '%s\n' "$ENTRY_REL_RAW" | tail -1)
ENTRY_REL_BODY=$(printf '%s\n' "$ENTRY_REL_RAW" | head -n -1)

check_hard_failure "$ENTRY_REL_CODE" "GET /relationships/entry/:id"

ENTRY_HAS_RELS=$(printf '%s\n' "$ENTRY_REL_BODY" | jq 'has("relationships")')
ENTRY_REL_TYPES=$(printf '%s\n' "$ENTRY_REL_BODY" | jq '.relationships | keys | length')

if [ "$ENTRY_HAS_RELS" != "true" ]; then
  ENTRY_REL_STATUS="failure"
fi

# Thread relationships
THREAD_REL_RAW=$(curl -sf -X GET \
  "http://localhost:3000/relationships/thread/${THREAD_1_ID}" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
THREAD_REL_CODE=$(printf '%s\n' "$THREAD_REL_RAW" | tail -1)
THREAD_REL_BODY=$(printf '%s\n' "$THREAD_REL_RAW" | head -n -1)

check_hard_failure "$THREAD_REL_CODE" "GET /relationships/thread/:id"

THREAD_HAS_RELS=$(printf '%s\n' "$THREAD_REL_BODY" | jq 'has("relationships")')
THREAD_REL_TYPES=$(printf '%s\n' "$THREAD_REL_BODY" | jq '.relationships | keys | length')

if [ "$THREAD_HAS_RELS" != "true" ]; then
  THREAD_REL_STATUS="failure"
fi

# Aggregate RETR-06 result
OVERALL_STATUS="pass"
DETAIL="fragment: has_rels=$FRAG_HAS_RELS types=$FRAG_REL_TYPES; entry: has_rels=$ENTRY_HAS_RELS types=$ENTRY_REL_TYPES; thread: has_rels=$THREAD_HAS_RELS types=$THREAD_REL_TYPES"

if [ "$FRAG_REL_STATUS" = "failure" ] || [ "$ENTRY_REL_STATUS" = "failure" ] || [ "$THREAD_REL_STATUS" = "failure" ]; then
  OVERALL_STATUS="failure"
fi

# If all have relationships key but zero edge types, flag as concern (pipeline didn't create edges)
if [ "$FRAG_REL_TYPES" = "0" ] && [ "$ENTRY_REL_TYPES" = "0" ] && [ "$THREAD_REL_TYPES" = "0" ]; then
  if [ "$OVERALL_STATUS" = "pass" ]; then
    OVERALL_STATUS="concern"
    DETAIL="$DETAIL (all relationship keys present but empty -- pipeline edges missing)"
  fi
fi

record_result "RETR-06" "$OVERALL_STATUS" "$DETAIL" "null"
echo "[${OVERALL_STATUS}] RETR-06 -- relationships: frag_types=$FRAG_REL_TYPES entry_types=$ENTRY_REL_TYPES thread_types=$THREAD_REL_TYPES"
```

## Step 33 -- Activity feed validation (USER-03)

```bash
ACTIVITY_RAW=$(curl -sf -X GET "http://localhost:3000/users/activity" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
ACTIVITY_CODE=$(printf '%s\n' "$ACTIVITY_RAW" | tail -1)
ACTIVITY_BODY=$(printf '%s\n' "$ACTIVITY_RAW" | head -n -1)

check_hard_failure "$ACTIVITY_CODE" "GET /users/activity"

HAS_ACTIVITY=$(printf '%s\n' "$ACTIVITY_BODY" | jq 'has("activity")')
ACTIVITY_LEN=$(printf '%s\n' "$ACTIVITY_BODY" | jq '.activity | length')

if [ "$HAS_ACTIVITY" = "true" ] && [ "$ACTIVITY_LEN" -gt 0 ] 2>/dev/null; then
  # Verify shape: first item has action and time
  FIRST_HAS_ACTION=$(printf '%s\n' "$ACTIVITY_BODY" | jq '.activity[0] | has("action")')
  FIRST_HAS_TIME=$(printf '%s\n' "$ACTIVITY_BODY" | jq '.activity[0] | has("time")')

  if [ "$FIRST_HAS_ACTION" = "true" ] && [ "$FIRST_HAS_TIME" = "true" ]; then
    record_result "USER-03" "pass" "activity: $ACTIVITY_LEN items, shape valid (action + time fields present)" "null"
    echo "[pass] USER-03 -- activity: $ACTIVITY_LEN items, shape valid"
  else
    record_result "USER-03" "failure" "activity items missing fields: action=$FIRST_HAS_ACTION time=$FIRST_HAS_TIME" "$ACTIVITY_BODY"
    echo "[fail] USER-03 -- activity item shape invalid"
  fi
elif [ "$HAS_ACTIVITY" = "true" ] && [ "$ACTIVITY_LEN" = "0" ]; then
  record_result "USER-03" "concern" "activity array exists but is empty -- audit log may not have entries" "null"
  echo "[concern] USER-03 -- activity array empty"
else
  record_result "USER-03" "failure" "activity response missing activity key" "$ACTIVITY_BODY"
  echo "[fail] USER-03 -- malformed activity response"
fi
```

## Step 34 -- Export validation (USER-04)

```bash
EXPORT_RAW=$(curl -sf -X POST "http://localhost:3000/users/export" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d '{}' \
  -w "\n%{http_code}" 2>&1 || echo -e "\n000")
EXPORT_CODE=$(printf '%s\n' "$EXPORT_RAW" | tail -1)
EXPORT_BODY=$(printf '%s\n' "$EXPORT_RAW" | head -n -1)

check_hard_failure "$EXPORT_CODE" "POST /users/export"

# Count exported entities
EXP_VAULT_COUNT=$(printf '%s\n' "$EXPORT_BODY" | jq '.vaults | length')
EXP_THREAD_COUNT=$(printf '%s\n' "$EXPORT_BODY" | jq '.threads | length')
EXP_FRAG_COUNT=$(printf '%s\n' "$EXPORT_BODY" | jq '.fragments | length')
EXP_PEOPLE_COUNT=$(printf '%s\n' "$EXPORT_BODY" | jq '.people | length')
HAS_EXPORTED_AT=$(printf '%s\n' "$EXPORT_BODY" | jq 'has("exportedAt")')

# Compare against fixture counts
FIXTURE_VAULT_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.vaults | length')
FIXTURE_THREAD_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.threads | length')
FIXTURE_FRAG_COUNT=$(printf '%s\n' "$FIXTURES" | jq '.fragments | length')

EXPORT_STATUS="pass"
EXPORT_DETAIL="vaults=$EXP_VAULT_COUNT/$FIXTURE_VAULT_COUNT threads=$EXP_THREAD_COUNT/$FIXTURE_THREAD_COUNT fragments=$EXP_FRAG_COUNT/$FIXTURE_FRAG_COUNT people=$EXP_PEOPLE_COUNT exportedAt=$HAS_EXPORTED_AT"

# Verify counts match
if [ "$EXP_VAULT_COUNT" -lt "$FIXTURE_VAULT_COUNT" ] 2>/dev/null; then
  EXPORT_STATUS="failure"
  EXPORT_DETAIL="missing vaults: exported=$EXP_VAULT_COUNT expected>=$FIXTURE_VAULT_COUNT; $EXPORT_DETAIL"
fi
if [ "$EXP_THREAD_COUNT" -lt "$FIXTURE_THREAD_COUNT" ] 2>/dev/null; then
  EXPORT_STATUS="failure"
  EXPORT_DETAIL="missing threads: exported=$EXP_THREAD_COUNT expected>=$FIXTURE_THREAD_COUNT; $EXPORT_DETAIL"
fi
if [ "$EXP_FRAG_COUNT" -lt "$FIXTURE_FRAG_COUNT" ] 2>/dev/null; then
  EXPORT_STATUS="failure"
  EXPORT_DETAIL="missing fragments: exported=$EXP_FRAG_COUNT expected>=$FIXTURE_FRAG_COUNT; $EXPORT_DETAIL"
fi

# Deep field check: verify vault names appear
HAS_WORK_VAULT=$(printf '%s\n' "$EXPORT_BODY" | jq '[.vaults[].name] | any(. == "Work")')
HAS_PERSONAL_VAULT=$(printf '%s\n' "$EXPORT_BODY" | jq '[.vaults[].name] | any(. == "Personal")')

if [ "$HAS_WORK_VAULT" != "true" ] || [ "$HAS_PERSONAL_VAULT" != "true" ]; then
  EXPORT_STATUS="failure"
  EXPORT_DETAIL="vault names missing: Work=$HAS_WORK_VAULT Personal=$HAS_PERSONAL_VAULT; $EXPORT_DETAIL"
fi

record_result "USER-04" "$EXPORT_STATUS" "$EXPORT_DETAIL" "null"
echo "[${EXPORT_STATUS}] USER-04 -- export: $EXPORT_DETAIL"

# D-18: Flag raw DB rows as observation
record_result "USER-04-obs" "observation" "export returns raw DB rows (z.any() arrays) without response schema shaping -- noted for future hardening per D-18" "null"
echo "[observation] USER-04 -- export uses z.any() arrays (raw DB rows)"
```

## Step 35 -- Write retrieval results (D-19)

```bash
printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/retrieval-results.json

TOTAL=$(printf '%s\n' "$RESULTS" | jq 'length')
PASSES=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="pass")] | length')
CONCERNS=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="concern")] | length')
OBSERVATIONS=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="observation")] | length')
FAILURES=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="failure")] | length')

echo ""
echo "===== Retrieval & Profile Validation Complete ====="
echo "  Total:        $TOTAL"
echo "  Pass:         $PASSES"
echo "  Concern:      $CONCERNS"
echo "  Observation:  $OBSERVATIONS"
echo "  Failure:      $FAILURES"
echo "  Results:      .qa/runs/retrieval-results.json"
echo "==================================================="
```

## Step 36 -- Initialize adaptive-exploratory testing

Phase 5 infrastructure: snapshot directory, fixture re-load, results accumulator, helper functions, and the `qa_curl` wrapper that drives all Phase 5 calls. Every subsequent adaptive-exploratory step calls `qa_curl` instead of raw `curl` — this ensures automatic golden snapshot diffing, critical field checking, and non-crash error handling on every API response.

Run:

```bash
# Create snapshots directory (Pitfall 7 -- Phase 2 creates .qa/runs/ but not the subdirectory)
mkdir -p .qa/runs/snapshots/

# ── Load fixtures (defensive re-load for cross-session safety, same pattern as Step 25) ──
FIXTURES=$(cat .qa/runs/fixtures.json)
if [ -z "$FIXTURES" ]; then
  echo "[halt] fixtures.json not found or empty -- run Phase 2 steps first"
  exit 1
fi

COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[halt] cookie jar not found at $COOKIE_JAR -- re-run Phase 1 sign-in steps"
  exit 1
fi

ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id // empty')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id // empty')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Personal") | .id')

# ── Results accumulator ──
RESULTS='[]'

# ── append_result helper (D-25 categories: pass, observation, concern, failure) ──
append_result() {
  local REQ_ID="$1"
  local STATUS="$2"
  local DETAIL="$3"
  local RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" \
    --arg status "$STATUS" \
    --arg detail "$DETAIL" \
    --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

# ── flush_results helper (D-24 -- atomic write to prevent truncation on jq failure) ──
flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

# ── Critical fields per endpoint (D-10 -- hardcoded checklist; must be present on every response) ──
declare -A CRITICAL_FIELDS
CRITICAL_FIELDS["POST-entries"]="id lookupKey state status"
CRITICAL_FIELDS["GET-entries-id"]="id lookupKey content state"
CRITICAL_FIELDS["POST-fragments"]="id lookupKey slug tags state"
CRITICAL_FIELDS["GET-fragments-id"]="id lookupKey content slug tags state"
CRITICAL_FIELDS["POST-vaults"]="id name slug type"
CRITICAL_FIELDS["GET-vaults"]="vaults"
CRITICAL_FIELDS["error"]="error"

# ── qa_curl wrapper (ADPT-01, ADPT-02, ADPT-03, ADPT-04) ──
# Signature: qa_curl METHOD URL REQ_ID ENDPOINT_KEY [extra curl args...]
# Returns: echoes BODY; sets QA_LAST_HTTP_CODE global
qa_curl() {
  local METHOD="$1"
  local URL="$2"
  local REQ_ID="$3"
  local ENDPOINT_KEY="$4"
  shift 4

  local RESP_RAW
  RESP_RAW=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$URL" "$@" 2>&1 || echo -e "\nCONNECTION_FAILED")

  # Split: last line = HTTP code, everything before = body
  # Use sed '$d' (not head -n -1) for portability across platforms
  QA_LAST_HTTP_CODE=$(printf '%s\n' "$RESP_RAW" | tail -1)
  local BODY
  BODY=$(printf '%s\n' "$RESP_RAW" | sed '$d')

  # ── Hard failure gate (D-26): server is down → flush and exit ──
  if [ "$QA_LAST_HTTP_CODE" = "CONNECTION_FAILED" ]; then
    echo "[halt] qa_curl: connection failed for $METHOD $URL"
    flush_results
    exit 1
  fi

  # ── JSON parse attempt (D-15, ADPT-02): non-JSON is an observation, never a halt ──
  if ! printf '%s\n' "$BODY" | jq . >/dev/null 2>&1; then
    append_result "$REQ_ID" "observation" "Non-JSON response (HTTP $QA_LAST_HTTP_CODE): $(printf '%s\n' "$BODY" | head -c 200)" "$BODY"
    append_result "ADPT-02" "pass" "Non-JSON response handled without crash for $REQ_ID (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
    echo "$BODY"
    return 0
  fi

  # ── Error response shape check (D-13): 4xx/5xx must have "error" key ──
  if [ "$QA_LAST_HTTP_CODE" -ge 400 ] 2>/dev/null; then
    local HAS_ERROR_KEY
    HAS_ERROR_KEY=$(printf '%s\n' "$BODY" | jq 'has("error")' 2>/dev/null || echo "false")
    if [ "$HAS_ERROR_KEY" != "true" ]; then
      append_result "$REQ_ID" "concern" "Error response missing 'error' key (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
    fi
  fi

  # ── Golden snapshot diff (D-10, D-14, ADPT-04) ──
  # Extract actual key set from response (arrays: use first element; objects: use top-level keys)
  local ACTUAL_KEYS
  ACTUAL_KEYS=$(printf '%s\n' "$BODY" | jq -c 'if type == "array" then .[0] // {} else . end | keys | sort' 2>/dev/null || echo "[]")

  local SNAP_FILE=".qa/runs/snapshots/${ENDPOINT_KEY}.json"

  if [ ! -f "$SNAP_FILE" ] && [ "$QA_LAST_HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$QA_LAST_HTTP_CODE" -lt 300 ] 2>/dev/null; then
    # First successful response — seed the golden snapshot
    echo "$ACTUAL_KEYS" > "$SNAP_FILE"
    append_result "$REQ_ID" "pass" "Snapshot seeded for $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
  elif [ -f "$SNAP_FILE" ]; then
    local EXPECTED_KEYS
    EXPECTED_KEYS=$(cat "$SNAP_FILE")
    if [ "$ACTUAL_KEYS" != "$EXPECTED_KEYS" ]; then
      local MISSING EXTRA
      # (D-11, ADPT-03) missing keys = concern; extra keys = observation
      MISSING=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$exp - $act')
      EXTRA=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$act - $exp')
      if [ "$MISSING" != "[]" ]; then
        append_result "$REQ_ID" "concern" "Missing keys $MISSING from $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
      if [ "$EXTRA" != "[]" ]; then
        append_result "$REQ_ID" "observation" "Extra keys $EXTRA in $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
      append_result "ADPT-01" "pass" "Shape difference detected and logged for $REQ_ID/$ENDPOINT_KEY — missing=$MISSING extra=$EXTRA" "$BODY"
      append_result "ADPT-03" "pass" "Missing/extra field findings recorded for $ENDPOINT_KEY" "$BODY"
    fi
  fi

  # ── Critical field check (D-10): fields that MUST be present on every matching response ──
  local CRITICAL="${CRITICAL_FIELDS[$ENDPOINT_KEY]:-}"
  if [ -n "$CRITICAL" ]; then
    local field
    for field in $CRITICAL; do
      local FIELD_PRESENT
      FIELD_PRESENT=$(printf '%s\n' "$BODY" | jq --arg f "$field" 'has($f)' 2>/dev/null || echo "false")
      if [ "$FIELD_PRESENT" != "true" ]; then
        append_result "$REQ_ID" "concern" "Missing critical field '$field' in $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
    done
  fi

  # Return body to caller and expose HTTP code via global
  echo "$BODY"
}

echo "[ok] adaptive-exploratory initialized — qa_curl wrapper, snapshots dir, ${#CRITICAL_FIELDS[@]} endpoint schemas"
```

## Step 37 -- Seed golden snapshots

Make one successful call per endpoint pattern via `qa_curl` to seed the golden snapshots in `.qa/runs/snapshots/`. These provide the baseline for shape drift detection in all subsequent adaptive-exploratory steps. Step 36 must have been run in the same shell session so that `qa_curl`, `append_result`, `flush_results`, `CRITICAL_FIELDS`, `COOKIE_JAR`, `ENTRY_1_ID`, and `FRAG_1_ID` are all in scope.

Run:

```bash
# Seed POST-entries snapshot — submit a new entry via qa_curl
SEED_RESP=$(qa_curl POST "http://localhost:3000/entries" "ADPT-04-seed-entries" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "Snapshot seed entry for QA adaptive testing" '{content: $c}')")
echo "[seed] POST-entries: HTTP $QA_LAST_HTTP_CODE"

# Seed GET-entries-id snapshot — GET first fixture entry by ID
SEED_RESP=$(qa_curl GET "http://localhost:3000/entries/${ENTRY_1_ID}" "ADPT-04-seed-get-entry" "GET-entries-id" \
  -b "$COOKIE_JAR")
echo "[seed] GET-entries-id: HTTP $QA_LAST_HTTP_CODE"

# Seed POST-fragments snapshot — POST a new fragment referencing first fixture entry
SEED_RESP=$(qa_curl POST "http://localhost:3000/fragments" "ADPT-04-seed-fragments" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t "Snapshot seed fragment" --arg e "$ENTRY_1_ID" '{title: $t, entryId: $e}')")
echo "[seed] POST-fragments: HTTP $QA_LAST_HTTP_CODE"

# Seed GET-fragments-id snapshot — GET first fixture fragment by ID
SEED_RESP=$(qa_curl GET "http://localhost:3000/fragments/${FRAG_1_ID}" "ADPT-04-seed-get-fragment" "GET-fragments-id" \
  -b "$COOKIE_JAR")
echo "[seed] GET-fragments-id: HTTP $QA_LAST_HTTP_CODE"

# Seed GET-vaults snapshot — list all vaults
SEED_RESP=$(qa_curl GET "http://localhost:3000/vaults" "ADPT-04-seed-vaults" "GET-vaults" \
  -b "$COOKIE_JAR")
echo "[seed] GET-vaults: HTTP $QA_LAST_HTTP_CODE"

# Verify snapshot files were created
SNAP_COUNT=$(ls .qa/runs/snapshots/*.json 2>/dev/null | wc -l)
echo "[ok] golden snapshots seeded: ${SNAP_COUNT} endpoints in .qa/runs/snapshots/"
ls .qa/runs/snapshots/

flush_results
```

## Step 38 -- Edge-case content catalog (EXPL-01)

Exhaustive edge-case testing covering all content categories from D-01 through D-08. Each edge case is a distinct test submitted via `qa_curl` with its own `reqId`. Re-initializes all helpers and fixtures at the top for shell session independence (same pattern as Steps 21-23). Tests cover `/entries` (all categories) and `/fragments` (where applicable). After all edge cases, calls `flush_results` to persist results to `adaptive-exploratory-results.json`.

Run:

```bash
# ── Re-initialize for shell session independence (D-26, same pattern as Steps 21-23) ──
mkdir -p .qa/runs/snapshots/

FIXTURES=$(cat .qa/runs/fixtures.json)
if [ -z "$FIXTURES" ]; then
  echo "[halt] fixtures.json not found -- run Phase 2 steps first"
  exit 1
fi

COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[halt] cookie jar not found at $COOKIE_JAR -- re-run Phase 1 sign-in steps"
  exit 1
fi

ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id // empty')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id // empty')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Personal") | .id')

RESULTS='[]'

append_result() {
  local REQ_ID="$1"
  local STATUS="$2"
  local DETAIL="$3"
  local RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" \
    --arg status "$STATUS" \
    --arg detail "$DETAIL" \
    --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

declare -A CRITICAL_FIELDS
CRITICAL_FIELDS["POST-entries"]="id lookupKey state status"
CRITICAL_FIELDS["GET-entries-id"]="id lookupKey content state"
CRITICAL_FIELDS["POST-fragments"]="id lookupKey slug tags state"
CRITICAL_FIELDS["GET-fragments-id"]="id lookupKey content slug tags state"
CRITICAL_FIELDS["POST-vaults"]="id name slug type"
CRITICAL_FIELDS["GET-vaults"]="vaults"
CRITICAL_FIELDS["error"]="error"

qa_curl() {
  local METHOD="$1"
  local URL="$2"
  local REQ_ID="$3"
  local ENDPOINT_KEY="$4"
  shift 4

  local RESP_RAW
  RESP_RAW=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$URL" "$@" 2>&1 || echo -e "\nCONNECTION_FAILED")

  QA_LAST_HTTP_CODE=$(printf '%s\n' "$RESP_RAW" | tail -1)
  local BODY
  BODY=$(printf '%s\n' "$RESP_RAW" | sed '$d')

  if [ "$QA_LAST_HTTP_CODE" = "CONNECTION_FAILED" ]; then
    echo "[halt] qa_curl: connection failed for $METHOD $URL"
    flush_results
    exit 1
  fi

  if ! printf '%s\n' "$BODY" | jq . >/dev/null 2>&1; then
    append_result "$REQ_ID" "observation" "Non-JSON response (HTTP $QA_LAST_HTTP_CODE): $(printf '%s\n' "$BODY" | head -c 200)" "$BODY"
    append_result "ADPT-02" "pass" "Non-JSON response handled without crash for $REQ_ID (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
    echo "$BODY"
    return 0
  fi

  if [ "$QA_LAST_HTTP_CODE" -ge 400 ] 2>/dev/null; then
    local HAS_ERROR_KEY
    HAS_ERROR_KEY=$(printf '%s\n' "$BODY" | jq 'has("error")' 2>/dev/null || echo "false")
    if [ "$HAS_ERROR_KEY" != "true" ]; then
      append_result "$REQ_ID" "concern" "Error response missing 'error' key (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
    fi
  fi

  local ACTUAL_KEYS
  ACTUAL_KEYS=$(printf '%s\n' "$BODY" | jq -c 'if type == "array" then .[0] // {} else . end | keys | sort' 2>/dev/null || echo "[]")

  local SNAP_FILE=".qa/runs/snapshots/${ENDPOINT_KEY}.json"

  if [ ! -f "$SNAP_FILE" ] && [ "$QA_LAST_HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$QA_LAST_HTTP_CODE" -lt 300 ] 2>/dev/null; then
    echo "$ACTUAL_KEYS" > "$SNAP_FILE"
    append_result "$REQ_ID" "pass" "Snapshot seeded for $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
  elif [ -f "$SNAP_FILE" ]; then
    local EXPECTED_KEYS
    EXPECTED_KEYS=$(cat "$SNAP_FILE")
    if [ "$ACTUAL_KEYS" != "$EXPECTED_KEYS" ]; then
      local MISSING EXTRA
      MISSING=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$exp - $act')
      EXTRA=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$act - $exp')
      if [ "$MISSING" != "[]" ]; then
        append_result "$REQ_ID" "concern" "Missing keys $MISSING from $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
      if [ "$EXTRA" != "[]" ]; then
        append_result "$REQ_ID" "observation" "Extra keys $EXTRA in $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
      append_result "ADPT-01" "pass" "Shape difference detected and logged for $REQ_ID/$ENDPOINT_KEY — missing=$MISSING extra=$EXTRA" "$BODY"
      append_result "ADPT-03" "pass" "Missing/extra field findings recorded for $ENDPOINT_KEY" "$BODY"
    fi
  fi

  local CRITICAL="${CRITICAL_FIELDS[$ENDPOINT_KEY]:-}"
  if [ -n "$CRITICAL" ]; then
    local field
    for field in $CRITICAL; do
      local FIELD_PRESENT
      FIELD_PRESENT=$(printf '%s\n' "$BODY" | jq --arg f "$field" 'has($f)' 2>/dev/null || echo "false")
      if [ "$FIELD_PRESENT" != "true" ]; then
        append_result "$REQ_ID" "concern" "Missing critical field '$field' in $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
    done
  fi

  echo "$BODY"
}

echo "[ok] Step 38 initialized — fixtures loaded, qa_curl ready"

# ══════════════════════════════════════════════════════════════════════
# Category A: Whitespace-only content (D-03)
# These pass z.string().min(1) but are semantically empty. Document
# whether the server accepts or rejects them (Pitfall 4).
# ══════════════════════════════════════════════════════════════════════

# Test 1: Single space
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-whitespace-space" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c ' ' '{content: $c}')")
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] || [ "$QA_LAST_HTTP_CODE" -eq 202 ]; then
  append_result "EXPL-01-whitespace-space" "observation" "Server accepts whitespace-only content: single space (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" -eq 400 ]; then
  append_result "EXPL-01-whitespace-space" "pass" "Server rejects whitespace-only content: single space (HTTP 400)" "$RESP"
fi
echo "[test] EXPL-01-whitespace-space: HTTP $QA_LAST_HTTP_CODE"

# Test 2: Single newline
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-whitespace-newline" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'\n' '{content: $c}')")
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] || [ "$QA_LAST_HTTP_CODE" -eq 202 ]; then
  append_result "EXPL-01-whitespace-newline" "observation" "Server accepts whitespace-only content: single newline (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" -eq 400 ]; then
  append_result "EXPL-01-whitespace-newline" "pass" "Server rejects whitespace-only content: single newline (HTTP 400)" "$RESP"
fi
echo "[test] EXPL-01-whitespace-newline: HTTP $QA_LAST_HTTP_CODE"

# Test 3: Single tab
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-whitespace-tab" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'\t' '{content: $c}')")
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] || [ "$QA_LAST_HTTP_CODE" -eq 202 ]; then
  append_result "EXPL-01-whitespace-tab" "observation" "Server accepts whitespace-only content: single tab (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" -eq 400 ]; then
  append_result "EXPL-01-whitespace-tab" "pass" "Server rejects whitespace-only content: single tab (HTTP 400)" "$RESP"
fi
echo "[test] EXPL-01-whitespace-tab: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Category B: Large payloads (D-02)
# Test on both entries and fragments. 413, 201/202, and 500 are all
# valid outcomes to document. No max-length in Zod schemas, so large
# payloads will pass validation and reach gateway/DB layer.
# ══════════════════════════════════════════════════════════════════════

CONTENT_50KB=$(python3 -c "print('The quick brown fox jumps over the lazy dog. ' * 1200)")
CONTENT_1MB=$(python3 -c "print('x' * 1100000)")

# Test 4: 50KB entry
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-size-50kb-entry" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$CONTENT_50KB" '{content: $c}')")
append_result "EXPL-01-size-50kb-entry" "observation" "50KB entry POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-size-50kb-entry: HTTP $QA_LAST_HTTP_CODE"

# Test 5: 1MB+ entry
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-size-1mb-entry" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$CONTENT_1MB" '{content: $c}')")
append_result "EXPL-01-size-1mb-entry" "observation" "1MB+ entry POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-size-1mb-entry: HTTP $QA_LAST_HTTP_CODE"

# Test 6: 50KB fragment
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-size-50kb-fragment" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$CONTENT_50KB" --arg e "$ENTRY_1_ID" '{title: "50KB fragment", content: $c, entryId: $e}')")
append_result "EXPL-01-size-50kb-fragment" "observation" "50KB fragment POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-size-50kb-fragment: HTTP $QA_LAST_HTTP_CODE"

# Test 7: 1MB+ fragment
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-size-1mb-fragment" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$CONTENT_1MB" --arg e "$ENTRY_1_ID" '{title: "1MB fragment", content: $c, entryId: $e}')")
append_result "EXPL-01-size-1mb-fragment" "observation" "1MB+ fragment POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-size-1mb-fragment: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Category C: JSON-breaking characters (D-04)
# All bodies constructed with jq -n --arg — never string interpolation.
# Null byte test uses --data-binary directly (Pitfall 1: jq cannot
# encode null bytes — RFC 8259 §7 forbids U+0000 in strings).
# ══════════════════════════════════════════════════════════════════════

# Test 8: Raw backslashes
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-json-backslash" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c 'back\slash and \\double' '{content: $c}')")
append_result "EXPL-01-json-backslash" "observation" "Backslash content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-json-backslash: HTTP $QA_LAST_HTTP_CODE"

# Test 9: Unescaped double quotes
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-json-quotes" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c 'He said "hello" and she said "goodbye"' '{content: $c}')")
append_result "EXPL-01-json-quotes" "observation" "Double-quote content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-json-quotes: HTTP $QA_LAST_HTTP_CODE"

# Test 10: Nested JSON string as content
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-json-nested" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c '{"nested": "json", "as": "content"}' '{content: $c}')")
append_result "EXPL-01-json-nested" "observation" "Nested JSON string content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-json-nested: HTTP $QA_LAST_HTTP_CODE"

# Test 11: Null byte via --data-binary (bypasses jq — Pitfall 1)
# Record whatever happens as observation; HTTP parser may reject before server sees it
RESP_RAW=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:3000/entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  --data-binary $'{"content":"before\x00after"}' 2>&1 || echo -e "\nCONNECTION_FAILED")
NULL_HTTP=$(printf '%s\n' "$RESP_RAW" | tail -1)
NULL_BODY=$(printf '%s\n' "$RESP_RAW" | sed '$d')
append_result "EXPL-01-json-null-byte" "observation" "Null byte in content (--data-binary bypass): HTTP $NULL_HTTP" "$NULL_BODY"
echo "[test] EXPL-01-json-null-byte: HTTP $NULL_HTTP"

# ══════════════════════════════════════════════════════════════════════
# Category D: YAML-breaking characters (D-05)
# Fragments stored as markdown with YAML frontmatter — hostile chars
# could corrupt storage. YAML frontmatter test also GETs back the
# fragment to compare submitted vs returned content (Pitfall 5).
# ══════════════════════════════════════════════════════════════════════

# Test 12: YAML frontmatter injection — POST then GET back and compare
YAML_INJECT_CONTENT=$'---\ninjected: true\ntitle: "hacked"\n---\nReal content after injection'
YAML_INJECT_RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-yaml-frontmatter" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$YAML_INJECT_CONTENT" --arg e "$ENTRY_1_ID" '{title: "YAML injection test", content: $c, entryId: $e}')")
YAML_INJECT_HTTP="$QA_LAST_HTTP_CODE"
echo "[test] EXPL-01-yaml-frontmatter POST: HTTP $YAML_INJECT_HTTP"

if [ "$YAML_INJECT_HTTP" -eq 201 ] 2>/dev/null; then
  YAML_FRAG_ID=$(printf '%s\n' "$YAML_INJECT_RESP" | jq -r '.id // empty')
  if [ -n "$YAML_FRAG_ID" ]; then
    # GET back the fragment and compare content
    GET_RESP=$(qa_curl GET "http://localhost:3000/fragments/${YAML_FRAG_ID}" "EXPL-01-yaml-frontmatter-get" "GET-fragments-id" \
      -b "$COOKIE_JAR")
    RETURNED_CONTENT=$(printf '%s\n' "$GET_RESP" | jq -r '.content // empty')
    if [ "$RETURNED_CONTENT" = "$YAML_INJECT_CONTENT" ]; then
      append_result "EXPL-01-yaml-frontmatter" "pass" "YAML frontmatter content round-trips correctly — content unchanged by gateway" "$GET_RESP"
    else
      append_result "EXPL-01-yaml-frontmatter" "concern" "YAML frontmatter injection may have corrupted content — submitted vs returned content differ" "$GET_RESP"
    fi
  fi
fi

# Test 13: Colon-start content (YAML key syntax)
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-yaml-colon-start" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c ': value that looks like YAML' '{content: $c}')")
append_result "EXPL-01-yaml-colon-start" "observation" "Colon-start content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-yaml-colon-start: HTTP $QA_LAST_HTTP_CODE"

# Test 14: Hash-start content (YAML comment syntax)
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-yaml-hash-start" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c '# This looks like a YAML comment' '{content: $c}')")
append_result "EXPL-01-yaml-hash-start" "observation" "Hash-start content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-yaml-hash-start: HTTP $QA_LAST_HTTP_CODE"

# Test 15: YAML directive line
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-yaml-directive" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'%YAML 1.2\n---\ninjected: true' '{content: $c}')")
append_result "EXPL-01-yaml-directive" "observation" "YAML directive content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-yaml-directive: HTTP $QA_LAST_HTTP_CODE"

# Test 16: YAML multiline block scalar indicator
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-yaml-multiline-pipe" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'|\n  This is a YAML multiline\n  block scalar indicator' '{content: $c}')")
append_result "EXPL-01-yaml-multiline-pipe" "observation" "YAML multiline pipe content POST result: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-yaml-multiline-pipe: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Category E: Slug-breaking titles (D-06)
# POST to /fragments with slug-hostile titles. generateSlug() returns
# 'untitled' for empty results (Pitfall 2) — expect 201, not 400.
# Extract actual slug and record as observation.
# ══════════════════════════════════════════════════════════════════════

# Test 17: Emoji-only title
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-slug-emoji" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t '🚀🔥' --arg e "$ENTRY_1_ID" '{title: $t, content: "emoji title test", entryId: $e}')")
ACTUAL_SLUG=$(printf '%s\n' "$RESP" | jq -r '.slug // "null"')
append_result "EXPL-01-slug-emoji" "observation" "Emoji-only title produces slug: '$ACTUAL_SLUG' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
echo "[test] EXPL-01-slug-emoji: HTTP $QA_LAST_HTTP_CODE slug=$ACTUAL_SLUG"

# Test 18: Punctuation-only title
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-slug-punctuation" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t '!!!???' --arg e "$ENTRY_1_ID" '{title: $t, content: "punctuation title test", entryId: $e}')")
ACTUAL_SLUG=$(printf '%s\n' "$RESP" | jq -r '.slug // "null"')
append_result "EXPL-01-slug-punctuation" "observation" "Punctuation-only title produces slug: '$ACTUAL_SLUG' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
echo "[test] EXPL-01-slug-punctuation: HTTP $QA_LAST_HTTP_CODE slug=$ACTUAL_SLUG"

# Test 19: Whitespace-only title
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-slug-whitespace-only" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t '   ' --arg e "$ENTRY_1_ID" '{title: $t, content: "whitespace title test", entryId: $e}')")
ACTUAL_SLUG=$(printf '%s\n' "$RESP" | jq -r '.slug // "null"')
if [ "$QA_LAST_HTTP_CODE" -eq 400 ] 2>/dev/null; then
  # title: min(1) — "   " is 3 bytes, so this may pass; record outcome
  append_result "EXPL-01-slug-whitespace-only" "pass" "Whitespace-only title rejected (HTTP 400)" "$RESP"
else
  append_result "EXPL-01-slug-whitespace-only" "observation" "Whitespace-only title produces slug: '$ACTUAL_SLUG' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
fi
echo "[test] EXPL-01-slug-whitespace-only: HTTP $QA_LAST_HTTP_CODE slug=$ACTUAL_SLUG"

# Test 20: Unicode combining characters only
COMBINING_TITLE=$'\xcc\x80\xcc\x81\xcc\x82'
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-slug-combining-chars" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t "$COMBINING_TITLE" --arg e "$ENTRY_1_ID" '{title: $t, content: "combining chars title test", entryId: $e}')")
ACTUAL_SLUG=$(printf '%s\n' "$RESP" | jq -r '.slug // "null"')
append_result "EXPL-01-slug-combining-chars" "observation" "Combining-chars-only title produces slug: '$ACTUAL_SLUG' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
echo "[test] EXPL-01-slug-combining-chars: HTTP $QA_LAST_HTTP_CODE slug=$ACTUAL_SLUG"

# ══════════════════════════════════════════════════════════════════════
# Category F: SQL injection (D-07)
# Parameterized queries should make these harmless. Record pass if
# server returns 201/202 without error (confirms safe handling).
# ══════════════════════════════════════════════════════════════════════

# Test 21: SQL injection in content
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-sql-inject-content" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "'; DROP TABLE entries; --" '{content: $c}')")
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] || [ "$QA_LAST_HTTP_CODE" -eq 202 ]; then
  append_result "EXPL-01-sql-inject-content" "pass" "SQL injection in content handled safely — parameterized queries protected DB (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-01-sql-inject-content" "observation" "SQL injection in content: unexpected HTTP $QA_LAST_HTTP_CODE" "$RESP"
fi
echo "[test] EXPL-01-sql-inject-content: HTTP $QA_LAST_HTTP_CODE"

# Test 22: SQL injection in fragment title
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-01-sql-inject-title" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t "'; DROP TABLE fragments; --" --arg e "$ENTRY_1_ID" '{title: $t, content: "normal content", entryId: $e}')")
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] || [ "$QA_LAST_HTTP_CODE" -eq 202 ]; then
  append_result "EXPL-01-sql-inject-title" "pass" "SQL injection in fragment title handled safely — parameterized queries protected DB (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-01-sql-inject-title" "observation" "SQL injection in fragment title: unexpected HTTP $QA_LAST_HTTP_CODE" "$RESP"
fi
echo "[test] EXPL-01-sql-inject-title: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Category G: Unicode and text edge cases (D-08)
# Zero-width characters, RTL text, extremely long single line,
# content that is only newlines.
# ══════════════════════════════════════════════════════════════════════

# Test 23: Zero-width space (U+200B)
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-unicode-zwsp" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'invisible\xe2\x80\x8bcharacter' '{content: $c}')")
append_result "EXPL-01-unicode-zwsp" "observation" "Zero-width space (U+200B) in content: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-unicode-zwsp: HTTP $QA_LAST_HTTP_CODE"

# Test 24: Zero-width joiner (U+200D)
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-unicode-zwj" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'joined\xe2\x80\x8dcharacter' '{content: $c}')")
append_result "EXPL-01-unicode-zwj" "observation" "Zero-width joiner (U+200D) in content: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-unicode-zwj: HTTP $QA_LAST_HTTP_CODE"

# Test 25: RTL text mixed with LTR
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-unicode-rtl" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c 'مرحبا بالعالم - Hello World RTL test' '{content: $c}')")
append_result "EXPL-01-unicode-rtl" "observation" "RTL Arabic mixed with LTR content: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-unicode-rtl: HTTP $QA_LAST_HTTP_CODE"

# Test 26: 10K chars no newlines (single line)
CONTENT_LONG_LINE=$(python3 -c "print('a' * 10000)")
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-unicode-long-single-line" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$CONTENT_LONG_LINE" '{content: $c}')")
append_result "EXPL-01-unicode-long-single-line" "observation" "10K-char single-line content: HTTP $QA_LAST_HTTP_CODE" "$RESP"
echo "[test] EXPL-01-unicode-long-single-line: HTTP $QA_LAST_HTTP_CODE"

# Test 27: Only newlines (5 newlines, no other content)
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-01-unicode-only-newlines" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c $'\n\n\n\n\n' '{content: $c}')")
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] || [ "$QA_LAST_HTTP_CODE" -eq 202 ]; then
  append_result "EXPL-01-unicode-only-newlines" "observation" "Five-newline-only content accepted by server (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" -eq 400 ]; then
  append_result "EXPL-01-unicode-only-newlines" "pass" "Five-newline-only content rejected (HTTP 400)" "$RESP"
fi
echo "[test] EXPL-01-unicode-only-newlines: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Flush all EXPL-01 results
# ══════════════════════════════════════════════════════════════════════
TOTAL_38=$(printf '%s\n' "$RESULTS" | jq 'length')
echo ""
echo "===== Step 38: Edge-case content catalog complete ====="
echo "  Results accumulated: $TOTAL_38"
echo "  Flushing to .qa/runs/adaptive-exploratory-results.json"
flush_results
echo "  Done."
echo "======================================================="
```

## Step 39 -- Missing optional fields (EXPL-02)

Tests all entry and fragment optional field combinations (D-09). Verifies that Zod defaults — `source: 'api'`, `type: 'thought'`, `tags: []` — are applied correctly when optional fields are omitted. Also tests invalid vaultId handling (expect 400, not 500) and vault-scoped search for pipeline-processed entries. Re-initializes helpers for shell session independence, merges with prior results from `adaptive-exploratory-results.json` before flushing.

Run:

```bash
# ── Re-initialize for shell session independence ──
mkdir -p .qa/runs/snapshots/

FIXTURES=$(cat .qa/runs/fixtures.json)
if [ -z "$FIXTURES" ]; then
  echo "[halt] fixtures.json not found -- run Phase 2 steps first"
  exit 1
fi

COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[halt] cookie jar not found at $COOKIE_JAR -- re-run Phase 1 sign-in steps"
  exit 1
fi

ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id // empty')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id // empty')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Personal") | .id')

RESULTS='[]'

append_result() {
  local REQ_ID="$1"
  local STATUS="$2"
  local DETAIL="$3"
  local RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" \
    --arg status "$STATUS" \
    --arg detail "$DETAIL" \
    --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

declare -A CRITICAL_FIELDS
CRITICAL_FIELDS["POST-entries"]="id lookupKey state status"
CRITICAL_FIELDS["GET-entries-id"]="id lookupKey content state"
CRITICAL_FIELDS["POST-fragments"]="id lookupKey slug tags state"
CRITICAL_FIELDS["GET-fragments-id"]="id lookupKey content slug tags state"
CRITICAL_FIELDS["POST-vaults"]="id name slug type"
CRITICAL_FIELDS["GET-vaults"]="vaults"
CRITICAL_FIELDS["error"]="error"

qa_curl() {
  local METHOD="$1"
  local URL="$2"
  local REQ_ID="$3"
  local ENDPOINT_KEY="$4"
  shift 4

  local RESP_RAW
  RESP_RAW=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$URL" "$@" 2>&1 || echo -e "\nCONNECTION_FAILED")

  QA_LAST_HTTP_CODE=$(printf '%s\n' "$RESP_RAW" | tail -1)
  local BODY
  BODY=$(printf '%s\n' "$RESP_RAW" | sed '$d')

  if [ "$QA_LAST_HTTP_CODE" = "CONNECTION_FAILED" ]; then
    echo "[halt] qa_curl: connection failed for $METHOD $URL"
    flush_results
    exit 1
  fi

  if ! printf '%s\n' "$BODY" | jq . >/dev/null 2>&1; then
    append_result "$REQ_ID" "observation" "Non-JSON response (HTTP $QA_LAST_HTTP_CODE): $(printf '%s\n' "$BODY" | head -c 200)" "$BODY"
    append_result "ADPT-02" "pass" "Non-JSON response handled without crash for $REQ_ID (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
    echo "$BODY"
    return 0
  fi

  if [ "$QA_LAST_HTTP_CODE" -ge 400 ] 2>/dev/null; then
    local HAS_ERROR_KEY
    HAS_ERROR_KEY=$(printf '%s\n' "$BODY" | jq 'has("error")' 2>/dev/null || echo "false")
    if [ "$HAS_ERROR_KEY" != "true" ]; then
      append_result "$REQ_ID" "concern" "Error response missing 'error' key (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
    fi
  fi

  local ACTUAL_KEYS
  ACTUAL_KEYS=$(printf '%s\n' "$BODY" | jq -c 'if type == "array" then .[0] // {} else . end | keys | sort' 2>/dev/null || echo "[]")

  local SNAP_FILE=".qa/runs/snapshots/${ENDPOINT_KEY}.json"

  if [ ! -f "$SNAP_FILE" ] && [ "$QA_LAST_HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$QA_LAST_HTTP_CODE" -lt 300 ] 2>/dev/null; then
    echo "$ACTUAL_KEYS" > "$SNAP_FILE"
    append_result "$REQ_ID" "pass" "Snapshot seeded for $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
  elif [ -f "$SNAP_FILE" ]; then
    local EXPECTED_KEYS
    EXPECTED_KEYS=$(cat "$SNAP_FILE")
    if [ "$ACTUAL_KEYS" != "$EXPECTED_KEYS" ]; then
      local MISSING EXTRA
      MISSING=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$exp - $act')
      EXTRA=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$act - $exp')
      if [ "$MISSING" != "[]" ]; then
        append_result "$REQ_ID" "concern" "Missing keys $MISSING from $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
      if [ "$EXTRA" != "[]" ]; then
        append_result "$REQ_ID" "observation" "Extra keys $EXTRA in $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
      append_result "ADPT-01" "pass" "Shape difference detected and logged for $REQ_ID/$ENDPOINT_KEY — missing=$MISSING extra=$EXTRA" "$BODY"
      append_result "ADPT-03" "pass" "Missing/extra field findings recorded for $ENDPOINT_KEY" "$BODY"
    fi
  fi

  local CRITICAL="${CRITICAL_FIELDS[$ENDPOINT_KEY]:-}"
  if [ -n "$CRITICAL" ]; then
    local field
    for field in $CRITICAL; do
      local FIELD_PRESENT
      FIELD_PRESENT=$(printf '%s\n' "$BODY" | jq --arg f "$field" 'has($f)' 2>/dev/null || echo "false")
      if [ "$FIELD_PRESENT" != "true" ]; then
        append_result "$REQ_ID" "concern" "Missing critical field '$field' in $ENDPOINT_KEY (HTTP $QA_LAST_HTTP_CODE)" "$BODY"
      fi
    done
  fi

  echo "$BODY"
}

echo "[ok] Step 39 initialized — fixtures loaded, qa_curl ready"

# ══════════════════════════════════════════════════════════════════════
# Entry optional field combinations (D-09)
# Required field: content. Optional: title, source, type, vaultId.
# Zod defaults: source='api', type='thought'.
# ══════════════════════════════════════════════════════════════════════

EXPL02_CONTENT="EXPL-02 optional field test"

# Test 1: No optional fields at all (bare minimum)
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-no-title" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$EXPL02_CONTENT" '{content: $c}')")
RESP_SOURCE=$(printf '%s\n' "$RESP" | jq -r '.source // "missing"')
RESP_TYPE=$(printf '%s\n' "$RESP" | jq -r '.type // "missing"')
if [ "$RESP_SOURCE" = "api" ] && [ "$RESP_TYPE" = "thought" ]; then
  append_result "EXPL-02-no-title" "pass" "Defaults applied: source='api', type='thought' when all optional fields omitted (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-no-title" "concern" "Defaults NOT applied correctly: source='$RESP_SOURCE' type='$RESP_TYPE' (expected source=api, type=thought)" "$RESP"
fi
echo "[test] EXPL-02-no-title: HTTP $QA_LAST_HTTP_CODE source=$RESP_SOURCE type=$RESP_TYPE"

# Test 2: Include title, omit source — verify source default
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-no-source" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$EXPL02_CONTENT" '{content: $c, title: "EXPL-02 test"}')")
RESP_SOURCE=$(printf '%s\n' "$RESP" | jq -r '.source // "missing"')
if [ "$RESP_SOURCE" = "api" ]; then
  append_result "EXPL-02-no-source" "pass" "source default 'api' applied when source omitted (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-no-source" "concern" "source default NOT applied: got '$RESP_SOURCE' (expected 'api')" "$RESP"
fi
echo "[test] EXPL-02-no-source: HTTP $QA_LAST_HTTP_CODE source=$RESP_SOURCE"

# Test 3: Include title, omit type — verify type default
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-no-type" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$EXPL02_CONTENT" '{content: $c, title: "EXPL-02 type test"}')")
RESP_TYPE=$(printf '%s\n' "$RESP" | jq -r '.type // "missing"')
if [ "$RESP_TYPE" = "thought" ]; then
  append_result "EXPL-02-no-type" "pass" "type default 'thought' applied when type omitted (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-no-type" "concern" "type default NOT applied: got '$RESP_TYPE' (expected 'thought')" "$RESP"
fi
echo "[test] EXPL-02-no-type: HTTP $QA_LAST_HTTP_CODE type=$RESP_TYPE"

# Test 4: Include title, omit vaultId — record what vaultId is assigned
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-no-vaultId" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$EXPL02_CONTENT" '{content: $c, title: "EXPL-02 vault test"}')")
RESP_VAULT=$(printf '%s\n' "$RESP" | jq -r '.vaultId // "null"')
append_result "EXPL-02-no-vaultId" "observation" "vaultId when omitted: '$RESP_VAULT' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
echo "[test] EXPL-02-no-vaultId: HTTP $QA_LAST_HTTP_CODE vaultId=$RESP_VAULT"

# Test 5: Only required content field — verify all defaults
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-only-content" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n '{content: "EXPL-02 bare minimum"}')")
RESP_SOURCE=$(printf '%s\n' "$RESP" | jq -r '.source // "missing"')
RESP_TYPE=$(printf '%s\n' "$RESP" | jq -r '.type // "missing"')
RESP_TITLE=$(printf '%s\n' "$RESP" | jq -r '.title // "null"')
if [ "$RESP_SOURCE" = "api" ] && [ "$RESP_TYPE" = "thought" ]; then
  append_result "EXPL-02-only-content" "pass" "All defaults applied on bare-minimum payload: source='$RESP_SOURCE', type='$RESP_TYPE', title='$RESP_TITLE' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-only-content" "concern" "Defaults NOT applied on bare-minimum: source='$RESP_SOURCE' type='$RESP_TYPE'" "$RESP"
fi
echo "[test] EXPL-02-only-content: HTTP $QA_LAST_HTTP_CODE source=$RESP_SOURCE type=$RESP_TYPE title=$RESP_TITLE"

# Test 6: All optional fields provided — verify no defaults override explicit values
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-all-optional-present" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$EXPL02_CONTENT" --arg v "$VAULT_WORK_ID" \
    '{content: $c, title: "Full payload", source: "test", type: "note", vaultId: $v}')")
RESP_SOURCE=$(printf '%s\n' "$RESP" | jq -r '.source // "missing"')
RESP_TYPE=$(printf '%s\n' "$RESP" | jq -r '.type // "missing"')
if [ "$RESP_SOURCE" = "test" ] && [ "$RESP_TYPE" = "note" ]; then
  append_result "EXPL-02-all-optional-present" "pass" "Explicit values not overridden by defaults: source='test', type='note' preserved (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-all-optional-present" "concern" "Explicit values overridden by defaults: source='$RESP_SOURCE' type='$RESP_TYPE' (expected source=test, type=note)" "$RESP"
fi
echo "[test] EXPL-02-all-optional-present: HTTP $QA_LAST_HTTP_CODE source=$RESP_SOURCE type=$RESP_TYPE"

# Test 6b: Invalid vaultId — server must return 400, not 500
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-02-invalid-vaultId" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "$EXPL02_CONTENT" '{content: $c, title: "Invalid vault test", vaultId: "nonexistent-vault-id"}')")
if [ "$QA_LAST_HTTP_CODE" = "400" ] || [ "$QA_LAST_HTTP_CODE" = "404" ] || [ "$QA_LAST_HTTP_CODE" = "422" ]; then
  append_result "EXPL-02-invalid-vaultId" "pass" "Invalid vaultId rejected with HTTP $QA_LAST_HTTP_CODE (proper validation)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "500" ]; then
  append_result "EXPL-02-invalid-vaultId" "concern" "Invalid vaultId causes HTTP 500 — server does not validate vaultId existence before DB insert (FK constraint violation)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "202" ]; then
  append_result "EXPL-02-invalid-vaultId" "concern" "Invalid vaultId accepted (HTTP 202) — server does not validate vaultId existence, may cause downstream pipeline errors" "$RESP"
else
  append_result "EXPL-02-invalid-vaultId" "observation" "Invalid vaultId returned HTTP $QA_LAST_HTTP_CODE" "$RESP"
fi
echo "[test] EXPL-02-invalid-vaultId: HTTP $QA_LAST_HTTP_CODE"

# Test 6c: Vault-scoped search returns results for pipeline-processed entries
# Entries created in Phase 2 with vaultId should have been processed by the agent
# pipeline, which creates fragments with vaultId set. Search scoped to that vault
# should return at least one result if indexing is complete.
RESP=$(qa_curl GET "http://localhost:3000/search?q=sprint+planning&limit=10&vaultId=${VAULT_WORK_ID}" \
  "EXPL-02-vault-scoped-search" "GET-search" \
  -b "$COOKIE_JAR")
SEARCH_COUNT=$(printf '%s\n' "$RESP" | jq '.results | length' 2>/dev/null || echo "0")
if [ "$SEARCH_COUNT" -gt 0 ] 2>/dev/null; then
  append_result "EXPL-02-vault-scoped-search" "pass" "Vault-scoped search returned $SEARCH_COUNT results for Work vault (pipeline fragments indexed)" "$RESP"
elif [ "$SEARCH_COUNT" = "0" ]; then
  # Check if unscoped search finds anything for the same query
  UNSCOPED=$(curl -sf "http://localhost:3000/search?q=sprint+planning&limit=10" -b "$COOKIE_JAR" 2>/dev/null)
  UNSCOPED_COUNT=$(printf '%s\n' "$UNSCOPED" | jq '.results | length' 2>/dev/null || echo "0")
  if [ "$UNSCOPED_COUNT" -gt 0 ] 2>/dev/null; then
    append_result "EXPL-02-vault-scoped-search" "concern" "Unscoped search returns $UNSCOPED_COUNT results but vault-scoped returns 0 — fragments may lack vaultId in DB or gateway indexing incomplete for vault-scoped paths" "$RESP"
  else
    append_result "EXPL-02-vault-scoped-search" "observation" "Both scoped and unscoped search return 0 — gateway indexing may not have completed for pipeline-created fragments" "$RESP"
  fi
fi
echo "[test] EXPL-02-vault-scoped-search: HTTP $QA_LAST_HTTP_CODE results=$SEARCH_COUNT"

# ══════════════════════════════════════════════════════════════════════
# Fragment optional field combinations (D-09)
# Required: title, entryId. Optional: content, tags (default []).
# ══════════════════════════════════════════════════════════════════════

# Test 7: Fragment with no content (content is optional per schema)
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-02-fragment-no-content" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg e "$ENTRY_1_ID" '{title: "No content fragment", entryId: $e}')")
RESP_CONTENT=$(printf '%s\n' "$RESP" | jq -r '.content // "null"')
if [ "$QA_LAST_HTTP_CODE" -eq 201 ] 2>/dev/null; then
  append_result "EXPL-02-fragment-no-content" "pass" "Fragment created without content field (content is optional): content='$RESP_CONTENT' (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-fragment-no-content" "concern" "Fragment without content field rejected: HTTP $QA_LAST_HTTP_CODE (schema says content is optional)" "$RESP"
fi
echo "[test] EXPL-02-fragment-no-content: HTTP $QA_LAST_HTTP_CODE content=$RESP_CONTENT"

# Test 8: Fragment with no tags — verify tags defaults to []
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-02-fragment-no-tags" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg e "$ENTRY_1_ID" '{title: "No tags fragment", content: "has content", entryId: $e}')")
RESP_TAGS=$(printf '%s\n' "$RESP" | jq -c '.tags // "missing"')
if [ "$RESP_TAGS" = "[]" ]; then
  append_result "EXPL-02-fragment-no-tags" "pass" "tags default [] applied when tags omitted (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-fragment-no-tags" "concern" "tags default NOT applied: got '$RESP_TAGS' (expected [])" "$RESP"
fi
echo "[test] EXPL-02-fragment-no-tags: HTTP $QA_LAST_HTTP_CODE tags=$RESP_TAGS"

# Test 9: Fragment with explicit empty tags array — verify same as omitted
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-02-fragment-empty-tags" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg e "$ENTRY_1_ID" '{title: "Empty tags", content: "has content", entryId: $e, tags: []}')")
RESP_TAGS=$(printf '%s\n' "$RESP" | jq -c '.tags // "missing"')
if [ "$RESP_TAGS" = "[]" ]; then
  append_result "EXPL-02-fragment-empty-tags" "pass" "Explicit empty tags [] preserved in response (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-02-fragment-empty-tags" "concern" "Explicit empty tags NOT preserved: got '$RESP_TAGS' (expected [])" "$RESP"
fi
echo "[test] EXPL-02-fragment-empty-tags: HTTP $QA_LAST_HTTP_CODE tags=$RESP_TAGS"

# ══════════════════════════════════════════════════════════════════════
# Merge with prior results from adaptive-exploratory-results.json
# (same pattern as Step 24 in Phase 3)
# ══════════════════════════════════════════════════════════════════════
if [ -f .qa/runs/adaptive-exploratory-results.json ]; then
  PRIOR=$(cat .qa/runs/adaptive-exploratory-results.json)
  RESULTS=$(printf '%s\n' "$PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
fi

TOTAL_39=$(printf '%s\n' "$RESULTS" | jq 'length')
PASSES=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="pass")] | length')
CONCERNS=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="concern")] | length')
OBSERVATIONS=$(printf '%s\n' "$RESULTS" | jq '[.[] | select(.status=="observation")] | length')

echo ""
echo "===== Step 39: Missing optional fields complete ====="
echo "  Total results (all steps merged): $TOTAL_39"
echo "  Pass:         $PASSES"
echo "  Concern:      $CONCERNS"
echo "  Observation:  $OBSERVATIONS"
echo "  Flushing merged results to .qa/runs/adaptive-exploratory-results.json"
flush_results
echo "  Done."
echo "====================================================="
```

## Step 40 -- Authorization boundary tests (EXPL-03)

Tests security boundaries using a second QA user: cross-user read/write/delete access to User 1's resources (expect 404), unauthenticated access to all protected endpoints (expect 401), and verification that User 1's data is intact after all cross-user probes. Re-initializes helpers for shell session independence.

Run:

```bash
# ── Re-initialize for shell session independence ──
mkdir -p .qa/runs/snapshots/

FIXTURES=$(cat .qa/runs/fixtures.json)
if [ -z "$FIXTURES" ]; then
  echo "[halt] fixtures.json not found -- run Phase 2 steps first"
  exit 1
fi

COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[halt] cookie jar not found at $COOKIE_JAR -- re-run Phase 1 sign-in steps"
  exit 1
fi

ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id // empty')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id // empty')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')
VAULT_PERSONAL_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Personal") | .id')

RESULTS='[]'

append_result() {
  local REQ_ID="$1" STATUS="$2" DETAIL="$3" RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" --arg status "$STATUS" \
    --arg detail "$DETAIL" --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

declare -A CRITICAL_FIELDS
CRITICAL_FIELDS["POST-entries"]="id lookupKey state status"
CRITICAL_FIELDS["GET-entries-id"]="id lookupKey content state"
CRITICAL_FIELDS["POST-fragments"]="id lookupKey slug tags state"
CRITICAL_FIELDS["GET-fragments-id"]="id lookupKey content slug tags state"
CRITICAL_FIELDS["POST-vaults"]="id name slug type"
CRITICAL_FIELDS["GET-vaults"]="vaults"
CRITICAL_FIELDS["error"]="error"

QA_LAST_HTTP_CODE=""

qa_curl() {
  local METHOD="$1" URL="$2" REQ_ID="$3" ENDPOINT_KEY="$4"
  shift 4
  local RESP_RAW HTTP_CODE BODY
  RESP_RAW=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$URL" "$@" 2>&1 || echo -e "\nCONNECTION_FAILED")
  HTTP_CODE=$(printf '%s\n' "$RESP_RAW" | tail -1)
  BODY=$(printf '%s\n' "$RESP_RAW" | sed '$d')
  QA_LAST_HTTP_CODE="$HTTP_CODE"

  if [ "$HTTP_CODE" = "CONNECTION_FAILED" ]; then
    flush_results; echo "[halt] server not reachable"; exit 1
  fi

  local IS_JSON=false
  if printf '%s\n' "$BODY" | jq . >/dev/null 2>&1; then IS_JSON=true; fi

  if [ "$IS_JSON" = false ]; then
    append_result "$REQ_ID" "observation" "Non-JSON response (HTTP $HTTP_CODE): $BODY" "$BODY"
    append_result "ADPT-02" "pass" "Non-JSON response handled without crash for $REQ_ID (HTTP $HTTP_CODE)" "$BODY"
    echo "$BODY"; return
  fi

  # Error shape check
  local HAS_ERROR
  HAS_ERROR=$(printf '%s\n' "$BODY" | jq 'has("error")')
  if [ "$HAS_ERROR" = "true" ]; then
    local KEY_COUNT
    KEY_COUNT=$(printf '%s\n' "$BODY" | jq 'keys | length')
    if [ "$KEY_COUNT" -gt 2 ]; then
      append_result "$REQ_ID" "concern" "Error response has $KEY_COUNT keys (expected <=2 for {error,fields?})" "$BODY"
    fi
  fi

  # Golden snapshot diff
  local SNAP_FILE=".qa/runs/snapshots/${ENDPOINT_KEY}.json"
  local ACTUAL_KEYS
  ACTUAL_KEYS=$(printf '%s\n' "$BODY" | jq -c 'keys | sort' 2>/dev/null || echo "[]")
  if [ ! -f "$SNAP_FILE" ] && [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
    echo "$ACTUAL_KEYS" > "$SNAP_FILE"
  elif [ -f "$SNAP_FILE" ] && [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
    local EXPECTED_KEYS MISSING EXTRA
    EXPECTED_KEYS=$(cat "$SNAP_FILE")
    if [ "$ACTUAL_KEYS" != "$EXPECTED_KEYS" ]; then
      MISSING=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$exp - $act')
      EXTRA=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$act - $exp')
      [ "$MISSING" != "[]" ] && append_result "$REQ_ID" "concern" "Missing keys $MISSING from $ENDPOINT_KEY snapshot" "$BODY"
      [ "$EXTRA" != "[]" ] && append_result "$REQ_ID" "observation" "Extra keys $EXTRA in $ENDPOINT_KEY response" "$BODY"
      append_result "ADPT-01" "pass" "Shape difference detected and logged for $REQ_ID/$ENDPOINT_KEY — missing=$MISSING extra=$EXTRA" "$BODY"
      append_result "ADPT-03" "pass" "Missing/extra field findings recorded for $ENDPOINT_KEY" "$BODY"
    fi
  fi

  # Critical field check
  local CRIT="${CRITICAL_FIELDS[$ENDPOINT_KEY]:-}"
  if [ -n "$CRIT" ]; then
    for field in $CRIT; do
      local PRESENT
      PRESENT=$(printf '%s\n' "$BODY" | jq --arg f "$field" 'has($f)')
      if [ "$PRESENT" != "true" ]; then
        append_result "$REQ_ID" "concern" "Critical field '$field' missing from $ENDPOINT_KEY response" "$BODY"
      fi
    done
  fi

  echo "$BODY"
}

# ══════════════════════════════════════════════════════════════════════
# Section A: Second user creation (D-18)
# ══════════════════════════════════════════════════════════════════════

COOKIE_JAR_2=$(mktemp /tmp/qa-cookies2-XXXXXX.txt)
TS2=$(date +%s)
QA_EMAIL_2="qa.robot2.${TS2}@robin.os"
QA_PASS_2="qa-password2-${TS2}"

SIGNUP2_RESP=$(curl -sf -X POST http://localhost:3000/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -c "$COOKIE_JAR_2" \
  -d "$(jq -n --arg e "$QA_EMAIL_2" --arg p "$QA_PASS_2" --arg n "QA Robot 2" \
    '{email: $e, password: $p, name: $n}')" 2>&1)

if [ $? -ne 0 ]; then
  append_result "EXPL-03-user2-signup" "failure" "Second user signup failed: $SIGNUP2_RESP" '"SIGNUP_FAILED"'
else
  append_result "EXPL-03-user2-signup" "pass" "Second user created: $QA_EMAIL_2" "$SIGNUP2_RESP"
fi

sleep 5  # wait for gitolite provision (STATE.md decision)
echo "[ok] second QA user created: $QA_EMAIL_2"

# ══════════════════════════════════════════════════════════════════════
# Section B: Cross-user READ tests (D-19 Read)
# User 2 attempts to read User 1's resources — expect 404 (ownership check)
# ══════════════════════════════════════════════════════════════════════

# Test 1: Cross-user vault read
RESP=$(qa_curl GET "http://localhost:3000/vaults/${VAULT_WORK_ID}" "EXPL-03-crossuser-read-vault" "GET-vaults" -b "$COOKIE_JAR_2")
if [ "$QA_LAST_HTTP_CODE" = "404" ]; then
  append_result "EXPL-03-crossuser-read-vault" "pass" "User 2 cannot read User 1 vault: 404 (ownership check working)" "$RESP"
else
  append_result "EXPL-03-crossuser-read-vault" "failure" "Cross-user vault read returned HTTP $QA_LAST_HTTP_CODE (expected 404)" "$RESP"
fi
echo "[test] EXPL-03-crossuser-read-vault: HTTP $QA_LAST_HTTP_CODE"

# Test 2: Cross-user entry read
RESP=$(qa_curl GET "http://localhost:3000/entries/${ENTRY_1_ID}" "EXPL-03-crossuser-read-entry" "GET-entries-id" -b "$COOKIE_JAR_2")
if [ "$QA_LAST_HTTP_CODE" = "404" ]; then
  append_result "EXPL-03-crossuser-read-entry" "pass" "User 2 cannot read User 1 entry: 404 (ownership check working)" "$RESP"
else
  append_result "EXPL-03-crossuser-read-entry" "failure" "Cross-user entry read returned HTTP $QA_LAST_HTTP_CODE (expected 404)" "$RESP"
fi
echo "[test] EXPL-03-crossuser-read-entry: HTTP $QA_LAST_HTTP_CODE"

# Test 3: Cross-user fragment read
RESP=$(qa_curl GET "http://localhost:3000/fragments/${FRAG_1_ID}" "EXPL-03-crossuser-read-fragment" "GET-fragments-id" -b "$COOKIE_JAR_2")
if [ "$QA_LAST_HTTP_CODE" = "404" ]; then
  append_result "EXPL-03-crossuser-read-fragment" "pass" "User 2 cannot read User 1 fragment: 404 (ownership check working)" "$RESP"
else
  append_result "EXPL-03-crossuser-read-fragment" "failure" "Cross-user fragment read returned HTTP $QA_LAST_HTTP_CODE (expected 404)" "$RESP"
fi
echo "[test] EXPL-03-crossuser-read-fragment: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Section C: Cross-user WRITE tests (D-19 Write)
# ══════════════════════════════════════════════════════════════════════

# Test 4: User 2 POSTs fragment with User 1's entryId (Pitfall 3 — must use real ID to reach ownership check)
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-03-crossuser-write-fragment" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR_2" \
  -d "$(jq -n --arg t "Cross-user fragment" --arg e "$ENTRY_1_ID" '{title: $t, entryId: $e}')")
if [ "$QA_LAST_HTTP_CODE" = "404" ] || [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-crossuser-write-fragment" "pass" "User 2 cannot create fragment on User 1 entry: HTTP $QA_LAST_HTTP_CODE (entry not found for this user)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "201" ]; then
  append_result "EXPL-03-crossuser-write-fragment" "failure" "SECURITY: User 2 was able to create fragment on User 1's entry (HTTP 201)" "$RESP"
else
  append_result "EXPL-03-crossuser-write-fragment" "concern" "Unexpected HTTP $QA_LAST_HTTP_CODE on cross-user fragment write" "$RESP"
fi
echo "[test] EXPL-03-crossuser-write-fragment: HTTP $QA_LAST_HTTP_CODE"

# Test 5: User 2 PUTs to update User 1's fragment
RESP=$(qa_curl PUT "http://localhost:3000/fragments/${FRAG_1_ID}" "EXPL-03-crossuser-update-fragment" "PUT-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR_2" \
  -d "$(jq -n --arg t "Hacked title" '{title: $t}')")
if [ "$QA_LAST_HTTP_CODE" = "404" ]; then
  append_result "EXPL-03-crossuser-update-fragment" "pass" "User 2 cannot update User 1 fragment: 404 (ownership check working)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "200" ]; then
  append_result "EXPL-03-crossuser-update-fragment" "failure" "SECURITY: User 2 was able to update User 1's fragment (HTTP 200)" "$RESP"
else
  append_result "EXPL-03-crossuser-update-fragment" "concern" "Unexpected HTTP $QA_LAST_HTTP_CODE on cross-user fragment update" "$RESP"
fi
echo "[test] EXPL-03-crossuser-update-fragment: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Section D: Cross-user DELETE probes (D-19 Delete)
# Probe whether DELETE endpoints exist; if so, verify cross-user rejection
# ══════════════════════════════════════════════════════════════════════

# Test 6: Cross-user fragment delete probe
RESP=$(qa_curl DELETE "http://localhost:3000/fragments/${FRAG_1_ID}" "EXPL-03-crossuser-delete-fragment" "DELETE-fragments" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR_2")
if [ "$QA_LAST_HTTP_CODE" = "404" ]; then
  append_result "EXPL-03-crossuser-delete-fragment" "pass" "Cross-user fragment delete returned 404 (ownership check or route not found)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "405" ]; then
  append_result "EXPL-03-crossuser-delete-fragment" "observation" "DELETE /fragments/:id returns 405 — route does not exist" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "204" ] || [ "$QA_LAST_HTTP_CODE" = "200" ]; then
  append_result "EXPL-03-crossuser-delete-fragment" "failure" "SECURITY: User 2 was able to delete User 1's fragment (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-03-crossuser-delete-fragment" "observation" "DELETE /fragments/:id returned HTTP $QA_LAST_HTTP_CODE" "$RESP"
fi
echo "[test] EXPL-03-crossuser-delete-fragment: HTTP $QA_LAST_HTTP_CODE"

# Test 7: Cross-user vault delete probe
RESP=$(qa_curl DELETE "http://localhost:3000/vaults/${VAULT_WORK_ID}" "EXPL-03-crossuser-delete-vault" "DELETE-vaults" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR_2")
if [ "$QA_LAST_HTTP_CODE" = "404" ]; then
  append_result "EXPL-03-crossuser-delete-vault" "pass" "Cross-user vault delete returned 404 (ownership check or route not found)" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "405" ]; then
  append_result "EXPL-03-crossuser-delete-vault" "observation" "DELETE /vaults/:id returns 405 — route does not exist" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "204" ] || [ "$QA_LAST_HTTP_CODE" = "200" ]; then
  append_result "EXPL-03-crossuser-delete-vault" "failure" "SECURITY: User 2 was able to delete User 1's vault (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
else
  append_result "EXPL-03-crossuser-delete-vault" "observation" "DELETE /vaults/:id returned HTTP $QA_LAST_HTTP_CODE" "$RESP"
fi
echo "[test] EXPL-03-crossuser-delete-vault: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Section E: Unauthenticated access tests (D-20)
# Same calls WITHOUT -b cookie jar — expect 401 on all protected routes
# ══════════════════════════════════════════════════════════════════════

# Test 8: Unauthenticated GET /entries
RESP=$(qa_curl GET "http://localhost:3000/entries" "EXPL-03-unauth-entries" "GET-entries")
if [ "$QA_LAST_HTTP_CODE" = "401" ]; then
  append_result "EXPL-03-unauth-entries" "pass" "Unauthenticated GET /entries correctly returns 401" "$RESP"
else
  append_result "EXPL-03-unauth-entries" "failure" "Unauthenticated GET /entries returned HTTP $QA_LAST_HTTP_CODE (expected 401)" "$RESP"
fi
echo "[test] EXPL-03-unauth-entries: HTTP $QA_LAST_HTTP_CODE"

# Test 9: Unauthenticated GET /fragments
RESP=$(qa_curl GET "http://localhost:3000/fragments" "EXPL-03-unauth-fragments" "GET-fragments")
if [ "$QA_LAST_HTTP_CODE" = "401" ]; then
  append_result "EXPL-03-unauth-fragments" "pass" "Unauthenticated GET /fragments correctly returns 401" "$RESP"
else
  append_result "EXPL-03-unauth-fragments" "failure" "Unauthenticated GET /fragments returned HTTP $QA_LAST_HTTP_CODE (expected 401)" "$RESP"
fi
echo "[test] EXPL-03-unauth-fragments: HTTP $QA_LAST_HTTP_CODE"

# Test 10: Unauthenticated GET /vaults
RESP=$(qa_curl GET "http://localhost:3000/vaults" "EXPL-03-unauth-vaults" "GET-vaults")
if [ "$QA_LAST_HTTP_CODE" = "401" ]; then
  append_result "EXPL-03-unauth-vaults" "pass" "Unauthenticated GET /vaults correctly returns 401" "$RESP"
else
  append_result "EXPL-03-unauth-vaults" "failure" "Unauthenticated GET /vaults returned HTTP $QA_LAST_HTTP_CODE (expected 401)" "$RESP"
fi
echo "[test] EXPL-03-unauth-vaults: HTTP $QA_LAST_HTTP_CODE"

# Test 11: Unauthenticated POST /entries
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-unauth-post-entry" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"content":"unauthenticated"}')
if [ "$QA_LAST_HTTP_CODE" = "401" ]; then
  append_result "EXPL-03-unauth-post-entry" "pass" "Unauthenticated POST /entries correctly returns 401" "$RESP"
else
  append_result "EXPL-03-unauth-post-entry" "failure" "Unauthenticated POST /entries returned HTTP $QA_LAST_HTTP_CODE (expected 401)" "$RESP"
fi
echo "[test] EXPL-03-unauth-post-entry: HTTP $QA_LAST_HTTP_CODE"

# Test 12: Unauthenticated GET /users/profile
RESP=$(qa_curl GET "http://localhost:3000/users/profile" "EXPL-03-unauth-profile" "GET-profile")
if [ "$QA_LAST_HTTP_CODE" = "401" ]; then
  append_result "EXPL-03-unauth-profile" "pass" "Unauthenticated GET /users/profile correctly returns 401" "$RESP"
else
  append_result "EXPL-03-unauth-profile" "failure" "Unauthenticated GET /users/profile returned HTTP $QA_LAST_HTTP_CODE (expected 401)" "$RESP"
fi
echo "[test] EXPL-03-unauth-profile: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Verify User 1 data is still intact after all cross-user tests
# ══════════════════════════════════════════════════════════════════════

VERIFY=$(qa_curl GET "http://localhost:3000/fragments/${FRAG_1_ID}" "EXPL-03-verify-intact" "GET-fragments-id" -b "$COOKIE_JAR")
if [ "$QA_LAST_HTTP_CODE" = "200" ]; then
  append_result "EXPL-03-verify-intact" "pass" "User 1 fragment still intact after cross-user tests (HTTP 200)" "$VERIFY"
else
  append_result "EXPL-03-verify-intact" "failure" "User 1 fragment may have been modified/deleted (HTTP $QA_LAST_HTTP_CODE)" "$VERIFY"
fi
echo "[test] EXPL-03-verify-intact: HTTP $QA_LAST_HTTP_CODE"

# Merge with prior results and flush
if [ -f .qa/runs/adaptive-exploratory-results.json ]; then
  PRIOR=$(cat .qa/runs/adaptive-exploratory-results.json)
  RESULTS=$(printf '%s\n' "$PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
fi

echo ""
echo "===== Step 40: Authorization boundary tests complete ====="
echo "  Total results (all steps merged): $(printf '%s\n' "$RESULTS" | jq 'length')"
flush_results
echo "  Done."
echo "=========================================================="
```

## Step 41 -- Malformed JSON and extra fields tests (EXPL-03 continued)

Tests how the server handles all four malformed JSON categories (D-21): syntactically invalid JSON, wrong-type field values, empty/missing bodies, and extra unexpected fields that should be stripped by Zod. Re-initializes helpers for shell session independence.

Run:

```bash
# ── Re-initialize for shell session independence ──
mkdir -p .qa/runs/snapshots/

FIXTURES=$(cat .qa/runs/fixtures.json)
if [ -z "$FIXTURES" ]; then
  echo "[halt] fixtures.json not found -- run Phase 2 steps first"
  exit 1
fi

COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[halt] cookie jar not found at $COOKIE_JAR -- re-run Phase 1 sign-in steps"
  exit 1
fi

ENTRY_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.entries[0].id // empty')
FRAG_1_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.fragments[0].id // empty')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')

RESULTS='[]'

append_result() {
  local REQ_ID="$1" STATUS="$2" DETAIL="$3" RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" --arg status "$STATUS" \
    --arg detail "$DETAIL" --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

declare -A CRITICAL_FIELDS
CRITICAL_FIELDS["POST-entries"]="id lookupKey state status"
CRITICAL_FIELDS["GET-entries-id"]="id lookupKey content state"
CRITICAL_FIELDS["POST-fragments"]="id lookupKey slug tags state"
CRITICAL_FIELDS["GET-fragments-id"]="id lookupKey content slug tags state"
CRITICAL_FIELDS["POST-vaults"]="id name slug type"
CRITICAL_FIELDS["GET-vaults"]="vaults"
CRITICAL_FIELDS["error"]="error"

QA_LAST_HTTP_CODE=""

qa_curl() {
  local METHOD="$1" URL="$2" REQ_ID="$3" ENDPOINT_KEY="$4"
  shift 4
  local RESP_RAW HTTP_CODE BODY
  RESP_RAW=$(curl -s -w "\n%{http_code}" -X "$METHOD" "$URL" "$@" 2>&1 || echo -e "\nCONNECTION_FAILED")
  HTTP_CODE=$(printf '%s\n' "$RESP_RAW" | tail -1)
  BODY=$(printf '%s\n' "$RESP_RAW" | sed '$d')
  QA_LAST_HTTP_CODE="$HTTP_CODE"

  if [ "$HTTP_CODE" = "CONNECTION_FAILED" ]; then
    flush_results; echo "[halt] server not reachable"; exit 1
  fi

  local IS_JSON=false
  if printf '%s\n' "$BODY" | jq . >/dev/null 2>&1; then IS_JSON=true; fi

  if [ "$IS_JSON" = false ]; then
    append_result "$REQ_ID" "observation" "Non-JSON response (HTTP $HTTP_CODE): $BODY" "$BODY"
    append_result "ADPT-02" "pass" "Non-JSON response handled without crash for $REQ_ID (HTTP $HTTP_CODE)" "$BODY"
    echo "$BODY"; return
  fi

  local HAS_ERROR
  HAS_ERROR=$(printf '%s\n' "$BODY" | jq 'has("error")')
  if [ "$HAS_ERROR" = "true" ]; then
    local KEY_COUNT
    KEY_COUNT=$(printf '%s\n' "$BODY" | jq 'keys | length')
    if [ "$KEY_COUNT" -gt 2 ]; then
      append_result "$REQ_ID" "concern" "Error response has $KEY_COUNT keys (expected <=2 for {error,fields?})" "$BODY"
    fi
  fi

  local SNAP_FILE=".qa/runs/snapshots/${ENDPOINT_KEY}.json"
  local ACTUAL_KEYS
  ACTUAL_KEYS=$(printf '%s\n' "$BODY" | jq -c 'keys | sort' 2>/dev/null || echo "[]")
  if [ ! -f "$SNAP_FILE" ] && [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
    echo "$ACTUAL_KEYS" > "$SNAP_FILE"
  elif [ -f "$SNAP_FILE" ] && [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
    local EXPECTED_KEYS MISSING EXTRA
    EXPECTED_KEYS=$(cat "$SNAP_FILE")
    if [ "$ACTUAL_KEYS" != "$EXPECTED_KEYS" ]; then
      MISSING=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$exp - $act')
      EXTRA=$(jq -n --argjson exp "$EXPECTED_KEYS" --argjson act "$ACTUAL_KEYS" '$act - $exp')
      [ "$MISSING" != "[]" ] && append_result "$REQ_ID" "concern" "Missing keys $MISSING from $ENDPOINT_KEY snapshot" "$BODY"
      [ "$EXTRA" != "[]" ] && append_result "$REQ_ID" "observation" "Extra keys $EXTRA in $ENDPOINT_KEY response" "$BODY"
      append_result "ADPT-01" "pass" "Shape difference detected and logged for $REQ_ID/$ENDPOINT_KEY — missing=$MISSING extra=$EXTRA" "$BODY"
      append_result "ADPT-03" "pass" "Missing/extra field findings recorded for $ENDPOINT_KEY" "$BODY"
    fi
  fi

  local CRIT="${CRITICAL_FIELDS[$ENDPOINT_KEY]:-}"
  if [ -n "$CRIT" ]; then
    for field in $CRIT; do
      local PRESENT
      PRESENT=$(printf '%s\n' "$BODY" | jq --arg f "$field" 'has($f)')
      if [ "$PRESENT" != "true" ]; then
        append_result "$REQ_ID" "concern" "Critical field '$field' missing from $ENDPOINT_KEY response" "$BODY"
      fi
    done
  fi

  echo "$BODY"
}

# ══════════════════════════════════════════════════════════════════════
# Section A: Syntactically invalid JSON (D-21)
# ══════════════════════════════════════════════════════════════════════

# Test 1: Broken JSON
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-malformed-broken-json" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  --data-raw '{broken json')
if [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-malformed-broken-json" "pass" "Broken JSON rejected with 400" "$RESP"
elif [ "$QA_LAST_HTTP_CODE" = "422" ]; then
  append_result "EXPL-03-malformed-broken-json" "pass" "Broken JSON rejected with 422 (acceptable)" "$RESP"
else
  append_result "EXPL-03-malformed-broken-json" "concern" "Broken JSON returned HTTP $QA_LAST_HTTP_CODE (expected 400 or 422)" "$RESP"
fi
echo "[test] EXPL-03-malformed-broken-json: HTTP $QA_LAST_HTTP_CODE"

# Test 2: Truncated JSON
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-malformed-truncated" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  --data-raw '{"content": "hello')
if [ "$QA_LAST_HTTP_CODE" = "400" ] || [ "$QA_LAST_HTTP_CODE" = "422" ]; then
  append_result "EXPL-03-malformed-truncated" "pass" "Truncated JSON rejected with HTTP $QA_LAST_HTTP_CODE" "$RESP"
else
  append_result "EXPL-03-malformed-truncated" "concern" "Truncated JSON returned HTTP $QA_LAST_HTTP_CODE (expected 400 or 422)" "$RESP"
fi
echo "[test] EXPL-03-malformed-truncated: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Section B: Wrong types (D-21)
# ══════════════════════════════════════════════════════════════════════

# Test 3: content as number instead of string
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-malformed-content-number" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n '{content: 123}')")
if [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-malformed-content-number" "pass" "Number as content rejected with 400 validation error" "$RESP"
else
  append_result "EXPL-03-malformed-content-number" "concern" "Number as content returned HTTP $QA_LAST_HTTP_CODE (expected 400)" "$RESP"
fi
echo "[test] EXPL-03-malformed-content-number: HTTP $QA_LAST_HTTP_CODE"

# Test 4: tags as string instead of array
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-03-malformed-tags-string" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg t "test" --arg e "$ENTRY_1_ID" '{title: $t, entryId: $e, tags: "not-an-array"}')")
if [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-malformed-tags-string" "pass" "String as tags rejected with 400 validation error" "$RESP"
else
  append_result "EXPL-03-malformed-tags-string" "concern" "String as tags returned HTTP $QA_LAST_HTTP_CODE (expected 400)" "$RESP"
fi
echo "[test] EXPL-03-malformed-tags-string: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Section C: Empty body (D-21)
# ══════════════════════════════════════════════════════════════════════

# Test 5: POST with no body
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-malformed-no-body" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR")
if [ "$QA_LAST_HTTP_CODE" = "400" ] || [ "$QA_LAST_HTTP_CODE" = "422" ]; then
  append_result "EXPL-03-malformed-no-body" "pass" "POST with no body rejected with HTTP $QA_LAST_HTTP_CODE" "$RESP"
else
  append_result "EXPL-03-malformed-no-body" "concern" "POST with no body returned HTTP $QA_LAST_HTTP_CODE (expected 400 or 422)" "$RESP"
fi
echo "[test] EXPL-03-malformed-no-body: HTTP $QA_LAST_HTTP_CODE"

# Test 6: POST with empty object {}
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-malformed-empty-object" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n '{}')")
if [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-malformed-empty-object" "pass" "Empty object rejected with 400 (content is required)" "$RESP"
else
  append_result "EXPL-03-malformed-empty-object" "concern" "Empty object returned HTTP $QA_LAST_HTTP_CODE (expected 400)" "$RESP"
fi
echo "[test] EXPL-03-malformed-empty-object: HTTP $QA_LAST_HTTP_CODE"

# ══════════════════════════════════════════════════════════════════════
# Section D: Extra unexpected fields (D-21)
# Verify extra fields are stripped by Zod, not echoed back or stored
# ══════════════════════════════════════════════════════════════════════

# Test 7: Entry with extra admin/role fields
RESP=$(qa_curl POST "http://localhost:3000/entries" "EXPL-03-malformed-extra-fields" "POST-entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg c "Extra field test" '{content: $c, admin: true, role: "superuser"}')")
if [ "$QA_LAST_HTTP_CODE" = "201" ] || [ "$QA_LAST_HTTP_CODE" = "202" ]; then
  HAS_ADMIN=$(printf '%s\n' "$RESP" | jq 'has("admin")')
  HAS_ROLE=$(printf '%s\n' "$RESP" | jq 'has("role")')
  if [ "$HAS_ADMIN" = "false" ] && [ "$HAS_ROLE" = "false" ]; then
    append_result "EXPL-03-malformed-extra-fields" "pass" "Entry created (HTTP $QA_LAST_HTTP_CODE); extra fields admin/role stripped from response (Zod passthrough off)" "$RESP"
  else
    append_result "EXPL-03-malformed-extra-fields" "concern" "Extra fields leaked in response: admin=$HAS_ADMIN role=$HAS_ROLE (HTTP $QA_LAST_HTTP_CODE)" "$RESP"
  fi
elif [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-malformed-extra-fields" "pass" "Entry with extra fields rejected with 400 (strict validation)" "$RESP"
else
  append_result "EXPL-03-malformed-extra-fields" "concern" "Unexpected HTTP $QA_LAST_HTTP_CODE for extra-fields entry" "$RESP"
fi
echo "[test] EXPL-03-malformed-extra-fields: HTTP $QA_LAST_HTTP_CODE"

# Test 8: Fragment with extra isAdmin/deleteAll fields
RESP=$(qa_curl POST "http://localhost:3000/fragments" "EXPL-03-malformed-extra-fragment" "POST-fragments" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -d "$(jq -n --arg e "$ENTRY_1_ID" '{title: "extra fields fragment", entryId: $e, isAdmin: true, deleteAll: true}')")
if [ "$QA_LAST_HTTP_CODE" = "201" ] || [ "$QA_LAST_HTTP_CODE" = "202" ]; then
  HAS_IS_ADMIN=$(printf '%s\n' "$RESP" | jq 'has("isAdmin")')
  HAS_DELETE_ALL=$(printf '%s\n' "$RESP" | jq 'has("deleteAll")')
  if [ "$HAS_IS_ADMIN" = "false" ] && [ "$HAS_DELETE_ALL" = "false" ]; then
    append_result "EXPL-03-malformed-extra-fragment" "pass" "Fragment created (HTTP $QA_LAST_HTTP_CODE); extra fields isAdmin/deleteAll stripped from response" "$RESP"
  else
    append_result "EXPL-03-malformed-extra-fragment" "concern" "Extra fields leaked in fragment response: isAdmin=$HAS_IS_ADMIN deleteAll=$HAS_DELETE_ALL" "$RESP"
  fi
elif [ "$QA_LAST_HTTP_CODE" = "400" ]; then
  append_result "EXPL-03-malformed-extra-fragment" "pass" "Fragment with extra fields rejected with 400 (strict validation)" "$RESP"
else
  append_result "EXPL-03-malformed-extra-fragment" "concern" "Unexpected HTTP $QA_LAST_HTTP_CODE for extra-fields fragment" "$RESP"
fi
echo "[test] EXPL-03-malformed-extra-fragment: HTTP $QA_LAST_HTTP_CODE"

# Merge with prior results and flush
if [ -f .qa/runs/adaptive-exploratory-results.json ]; then
  PRIOR=$(cat .qa/runs/adaptive-exploratory-results.json)
  RESULTS=$(printf '%s\n' "$PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
fi

echo ""
echo "===== Step 41: Malformed JSON tests complete ====="
echo "  Total results (all steps merged): $(printf '%s\n' "$RESULTS" | jq 'length')"
flush_results
echo "  Done."
echo "=================================================="
```

## Step 42 -- Thread wiki regeneration validation (REGEN-01, REGEN-02)

Tests the thread wiki regeneration pipeline end-to-end. REGEN-01 triggers manual regen on a fixture thread whose linked fragments were created by the pipeline in Step 13, then validates that the generated wiki contains substantive content. REGEN-02 submits a new entry with distinctive keywords, waits for the pipeline to process and link fragments, triggers a second regen, and validates the wiki grew or incorporated the new material. Re-initializes helpers for shell session independence.

Run:

```bash
# ── Re-initialize for shell session independence ──
FIXTURES=$(cat .qa/runs/fixtures.json)
if [ -z "$FIXTURES" ]; then
  echo "[halt] fixtures.json not found -- run Phase 2 steps first"
  exit 1
fi

COOKIE_JAR=$(printf '%s\n' "$FIXTURES" | jq -r '.cookieJarPath')
if [ ! -f "$COOKIE_JAR" ]; then
  echo "[halt] cookie jar not found at $COOKIE_JAR -- re-run Phase 1 sign-in steps"
  exit 1
fi

THREAD_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.threads[] | select(.name=="Engineering Log") | .id')
VAULT_WORK_ID=$(printf '%s\n' "$FIXTURES" | jq -r '.vaults[] | select(.name=="Work") | .id')

if [ -z "$THREAD_WORK_ID" ]; then
  echo "[halt] Engineering Log thread not found in fixtures"
  exit 1
fi

RESULTS='[]'

append_result() {
  local REQ_ID="$1" STATUS="$2" DETAIL="$3" RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" --arg status "$STATUS" \
    --arg detail "$DETAIL" --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

echo "[ok] Step 42 initialized — thread=$THREAD_WORK_ID vault=$VAULT_WORK_ID"

# ══════════════════════════════════════════════════════════════════════
# REGEN-01: Trigger thread wiki regen, validate wiki content generated
# ══════════════════════════════════════════════════════════════════════

# Trigger regen
REGEN1_RAW=$(curl -sf -X POST "http://localhost:3000/threads/${THREAD_WORK_ID}/regenerate" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}")
REGEN1_CODE=$(printf '%s\n' "$REGEN1_RAW" | tail -1)
REGEN1_BODY=$(printf '%s\n' "$REGEN1_RAW" | sed '$d')
REGEN1_STATUS=$(printf '%s\n' "$REGEN1_BODY" | jq -r '.status // empty')

echo "[test] REGEN-01 trigger: HTTP $REGEN1_CODE status=$REGEN1_STATUS"

if [ "$REGEN1_CODE" != "202" ]; then
  append_result "REGEN-01" "failure" "POST /threads/:id/regenerate returned HTTP $REGEN1_CODE (expected 202)" "$REGEN1_BODY"
  echo "[fail] REGEN-01 -- regen trigger failed"
else
  # Poll thread state until RESOLVED (regen complete) — max 90s
  REGEN1_ELAPSED=0
  REGEN1_MAX=90
  while [ $REGEN1_ELAPSED -lt $REGEN1_MAX ]; do
    THREAD_STATE=$(curl -sf "http://localhost:3000/threads/${THREAD_WORK_ID}" \
      -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" | jq -r '.state // "UNKNOWN"')
    if [ "$THREAD_STATE" = "RESOLVED" ]; then
      echo "[poll] thread -> RESOLVED after ${REGEN1_ELAPSED}s"
      break
    fi
    echo "[poll] thread state=$THREAD_STATE (${REGEN1_ELAPSED}s)..."
    sleep 3
    REGEN1_ELAPSED=$((REGEN1_ELAPSED + 3))
  done

  # Fetch thread with wiki content
  THREAD_RESP=$(curl -sf "http://localhost:3000/threads/${THREAD_WORK_ID}" \
    -b "$COOKIE_JAR" -H "Origin: http://localhost:3000")
  WIKI_CONTENT=$(printf '%s\n' "$THREAD_RESP" | jq -r '.wikiContent // ""')
  WIKI_LEN=${#WIKI_CONTENT}
  LAST_REBUILT=$(printf '%s\n' "$THREAD_RESP" | jq -r '.lastRebuiltAt // "null"')

  if [ "$WIKI_LEN" -gt 50 ]; then
    append_result "REGEN-01" "pass" \
      "Thread regen completed — wiki has $WIKI_LEN chars, lastRebuiltAt=$LAST_REBUILT, state=$THREAD_STATE" \
      "$THREAD_RESP"
    echo "[pass] REGEN-01 -- wiki generated: $WIKI_LEN chars"
  elif [ "$WIKI_LEN" -gt 0 ]; then
    append_result "REGEN-01" "observation" \
      "Thread regen completed but wiki is short ($WIKI_LEN chars) — may have few linked fragments" \
      "$THREAD_RESP"
    echo "[observation] REGEN-01 -- wiki short: $WIKI_LEN chars"
  elif [ "$THREAD_STATE" != "RESOLVED" ]; then
    append_result "REGEN-01" "concern" \
      "Thread did not reach RESOLVED after ${REGEN1_MAX}s (state=$THREAD_STATE) — regen may have failed" \
      "$THREAD_RESP"
    echo "[concern] REGEN-01 -- regen timed out, state=$THREAD_STATE"
  else
    # Thread is RESOLVED but wiki is empty — check if it has linked fragments
    REL_RESP=$(curl -sf "http://localhost:3000/relationships/thread/${THREAD_WORK_ID}" \
      -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" 2>/dev/null)
    # Count fragment relationships (may be under different keys depending on API shape)
    LINKED_FRAGS=$(printf '%s\n' "$REL_RESP" | jq '[.relationships // {} | to_entries[] | .value | length] | add // 0' 2>/dev/null || echo "0")
    if [ "$LINKED_FRAGS" = "0" ] 2>/dev/null; then
      append_result "REGEN-01" "observation" \
        "Thread has 0 linked fragments — wiki empty as expected (thread classifier did not match any pipeline fragments to this thread)" \
        "$THREAD_RESP"
      echo "[observation] REGEN-01 -- no linked fragments, wiki empty"
    else
      append_result "REGEN-01" "concern" \
        "Thread has $LINKED_FRAGS linked fragments but wiki is empty after regen — regen processor may have failed silently" \
        "$THREAD_RESP"
      echo "[concern] REGEN-01 -- $LINKED_FRAGS fragments linked but wiki empty"
    fi
  fi
fi

# Save baseline wiki length for REGEN-02 comparison
WIKI_LEN_BASELINE=${WIKI_LEN:-0}

# ══════════════════════════════════════════════════════════════════════
# REGEN-02: Append new entry, re-regen, validate wiki incorporates it
#
# Submit a new entry with distinctive engineering keywords to the Work
# vault. The pipeline will fragment it and the thread classifier will
# attempt to link fragments to Engineering Log. After pipeline completes,
# trigger a second regen and check if the wiki grew or contains new
# keywords. Non-deterministic thread classification is handled: if the
# classifier did not link to this thread, result is observation not failure.
# ══════════════════════════════════════════════════════════════════════

REGEN2_MARKER="regen-validation-$(date +%s)"
REGEN2_CONTENT="$REGEN2_MARKER: The engineering team decided to adopt WebSocket connections for real-time dashboard updates. The Go gateway needs a new ws:// handler and the server requires a Redis pub/sub layer for broadcasting state changes to connected clients."

# Submit entry
REGEN2_ENTRY_RAW=$(curl -sf -X POST "http://localhost:3000/entries" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -b "$COOKIE_JAR" \
  -w "\n%{http_code}" \
  -d "$(jq -n --arg c "$REGEN2_CONTENT" --arg v "$VAULT_WORK_ID" '{content: $c, vaultId: $v}')")
REGEN2_ENTRY_CODE=$(printf '%s\n' "$REGEN2_ENTRY_RAW" | tail -1)
REGEN2_ENTRY_BODY=$(printf '%s\n' "$REGEN2_ENTRY_RAW" | sed '$d')
REGEN2_ENTRY_ID=$(printf '%s\n' "$REGEN2_ENTRY_BODY" | jq -r '.id // empty')

echo "[test] REGEN-02 entry submitted: HTTP $REGEN2_ENTRY_CODE id=$REGEN2_ENTRY_ID"

if [ -z "$REGEN2_ENTRY_ID" ]; then
  append_result "REGEN-02" "failure" "Could not create entry for regen test (HTTP $REGEN2_ENTRY_CODE)" "$REGEN2_ENTRY_BODY"
else
  # Poll entry to RESOLVED (pipeline must finish before regen is meaningful)
  REGEN2_ENTRY_ELAPSED=0
  REGEN2_ENTRY_MAX=120
  REGEN2_ENTRY_STATE="UNKNOWN"
  while [ $REGEN2_ENTRY_ELAPSED -lt $REGEN2_ENTRY_MAX ]; do
    REGEN2_ENTRY_STATE=$(curl -sf "http://localhost:3000/entries/${REGEN2_ENTRY_ID}" \
      -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" | jq -r '.state // "UNKNOWN"')
    if [ "$REGEN2_ENTRY_STATE" = "RESOLVED" ]; then
      echo "[poll] regen-02 entry -> RESOLVED after ${REGEN2_ENTRY_ELAPSED}s"
      break
    fi
    echo "[poll] regen-02 entry state=$REGEN2_ENTRY_STATE (${REGEN2_ENTRY_ELAPSED}s)..."
    sleep 5
    REGEN2_ENTRY_ELAPSED=$((REGEN2_ENTRY_ELAPSED + 5))
  done

  if [ "$REGEN2_ENTRY_STATE" != "RESOLVED" ]; then
    append_result "REGEN-02" "concern" \
      "Entry did not reach RESOLVED after ${REGEN2_ENTRY_MAX}s (state=$REGEN2_ENTRY_STATE) — cannot test wiki update" \
      "$REGEN2_ENTRY_BODY"
    echo "[concern] REGEN-02 -- entry stuck at $REGEN2_ENTRY_STATE"
  else
    # Brief pause for linking stage to complete (fragments → threads)
    sleep 3

    # Trigger second regen
    curl -sf -X POST "http://localhost:3000/threads/${THREAD_WORK_ID}/regenerate" \
      -H "Origin: http://localhost:3000" \
      -b "$COOKIE_JAR" > /dev/null

    # Poll thread to RESOLVED
    REGEN2_THREAD_ELAPSED=0
    REGEN2_THREAD_MAX=90
    REGEN2_THREAD_STATE="UNKNOWN"
    while [ $REGEN2_THREAD_ELAPSED -lt $REGEN2_THREAD_MAX ]; do
      REGEN2_THREAD_STATE=$(curl -sf "http://localhost:3000/threads/${THREAD_WORK_ID}" \
        -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" | jq -r '.state // "UNKNOWN"')
      if [ "$REGEN2_THREAD_STATE" = "RESOLVED" ]; then
        echo "[poll] regen-02 thread -> RESOLVED after ${REGEN2_THREAD_ELAPSED}s"
        break
      fi
      sleep 3
      REGEN2_THREAD_ELAPSED=$((REGEN2_THREAD_ELAPSED + 3))
    done

    # Fetch updated wiki
    THREAD_RESP2=$(curl -sf "http://localhost:3000/threads/${THREAD_WORK_ID}" \
      -b "$COOKIE_JAR" -H "Origin: http://localhost:3000")
    WIKI_CONTENT2=$(printf '%s\n' "$THREAD_RESP2" | jq -r '.wikiContent // ""')
    WIKI_LEN2=${#WIKI_CONTENT2}

    # Evaluate: did the wiki grow or incorporate new content?
    CONTAINS_NEW=false
    if printf '%s\n' "$WIKI_CONTENT2" | grep -qiE 'websocket|real-time|pub.sub|broadcasting'; then
      CONTAINS_NEW=true
    fi

    if [ "$CONTAINS_NEW" = "true" ]; then
      append_result "REGEN-02" "pass" \
        "Wiki contains new entry keywords after second regen — grew from $WIKI_LEN_BASELINE to $WIKI_LEN2 chars" \
        "$THREAD_RESP2"
      echo "[pass] REGEN-02 -- wiki includes new content ($WIKI_LEN_BASELINE → $WIKI_LEN2 chars)"
    elif [ "$WIKI_LEN2" -gt "$WIKI_LEN_BASELINE" ] 2>/dev/null && [ "$WIKI_LEN_BASELINE" -gt 0 ] 2>/dev/null; then
      append_result "REGEN-02" "pass" \
        "Wiki grew from $WIKI_LEN_BASELINE to $WIKI_LEN2 chars (keywords not found verbatim but content expanded)" \
        "$THREAD_RESP2"
      echo "[pass] REGEN-02 -- wiki grew ($WIKI_LEN_BASELINE → $WIKI_LEN2 chars)"
    elif [ "$WIKI_LEN2" -gt 0 ] 2>/dev/null; then
      append_result "REGEN-02" "observation" \
        "Wiki is $WIKI_LEN2 chars but did not grow from baseline $WIKI_LEN_BASELINE — new entry fragments may not have been classified to this thread" \
        "$THREAD_RESP2"
      echo "[observation] REGEN-02 -- wiki unchanged ($WIKI_LEN2 chars), classifier may not have linked"
    else
      append_result "REGEN-02" "concern" \
        "Wiki is empty after second regen ($WIKI_LEN2 chars, baseline was $WIKI_LEN_BASELINE)" \
        "$THREAD_RESP2"
      echo "[concern] REGEN-02 -- wiki empty after second regen"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════
# Merge with prior results and flush
# ══════════════════════════════════════════════════════════════════════
if [ -f .qa/runs/adaptive-exploratory-results.json ]; then
  PRIOR=$(cat .qa/runs/adaptive-exploratory-results.json)
  RESULTS=$(printf '%s\n' "$PRIOR" | jq --argjson cur "$RESULTS" '. + $cur')
fi

echo ""
echo "===== Step 42: Thread wiki regeneration validation complete ====="
echo "  Total results (all steps merged): $(printf '%s\n' "$RESULTS" | jq 'length')"
flush_results
echo "  Done."
echo "================================================================="
```

## Step 43 -- Error quality assessment and final results write (EXPL-04)

Aggregates all error responses collected across all Phase 5 steps from `adaptive-exploratory-results.json`. Assesses each error response for helpfulness (meaningful message), consistency (matches canonical `{error, fields?}` shape), and safety (no stack traces, file paths, or SQL). Writes final results file with `errorQualitySummary` section. This is the last step of Phase 5.

Run:

```bash
# ── Re-initialize helpers for shell session independence ──
RESULTS='[]'

append_result() {
  local REQ_ID="$1" STATUS="$2" DETAIL="$3" RESPONSE="$4"
  local ENTRY
  ENTRY=$(jq -n \
    --arg reqId "$REQ_ID" --arg status "$STATUS" \
    --arg detail "$DETAIL" --arg response "$RESPONSE" \
    '{reqId: $reqId, status: $status, detail: $detail, response: $response}')
  RESULTS=$(printf '%s\n' "$RESULTS" | jq ". + [$ENTRY]")
}

flush_results() {
  printf '%s\n' "$RESULTS" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
    && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
    || echo "[warn] results flush failed"
}

# ── Step 1: Load all prior results ──
ALL_RESULTS=$(cat .qa/runs/adaptive-exploratory-results.json 2>/dev/null || echo '[]')
echo "[ok] Loaded $(printf '%s\n' "$ALL_RESULTS" | jq 'length') results from adaptive-exploratory-results.json"

# ── Step 2: Error quality assessment (D-22) ──
# Iterate all results with parseable JSON responses that contain an error field.
# Use fromjson? (with ?) for safe parsing — Pitfall 6: non-JSON responses must not crash jq.
ERROR_QUALITY=$(printf '%s\n' "$ALL_RESULTS" | jq '[
  .[] |
  select(.response != null and .response != "") |
  select((.response | fromjson? // null) != null) |
  select((.response | fromjson).error != null) |
  {
    reqId: .reqId,
    endpoint: .reqId,
    httpDetail: .detail,
    errorMessage: (.response | fromjson).error,
    hasFieldsKey: ((.response | fromjson) | has("fields")),
    responseKeyCount: ((.response | fromjson) | keys | length),
    matchesCanonicalShape: (
      ((.response | fromjson) | has("error")) and
      ((.response | fromjson) | keys | length) <= 2
    ),
    containsStackTrace: ((.response | fromjson).error | test("at .*\\(.*\\.ts:"; "i") // false),
    containsFilePath: ((.response | fromjson).error | test("/home/|/usr/|/var/|node_modules"; "i") // false),
    containsSql: ((.response | fromjson).error | test("SELECT|INSERT|UPDATE|DELETE|FROM|WHERE"; "i") // false)
  }
]' 2>/dev/null || echo '[]')

echo "[ok] Error quality analysis complete: $(printf '%s\n' "$ERROR_QUALITY" | jq 'length') error responses analyzed"

# ── Step 3: Compute summary statistics ──
TOTAL_ERRORS=$(printf '%s\n' "$ERROR_QUALITY" | jq 'length')
CONSISTENT_COUNT=$(printf '%s\n' "$ERROR_QUALITY" | jq '[.[] | select(.matchesCanonicalShape == true)] | length')
UNSAFE_COUNT=$(printf '%s\n' "$ERROR_QUALITY" | jq '[.[] | select(.containsStackTrace == true or .containsFilePath == true or .containsSql == true)] | length')
HELPFUL_COUNT=$(printf '%s\n' "$ERROR_QUALITY" | jq '[.[] | select(.errorMessage | length > 5)] | length')

echo "[ok] Stats: total=$TOTAL_ERRORS consistent=$CONSISTENT_COUNT unsafe=$UNSAFE_COUNT helpful=$HELPFUL_COUNT"

# ── Step 4: Build final results object with error quality summary ──
FINAL_OUTPUT=$(printf '%s\n' "$ALL_RESULTS" | jq --argjson eq "$ERROR_QUALITY" \
  --arg total "$TOTAL_ERRORS" --arg consistent "$CONSISTENT_COUNT" \
  --arg unsafe "$UNSAFE_COUNT" --arg helpful "$HELPFUL_COUNT" \
  '{
    results: .,
    errorQualitySummary: {
      totalErrorResponses: ($total | tonumber),
      matchCanonicalShape: ($consistent | tonumber),
      potentiallyUnsafe: ($unsafe | tonumber),
      helpfulMessages: ($helpful | tonumber),
      details: $eq
    }
  }')

# ── Step 5: Write final results file via .tmp intermediate ──
printf '%s\n' "$FINAL_OUTPUT" | jq '.' > .qa/runs/adaptive-exploratory-results.json.tmp \
  && mv .qa/runs/adaptive-exploratory-results.json.tmp .qa/runs/adaptive-exploratory-results.json \
  || { echo "[error] Failed to write final results file"; exit 1; }

echo "[ok] Final results written to .qa/runs/adaptive-exploratory-results.json"

# ── Step 6: Print final summary table ──
TOTAL=$(printf '%s\n' "$ALL_RESULTS" | jq 'length')
PASS=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status == "pass")] | length')
FAIL=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status == "failure")] | length')
CONCERN=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status == "concern")] | length')
OBS=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status == "observation")] | length')

echo ""
echo "=== Adaptive & Exploratory Testing Results ==="
echo "Total checks: ${TOTAL}"
echo "  pass:        ${PASS}"
echo "  failure:     ${FAIL}"
echo "  concern:     ${CONCERN}"
echo "  observation: ${OBS}"
echo ""
echo "Error Quality Summary:"
echo "  Total error responses analyzed: ${TOTAL_ERRORS}"
echo "  Match canonical shape { error, fields? }: ${CONSISTENT_COUNT}"
echo "  Potentially unsafe (stack traces/paths/SQL): ${UNSAFE_COUNT}"
echo "  Helpful messages (>5 chars): ${HELPFUL_COUNT}"
echo ""
echo "Results written to: .qa/runs/adaptive-exploratory-results.json"
echo "Snapshots stored in: .qa/runs/snapshots/"
echo "=== Phase 5 complete ==="
```

## Step 44 -- Generate narrative report

Aggregate all test results from Phases 3-5, scan server and gateway logs for anomalies, compute a health verdict, and write a comprehensive markdown report to `.qa/report-{timestamp}.md`. Print a brief summary to stdout.

Run:

```bash
# ── Section A: Shell-session-independence initialization ──
CAPTURE_RESULTS=".qa/runs/capture-storage-results.json"
RETRIEVAL_RESULTS=".qa/runs/retrieval-results.json"
ADAPTIVE_RESULTS=".qa/runs/adaptive-exploratory-results.json"
FIXTURES_FILE=".qa/runs/fixtures.json"
SERVER_LOG=".qa/runs/server.log"
GATEWAY_LOG=".qa/runs/gateway.log"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
REPORT_FILE=".qa/report-${TIMESTAMP}.md"

# ── Section B: Defensive result loading (D-08) ──
MISSING_PHASES=""

load_results() {
  local file="$1"
  local adaptive="${2:-false}"
  if [ ! -f "$file" ] || [ ! -s "$file" ]; then
    MISSING_PHASES="${MISSING_PHASES:+${MISSING_PHASES}, }$(basename "$file")"
    echo "[]"
  elif [ "$adaptive" = "true" ]; then
    jq '.results // .' "$file" 2>/dev/null || echo "[]"
  else
    jq '.' "$file" 2>/dev/null || echo "[]"
  fi
}

CAPTURE_DATA=$(load_results "$CAPTURE_RESULTS")
RETRIEVAL_DATA=$(load_results "$RETRIEVAL_RESULTS")
ADAPTIVE_DATA=$(load_results "$ADAPTIVE_RESULTS" true)

ALL_RESULTS=$(jq -s '.[0] + .[1] + .[2]' \
  <(echo "$CAPTURE_DATA") \
  <(echo "$RETRIEVAL_DATA") \
  <(echo "$ADAPTIVE_DATA"))

TOTAL=$(printf '%s\n' "$ALL_RESULTS" | jq 'length')
TOTAL_PASSES=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status=="pass")] | length')
TOTAL_FAILURES=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status=="failure")] | length')
TOTAL_CONCERNS=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status=="concern")] | length')
TOTAL_OBSERVATIONS=$(printf '%s\n' "$ALL_RESULTS" | jq '[.[] | select(.status=="observation")] | length')

# D-08: each missing result file counts as a failure
if [ -n "$MISSING_PHASES" ]; then
  MISSING_COUNT=$(printf '%s\n' "$MISSING_PHASES" | tr ',' '\n' | wc -l)
  TOTAL_FAILURES=$((TOTAL_FAILURES + MISSING_COUNT))
fi

# ── Section C: Log anomaly counting (D-09, D-10) ──
ERROR_PATTERN_COUNT=0

if [ -s "$SERVER_LOG" ]; then
  SERVER_ERRORS=$(jq -c 'select(.level >= 50)' "$SERVER_LOG" 2>/dev/null \
    | jq -r '.msg // .message // ""' 2>/dev/null \
    | cut -c1-60 | sort -u | grep -c . || true)
  ERROR_PATTERN_COUNT=$((ERROR_PATTERN_COUNT + SERVER_ERRORS))
fi

if [ -s "$GATEWAY_LOG" ]; then
  GW_LEVEL_TYPE=$(jq -r '.level | type' "$GATEWAY_LOG" 2>/dev/null | head -1)
  if [ "$GW_LEVEL_TYPE" = "number" ]; then
    GW_ERRORS=$(jq -c 'select(.level >= 50)' "$GATEWAY_LOG" 2>/dev/null \
      | jq -r '.msg // .message // ""' 2>/dev/null \
      | cut -c1-60 | sort -u | grep -c . || true)
  else
    GW_ERRORS=$(jq -c 'select(.level == "error" or .level == "ERROR" or .level == "fatal" or .level == "FATAL")' "$GATEWAY_LOG" 2>/dev/null \
      | jq -r '.msg // .message // ""' 2>/dev/null \
      | cut -c1-60 | sort -u | grep -c . || true)
  fi
  ERROR_PATTERN_COUNT=$((ERROR_PATTERN_COUNT + GW_ERRORS))
fi

# D-09: each distinct ERROR pattern adds a concern
TOTAL_CONCERNS=$((TOTAL_CONCERNS + ERROR_PATTERN_COUNT))

# ── Section D: Pass rate and verdict calculation ──
if [ "$TOTAL" -gt 0 ]; then
  PASS_RATE=$(printf "%.1f" "$(echo "scale=4; $TOTAL_PASSES * 100 / $TOTAL" | bc)")
else
  PASS_RATE="0.0"
fi

# D-06: three-tier verdict
if [ "$TOTAL_FAILURES" -gt 0 ]; then
  VERDICT="UNHEALTHY"
elif [ "$TOTAL_CONCERNS" -ge 5 ]; then
  VERDICT="NEEDS ATTENTION"
else
  VERDICT="HEALTHY"
fi

# ── Section E: Write YAML frontmatter (D-13) ──
cat > "$REPORT_FILE" <<FRONTMATTER
---
verdict: ${VERDICT}
pass_count: ${TOTAL_PASSES}
fail_count: ${TOTAL_FAILURES}
concern_count: ${TOTAL_CONCERNS}
observation_count: ${TOTAL_OBSERVATIONS}
pass_rate: ${PASS_RATE}
generated_at: $(date -u +%Y-%m-%dT%H:%M:%S)
phases_missing: [${MISSING_PHASES}]
---
FRONTMATTER

# ── Section F: Executive summary (D-02, D-05) ──
cat >> "$REPORT_FILE" <<EXEC_SUMMARY

# QA Report -- ${TIMESTAMP}

## Executive Summary

**Verdict: ${VERDICT}**

${TOTAL_PASSES}/${TOTAL} tests passed (${PASS_RATE}%)
Failures: ${TOTAL_FAILURES} | Concerns: ${TOTAL_CONCERNS} | Observations: ${TOTAL_OBSERVATIONS}
EXEC_SUMMARY

if [ -n "$MISSING_PHASES" ]; then
  echo "" >> "$REPORT_FILE"
  echo "Missing result files: ${MISSING_PHASES}" >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"

# ── Section G: Findings by severity (D-02, D-03, D-04, REPT-01, REPT-04) ──
generate_findings_section() {
  local results="$1"
  local status="$2"
  local heading="$3"
  local count
  count=$(echo "$results" | jq --arg s "$status" '[.[] | select(.status==$s)] | length')
  echo "### ${heading} (${count})"
  echo ""
  if [ "$count" -eq 0 ]; then
    echo "_None._"
  else
    echo "$results" | jq -r --arg s "$status" \
      '.[] | select(.status==$s) | "- **\(.reqId):** \(.detail)"'
  fi
  echo ""
}

{
  echo "## Findings by Severity"
  echo ""
  generate_findings_section "$ALL_RESULTS" "failure" "Failures"
  generate_findings_section "$ALL_RESULTS" "concern" "Concerns"
  generate_findings_section "$ALL_RESULTS" "observation" "Observations"
  generate_findings_section "$ALL_RESULTS" "pass" "Passes"
} >> "$REPORT_FILE"

# ── Section H: Phase detail (REPT-01) ──
generate_phase_detail() {
  local results="$1"
  local phase_name="$2"
  local phase_num="$3"

  local total_p total_f total_c total_o
  total_p=$(echo "$results" | jq '[.[] | select(.status=="pass")] | length')
  total_f=$(echo "$results" | jq '[.[] | select(.status=="failure")] | length')
  total_c=$(echo "$results" | jq '[.[] | select(.status=="concern")] | length')
  total_o=$(echo "$results" | jq '[.[] | select(.status=="observation")] | length')

  echo "### Phase ${phase_num}: ${phase_name}"
  echo ""
  echo "${total_p} passed, ${total_f} failed, ${total_c} concerns, ${total_o} observations"
  echo ""
  echo "$results" | jq -r '.[] | "- [\(.status)] **\(.reqId):** \(.detail)"'
  echo ""
}

{
  echo "## Phase Detail"
  echo ""

  CAPTURE_PHASE=$(load_results "$CAPTURE_RESULTS")
  generate_phase_detail "$CAPTURE_PHASE" "Capture & Storage Validation" "3"

  RETRIEVAL_PHASE=$(load_results "$RETRIEVAL_RESULTS")
  generate_phase_detail "$RETRIEVAL_PHASE" "Retrieval & Profile Validation" "4"

  ADAPTIVE_PHASE=$(load_results "$ADAPTIVE_RESULTS" true)
  generate_phase_detail "$ADAPTIVE_PHASE" "Adaptive & Exploratory Testing" "5"

  # Error Quality Summary subsection (Phase 5 specific)
  if [ -f "$ADAPTIVE_RESULTS" ] && [ -s "$ADAPTIVE_RESULTS" ]; then
    EQ_SUMMARY=$(jq '.errorQualitySummary // empty' "$ADAPTIVE_RESULTS" 2>/dev/null)
    if [ -n "$EQ_SUMMARY" ]; then
      EQ_TOTAL=$(printf '%s\n' "$EQ_SUMMARY" | jq '.totalErrorResponses // 0')
      EQ_CONSISTENT=$(printf '%s\n' "$EQ_SUMMARY" | jq '.matchCanonicalShape // 0')
      EQ_UNSAFE=$(printf '%s\n' "$EQ_SUMMARY" | jq '.potentiallyUnsafe // 0')
      EQ_HELPFUL=$(printf '%s\n' "$EQ_SUMMARY" | jq '.helpfulMessages // 0')
      echo "#### Error Quality Summary"
      echo ""
      echo "Helpful: ${EQ_HELPFUL} | Consistent: ${EQ_CONSISTENT} | Unsafe: ${EQ_UNSAFE} (out of ${EQ_TOTAL} error responses)"
      echo ""
      EQ_DETAILS=$(printf '%s\n' "$EQ_SUMMARY" | jq -r '.details[]? | "- \(.endpoint // "unknown"): \(.errorMessage // "no message")"' 2>/dev/null || true)
      if [ -n "$EQ_DETAILS" ]; then
        echo "$EQ_DETAILS"
        echo ""
      fi
    fi
  fi
} >> "$REPORT_FILE"

# ── Section I: Log anomalies table (REPT-03, D-10, D-11, D-12) ──
generate_log_table() {
  local logfile="$1"
  local source_label="$2"

  echo "### ${source_label}"
  echo ""

  if [ ! -s "$logfile" ]; then
    echo "_No log data available._"
    echo ""
    return
  fi

  # Detect level format: numeric (Pino) vs string (Go)
  local level_type
  level_type=$(jq -r '.level | type' "$logfile" 2>/dev/null | head -1)

  local error_filter warn_filter
  if [ "$level_type" = "number" ]; then
    error_filter='select(.level >= 50)'
    warn_filter='select(.level == 40)'
  else
    error_filter='select(.level == "error" or .level == "ERROR" or .level == "fatal" or .level == "FATAL")'
    warn_filter='select(.level == "warn" or .level == "WARN" or .level == "warning" or .level == "WARNING")'
  fi

  # Slow operations filter (works for both formats)
  local slow_filter='select((.duration // .latency // 0) > 1000)'

  local has_rows=false

  echo "| Level | Count | First Seen | Last Seen | Example Message |"
  echo "|-------|-------|------------|-----------|-----------------|"

  # Process ERROR-level entries
  jq -c "$error_filter" "$logfile" 2>/dev/null | jq -r '.msg // .message // "unknown"' 2>/dev/null \
    | cut -c1-60 | sort | uniq -c | sort -rn | while read -r count msg; do
      if [ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null; then
        first=$(jq -c "$error_filter" "$logfile" 2>/dev/null \
          | jq -r --arg m "$msg" 'select((.msg // .message // "") | startswith($m)) | .time' 2>/dev/null \
          | sort -n | head -1)
        last=$(jq -c "$error_filter" "$logfile" 2>/dev/null \
          | jq -r --arg m "$msg" 'select((.msg // .message // "") | startswith($m)) | .time' 2>/dev/null \
          | sort -n | tail -1)
        first_ts=$(date -d @"$(echo "${first:-0} / 1000" | bc)" "+%H:%M:%S" 2>/dev/null || echo "?")
        last_ts=$(date -d @"$(echo "${last:-0} / 1000" | bc)" "+%H:%M:%S" 2>/dev/null || echo "?")
        echo "| ERROR | ${count} | ${first_ts} | ${last_ts} | \`${msg:0:60}\` |"
        has_rows=true
      fi
    done || true

  # Process WARN-level entries
  jq -c "$warn_filter" "$logfile" 2>/dev/null | jq -r '.msg // .message // "unknown"' 2>/dev/null \
    | cut -c1-60 | sort | uniq -c | sort -rn | head -10 | while read -r count msg; do
      if [ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null; then
        first=$(jq -c "$warn_filter" "$logfile" 2>/dev/null \
          | jq -r --arg m "$msg" 'select((.msg // .message // "") | startswith($m)) | .time' 2>/dev/null \
          | sort -n | head -1)
        last=$(jq -c "$warn_filter" "$logfile" 2>/dev/null \
          | jq -r --arg m "$msg" 'select((.msg // .message // "") | startswith($m)) | .time' 2>/dev/null \
          | sort -n | tail -1)
        first_ts=$(date -d @"$(echo "${first:-0} / 1000" | bc)" "+%H:%M:%S" 2>/dev/null || echo "?")
        last_ts=$(date -d @"$(echo "${last:-0} / 1000" | bc)" "+%H:%M:%S" 2>/dev/null || echo "?")
        echo "| WARN | ${count} | ${first_ts} | ${last_ts} | \`${msg:0:60}\` |"
        has_rows=true
      fi
    done || true

  # Process slow operations
  jq -c "$slow_filter" "$logfile" 2>/dev/null | jq -r '"\(.msg // .message // "unknown") (\(.duration // .latency)ms)"' 2>/dev/null \
    | cut -c1-60 | sort | uniq -c | sort -rn | head -10 | while read -r count msg; do
      if [ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null; then
        echo "| SLOW | ${count} | - | - | \`${msg:0:60}\` |"
        has_rows=true
      fi
    done || true

  echo ""
}

{
  echo "## Log Anomalies"
  echo ""
  generate_log_table "$SERVER_LOG" "server.log"
  generate_log_table "$GATEWAY_LOG" "gateway.log"
} >> "$REPORT_FILE"

# ── Section J: Fixture inventory appendix (REPT-02, D-04) ──
{
  echo "## Appendix: Fixture Inventory"
  echo ""

  if [ ! -f "$FIXTURES_FILE" ]; then
    echo "_Fixture manifest not found._"
  else
    USER_EMAIL=$(jq -r '.user.email // "unknown"' "$FIXTURES_FILE" 2>/dev/null)
    echo "**Test user:** \`${USER_EMAIL}\`"
    echo ""
    echo "**Vaults:**"
    jq -r '.vaults | to_entries[] | "- \(.key): \(.value.name) — `\(.value.id)`"' "$FIXTURES_FILE" 2>/dev/null || echo "_None_"
    echo ""
    echo "**Threads:**"
    jq -r '.threads | to_entries[] | "- \(.key): \(.value.title) — `\(.value.id)`"' "$FIXTURES_FILE" 2>/dev/null || echo "_None_"
    echo ""
    ENTRY_COUNT=$(jq '.entries | length' "$FIXTURES_FILE" 2>/dev/null || echo "0")
    echo "**Entries (${ENTRY_COUNT}):**"
    jq -r '.entries[] | "- \(.title // .id) — `\(.id)`"' "$FIXTURES_FILE" 2>/dev/null || echo "_None_"
    echo ""
    FRAG_COUNT=$(jq '.fragments | length' "$FIXTURES_FILE" 2>/dev/null || echo "0")
    echo "**Fragments (${FRAG_COUNT}):**"
    jq -r '.fragments[] | "- \(.slug // .id) — `\(.id)`"' "$FIXTURES_FILE" 2>/dev/null || echo "_None_"
  fi
  echo ""
} >> "$REPORT_FILE"

# ── Section K: Investigation recommendations (REPT-07) ──
# For each failure/concern, extract the error type, origin stack frame, API path,
# and produce a surgical investigation recommendation (what to look at, not how to fix).
{
  echo "## Investigation Recommendations"
  echo ""

  # Parse server log for distinct error patterns with stack traces
  RECO_IDX=0

  # Build recommendations from failures and concerns
  printf '%s\n' "$ALL_RESULTS" | jq -r '.[] | select(.status == "failure" or .status == "concern") | "\(.reqId)\t\(.status)\t\(.detail)"' | while IFS=$'\t' read -r REQ_ID STATUS DETAIL; do
    RECO_IDX=$((RECO_IDX + 1))
    echo "### ${RECO_IDX}. ${REQ_ID} (${STATUS})"
    echo ""
    echo "**Finding:** ${DETAIL}"
    echo ""

    # Try to find a matching log entry with stack trace for this error
    # Match on keywords from the reqId (e.g., "broken-json" -> search for "Malformed JSON")
    SEARCH_TERM=""
    case "$REQ_ID" in
      *broken-json*|*truncated*|*no-body*) SEARCH_TERM="Malformed JSON" ;;
      *cross*write*) SEARCH_TERM="Entry not found" ;;
      *cross*read*|*cross*delete*) SEARCH_TERM="Not found" ;;
      *dedup*|*CAPT-02*) SEARCH_TERM="duplicate" ;;
    esac

    if [ -n "$SEARCH_TERM" ] && [ -s "$SERVER_LOG" ]; then
      STACK_SAMPLE=$(grep -A 8 "$SEARCH_TERM" "$SERVER_LOG" 2>/dev/null | head -12)
      if [ -n "$STACK_SAMPLE" ]; then
        echo "**Stack trace (from server.log):**"
        echo '```'
        echo "$STACK_SAMPLE"
        echo '```'
        echo ""
      fi
    fi

    # Generate investigation steps
    echo "**To investigate:**"
    case "$REQ_ID" in
      *broken-json*|*truncated*|*no-body*)
        echo "1. Check how \`@hono/zod-validator\` wraps JSON parse errors — is the thrown error an \`HTTPException\` or \`SyntaxError\`?"
        echo "2. Read \`node_modules/@hono/zod-validator/dist/index.js\` and trace the error path for malformed body"
        echo "3. Verify \`app.onError\` in \`index.ts\` catches the correct error type"
        ;;
      *CAPT-02*|*dedup*)
        echo "1. Compare the content hash of the re-submitted body vs the original entry's \`dedupHash\` in the DB"
        echo "2. Check if the \`originalBody\` in fixtures.json matches the exact content from the first submission"
        echo "3. Query: \`SELECT dedup_hash, content FROM entries WHERE lookup_key = '<id>' LIMIT 1\`"
        ;;
      *search*|*RETR-01*)
        echo "1. Check if entries have reached RESOLVED state: \`SELECT state FROM entries WHERE user_id = '<userId>'\`"
        echo "2. Verify the gateway has indexed content: \`curl localhost:9000/search?q=HNSW\`"
        echo "3. Check if the LLM pipeline ran (look for \`runExtraction\` or \`stage\` in server.log)"
        ;;
      *activity*|*USER-03*)
        echo "1. Check if the \`/users/activity\` endpoint queries an audit log table or derives activity from entries/fragments"
        echo "2. Read \`apps/server/src/routes/users.ts\` for the activity handler implementation"
        ;;
      *)
        echo "1. Read the route handler for the failing endpoint"
        echo "2. Check server.log for errors around the test timestamp"
        echo "3. Reproduce with \`curl -v\` and inspect the full response"
        ;;
    esac
    echo ""
  done
} >> "$REPORT_FILE"

# ── Section L: Auto-cleanup (D-16) — keep last 5 reports ──
ls -t .qa/report-*.md 2>/dev/null | tail -n +6 | xargs -r rm --

# ── Section M: Stdout summary (D-17) ──
echo ""
echo "===== QA Report ====="
echo "  Verdict:    ${VERDICT}"
echo "  Pass rate:  ${TOTAL_PASSES}/${TOTAL} (${PASS_RATE}%)"
echo "  Failures:   ${TOTAL_FAILURES}"
echo "  Concerns:   ${TOTAL_CONCERNS}"
echo "  Report:     ${REPORT_FILE}"
echo "===================="
```
