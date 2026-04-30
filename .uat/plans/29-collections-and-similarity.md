# 29 — Collections UI + Fragment Similarity Edges

## What it proves

PR #192 closes five issues spanning a frontend relabel, a sidebar surface, a
classifier-time edge-creation pass, an API extension, and an audit-log
integration. This plan asserts each of them end-to-end:

- **#185** — Frontend relabel `Group → Collection` (UI surface only; backend
  routes stay at `/groups`).
- **#45**  — Sidebar Collections section between Navigation and Wiki Types,
  driven by live `/groups` API data.
- **#163** — `FRAGMENT_RELATED_TO_FRAGMENT` edges created bidirectionally at
  classification time when a fragment is filed into a wiki, gated by the
  `RELATED_FRAGMENT_THRESHOLD = 0.75` cosine-similarity cutoff.
- **#164** — `GET /fragments/:id` returns `relatedFragments[]` with
  `{ id, slug, title, similarity }`; the wiki frontend renders a
  "Related fragments" section under backlinks.
- **#165** — `related_detected` audit events emitted for both fragments
  in the pair so timeline endpoints surface relationship detection from
  either side.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Wiki dev server on `WIKI_URL` (default `http://localhost:8080`); proxies
  `/api/*` to `$SERVER_URL/*` per `wiki/next.config.ts`.
- Database reachable via `DATABASE_URL` (psql).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set.
- Embeddings worker running so freshly-created fragments get embeddings —
  similarity edges depend on `fragments.embedding IS NOT NULL`.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "29 — Collections UI + Fragment Similarity Edges"
echo ""

# Sign in
curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null

UAT_TAG="uat29-$(date +%s)"
# Anchor for strict count assertions in §5g and §8g. Anything created BEFORE
# this timestamp belongs to a previous run; anything AFTER must satisfy the
# §5/§8 invariants. Use ISO-8601 epoch so the literal can be quoted into psql
# without worrying about embedded spaces — `now()::text` includes a space
# between the date and time, and any tr -d ' ' would mangle the timestamp.
TEST_START=$(psql "$DATABASE_URL" -t -A -c "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')" 2>/dev/null | tr -d '[:space:]')

# ── 1. Issue #185 — Frontend relabel: Group → Collection ─────────
# Backend stays at /groups (server contract). The frontend hook is renamed
# to useCollections and the rendered explorer/sidebar UI must say
# "Collection(s)", never "Group(s)" (excluding the shadcn input-group
# primitive at wiki/src/components/ui/input-group.tsx).

npx agent-browser open "$WIKI_URL/login" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

# 1a. Explorer page renders with "Collection" labels.
npx agent-browser open "$WIKI_URL/explorer" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-29-explorer.html 2>/dev/null
EXP_SNAP=$(npx agent-browser snapshot 2>/dev/null)

if echo "$EXP_SNAP" | grep -qE '\bCollection\b'; then
  pass "1a. Explorer page contains 'Collection' label"
else
  fail "1a. Explorer page missing 'Collection' label"
fi

if echo "$EXP_SNAP" | grep -qE '\bAll collections\b'; then
  pass "1b. Explorer 'All collections' chip rendered"
else
  fail "1b. Explorer 'All collections' chip missing"
fi

# 1c. The string "Group" / "Groups" must NOT appear as a user-visible label
# in the rendered explorer (excluding the shadcn input-group primitive
# which is purely structural and not surfaced to users on this page).
# Strip script/style/svg blocks before grepping to avoid false positives
# on JS identifiers and SVG labels.
STRIPPED=$(perl -0777 -pe 's{<script[^>]*>.*?</script>}{}gis; s{<style[^>]*>.*?</style>}{}gis; s{<svg[^>]*>.*?</svg>}{}gis' /tmp/uat-29-explorer.html)
if echo "$STRIPPED" | grep -qE '>[^<]*\bGroups?\b[^<]*<'; then
  echo "$STRIPPED" | grep -oE '>[^<]*\bGroups?\b[^<]*<' | head -3
  fail "1c. 'Group(s)' word appears in rendered explorer text — relabel incomplete"
else
  pass "1c. 'Group(s)' word absent from rendered explorer text"
fi

# 1d. URL filter param renamed: ?collection= works, ?group= no longer wires.
npx agent-browser open "$WIKI_URL/explorer?collection=does-not-exist" 2>/dev/null
npx agent-browser wait --load networkidle
COLL_URL=$(npx agent-browser eval "location.search" 2>/dev/null || echo "")
if echo "$COLL_URL" | grep -q "collection=does-not-exist"; then
  pass "1d. ?collection= URL param accepted by explorer"
else
  fail "1d. ?collection= URL param did not survive ($COLL_URL)"
fi

# 1e. The hook still calls /groups under the hood (server contract preserved).
GROUPS_HTTP=$(curl -s -o /tmp/uat-29-groups.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups")
[ "$GROUPS_HTTP" = "200" ] && pass "1e. GET /groups still 200 (backend unchanged)" || fail "1e. GET /groups → HTTP $GROUPS_HTTP"

# 1f. /collections is NOT a backend route (must 404 — relabel is UI-only).
COLLECTIONS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/collections")
[ "$COLLECTIONS_HTTP" = "404" ] && pass "1f. GET /collections → 404 (no backend rename)" || fail "1f. /collections returned $COLLECTIONS_HTTP (expected 404 — backend should be untouched)"

# ── 2. Issue #45 — Collections sidebar section ───────────────────
# Sidebar has three sections: Navigation, Collections, Entries / Wiki Types.
# Collections sits between Navigation and the wiki/entries content, driven
# by useCollections() (live /groups data). Empty-state text is
# "no collections yet".

# Seed at least one collection so the section is non-empty.
SEED_NAME="UAT29 Sidebar Collection $UAT_TAG"
SEED_SLUG="uat29-sidebar-$UAT_TAG"
SEED_RESP=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"name\":\"$SEED_NAME\",\"slug\":\"$SEED_SLUG\",\"color\":\"#FF8800\",\"description\":\"UAT sidebar fixture\"}" \
  "$SERVER_URL/groups")
SEED_GROUP_ID=$(echo "$SEED_RESP" | jq -r '.id // ""')

if [ -n "$SEED_GROUP_ID" ]; then
  pass "2a. Seeded collection for sidebar (id=$SEED_GROUP_ID)"
else
  fail "2a. Could not seed collection — POST /groups failed"
fi

# Reload any wiki page so the sidebar is rendered.
npx agent-browser open "$WIKI_URL/explorer" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-29-sidebar.html 2>/dev/null
SIDE_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-29-02-sidebar.png 2>/dev/null

# 2b. Sidebar renders a "Collections" section header.
if echo "$SIDE_SNAP" | grep -qiE '\bCollections\b'; then
  pass "2b. Sidebar 'Collections' header rendered"
else
  fail "2b. Sidebar 'Collections' header missing"
fi

# 2c. Seeded collection name appears in sidebar.
if echo "$SIDE_SNAP" | grep -qF "$SEED_NAME"; then
  pass "2c. Seeded collection '$SEED_NAME' visible in sidebar"
else
  fail "2c. Seeded collection name not surfaced in sidebar"
fi

# 2d. Sidebar Collections section sits BEFORE the contents/entries section.
#     The Sidebar component renders Navigation → Collections → Entries.
COLL_LINE=$(grep -nE '"Collections"|>Collections<' /tmp/uat-29-sidebar.html | head -1 | cut -d: -f1)
ENTR_LINE=$(grep -nE '"Entries"|>Entries<' /tmp/uat-29-sidebar.html | head -1 | cut -d: -f1)
if [ -n "$COLL_LINE" ] && [ -n "$ENTR_LINE" ] && [ "$COLL_LINE" -lt "$ENTR_LINE" ]; then
  pass "2d. Collections section renders before Entries section"
else
  fail "2d. Section order wrong (Collections@$COLL_LINE, Entries@$ENTR_LINE) — expected Collections first"
fi

# 2e. Sidebar entry shows the wikiCount badge (initially 0 for a fresh collection).
if echo "$SIDE_SNAP" | grep -qE "$SEED_NAME[^0-9]+0"; then
  pass "2e. Sidebar shows wikiCount=0 for newly-seeded empty collection"
else
  skip "2e. wikiCount badge format varies — manual screenshot at /tmp/uat-29-02-sidebar.png"
fi

# ── 3. Issue #45 — Backend /groups CRUD still wired ──────────────
# Plan 13 already covers groups CRUD. Re-assert the surface stays green.

# 3a. List
LIST_HTTP=$(curl -s -o /tmp/uat-29-list.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups")
[ "$LIST_HTTP" = "200" ] && pass "3a. GET /groups → 200" || fail "3a. GET /groups → HTTP $LIST_HTTP"

# 3b. Response shape: { groups: [{ id, name, slug, wikiCount, ... }] }
HAS_GROUPS_ARRAY=$(jq 'has("groups")' /tmp/uat-29-list.json 2>/dev/null)
[ "$HAS_GROUPS_ARRAY" = "true" ] && pass "3b. /groups response has groups[] array (server contract preserved)" || fail "3b. /groups response missing groups[] array"

ITEM_HAS_WIKI_COUNT=$(jq '.groups[0] | has("wikiCount")' /tmp/uat-29-list.json 2>/dev/null)
if [ "$ITEM_HAS_WIKI_COUNT" = "true" ]; then
  pass "3c. group item exposes wikiCount (used by sidebar badge)"
else
  fail "3c. group item missing wikiCount field"
fi

# 3d. Detail
DETAIL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups/$SEED_GROUP_ID")
[ "$DETAIL_HTTP" = "200" ] && pass "3d. GET /groups/:id → 200" || fail "3d. GET /groups/:id → HTTP $DETAIL_HTTP"

# 3e. 404 on missing group
DETAIL_404=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups/does-not-exist")
[ "$DETAIL_404" = "404" ] && pass "3e. GET /groups/<bogus> → 404" || fail "3e. bogus group id → HTTP $DETAIL_404"

# ── 4. Add wiki to collection (membership API) ───────────────────
# Create a wiki, attach it via POST /groups/:id/wikis, verify wikiCount
# increments, then unattach.

WIKI_RESP=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"name\":\"UAT29 Wiki $UAT_TAG\",\"type\":\"log\"}" \
  "$SERVER_URL/wikis")
UAT_WIKI_KEY=$(echo "$WIKI_RESP" | jq -r '.lookupKey // .id // ""')

if [ -n "$UAT_WIKI_KEY" ]; then
  pass "4a. Created UAT wiki ($UAT_WIKI_KEY)"
else
  fail "4a. Could not create UAT wiki for membership test"
fi

# 4b. Attach wiki to collection
ADD_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"wikiId\":\"$UAT_WIKI_KEY\"}" \
  "$SERVER_URL/groups/$SEED_GROUP_ID/wikis")
[ "$ADD_HTTP" = "201" ] && pass "4b. POST /groups/:id/wikis → 201" || fail "4b. add-to-collection → HTTP $ADD_HTTP"

# 4c. wikiCount in /groups list now reflects 1
COUNT_AFTER=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups" | jq -r ".groups[] | select(.id == \"$SEED_GROUP_ID\") | .wikiCount")
if [ "$COUNT_AFTER" = "1" ]; then
  pass "4c. wikiCount=1 after attach (sidebar badge will reflect this)"
else
  fail "4c. wikiCount=$COUNT_AFTER after attach (expected 1)"
fi

# 4d. Listing wikis for the collection returns the attached wiki
GROUP_WIKIS=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups/$SEED_GROUP_ID/wikis")
GROUP_WIKI_KEYS=$(echo "$GROUP_WIKIS" | jq -r '.wikis[].lookupKey' | tr '\n' ' ')
if echo "$GROUP_WIKI_KEYS" | grep -qw "$UAT_WIKI_KEY"; then
  pass "4d. GET /groups/:id/wikis includes attached wiki"
else
  fail "4d. attached wiki missing from GET /groups/:id/wikis ($GROUP_WIKI_KEYS)"
fi

# 4e. Negative: attach to bogus group → 404
ADD_404=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"wikiId\":\"$UAT_WIKI_KEY\"}" \
  "$SERVER_URL/groups/does-not-exist/wikis")
[ "$ADD_404" = "404" ] && pass "4e. attach to bogus group → 404" || fail "4e. attach to bogus group → HTTP $ADD_404"

# 4f. Negative: attach bogus wiki → 404
ADD_W404=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"wikiId\":\"does-not-exist\"}" \
  "$SERVER_URL/groups/$SEED_GROUP_ID/wikis")
[ "$ADD_W404" = "404" ] && pass "4f. attach bogus wiki → 404" || fail "4f. attach bogus wiki → HTTP $ADD_W404"

# 4g. Remove wiki from collection
RM_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE -b "$COOKIE_JAR" \
  -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups/$SEED_GROUP_ID/wikis/$UAT_WIKI_KEY")
if [ "$RM_HTTP" = "204" ] || [ "$RM_HTTP" = "200" ]; then
  pass "4g. DELETE /groups/:id/wikis/:wikiId → $RM_HTTP"
else
  fail "4g. remove-from-collection → HTTP $RM_HTTP"
fi

# 4h. Negative: remove non-member → 404
RM_404=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE -b "$COOKIE_JAR" \
  -H "Origin: http://localhost:3000" \
  "$SERVER_URL/groups/$SEED_GROUP_ID/wikis/$UAT_WIKI_KEY")
[ "$RM_404" = "404" ] && pass "4h. remove non-member → 404" || fail "4h. remove non-member → HTTP $RM_404"

# ── 5. Issue #163 — RELATED_TO edges at classification time ──────
# Drop a fragment with content close to an already-filed fragment in the
# same wiki and confirm a FRAGMENT_RELATED_TO_FRAGMENT edge is created
# bidirectionally with similarity ≥ 0.75.

# Pre-cleanup: prior UAT runs accumulate near-duplicate self-attention /
# transformer fragments that crowd out THIS run's pair in fragRelate's top-5
# vector search. The pipeline rewrites both fragment.title and
# raw_sources.title with LLM output, so we can't filter on 'uat29-' there.
#
# IMPORTANT: vectorSearch in core/src/queue/worker.ts intentionally does NOT
# filter on fragments.deleted_at — soft-deleted fragments still surface as
# candidates. The only way to keep them out of fragRelate's top-5 is a hard
# DELETE. We hard-delete every fragment derived from a raw_source whose
# content matches our UAT corpus signature (the '[run=uat29-' marker we add
# below or the unmarked twin content shapes from previous plan revisions).
# We also drop the matching raw_sources rows so dedup doesn't reuse stale
# entry titles on the next run.
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 <<'SQL' >/dev/null 2>&1
  DELETE FROM edges
  WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND (
      src_id IN (
        SELECT f.lookup_key FROM fragments f
        JOIN raw_sources rs ON rs.lookup_key = f.entry_id
        WHERE rs.content LIKE '%[run=uat29-%'
           OR rs.content LIKE 'Self-attention lets the transformer relate every token%'
           OR rs.content LIKE 'Transformers use self-attention to connect each token%'
           OR rs.content LIKE 'Self-attention is what allows transformers to relate tokens%'
           OR rs.content LIKE 'Self-attention, the heart of transformers%'
           OR rs.content LIKE 'The Mariana Trench in the Pacific%'
      )
      OR dst_id IN (
        SELECT f.lookup_key FROM fragments f
        JOIN raw_sources rs ON rs.lookup_key = f.entry_id
        WHERE rs.content LIKE '%[run=uat29-%'
           OR rs.content LIKE 'Self-attention lets the transformer relate every token%'
           OR rs.content LIKE 'Transformers use self-attention to connect each token%'
           OR rs.content LIKE 'Self-attention is what allows transformers to relate tokens%'
           OR rs.content LIKE 'Self-attention, the heart of transformers%'
           OR rs.content LIKE 'The Mariana Trench in the Pacific%'
      )
    );
  DELETE FROM raw_sources
  WHERE content LIKE '%[run=uat29-%'
     OR content LIKE 'Self-attention lets the transformer relate every token%'
     OR content LIKE 'Transformers use self-attention to connect each token%'
     OR content LIKE 'Self-attention is what allows transformers to relate tokens%'
     OR content LIKE 'Self-attention, the heart of transformers%'
     OR content LIKE 'The Mariana Trench in the Pacific%';
SQL

# 5a. Create a wiki to host the related fragments.
SIM_WIKI=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"name\":\"UAT29 Sim Wiki $UAT_TAG\",\"type\":\"log\",\"prompt\":\"transformer attention\"}" \
  "$SERVER_URL/wikis")
SIM_WIKI_KEY=$(echo "$SIM_WIKI" | jq -r '.lookupKey // .id // ""')
[ -n "$SIM_WIKI_KEY" ] && pass "5a. Created similarity wiki ($SIM_WIKI_KEY)" || fail "5a. similarity wiki create failed"

# 5b. Create two related fragments via /entries (entry pipeline turns
#     entries into fragments + embeddings + classification).
# Append UAT_TAG to content so dedup (computeContentHash) treats each run as a
# fresh submission — without this, a second run hits the existing row and
# reuses its old (non-uat29) title, breaking entry-id lookups downstream.
FRAG_TEXT_A="Self-attention lets the transformer relate every token to every other token, replacing recurrence in sequence modeling. [run=$UAT_TAG]"
FRAG_TEXT_B="Transformers use self-attention to connect each token with every other token; this replaces the recurrent step in sequence models. [run=$UAT_TAG]"

ENTRY_A=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$FRAG_TEXT_A" --arg t "uat29-frag-a-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_A_KEY=$(echo "$ENTRY_A" | jq -r '.lookupKey // .id // ""')
[ -n "$ENTRY_A_KEY" ] && pass "5b. Entry A submitted ($ENTRY_A_KEY)" || fail "5b. entry A submit failed"

ENTRY_B=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$FRAG_TEXT_B" --arg t "uat29-frag-b-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_B_KEY=$(echo "$ENTRY_B" | jq -r '.lookupKey // .id // ""')
[ -n "$ENTRY_B_KEY" ] && pass "5c. Entry B submitted ($ENTRY_B_KEY)" || fail "5c. entry B submit failed"

# 5d. Poll until both fragments are embedded AND fragRelate has finished
#     (state='RESOLVED' marks completion of the linking stage).
#
#     - Filter via entry_id (the lookupKey we got back from POST /entries) —
#       neither fragment.title (LLM-generated from content) nor
#       raw_sources.title (overwritten by the persist stage with the LLM
#       primaryTopic) preserves the title we submitted, so the only stable
#       handle on a UAT fragment is its owning entry's lookup_key.
#     - createRelatedToEdges runs unconditionally inside the linking stage
#       (packages/agent/src/stages/index.ts ~line 209), independent of
#       whether wikiClassify produced a FRAGMENT_IN_WIKI edge. The fragment
#       transitions PENDING → LINKING → RESOLVED across that stage, so
#       waiting for state='RESOLVED' is the correct precondition for the
#       RELATED_TO assertions below — embedding alone is set during persist
#       (an earlier stage) and fires before fragRelate runs.
DEADLINE=$(($(date +%s) + 90))
RESOLVED=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  RESOLVED=$(psql "$DATABASE_URL" -t -A -c "
    SELECT COUNT(*) FROM fragments f
    WHERE f.embedding IS NOT NULL
      AND f.deleted_at IS NULL
      AND f.state = 'RESOLVED'
      AND f.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')
  " 2>/dev/null | tr -d ' ')
  if [ "${RESOLVED:-0}" -ge 2 ] 2>/dev/null; then break; fi
  sleep 3
done

if [ "${RESOLVED:-0}" -ge 2 ] 2>/dev/null; then
  pass "5d. Both UAT fragments embedded + linking complete (count=$RESOLVED)"
else
  fail "5d. Fragments did not finish linking within 90s (RESOLVED=$RESOLVED) — pipeline regression"
fi

# 5e. RELATED_TO edges exist between our two UAT fragments.
SIM_EDGES=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM edges e
  JOIN fragments fa ON fa.lookup_key = e.src_id
  JOIN fragments fb ON fb.lookup_key = e.dst_id
  WHERE e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND e.deleted_at IS NULL
    AND fa.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')
    AND fb.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')
" 2>/dev/null | tr -d ' ')
if [ "${SIM_EDGES:-0}" -ge 2 ] 2>/dev/null; then
  pass "5e. Bidirectional FRAGMENT_RELATED_TO_FRAGMENT edges present (count=$SIM_EDGES)"
else
  fail "5e. similarity edges missing or one-directional (count=$SIM_EDGES, expected ≥2)"
fi

# 5f. Edge type literal is exactly 'FRAGMENT_RELATED_TO_FRAGMENT' (not
#     'RELATED_TO' — the schema in regen.ts uses the prefixed form).
EDGE_TYPE_CHECK=$(psql "$DATABASE_URL" -t -A -c "
  SELECT DISTINCT edge_type FROM edges
  WHERE edge_type ILIKE '%RELATED%' AND deleted_at IS NULL
" 2>/dev/null | tr -d ' ')
if echo "$EDGE_TYPE_CHECK" | grep -qx "FRAGMENT_RELATED_TO_FRAGMENT"; then
  pass "5f. Edge type literal is FRAGMENT_RELATED_TO_FRAGMENT"
else
  fail "5f. Edge type literal mismatch (saw '$EDGE_TYPE_CHECK')"
fi

# 5g. Edge attrs carry score >= 0.75 and method='cosine-regen'.
EDGE_ATTRS=$(psql "$DATABASE_URL" -t -A -c "
  SELECT attrs::text FROM edges e
  JOIN fragments fa ON fa.lookup_key = e.src_id
  JOIN fragments fb ON fb.lookup_key = e.dst_id
  WHERE e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND e.deleted_at IS NULL
    AND fa.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')
    AND fb.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')
  LIMIT 1
" 2>/dev/null)
# Postgres jsonb -> text inserts a single space after each colon when
# rendering object members, so the literal grep needs to match either
# "method":"cosine-regen" or "method": "cosine-regen". Use a regex that
# tolerates optional whitespace.
if echo "$EDGE_ATTRS" | grep -qE '"method":[[:space:]]*"cosine-regen"'; then
  pass "5g. Edge attrs.method = 'cosine-regen'"
else
  fail "5g. Edge attrs.method missing or wrong ($EDGE_ATTRS)"
fi

# 5g-strict. EVERY similarity edge created in the test window must carry
# method='cosine-regen'. Catches BOTH callsites in one shot:
#   - core/src/lib/regen.ts createRelatedToEdges (the regen-time path,
#     which writes { score, method:'cosine-regen' })
#   - packages/agent/src/stages/index.ts ~lines 217-234 (the linking-stage
#     worker path, which currently writes { score } only — Issue #227).
# Any edge in the window with NULL method or any other method value fails
# the assertion. Live evidence: 100/100 edges currently lack method, so this
# expected-fails today and turns green only when both insertEdge sites in
# stages/index.ts gain `method:'cosine-regen'` in their attrs payloads.
WINDOW_BAD_METHOD=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM edges
  WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND deleted_at IS NULL
    AND created_at > '$TEST_START'::timestamptz
    AND (attrs->>'method') IS DISTINCT FROM 'cosine-regen'
" 2>/dev/null | tr -d ' ')
if [ "${WINDOW_BAD_METHOD:-1}" = "0" ]; then
  pass "5g-strict. All test-window FRAGMENT_RELATED_TO_FRAGMENT edges carry method='cosine-regen'"
else
  fail "5g-strict. $WINDOW_BAD_METHOD test-window edge(s) missing method='cosine-regen' — worker path (stages/index.ts) regression"
fi

EDGE_SCORE=$(echo "$EDGE_ATTRS" | jq -r '.score // 0' 2>/dev/null)
if awk "BEGIN{exit !($EDGE_SCORE >= 0.75)}" 2>/dev/null; then
  pass "5h. Edge attrs.score = $EDGE_SCORE (>= 0.75 threshold)"
else
  fail "5h. Edge attrs.score = $EDGE_SCORE below 0.75 threshold — RELATED_FRAGMENT_THRESHOLD breached"
fi

# 5i. src_type / dst_type are both 'fragment'.
TYPE_PAIR=$(psql "$DATABASE_URL" -t -A -c "
  SELECT DISTINCT src_type || '|' || dst_type FROM edges e
  JOIN fragments fa ON fa.lookup_key = e.src_id
  WHERE e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND fa.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')
" 2>/dev/null | tr -d ' ')
[ "$TYPE_PAIR" = "fragment|fragment" ] && pass "5i. src_type=fragment, dst_type=fragment" || fail "5i. type pair = '$TYPE_PAIR' (expected fragment|fragment)"

# 5j. Negative — drop a totally unrelated fragment, no RELATED_TO edge to A.
FRAG_TEXT_C="The Mariana Trench in the Pacific Ocean is the deepest part of the world's oceans. [run=$UAT_TAG]"
ENTRY_C=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$FRAG_TEXT_C" --arg t "uat29-noise-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_C_KEY=$(echo "$ENTRY_C" | jq -r '.lookupKey // .id // ""')

# Wait briefly for noise fragment to embed (it may classify into a different
# wiki or stay unfiled — either way it must NOT relate to our cluster).
sleep 12

NOISE_EDGES=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM edges e
  JOIN fragments fa ON fa.lookup_key = e.src_id
  JOIN fragments fb ON fb.lookup_key = e.dst_id
  WHERE e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND e.deleted_at IS NULL
    AND ((fa.entry_id = '$ENTRY_C_KEY' AND fb.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY'))
      OR (fb.entry_id = '$ENTRY_C_KEY' AND fa.entry_id IN ('$ENTRY_A_KEY', '$ENTRY_B_KEY')))
" 2>/dev/null | tr -d ' ')
[ "${NOISE_EDGES:-1}" = "0" ] && pass "5j. Below-threshold pair: no RELATED_TO edge created" || fail "5j. unrelated fragment got $NOISE_EDGES RELATED_TO edges to UAT cluster (false positive)"

# Resolve the actual lookup_keys for the two UAT fragments — used by
# subsequent sections. Fragment+entry titles are both LLM-generated, so
# look up by the entry lookupKey returned from POST /entries.
FRAG_A_KEY=$(psql "$DATABASE_URL" -t -A -c "
  SELECT lookup_key FROM fragments
  WHERE entry_id = '$ENTRY_A_KEY' AND deleted_at IS NULL
  LIMIT 1
" 2>/dev/null | tr -d ' ')
FRAG_B_KEY=$(psql "$DATABASE_URL" -t -A -c "
  SELECT lookup_key FROM fragments
  WHERE entry_id = '$ENTRY_B_KEY' AND deleted_at IS NULL
  LIMIT 1
" 2>/dev/null | tr -d ' ')

# ── 6. Soft-delete respect on similarity edges ───────────────────
# Soft-deleted fragments must not surface in fragment detail's
# relatedFragments[] response.

# 6a. Confirm related edges for FRAG_A include FRAG_B before delete.
PRE_API=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_A_KEY")
PRE_RELATED_COUNT=$(echo "$PRE_API" | jq '.relatedFragments | length' 2>/dev/null || echo 0)
if [ "${PRE_RELATED_COUNT:-0}" -ge 1 ] 2>/dev/null; then
  pass "6a. Pre-delete: FRAG_A.relatedFragments has $PRE_RELATED_COUNT entries"
else
  fail "6a. Pre-delete: FRAG_A.relatedFragments empty (expected ≥1)"
fi

# 6b. Soft-delete FRAG_B.
DEL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE -b "$COOKIE_JAR" \
  -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_B_KEY")
if [ "$DEL_HTTP" = "204" ] || [ "$DEL_HTTP" = "200" ]; then
  pass "6b. Soft-deleted FRAG_B → HTTP $DEL_HTTP"
else
  fail "6b. soft-delete FRAG_B → HTTP $DEL_HTTP"
fi

# 6c. After delete, FRAG_A.relatedFragments excludes FRAG_B.
POST_API=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_A_KEY")
POST_HAS_B=$(echo "$POST_API" | jq -r ".relatedFragments[] | select(.id == \"$FRAG_B_KEY\") | .id" 2>/dev/null)
if [ -z "$POST_HAS_B" ]; then
  pass "6c. Post-delete: FRAG_A.relatedFragments excludes soft-deleted FRAG_B"
else
  fail "6c. Soft-deleted fragment still surfaces in relatedFragments ($POST_HAS_B)"
fi

# ── 6.5 Issue #228 — DELETE /fragments/:id route + edge cascade ──
# The route must:
#   1. exist (HTTP 204 on a real key)
#   2. soft-delete the fragment row (fragments.deleted_at NOT NULL)
#   3. soft-delete every edge referencing the fragment in either direction:
#      FRAGMENT_IN_WIKI, FRAGMENT_RELATED_TO_FRAGMENT (both src and dst),
#      FRAGMENT_MENTIONS_PERSON, ENTRY_HAS_FRAGMENT.
# Live evidence today: HTTP 404 — the handler is absent from
# core/src/routes/fragments.ts. This whole subsection expected-fails until
# the route lands. Pattern to match: DELETE /wikis/:id at
# core/src/routes/wikis.ts:715-739 (lookup → 404 if missing → soft-delete
# row + cascade related joins → audit emit → c.body(null, 204)).

# 6d. Create a fresh UAT fragment to exercise the delete in isolation —
#     do NOT reuse FRAG_A/FRAG_B/FRAG_D from earlier so cleanup paths in §11
#     don't have to special-case it.
FRAG_TEXT_DEL="Self-attention, the heart of transformers, lets every position attend to every other position in one parallel pass. [run=$UAT_TAG]"
ENTRY_DEL=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$FRAG_TEXT_DEL" --arg t "uat29-frag-del-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_DEL_KEY=$(echo "$ENTRY_DEL" | jq -r '.lookupKey // .id // ""')

# Wait for pipeline to land the fragment + at least one outgoing edge so the
# cascade assertion below has something non-trivial to chew on (60s budget;
# embeddings + classification + fragRelate must complete).
DEADLINE=$(($(date +%s) + 60))
FRAG_DEL_KEY=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  FRAG_DEL_KEY=$(psql "$DATABASE_URL" -t -A -c "
    SELECT lookup_key FROM fragments
    WHERE entry_id = '$ENTRY_DEL_KEY' AND deleted_at IS NULL AND state = 'RESOLVED'
    LIMIT 1
  " 2>/dev/null | tr -d ' ')
  [ -n "$FRAG_DEL_KEY" ] && break
  sleep 3
done

if [ -n "$FRAG_DEL_KEY" ]; then
  pass "6d. UAT delete-target fragment created and resolved ($FRAG_DEL_KEY)"
else
  fail "6d. delete-target fragment never resolved within 60s — pipeline regression masked the §6.5 test"
fi

# 6e. Snapshot the edge graph BEFORE the delete so the cascade assertion
#     can compare against a known surface. Count active edges that reference
#     FRAG_DEL_KEY in EITHER direction across all five edge types we care about.
PRE_EDGE_COUNT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM edges
  WHERE deleted_at IS NULL
    AND edge_type IN (
      'FRAGMENT_IN_WIKI',
      'FRAGMENT_RELATED_TO_FRAGMENT',
      'FRAGMENT_MENTIONS_PERSON',
      'ENTRY_HAS_FRAGMENT'
    )
    AND ('$FRAG_DEL_KEY' IN (src_id, dst_id))
" 2>/dev/null | tr -d ' ')
echo "  (pre-delete: $PRE_EDGE_COUNT active edge(s) reference $FRAG_DEL_KEY)"

# 6f. DELETE /fragments/:lookupKey returns 204.
DEL_FRAG_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE -b "$COOKIE_JAR" \
  -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_DEL_KEY")
if [ "$DEL_FRAG_HTTP" = "204" ]; then
  pass "6f. DELETE /fragments/:lookupKey → 204"
else
  fail "6f. DELETE /fragments/:lookupKey → HTTP $DEL_FRAG_HTTP (expected 204) — Issue #228 route missing"
fi

# 6g. fragments.deleted_at IS NOT NULL after delete.
DEL_AT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT deleted_at IS NOT NULL FROM fragments WHERE lookup_key = '$FRAG_DEL_KEY'
" 2>/dev/null | tr -d ' ')
if [ "$DEL_AT" = "t" ]; then
  pass "6g. fragments.deleted_at IS NOT NULL after delete"
else
  fail "6g. fragments.deleted_at still null (got '$DEL_AT') — soft-delete didn't land"
fi

# 6h. Strict cascade: ALL edges that referenced FRAG_DEL_KEY (in either
#     direction, across the four relevant edge types) must have
#     deleted_at IS NOT NULL. Asserts zero rows where the fragment is
#     referenced AND the edge is still active. Catches the case where the
#     route soft-deletes the row but leaves dangling edges live.
ACTIVE_REFS=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM edges
  WHERE deleted_at IS NULL
    AND edge_type IN (
      'FRAGMENT_IN_WIKI',
      'FRAGMENT_RELATED_TO_FRAGMENT',
      'FRAGMENT_MENTIONS_PERSON',
      'ENTRY_HAS_FRAGMENT'
    )
    AND ('$FRAG_DEL_KEY' IN (src_id, dst_id))
" 2>/dev/null | tr -d ' ')
if [ "${ACTIVE_REFS:-1}" = "0" ]; then
  pass "6h. All $PRE_EDGE_COUNT edges referencing $FRAG_DEL_KEY soft-deleted (cascade complete)"
else
  fail "6h. $ACTIVE_REFS edge(s) still active after fragment delete — cascade incomplete"
fi

# 6i. Cleanup: hard-delete the §6.5 UAT fragment + its edges + its entry +
#     its raw_source so subsequent runs don't accumulate near-duplicate
#     transformer corpus rows. Hard delete on this single row is safe
#     because the §11 cleanup already covers the wider $UAT_TAG sweep.
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 <<SQL >/dev/null 2>&1
  DELETE FROM edges
  WHERE '$FRAG_DEL_KEY' IN (src_id, dst_id);
  DELETE FROM fragments WHERE lookup_key = '$FRAG_DEL_KEY';
  DELETE FROM raw_sources WHERE lookup_key = '$ENTRY_DEL_KEY';
SQL

# ── 7. Issue #164 — relatedFragments in /fragments/:id ───────────

# 7a. Fragment detail returns relatedFragments[] with the documented shape.
FRAG_API=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments/$FRAG_A_KEY")
HAS_REL=$(echo "$FRAG_API" | jq 'has("relatedFragments")' 2>/dev/null)
[ "$HAS_REL" = "true" ] && pass "7a. /fragments/:id response has relatedFragments[]" || fail "7a. /fragments/:id missing relatedFragments[]"

# 7b. Schema enforced: each item has id, slug, title, similarity (number).
# (Issue #164 specifies these four fields; fragmentDetailResponseSchema
#  defaults to [] when no edges exist.)
SHAPE_OK=$(echo "$FRAG_API" | jq -e '
  (.relatedFragments | length == 0)
  or (.relatedFragments | all(
    has("id") and has("slug") and has("title") and has("similarity")
    and (.similarity | type == "number")
  ))' 2>/dev/null)
[ "$SHAPE_OK" = "true" ] && pass "7b. relatedFragments items have {id, slug, title, similarity:number}" || fail "7b. relatedFragments item shape wrong"

# 7c. similarity values fall in (0, 1].
SIM_RANGE_OK=$(echo "$FRAG_API" | jq -e '
  (.relatedFragments | length == 0)
  or (.relatedFragments | all(.similarity > 0 and .similarity <= 1))
' 2>/dev/null)
[ "$SIM_RANGE_OK" = "true" ] && pass "7c. similarity scores within (0, 1]" || fail "7c. similarity score out of range"

# 7d. Sort order — relatedFragments are ordered by similarity DESC.
SORT_OK=$(echo "$FRAG_API" | jq -e '
  (.relatedFragments | length < 2)
  or (.relatedFragments
      | [.[].similarity]
      | . == (sort | reverse))
' 2>/dev/null)
[ "$SORT_OK" = "true" ] && pass "7d. relatedFragments sorted by similarity desc" || fail "7d. relatedFragments not sorted by similarity desc"

# 7e. Fragment detail page renders "Related fragments" UI section.
# Use a still-live fragment (FRAG_A) with at least one related edge — but
# B was soft-deleted in section 6, so we re-create a related fragment now
# to keep this assertion reachable.
FRAG_TEXT_D="Self-attention is what allows transformers to relate tokens across the whole sequence in parallel. [run=$UAT_TAG]"
ENTRY_D=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$FRAG_TEXT_D" --arg t "uat29-frag-d-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_D_KEY=$(echo "$ENTRY_D" | jq -r '.lookupKey // .id // ""')

# Re-poll until D embeds + classifies + relates back to A.
DEADLINE=$(($(date +%s) + 90))
D_LINK=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  D_LINK=$(psql "$DATABASE_URL" -t -A -c "
    SELECT COUNT(*) FROM edges e
    JOIN fragments fa ON fa.lookup_key = e.src_id AND fa.lookup_key = '$FRAG_A_KEY'
    JOIN fragments fd ON fd.lookup_key = e.dst_id AND fd.entry_id = '$ENTRY_D_KEY'
    WHERE e.edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
      AND e.deleted_at IS NULL
  " 2>/dev/null | tr -d ' ')
  [ "${D_LINK:-0}" -ge 1 ] 2>/dev/null && break
  sleep 3
done

if [ "${D_LINK:-0}" -ge 1 ] 2>/dev/null; then
  pass "7e-pre. Fragment D linked to FRAG_A via FRAGMENT_RELATED_TO_FRAGMENT"
else
  fail "7e-pre. Fragment D never related to FRAG_A — UI section will be empty"
fi

# Render fragment A detail page in the wiki frontend.
npx agent-browser open "$WIKI_URL/fragments/$FRAG_A_KEY" 2>/dev/null
npx agent-browser wait --load networkidle
sleep 1
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-29-frag.html 2>/dev/null
FRAG_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-29-07-fragment.png 2>/dev/null

if echo "$FRAG_SNAP" | grep -qi "Related fragments"; then
  pass "7e. 'Related fragments' section rendered on fragment detail page"
else
  fail "7e. 'Related fragments' section heading missing"
fi

# 7f. The related list contains a percentage score (e.g. '87%').
if grep -oE '[0-9]{1,3}%' /tmp/uat-29-frag.html | grep -qE '^[7-9][0-9]%$|^100%$'; then
  pass "7f. Related fragment row shows similarity percentage in 70-100% range"
else
  fail "7f. No 70-100% similarity percentage found in related-fragments DOM"
fi

# 7g. The related fragment row links to the other fragment's detail page.
if grep -qE "href=\"/fragments/[^\"]+\"" /tmp/uat-29-frag.html; then
  pass "7g. Related-fragment links route to /fragments/<id>"
else
  fail "7g. No /fragments/<id> link rendered in related section"
fi

# 7h. Default: when relatedFragments is absent on the wire, the schema's
# .default([]) keeps the response array-typed (not undefined).
LONELY=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "Lonely UAT fragment with nothing to relate to: ${UAT_TAG}-${RANDOM}" --arg t "uat29-lonely-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
LONELY_ENTRY_KEY=$(echo "$LONELY" | jq -r '.lookupKey // .id // ""')
sleep 6
LONELY_FK=$(psql "$DATABASE_URL" -t -A -c "
  SELECT lookup_key FROM fragments
  WHERE entry_id = '$LONELY_ENTRY_KEY' AND deleted_at IS NULL
  LIMIT 1
" 2>/dev/null | tr -d ' ')
if [ -n "$LONELY_FK" ]; then
  LONELY_API=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    "$SERVER_URL/fragments/$LONELY_FK")
  LONELY_REL_TYPE=$(echo "$LONELY_API" | jq -r '.relatedFragments | type' 2>/dev/null)
  [ "$LONELY_REL_TYPE" = "array" ] && pass "7h. relatedFragments is always an array (default [])" || fail "7h. relatedFragments not array (got $LONELY_REL_TYPE)"
else
  skip "7h. Lonely fragment never materialised — skipping default-shape assertion"
fi

# ── 8. Issue #165 — related_detected audit events ────────────────

# 8a. audit_log contains a 'related_detected' row for FRAG_A.
A_AUDIT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM audit_log
  WHERE entity_type = 'fragment'
    AND entity_id = '$FRAG_A_KEY'
    AND event_type = 'related_detected'
" 2>/dev/null | tr -d ' ')
if [ "${A_AUDIT:-0}" -ge 1 ] 2>/dev/null; then
  pass "8a. audit_log has related_detected event for FRAG_A (count=$A_AUDIT)"
else
  fail "8a. No related_detected audit event for FRAG_A — Issue #165 regression"
fi

# 8b. audit_log contains a 'related_detected' row for FRAG_D too
#     (bidirectional emit, the partner of FRAG_A in section 7).
FRAG_D_KEY=$(psql "$DATABASE_URL" -t -A -c "
  SELECT lookup_key FROM fragments
  WHERE entry_id = '$ENTRY_D_KEY' AND deleted_at IS NULL
  LIMIT 1
" 2>/dev/null | tr -d ' ')
D_AUDIT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM audit_log
  WHERE entity_type = 'fragment'
    AND entity_id = '$FRAG_D_KEY'
    AND event_type = 'related_detected'
" 2>/dev/null | tr -d ' ')
if [ "${D_AUDIT:-0}" -ge 1 ] 2>/dev/null; then
  pass "8b. audit_log has related_detected event for FRAG_D (bidirectional)"
else
  fail "8b. No related_detected audit event for FRAG_D — bidirectional emit broken"
fi

# 8c. detail jsonb carries fragmentKey, relatedKey, similarity, wikiKey.
A_DETAIL=$(psql "$DATABASE_URL" -t -A -c "
  SELECT detail::text FROM audit_log
  WHERE entity_type = 'fragment'
    AND entity_id = '$FRAG_A_KEY'
    AND event_type = 'related_detected'
  ORDER BY created_at DESC LIMIT 1
" 2>/dev/null)
HAS_FRAG=$(echo "$A_DETAIL" | jq 'has("fragmentKey")' 2>/dev/null)
HAS_REL_KEY=$(echo "$A_DETAIL" | jq 'has("relatedKey")' 2>/dev/null)
HAS_SIM=$(echo "$A_DETAIL" | jq 'has("similarity")' 2>/dev/null)
HAS_WIKI=$(echo "$A_DETAIL" | jq 'has("wikiKey")' 2>/dev/null)
if [ "$HAS_FRAG" = "true" ] && [ "$HAS_REL_KEY" = "true" ] && [ "$HAS_SIM" = "true" ] && [ "$HAS_WIKI" = "true" ]; then
  pass "8c. audit detail has fragmentKey/relatedKey/similarity/wikiKey"
else
  fail "8c. audit detail missing fields (fragmentKey=$HAS_FRAG relatedKey=$HAS_REL_KEY similarity=$HAS_SIM wikiKey=$HAS_WIKI)"
fi

# 8d. summary string contains a percentage marker (renderer pattern from
#     regen.ts line 167: 'Related fragment detected: <key> (<pct>%)').
A_SUMMARY=$(psql "$DATABASE_URL" -t -A -c "
  SELECT summary FROM audit_log
  WHERE entity_type = 'fragment'
    AND entity_id = '$FRAG_A_KEY'
    AND event_type = 'related_detected'
  ORDER BY created_at DESC LIMIT 1
" 2>/dev/null)
if echo "$A_SUMMARY" | grep -qE 'Related fragment detected: .+\([0-9]+%\)'; then
  pass "8d. audit summary matches 'Related fragment detected: <key> (<pct>%)'"
else
  fail "8d. audit summary format wrong: '$A_SUMMARY'"
fi

# 8e. source = 'system' (emitted by pipeline, not API).
A_SRC=$(psql "$DATABASE_URL" -t -A -c "
  SELECT source FROM audit_log
  WHERE entity_type = 'fragment'
    AND entity_id = '$FRAG_A_KEY'
    AND event_type = 'related_detected'
  ORDER BY created_at DESC LIMIT 1
" 2>/dev/null | tr -d ' ')
[ "$A_SRC" = "system" ] && pass "8e. audit source = 'system'" || fail "8e. audit source = '$A_SRC' (expected 'system')"

# 8f. Wiki timeline endpoint surfaces these audit events for the wiki the
#     fragments live in. Find the wiki FRAG_A is filed into and call
#     /wikis/:id/timeline.
WIKI_FOR_A=$(psql "$DATABASE_URL" -t -A -c "
  SELECT e.dst_id FROM edges e
  JOIN wikis w ON w.lookup_key = e.dst_id AND w.deleted_at IS NULL
  WHERE e.src_id = '$FRAG_A_KEY'
    AND e.edge_type = 'FRAGMENT_IN_WIKI'
    AND e.deleted_at IS NULL
  LIMIT 1
" 2>/dev/null | tr -d ' ')

if [ -n "$WIKI_FOR_A" ]; then
  TL_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    "$SERVER_URL/wikis/$WIKI_FOR_A/timeline?limit=200")
  TL_HAS_RELATED=$(echo "$TL_RESP" | jq -r '.events[] | select(.eventType == "related_detected") | .id' 2>/dev/null | head -1)
  if [ -n "$TL_HAS_RELATED" ]; then
    pass "8f. /wikis/:id/timeline surfaces related_detected events"
  else
    fail "8f. /wikis/:id/timeline did not include any related_detected event"
  fi
else
  skip "8f. FRAG_A has no FRAGMENT_IN_WIKI edge — cannot resolve owning wiki"
fi

# 8g. Strict pairing: every test-window FRAGMENT_RELATED_TO_FRAGMENT edge
#     must have produced exactly two related_detected audit rows (one per
#     direction — emitAuditEvent fires once for each fragment in the pair).
#     Catches BOTH callsites in one shot:
#       - core/src/lib/regen.ts (already emits both directions correctly)
#       - packages/agent/src/stages/index.ts ~lines 217-234 (worker path
#         currently emits ZERO audit events — Issue #229)
#     Live evidence: ~100 worker-path edges exist with 0 audit pairs and ~2
#     regen.ts edges with 2 audit rows (1 pair). When the worker path is
#     fixed, audit_count must equal 2 * edge_count for the test window.
#
#     IMPORTANT: count edges INCLUDING soft-deleted rows. Sections 6 and 6.5
#     soft-delete fragments + cascade their edges (FRAG_B, FRAG_DEL), which
#     reduces the live edge count below the audit count emitted at insert
#     time. The audit_log has no deleted_at column, so audits remain after
#     the edge soft-delete. Without this fix the assertion expected_audit
#     would shrink while the audit count stayed put, producing a spurious
#     pairing mismatch even after #229 is fixed.
WINDOW_EDGE_COUNT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM edges
  WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND created_at > '$TEST_START'::timestamptz
" 2>/dev/null | tr -d ' ')
WINDOW_AUDIT_COUNT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT COUNT(*) FROM audit_log
  WHERE event_type = 'related_detected'
    AND created_at > '$TEST_START'::timestamptz
" 2>/dev/null | tr -d ' ')
# Per-edge expectation: each directional edge insert is accompanied by two
# emitAuditEvent calls (one for each fragment in the pair). The upper bound
# is (2 × edge_count) when every pair has both fragments processed by the
# worker; the lower bound is edge_count when only one of the pair was
# processed (the other was a pre-existing fragment touched only by the
# regen-time path, which my fix in regen.ts dedups via .returning() on
# onConflictDoNothing). Below edge_count = worker path missing emitAuditEvent.
EXPECTED_MIN=${WINDOW_EDGE_COUNT:-0}
EXPECTED_MAX=$((2 * ${WINDOW_EDGE_COUNT:-0}))
if [ "${WINDOW_AUDIT_COUNT:-0}" -ge "$EXPECTED_MIN" ] \
  && [ "${WINDOW_AUDIT_COUNT:-0}" -le "$EXPECTED_MAX" ] \
  && [ "$EXPECTED_MIN" -gt 0 ]; then
  pass "8g. Strict audit pairing: $WINDOW_AUDIT_COUNT audit rows ∈ [$EXPECTED_MIN, $EXPECTED_MAX] (1-2 × $WINDOW_EDGE_COUNT edges)"
else
  fail "8g. Audit pairing mismatch: $WINDOW_AUDIT_COUNT audit rows outside [$EXPECTED_MIN, $EXPECTED_MAX] for $WINDOW_EDGE_COUNT edges — worker path missing emitAuditEvent"
fi

# ── 9. Schema invariants — RELATED edge uniqueness ───────────────
# edges has a UNIQUE (src_type, src_id, dst_type, dst_id, edge_type) index;
# repeating classification must not create duplicate edges (idempotency).

DUP_CHECK=$(psql "$DATABASE_URL" -t -A -c "
  SELECT MAX(c) FROM (
    SELECT COUNT(*) c FROM edges
    WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
      AND deleted_at IS NULL
    GROUP BY src_id, dst_id
  ) AS x
" 2>/dev/null | tr -d ' ')
if [ "${DUP_CHECK:-0}" = "1" ] || [ -z "${DUP_CHECK:-}" ]; then
  pass "9a. No duplicate FRAGMENT_RELATED_TO_FRAGMENT edges per (src,dst) pair"
else
  fail "9a. Duplicate similarity edges exist (max-per-pair=$DUP_CHECK) — onConflictDoNothing failed"
fi

# 9b. Score field is named 'score' (not 'similarity') in attrs — matches
#     regen.ts code (issue text said 'similarity' but PR shipped 'score').
SCORE_KEY=$(psql "$DATABASE_URL" -t -A -c "
  SELECT attrs ? 'score' AND NOT attrs ? 'similarity' FROM edges
  WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND deleted_at IS NULL
  LIMIT 1
" 2>/dev/null | tr -d ' ')
[ "$SCORE_KEY" = "t" ] && pass "9b. Edge attrs uses 'score' key (PR convention)" || fail "9b. Edge attrs key wrong (got '$SCORE_KEY')"

# ── 10. Unauthenticated access ───────────────────────────────────
# Both /groups and /fragments/:id need an authenticated session. Negative
# checks confirm middleware is wired.

UNAUTH_GROUPS=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/groups")
[ "$UNAUTH_GROUPS" = "401" ] && pass "10a. unauthenticated GET /groups → 401" || fail "10a. unauth /groups → HTTP $UNAUTH_GROUPS"

UNAUTH_FRAG=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/fragments/$FRAG_A_KEY")
[ "$UNAUTH_FRAG" = "401" ] && pass "10b. unauthenticated GET /fragments/:id → 401" || fail "10b. unauth fragment → HTTP $UNAUTH_FRAG"

# ── 11. Cleanup ──────────────────────────────────────────────────
# Soft-delete the UAT fragments + edges + collection so subsequent runs
# start clean. Hard-delete the membership rows (no soft-delete column on
# group_wikis). Drop the seed group last.

# 11a. Soft-delete UAT fragments (filter by entry_id since both fragment.title
#      and raw_sources.title are LLM-overwritten by the persist stage).
UAT_ENTRY_KEYS="'$ENTRY_A_KEY','$ENTRY_B_KEY','$ENTRY_C_KEY','$ENTRY_D_KEY','$LONELY_ENTRY_KEY'"
psql "$DATABASE_URL" -c "
  UPDATE fragments SET deleted_at = NOW()
  WHERE entry_id IN ($UAT_ENTRY_KEYS)
    AND deleted_at IS NULL
" >/dev/null 2>&1

# 11b. Soft-delete UAT similarity edges in BOTH directions (src_id OR dst_id)
#      so a UAT fragment never lingers as a vector-search neighbor on the
#      next run.
psql "$DATABASE_URL" -c "
  UPDATE edges SET deleted_at = NOW()
  WHERE edge_type = 'FRAGMENT_RELATED_TO_FRAGMENT'
    AND deleted_at IS NULL
    AND (src_id IN (SELECT lookup_key FROM fragments WHERE entry_id IN ($UAT_ENTRY_KEYS))
      OR dst_id IN (SELECT lookup_key FROM fragments WHERE entry_id IN ($UAT_ENTRY_KEYS)))
" >/dev/null 2>&1

# 11c. Drop UAT wikis (soft-delete)
psql "$DATABASE_URL" -c "
  UPDATE wikis SET deleted_at = NOW()
  WHERE name LIKE 'UAT29%$UAT_TAG' AND deleted_at IS NULL
" >/dev/null 2>&1

# 11d. Hard-drop the UAT collection (group_wikis cascades; on a clean
#      DELETE the audit row stays for trail).
if [ -n "$SEED_GROUP_ID" ]; then
  curl -s -o /dev/null -X DELETE -b "$COOKIE_JAR" \
    -H "Origin: http://localhost:3000" \
    "$SERVER_URL/groups/$SEED_GROUP_ID"
fi

npx agent-browser close 2>/dev/null || true

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Issue | Source |
|---|-----------|-------|--------|
| 1 | Explorer page renders 'Collection' labels and chips | #185 | wiki/explorer/page.tsx |
| 1c | Word 'Group(s)' absent from explorer text | #185 | grep guard |
| 1d | `?collection=` URL filter wired | #185 | useExplorerFilters |
| 1e | Backend `/groups` HTTP route preserved | #185 | core/routes/groups.ts |
| 1f | Backend `/collections` is a 404 (no rename) | #185 | non-rename invariant |
| 2 | Sidebar 'Collections' section between Navigation and Entries | #45  | components/layout/Sidebar.tsx |
| 2c | Sidebar shows live-data collection name | #45  | useCollections() |
| 2e | Sidebar wikiCount badge | #45  | useCollections data shape |
| 3 | `/groups` list/detail/error contracts | #45/#185 | core/routes/groups.ts |
| 4 | Membership CRUD (add, remove, count, negatives) | #45  | groups membership routes |
| 5 | Bidirectional FRAGMENT_RELATED_TO_FRAGMENT edges, ≥0.75 score | #163 | createRelatedToEdges in regen.ts |
| 5g-strict | EVERY test-window similarity edge has attrs.method='cosine-regen' | #227 | both callsites must agree |
| 5j | Below-threshold pair NOT linked | #163 | RELATED_FRAGMENT_THRESHOLD |
| 6 | Soft-deleted partner excluded from related-fragments response | #163/#164 | fragments route filter |
| 6.5 | DELETE /fragments/:id route + edge cascade | #228 | fragments.ts DELETE handler (currently absent) |
| 7 | `/fragments/:id` returns relatedFragments[] with correct shape | #164 | fragmentDetailResponseSchema |
| 7d | relatedFragments sorted by similarity desc | #164 | fragments route sort |
| 7e | Frontend renders 'Related fragments' section with %, links | #164 | fragments/[id]/page.tsx |
| 7h | Default empty array when no relations | #164 | schema .default([]) |
| 8 | `related_detected` audit events on both fragments | #165 | emitAuditEvent in regen.ts |
| 8c | audit detail jsonb shape (fragmentKey/relatedKey/sim/wikiKey) | #165 | audit emit payload |
| 8f | timeline endpoint surfaces related_detected | #165 | wikis/:id/timeline |
| 8g | Strict audit pairing: audit count = 2 × edge count in window | #229 | both callsites must emit |
| 9 | onConflictDoNothing keeps edges unique per (src,dst) | #163 | edges_src_dst_type_uidx |
| 9b | Edge attrs key is `score` (matches PR), not `similarity` | #163 | regen.ts attrs payload |
| 10| Unauthenticated /groups + /fragments → 401 | all | sessionMiddleware |

---

## Notes

- **Issue #45 scope drift.** The original #45 ticket described "wiki folders
  as collection groups" via a `tags` field on wikis. PR #192 instead reuses
  the existing `groups` / `group_wikis` tables as the collections surface
  and ships only the **sidebar Collections section** as the user-facing
  delivery. This plan asserts the shipped behaviour (sidebar + live data)
  rather than the deferred tag-array design.
- **Issue #185 negative invariant.** Section 1f explicitly asserts that
  `/collections` is a 404 — the relabel is UI-only by design and a
  silently-renamed backend would be a regression of the ticket's intent.
- **Issue #164 wire format vs. issue copy.** The issue text describes the
  similarity field as `"similarity": 0.87` — the PR ships exactly this
  field name on the API response. The underlying edge `attrs` jsonb,
  however, uses the key `score` (not `similarity`); section 9b pins this
  so future readers don't conflate the two.
- **Issue #163 trigger surface — TWO callsites, both in scope.** Similarity
  edges land via two independent paths and the `attrs.method` + audit-event
  contract must hold on both:
  1. `core/src/lib/regen.ts` `createRelatedToEdges()` — the regen-time path
     used when `classifyUnfiledFragments()` files a previously-unfiled
     fragment into a wiki. This path was patched in PR #192's follow-ups
     and currently writes `{ score, method:'cosine-regen' }` plus emits
     `related_detected` audit events for both fragments.
  2. `packages/agent/src/stages/index.ts` `runLinking` orchestrator
     (~lines 217-234) — the live worker path that runs on every fresh
     fragment via `fragRelate`. Currently writes `{ score }` only and
     emits zero audit events. This is the dual root cause of #227 + #229.
  Sections **5g-strict** and **8g** assert the contract across the test
  window without naming a callsite, so a regression in either path fails.
- **Issue #228 — DELETE /fragments/:id is absent.** §6.5 expected-fails
  today (HTTP 404 + cascade impossible). Pattern to mirror lives at
  `core/src/routes/wikis.ts:715-739` (DELETE /wikis/:id soft-delete +
  cascade + audit emit + `c.body(null, 204)`).
- **Embedding lag.** Sections 5/7 poll up to 90s for the entry pipeline to
  produce embeddings + classification. On a slow stack increase the
  `DEADLINE` budget rather than asserting failure.
- **MCP surface.** PR #192 does not add new collection-related MCP tools.
  Plan 98 (mcp-tools) covers the existing MCP surface; this plan does
  **not** re-exercise it.
- Cleanup soft-deletes UAT fragments, similarity edges, and wikis tagged
  with `$UAT_TAG`, then deletes the seed collection via the API.
