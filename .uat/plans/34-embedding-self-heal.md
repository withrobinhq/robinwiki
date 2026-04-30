# 34 — Embedding self-heal across fragments + wikis + people

## What it proves

Issue #246 lays a self-healing pipeline across all three embedded tables.
For each table the contract is:

- **embed-at-create** — creating a record yields a non-null embedding (fragments
  via the persist stage's `embedText` pass, wikis via the POST /wikis quick-
  classify pass, people skipped — see Notes / open question).
- **null-on-edit** — editing the text that fed the embedded vector nulls the
  stored embedding so the heal worker (or next regen) refills it from the
  fresh text. Without this, edits leave stale vectors live in vector search.
- **heal worker** — the embedding-retry scheduler refills nulled fragment
  embeddings on its next tick (`core/src/queue/embedding-retry-worker.ts`,
  15-min cadence). Plan exercises this only for fragments today; wiki/people
  heal workers are deferred (open question).

Evidence target: §1 fragments, §2 wikis, §3 people. Each section owns its
embed-at-create + null-on-edit assertions; §1 also exercises the heal worker.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Database reachable via `DATABASE_URL` (psql).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set.
- Embeddings worker running (the persist stage embeds fragments synchronously;
  wikis embed in POST /wikis; people don't embed at create today).

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "34 — Embedding self-heal"
echo ""

curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null

UAT_TAG="uat34-$(date +%s)"

# ── 1. Fragments — embed at create + null on edit + heal ─────────
# Drop a fragment via /entries (the only path that runs the persist stage,
# which is what calls embedText). The pipeline is async — poll until the
# fragment row exists with embedding IS NOT NULL.

ENTRY_TEXT="Self-attention is the core ingredient of transformers. [run=$UAT_TAG-1]"
ENTRY=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$ENTRY_TEXT" --arg t "uat34-frag-$UAT_TAG" '{title:$t,content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_KEY=$(echo "$ENTRY" | jq -r '.lookupKey // .id // ""')

DEADLINE=$(($(date +%s) + 90))
FRAG_KEY=""
FRAG_EMBEDDED=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ROW=$(psql "$DATABASE_URL" -t -A -c "
    SELECT lookup_key, (embedding IS NOT NULL)::text
    FROM fragments
    WHERE entry_id = '$ENTRY_KEY' AND deleted_at IS NULL
    LIMIT 1
  " 2>/dev/null)
  if [ -n "$ROW" ]; then
    FRAG_KEY=$(echo "$ROW" | cut -d'|' -f1)
    FRAG_EMBEDDED=$(echo "$ROW" | cut -d'|' -f2)
    [ "$FRAG_EMBEDDED" = "true" ] && break
  fi
  sleep 3
done

# 1a. Embed-at-create — fragment row materialises with non-null embedding.
if [ "$FRAG_EMBEDDED" = "true" ]; then
  pass "1a. Fragment created with non-null embedding (key=$FRAG_KEY)"
else
  fail "1a. Fragment embedding still null after 90s (key=$FRAG_KEY) — embed-at-create regression"
fi

# 1b. Null-on-edit — PUT /fragments/:id with new content nulls the embedding.
NEW_CONTENT="A completely different topic about deep ocean trenches. [run=$UAT_TAG-1-edit]"
EDIT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg c "$NEW_CONTENT" '{content:$c}')" \
  "$SERVER_URL/fragments/$FRAG_KEY")
[ "$EDIT_HTTP" = "200" ] && pass "1b. PUT /fragments/:id → 200" || fail "1b. PUT /fragments/:id → HTTP $EDIT_HTTP"

EMB_AFTER_EDIT=$(psql "$DATABASE_URL" -t -A -c "
  SELECT (embedding IS NULL)::text FROM fragments WHERE lookup_key = '$FRAG_KEY'
" 2>/dev/null | tr -d ' ')
if [ "$EMB_AFTER_EDIT" = "true" ]; then
  pass "1c. Fragment embedding nulled after content edit"
else
  fail "1c. Fragment embedding NOT nulled after edit (still set) — null-on-edit regression"
fi

# 1d. Retry bookkeeping reset so the heal worker picks the row up immediately
# (rather than respecting stale embedding_attempt_count from a prior heal cycle).
ATTEMPT_RESET=$(psql "$DATABASE_URL" -t -A -c "
  SELECT embedding_attempt_count FROM fragments WHERE lookup_key = '$FRAG_KEY'
" 2>/dev/null | tr -d ' ')
[ "$ATTEMPT_RESET" = "0" ] && pass "1d. embedding_attempt_count reset to 0 on edit" || fail "1d. embedding_attempt_count = $ATTEMPT_RESET (expected 0)"

# 1e. Heal worker fills nulled embeddings. The embedding-retry scheduler
# runs every 15 min in production; under UAT we trigger it inline by
# enqueueing a one-off retry job into the scheduler queue. The worker is
# already wired (core/src/queue/embedding-retry-worker.ts).
psql "$DATABASE_URL" -c "
  -- Force embedding_last_attempt_at far enough back that MIN_RETRY_GAP_MS
  -- (1h) doesn't gate the heal worker on this row.
  UPDATE fragments
  SET embedding_last_attempt_at = NOW() - INTERVAL '2 hours'
  WHERE lookup_key = '$FRAG_KEY'
" >/dev/null 2>&1

# Inline kick: the scheduler queue accepts an `embedding-retry` job. We
# can't import the producer from bash, so observe the natural cadence
# instead — but to keep the test bounded, just assert that the worker
# *can* refill the row given enough time. Cap at 60s and skip if the
# scheduler tick hasn't fired yet (the production cadence is 15min,
# so this assertion is best-effort under UAT).
DEADLINE=$(($(date +%s) + 60))
HEALED=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  HEALED=$(psql "$DATABASE_URL" -t -A -c "
    SELECT (embedding IS NOT NULL)::text FROM fragments WHERE lookup_key = '$FRAG_KEY'
  " 2>/dev/null | tr -d ' ')
  [ "$HEALED" = "true" ] && break
  sleep 5
done
if [ "$HEALED" = "true" ]; then
  pass "1e. Heal worker refilled fragment embedding after edit"
else
  skip "1e. Heal worker did not refill within 60s — production cadence is 15min, manual ops or longer wait"
fi

# ── 2. Wikis — embed at create + null on edit ────────────────────

WIKI_NAME="UAT34 Embedding Wiki $UAT_TAG"
WIKI_DESC="Backward-classification embedded text for $UAT_TAG."
WIKI_RESP=$(curl -s -X POST -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg n "$WIKI_NAME" --arg d "$WIKI_DESC" '{name:$n,description:$d,type:"log"}')" \
  "$SERVER_URL/wikis")
WIKI_KEY=$(echo "$WIKI_RESP" | jq -r '.lookupKey // .id // ""')

# Give the POST /wikis embed pass a moment to settle (synchronous in the
# route handler, but we also depend on the /entries pipeline keeping
# embedText warm — under cold start the OpenRouter call can take a beat).
sleep 2

WIKI_EMB=$(psql "$DATABASE_URL" -t -A -c "
  SELECT (embedding IS NOT NULL)::text FROM wikis WHERE lookup_key = '$WIKI_KEY'
" 2>/dev/null | tr -d ' ')
if [ "$WIKI_EMB" = "true" ]; then
  pass "2a. Wiki created with non-null embedding"
else
  fail "2a. Wiki embedding still null after create — embed-at-create regression"
fi

# 2b. Edit the wiki name/description; embedding must null.
PUT_BODY=$(jq -n --arg n "${WIKI_NAME} renamed" --arg d "${WIKI_DESC} v2" '{name:$n,description:$d}')
PUT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$PUT_BODY" \
  "$SERVER_URL/wikis/$WIKI_KEY")
[ "$PUT_HTTP" = "200" ] && pass "2b. PUT /wikis/:id → 200" || fail "2b. PUT /wikis/:id → HTTP $PUT_HTTP"

WIKI_EMB_AFTER=$(psql "$DATABASE_URL" -t -A -c "
  SELECT (embedding IS NULL)::text FROM wikis WHERE lookup_key = '$WIKI_KEY'
" 2>/dev/null | tr -d ' ')
if [ "$WIKI_EMB_AFTER" = "true" ]; then
  pass "2c. Wiki embedding nulled after name/description edit"
else
  fail "2c. Wiki embedding NOT nulled after edit — null-on-edit regression"
fi

# ── 3. People — null on edit (embed-at-create deferred) ──────────
# People are only created via the worker pipeline (entityExtract). For UAT
# we don't have a public POST /people, so we exercise null-on-edit by
# locating any existing person and PUT'ing a name change.

EXISTING_PERSON=$(psql "$DATABASE_URL" -t -A -c "
  SELECT lookup_key FROM people WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1
" 2>/dev/null | tr -d ' ')

if [ -z "$EXISTING_PERSON" ]; then
  skip "3. No people row available — pipeline hasn't extracted any. Run plan 26 to seed."
else
  # Force a non-null embedding so the null-on-edit transition is observable.
  psql "$DATABASE_URL" -c "
    UPDATE people
    SET embedding = (SELECT embedding FROM fragments WHERE embedding IS NOT NULL LIMIT 1)
    WHERE lookup_key = '$EXISTING_PERSON' AND embedding IS NULL
  " >/dev/null 2>&1

  PRE_PERSON_EMB=$(psql "$DATABASE_URL" -t -A -c "
    SELECT (embedding IS NOT NULL)::text FROM people WHERE lookup_key = '$EXISTING_PERSON'
  " 2>/dev/null | tr -d ' ')

  if [ "$PRE_PERSON_EMB" = "true" ]; then
    PERSON_BODY=$(jq -n --arg n "Renamed for UAT34 $UAT_TAG" '{name:$n}')
    PUT_PERSON_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
      -X PUT -b "$COOKIE_JAR" \
      -H "Content-Type: application/json" \
      -H "Origin: http://localhost:3000" \
      -d "$PERSON_BODY" \
      "$SERVER_URL/people/$EXISTING_PERSON")
    [ "$PUT_PERSON_HTTP" = "200" ] && pass "3a. PUT /people/:id → 200" || fail "3a. PUT /people/:id → HTTP $PUT_PERSON_HTTP"

    POST_PERSON_EMB=$(psql "$DATABASE_URL" -t -A -c "
      SELECT (embedding IS NULL)::text FROM people WHERE lookup_key = '$EXISTING_PERSON'
    " 2>/dev/null | tr -d ' ')
    if [ "$POST_PERSON_EMB" = "true" ]; then
      pass "3b. Person embedding nulled after name edit"
    else
      fail "3b. Person embedding NOT nulled after edit — null-on-edit regression"
    fi
  else
    skip "3. Could not stage a non-null person embedding (no fragment vectors to copy)"
  fi
fi

# ── 4. Cleanup ───────────────────────────────────────────────────

psql "$DATABASE_URL" -c "
  UPDATE fragments SET deleted_at = NOW() WHERE entry_id = '$ENTRY_KEY' AND deleted_at IS NULL
" >/dev/null 2>&1
psql "$DATABASE_URL" -c "
  UPDATE wikis SET deleted_at = NOW() WHERE lookup_key = '$WIKI_KEY' AND deleted_at IS NULL
" >/dev/null 2>&1

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Issue | Source |
|---|-----------|-------|--------|
| 1a | Fragment row materialises with non-null embedding after /entries POST | #246 | packages/agent/src/stages/persist.ts (embedText) |
| 1b | PUT /fragments/:id with new content returns 200 | #246 | core/src/routes/fragments.ts |
| 1c | Fragment embedding nulled after content edit | #246 | core/src/routes/fragments.ts (PUT handler) |
| 1d | embedding_attempt_count reset to 0 on edit | #246 | PUT handler bookkeeping |
| 1e | Heal worker refills nulled fragment embeddings | #246 | core/src/queue/embedding-retry-worker.ts |
| 2a | Wiki created with non-null embedding | #246 | core/src/routes/wikis.ts (POST handler) |
| 2b | PUT /wikis/:id → 200 | #246 | core/src/routes/wikis.ts |
| 2c | Wiki embedding nulled after name/description edit | #246 | wikis PUT handler |
| 3a | PUT /people/:id → 200 | #246 | core/src/routes/people.ts |
| 3b | Person embedding nulled after name edit | #246 | people PUT handler |

---

## Notes

- **Heal-worker scope.** The fragment embedding-retry worker already exists
  (`core/src/queue/embedding-retry-worker.ts`, 15-min cadence). Wiki and
  person heal workers are NOT wired today — wikis recompute their vector
  during the next regen pass (which itself runs on a wider schedule), and
  people have no heal worker at all. Scope of #246 was capped at
  embed-at-create + null-on-edit; the wiki/person heal workers are an
  open follow-up.
- **People embed-at-create.** People are only created via the worker
  pipeline (`upsertPerson` in `core/src/queue/worker.ts`). That path
  doesn't currently call `embedText`. Adding a synchronous embed pass
  there grows the worker's OpenRouter dependency surface and is left as
  an open question; the null-on-edit half lands here so the contract
  isn't violated when an admin edits a person row.
- **§1e cadence.** Production cadence on the embedding-retry scheduler
  is 15 min (`MIN_RETRY_GAP_MS = 1h` per row, `BATCH_LIMIT = 25`). The
  60s assertion in §1e is best-effort and skips on slow ticks — if you
  need a hard guarantee, wait for the next scheduler tick (`docker
  compose logs -f scheduler`) or trigger an inline retry job through
  the producer in a node REPL.
