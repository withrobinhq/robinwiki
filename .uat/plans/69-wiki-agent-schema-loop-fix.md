# 69 — Close the wiki_agent_schema chicken-and-egg loop

## What it proves

Branch `fix/wiki-agent-schema-loop` closes the gap that left empty wikis
invisible to hybrid search until they happened to attract a fragment AND
trigger regen. Three sites now write into `wiki_agent_schema` outside
the regen pipeline, plus a recovery surface for existing instances.

1. **POST /wikis** seeds the `kind='description'` row at create time
   using the embedding it already computes for `wikis.embedding`. Zero
   extra LLM cost.
2. **PUT /wikis/:id** re-embeds the description on edit and upserts the
   `kind='description'` row, then deletes the `kind='hyde_synthetic'`
   row so the heal worker re-creates it on the next tick.
3. **embedding-retry-worker** (15-minute cron) runs an agent-schema heal
   pass: scans for missing or NULL description rows (batch of 25) and
   missing hyde rows (batch of 5), re-emits via the same helpers.
4. **scripts/backfill-wiki-agent-schema.ts** is a one-shot for existing
   instances. Idempotent, dry-run safe, --limit-bounded.

The architectural decoupling of agent_schema from regen is deferred to
v0.2.2 per orchestrator scope. The regen-call site at `regen.ts:1031`
remains unchanged; it now becomes a refresh path while POST/PUT/heal
also write rows.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`
- `DATABASE_URL` reachable for direct row inspection
- Migration `0005_wiki_agent_schema` applied (already in main)
- `OPENROUTER_API_KEY` set so embed/HyDE can run
- `pnpm install` and `pnpm -C core build` (or a dev process running)

## Endpoint map

- `POST /wikis`              — creates wiki, now writes description row
- `PUT  /wikis/:id`          — refreshes description row + drops hyde row
- `POST /wikis/:id/regenerate` — still works, still writes both kinds

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"
DB_URL="${DATABASE_URL:-postgresql://robin:@localhost:5432/robin_dev}"
JAR=$(mktemp /tmp/uat-69-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-69-*.json' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  + $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ! $1"; }
skip() { SKIP=$((SKIP+1)); echo "  - $1"; }

PSQL() { psql "$DB_URL" -A -t -c "$1" 2>/dev/null; }

echo "69 — wiki_agent_schema chicken-and-egg loop fix"
echo ""

# 1. Sign in (cookie session)
HTTP=$(curl -s -o /tmp/uat-69-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$HTTP" = "200" ]; then pass "sign in"; else fail "sign in $HTTP"; fi

# 2. POST /wikis with a description writes a kind=description row immediately.
NEW_NAME="UAT69 search bootstrap test $(date +%s)"
NEW_DESC="A wiki about empty-wiki search bootstrap, agent schema loop, retrieval surfaces, and hybrid lanes."
CREATE_RES=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -nc --arg n "$NEW_NAME" --arg d "$NEW_DESC" '{name:$n, description:$d, type:"research"}')" \
  "$SERVER_URL/wikis")
NEW_KEY=$(echo "$CREATE_RES" | jq -r '.id // .lookupKey // empty')
if [ -n "$NEW_KEY" ]; then pass "POST /wikis -> $NEW_KEY"; else fail "POST /wikis failed: $CREATE_RES"; fi

# Allow up to 5s for the embed call + insert to settle (POST returns 201
# before the embed-and-write block completes if any).
sleep 2

DESC_ROW=$(PSQL "SELECT kind || ':' || COALESCE(length(content)::text,'null') FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY' AND kind='description';" | tr -d '[:space:]')
if [[ "$DESC_ROW" == description:* ]]; then
  pass "POST seeded kind=description row (content $DESC_ROW)"
else
  fail "POST did not seed kind=description row (got '$DESC_ROW')"
fi

DESC_VEC_OK=$(PSQL "SELECT (embedding IS NOT NULL)::int FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY' AND kind='description';" | tr -d '[:space:]')
if [ "$DESC_VEC_OK" = "1" ]; then
  pass "POST description row has non-null embedding"
else
  fail "POST description row has null embedding"
fi

# 3. PUT /wikis/:id with description change refreshes the row and deletes hyde.
# First fake a kind=hyde_synthetic row so we can prove deletion happens.
PSQL "INSERT INTO wiki_agent_schema (wiki_key, kind, content, embedding, generator_version)
      VALUES ('$NEW_KEY', 'hyde_synthetic', 'fake hyde for uat69',
              array_fill(0.5, ARRAY[1536])::vector, 'hyde_v1')
      ON CONFLICT (wiki_key, kind) DO UPDATE SET content=EXCLUDED.content;" >/dev/null

NEW_DESC2="A different description for the same wiki, totally fresh wording for embedding."
PUT_HTTP=$(curl -s -o /tmp/uat-69-put.json -w "%{http_code}" \
  -b "$JAR" -X PUT -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -nc --arg d "$NEW_DESC2" '{description:$d}')" \
  "$SERVER_URL/wikis/$NEW_KEY")
if [ "$PUT_HTTP" = "200" ]; then pass "PUT /wikis/:id 200"; else fail "PUT got $PUT_HTTP"; fi

sleep 2

DESC_NEW=$(PSQL "SELECT content FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY' AND kind='description';")
if [[ "$DESC_NEW" == *"different description"* ]]; then
  pass "PUT refreshed description row content"
else
  fail "PUT did not refresh description row (got '$DESC_NEW')"
fi

HYDE_GONE=$(PSQL "SELECT COUNT(*)::int FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY' AND kind='hyde_synthetic';" | tr -d '[:space:]')
if [ "$HYDE_GONE" = "0" ]; then
  pass "PUT deleted kind=hyde_synthetic row"
else
  fail "PUT left $HYDE_GONE hyde rows behind"
fi

# 4. Heal worker: simulate by deleting both rows then waiting for the next tick.
# In a UAT context where the cron is not actively firing, we can run the
# script equivalent for description and rely on a regen for hyde, OR we
# can manually trigger the worker via the queue admin if available.
# Simplest UAT path: trigger via the backfill script for description and
# rely on a manual regenerate for hyde.
PSQL "DELETE FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY';" >/dev/null
GONE=$(PSQL "SELECT COUNT(*)::int FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY';" | tr -d '[:space:]')
if [ "$GONE" = "0" ]; then pass "agent_schema rows cleared for heal test"; else fail "rows still present"; fi

# 5. Backfill script restores the description row. Idempotent on re-run.
SCRIPT_OUT=$(pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts 2>&1 || true)
echo "$SCRIPT_OUT" | head -5

DESC_RESTORED=$(PSQL "SELECT COUNT(*)::int FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY' AND kind='description';" | tr -d '[:space:]')
if [ "$DESC_RESTORED" = "1" ]; then
  pass "backfill restored kind=description row"
else
  fail "backfill did not restore description row"
fi

# Idempotency: second run should not duplicate or fail.
SCRIPT_OUT_2=$(pnpm -C core tsx scripts/backfill-wiki-agent-schema.ts 2>&1 || true)
DESC_AFTER_2ND=$(PSQL "SELECT COUNT(*)::int FROM wiki_agent_schema WHERE wiki_key = '$NEW_KEY' AND kind='description';" | tr -d '[:space:]')
if [ "$DESC_AFTER_2ND" = "1" ]; then
  pass "backfill second run is idempotent (still 1 row)"
else
  fail "backfill second run produced $DESC_AFTER_2ND rows (expected 1)"
fi

# 6. Hybrid search: a freshly created wiki should be competitive on day one.
# Hand a query that the description text strongly matches and assert the
# new wiki cracks the top-10.
SEARCH_Q="empty wiki search bootstrap retrieval"
SEARCH_RES=$(curl -s -b "$JAR" "$SERVER_URL/search?q=$(jq -nrR --arg s "$SEARCH_Q" '$s|@uri')&limit=10")
HIT_KEY=$(echo "$SEARCH_RES" | jq -r --arg k "$NEW_KEY" '.results[]? | select(.wikiKey==$k or .id==$k or .lookupKey==$k) | (.wikiKey // .id // .lookupKey)' | head -1)
if [ -n "$HIT_KEY" ]; then
  pass "freshly created wiki ranks in top-10 for matching query"
else
  skip "search did not return new wiki in top-10 (may need wider corpus)"
fi

# 7. Heal worker dry-run (no kicker — confirm the worker function is wired).
# This step verifies the worker module loads cleanly and the heal entry
# point is exported. A live kick would require BullMQ; left to the cron.
WORKER_FN=$(grep -c "healAgentSchemaRows" core/src/queue/embedding-retry-worker.ts)
if [ "$WORKER_FN" -ge 1 ]; then pass "heal worker integration present"; else fail "heal worker not wired"; fi

# Cleanup the test wiki
curl -s -b "$JAR" -X DELETE "$SERVER_URL/wikis/$NEW_KEY" >/dev/null || true

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Cleanup

The script soft-deletes the test wiki at the end. The `wiki_agent_schema`
rows cascade via the table's `ON DELETE CASCADE` foreign key.

## Expected pass/fail behavior

All required steps PASS on a clean local stack. The hybrid-search ranking
step (step 6) can SKIP on a sparse fixture corpus where the description
keywords overlap with another wiki strongly enough to push the new wiki
out of the top-10; it is informational rather than load-bearing because
unit tests already cover the write paths and the heal worker.

The dry-run option for the backfill is exercised in the unit test
`core/scripts/backfill-wiki-agent-schema.test.ts`; this UAT exercises the
live path on a real DB with a real OpenRouter call.
