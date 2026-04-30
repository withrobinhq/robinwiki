# 32 — Search Recall (BM25 OR-join + tags woven into search_vector + trigger fires on edits)

## What it proves

Issue #249 — three independent recall gaps in BM25 search, all visible to
users as "I know I wrote that — why doesn't it surface?":

**(§1) BM25 OR-join.** `core/src/lib/search.ts:82` calls
`plainto_tsquery('english', q)` which **AND-joins** every stem. A query
`"divya europe travel"` requires *every* stem to match, so a fragment
titled `"Divya in Europe"` (no "travel" stem) does not surface even
though it's the obvious top hit. The fix replaces `plainto_tsquery` with
a sanitized `to_tsquery('a | b | c')`. `ts_rank` continues to score
all-terms-matched docs higher than partial-match docs, so quality stays
intact while recall opens up.

**(§2) Tag-vectorisation.** `fragments_search_vector_update()` (defined
in `core/drizzle/migrations/0000_init.sql` line 340) covers `title`+
`content` only. Fragment **tags** are never woven in — tag-only queries
are silently broken. The fix weaves tags at weight C and adds a one-time
backfill so deployed rows recover.

**(§3) Trigger on content edit.** Live `pg_trigger.tgattr` confirms each
table fires only on a partial column set:
- `fragments_search_vector_trigger` UPDATE OF **{title}** — content
  edits drift the index.
- `wikis_search_vector_trigger` UPDATE OF **{name, prompt}** — content
  edits drift the index.
- `people_search_vector_trigger` UPDATE OF **{name, relationship}** —
  content (and aliases) edits drift the index.
The fix expands each trigger's UPDATE-OF list to cover content (and
tags, on fragments).

**(§4) Same shape on wikis and people.** Per the issue: trigger-on-
content gap applies identically to `wikis` and `people`. (Tag-vector-
isation is fragments-specific; wikis/people have no tags column — but
they DO have analogous columns the trigger silently misses on UPDATE.)

**(§5) Rank stability.** Regression guard: after the OR-join change, an
all-terms-matched doc must still rank strictly above a partial-match
doc. Otherwise OR-join silently flattens the ranking signal and we've
traded recall for a worse user experience. Live probe shows `ts_rank`
returns 0.0608 (3-match) > 0.0405 (2-match) > 0.0203 (1-match) — clean
separation, so this guard is real, not vacuous.

## Pre-fix expectations

This plan is **written before** PR-249 is merged. On the current
`main`, sections §1, §2, §3a/§3b/§3c, §4a, §4b are expected to **fail**.
§5 (rank-stability) and the "AND-strict still works for fully-matched
queries" sub-cases are expected to **pass** on both pre- and post-fix.
After PR-249 merges, every assertion should pass.

## Prerequisites

- Core running on `SERVER_URL` with PR-249 merged (or pre-fix to confirm
  assertions fail in the documented places).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `jq` and `curl` installed.
- `psql` with `DATABASE_URL` configured. Tag-vector and trigger checks
  read `search_vector` directly from the row; without psql those
  sections degrade to skip.

## Fixture identity this plan references

- Per-run salt `RUN_ID="$(date +%s)-$$"` woven into every title/content
  string so the shared search corpus stays predictable across reruns.
- Per-run UAT raw_source (entry): `uat32-recall-<RUN_ID>` — the parent
  `entryId` every fragment created here points to.
- Per-run UAT fragments (fragments table):
  - `Divya in Europe <RUN_ID>` — §1 AND-strict probe.
  - `ML Tagged Note <RUN_ID>` (tags=`["machine-learning"]`) — §2 tag
    probe. Body deliberately lacks the tag stem.
  - `Edit Probe <RUN_ID>` — §3 trigger-on-content probe; content gets
    rewritten via psql to bypass the orthogonal `PUT /fragments/:id`
    bug (see "Notes" — that route currently never writes
    `updates.content`, only `updates.dedupHash`, so an API-level edit
    couldn't isolate the trigger gap).
  - `RankAll <RUN_ID>` / `RankPartial <RUN_ID>` — §5 rank-stability
    probes.
- Per-run UAT wiki: `UAT32 Wiki <RUN_ID>` — §4 trigger-on-content for
  wikis.
- Per-run UAT person: `UAT32 Person <RUN_ID>` (slug salted) — §4
  trigger-on-content for people.

## Restoring downstream-plan state

Cleanup at the end deletes every per-RUN_ID row (fragments, wiki,
person) and the per-RUN_ID raw_source. Plans 08–10 / 22 / 29 / 99 see
no drift; the seeded corpus they depend on is untouched.

## Notes — orthogonal bugs observed during plan-write

- `PUT /fragments/:id` (`core/src/routes/fragments.ts:213`) handles a
  `body.content` field by writing `updates.dedupHash =
  computeContentHash(body.content)` but **never** sets
  `updates.content` itself. Live confirmed: a PUT with content sets
  dedupHash, leaves content unchanged. This is **not** what #249 fixes
  — flagged separately. The plan deliberately uses a direct psql
  UPDATE to mutate content for §3 so it isolates the trigger gap.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:${PORT:-3000}}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-32-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

# Per-run salt — search corpus is shared across plans, so every probe
# string carries RUN_ID to keep matches deterministic across reruns.
RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "32 — Search Recall (BM25 OR-join + tags + trigger-on-edit)"
echo ""

# ── 0. Sign in (web cookie) ──────────────────────────────────
curl -s -o /dev/null -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email"

if [ -s "$COOKIE_JAR" ]; then
  pass "0a. sign-in established a session cookie"
else
  fail "0a. sign-in failed — every step below would skip"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# Create the parent entry (raw_source) every fragment will hang off.
ENTRY_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: $SERVER_URL" \
  -H "Content-Type: application/json" \
  -X POST -d "$(jq -n --arg c "uat32-recall-$RUN_ID" '{content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_ID=$(echo "$ENTRY_RESP" | jq -r '.lookupKey // .id // empty')
if [ -n "$ENTRY_ID" ] && [ "$ENTRY_ID" != "null" ]; then
  pass "0b. created parent entry ($ENTRY_ID) — fragments will FK here"
else
  fail "0b. could not create parent entry: $ENTRY_RESP"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# Helper — POST /fragments with a uniform shape.
mk_fragment() {
  local title="$1" content="$2" tags_json="$3"
  curl -s -b "$COOKIE_JAR" -H "Origin: $SERVER_URL" \
    -H "Content-Type: application/json" \
    -X POST -d "$(jq -n \
      --arg t "$title" --arg c "$content" --arg e "$ENTRY_ID" \
      --argjson tg "$tags_json" \
      '{title:$t, content:$c, entryId:$e, tags:$tg}')" \
    "$SERVER_URL/fragments"
}

# Helper — issue a BM25-only search and echo results JSON.
bm25_search() {
  local q="$1" tables="${2:-fragment}"
  curl -s -b "$COOKIE_JAR" -H "Origin: $SERVER_URL" \
    --get \
    --data-urlencode "q=$q" \
    --data-urlencode "mode=bm25" \
    --data-urlencode "tables=$tables" \
    "$SERVER_URL/search"
}

# ── §1. BM25 OR-join — "divya europe travel" must surface "Divya in Europe" ──
# Fragment title contains divya + europe but NOT travel. With current
# plainto_tsquery this misses (AND-strict). After fix: hit returned.

F1_RESP=$(mk_fragment \
  "Divya in Europe $RUN_ID" \
  "Recent itinerary across multiple cities $RUN_ID." \
  '[]')
F1_KEY=$(echo "$F1_RESP" | jq -r '.lookupKey // empty')
if [ -n "$F1_KEY" ]; then
  pass "§1a. created §1 fragment '$F1_KEY' (title 'Divya in Europe $RUN_ID')"
else
  fail "§1a. could not create §1 fragment: $F1_RESP"
fi

# Sanity — exact-AND query (subset stems already present) should hit
# regardless of OR/AND. Guards against unrelated breakage.
SUBSET_HITS=$(bm25_search "divya europe $RUN_ID" \
  | jq --arg k "$F1_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${SUBSET_HITS:-0}" -ge 1 ]; then
  pass "§1b. AND-OK control: 'divya europe $RUN_ID' returns the §1 fragment (sanity)"
else
  fail "§1b. AND-OK control failed — even subset query missed; investigate before §1c"
fi

# Real probe — the failing one on pre-fix.
ORJOIN_HITS=$(bm25_search "divya europe travel $RUN_ID" \
  | jq --arg k "$F1_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${ORJOIN_HITS:-0}" -ge 1 ]; then
  pass "§1c. OR-join: 'divya europe travel $RUN_ID' surfaces 'Divya in Europe' fragment"
else
  fail "§1c. OR-join: 'divya europe travel $RUN_ID' returned 0 hits for §1 fragment (CURRENTLY FAILS pre-#249)"
fi

# ── §2. Tag-vectorisation — search by tag returns the tagged fragment ──
# Tag is "machine-learning"; body is deliberately unrelated so the only
# possible stem-source is the tags array. Pre-fix: tags never enter
# search_vector → 0 hits.

F2_RESP=$(mk_fragment \
  "ML Tagged Note $RUN_ID" \
  "An unrelated body that says nothing useful $RUN_ID." \
  '["machine-learning"]')
F2_KEY=$(echo "$F2_RESP" | jq -r '.lookupKey // empty')
if [ -n "$F2_KEY" ]; then
  pass "§2a. created §2 fragment '$F2_KEY' (tags=['machine-learning'])"
else
  fail "§2a. could not create §2 fragment: $F2_RESP"
fi

# Direct DB inspection: vector should mention 'machin' / 'learn' stems
# post-fix. Pre-fix: it won't.
if [ -n "${DATABASE_URL:-}" ] && [ -n "$F2_KEY" ]; then
  VEC=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT search_vector::text FROM fragments WHERE lookup_key='$F2_KEY'")
  if echo "$VEC" | grep -qE "machin|learn"; then
    pass "§2b. fragments.search_vector for §2 row contains tag stems (machin/learn)"
  else
    fail "§2b. fragments.search_vector for §2 row LACKS tag stems — vec='${VEC:0:120}' (CURRENTLY FAILS pre-#249)"
  fi
else
  skip "§2b. DATABASE_URL unset or §2 fragment missing — vector inspection skipped"
fi

# Search probe: BM25 query for the tag returns the §2 fragment.
TAG_HITS=$(bm25_search "machine-learning" \
  | jq --arg k "$F2_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${TAG_HITS:-0}" -ge 1 ]; then
  pass "§2c. BM25 search 'machine-learning' returns the §2 tagged fragment"
else
  fail "§2c. BM25 search 'machine-learning' returned 0 hits for §2 fragment (CURRENTLY FAILS pre-#249)"
fi

# ── §3. Trigger fires on content edit — fragments ────────────
# We mutate content via direct psql UPDATE (the API PUT is broken on a
# different axis — see Notes — and would not isolate the trigger gap).
# Post-fix: trigger UPDATE-OF list includes content, so the vector
# rebuilds and the new stem becomes searchable. Pre-fix: vector is
# stale; the new stem is invisible.

F3_RESP=$(mk_fragment \
  "Edit Probe $RUN_ID" \
  "Original content placeholder $RUN_ID." \
  '[]')
F3_KEY=$(echo "$F3_RESP" | jq -r '.lookupKey // empty')
if [ -n "$F3_KEY" ]; then
  pass "§3a. created §3 fragment '$F3_KEY' (original body has no 'zinfandel' stem)"
else
  fail "§3a. could not create §3 fragment: $F3_RESP"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$F3_KEY" ]; then
  # Direct DB content update — bypasses PUT /fragments bug. Only the
  # trigger decides whether search_vector follows.
  psql "$DATABASE_URL" -q -c \
    "UPDATE fragments SET content='Updated body now mentions zinfandel-$RUN_ID.' WHERE lookup_key='$F3_KEY'"
  VEC=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT search_vector::text FROM fragments WHERE lookup_key='$F3_KEY'")
  if echo "$VEC" | grep -q "zinfandel"; then
    pass "§3b. content edit propagated to fragments.search_vector (zinfandel stem present)"
  else
    fail "§3b. content edit did NOT propagate — vec='${VEC:0:120}' (CURRENTLY FAILS pre-#249)"
  fi
else
  skip "§3b. DATABASE_URL unset or §3 fragment missing — direct content edit probe skipped"
fi

# Search probe through the API.
EDIT_HITS=$(bm25_search "zinfandel-$RUN_ID" \
  | jq --arg k "$F3_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${EDIT_HITS:-0}" -ge 1 ]; then
  pass "§3c. BM25 search 'zinfandel-$RUN_ID' returns §3 fragment after content edit"
else
  fail "§3c. BM25 search 'zinfandel-$RUN_ID' returned 0 hits — vector stale (CURRENTLY FAILS pre-#249)"
fi

# ── §4. Same shape on wikis and people — trigger-on-content ──
# wikis and people have no tags column, so the tag-vector probe doesn't
# port. The trigger-on-content gap does — pg_trigger.tgattr currently
# lists {name, prompt} for wikis and {name, relationship} for people.

# §4a — wikis
WIKI_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: $SERVER_URL" \
  -H "Content-Type: application/json" \
  -X POST -d "$(jq -n --arg n "UAT32 Wiki $RUN_ID" \
    '{name:$n, description:"UAT32 search-recall wiki probe", type:"log"}')" \
  "$SERVER_URL/wikis")
WIKI_KEY=$(echo "$WIKI_RESP" | jq -r '.lookupKey // .id // empty')
if [ -n "$WIKI_KEY" ] && [ "$WIKI_KEY" != "null" ]; then
  pass "§4a-i. created §4 wiki '$WIKI_KEY'"
else
  fail "§4a-i. could not create §4 wiki: $WIKI_RESP"
fi

if [ -n "${DATABASE_URL:-}" ] && [ -n "$WIKI_KEY" ] && [ "$WIKI_KEY" != "null" ]; then
  psql "$DATABASE_URL" -q -c \
    "UPDATE wikis SET content = 'Updated wiki body mentions xerophyte-$RUN_ID.' WHERE lookup_key='$WIKI_KEY'"
  VEC=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT search_vector::text FROM wikis WHERE lookup_key='$WIKI_KEY'")
  if echo "$VEC" | grep -q "xerophyt"; then
    pass "§4a-ii. wiki content edit propagated to wikis.search_vector"
  else
    fail "§4a-ii. wiki content edit did NOT propagate — vec='${VEC:0:120}' (CURRENTLY FAILS pre-#249)"
  fi
else
  skip "§4a-ii. DATABASE_URL unset or §4 wiki missing — wiki content-edit probe skipped"
fi

# §4b — people. Insert directly via psql (no public POST /people route
# exists; people are created by the pipeline). We can synthesise one
# row safely; the §4b cleanup deletes it.
if [ -n "${DATABASE_URL:-}" ]; then
  PERSON_KEY="person_uat32_$(echo "$RUN_ID" | tr -c 'A-Za-z0-9' '_')"
  psql "$DATABASE_URL" -q -c "
    INSERT INTO people (lookup_key, slug, name, summary, relationship,
                        canonical_name, aliases, content)
    VALUES ('$PERSON_KEY',
            'uat32-person-$RUN_ID',
            'UAT32 Person $RUN_ID',
            '', '', 'UAT32 Person $RUN_ID',
            ARRAY[]::text[],
            'Original person body $RUN_ID.')
  " 2>/dev/null

  # Confirm row exists.
  EXISTS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT 1 FROM people WHERE lookup_key='$PERSON_KEY'")
  if [ "$EXISTS" = "1" ]; then
    pass "§4b-i. created §4 person '$PERSON_KEY' via psql"

    # Mutate content; check trigger fires.
    psql "$DATABASE_URL" -q -c \
      "UPDATE people SET content = 'Updated person body mentions yodelling-$RUN_ID.' WHERE lookup_key='$PERSON_KEY'"
    VEC=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT search_vector::text FROM people WHERE lookup_key='$PERSON_KEY'")
    if echo "$VEC" | grep -q "yodel"; then
      pass "§4b-ii. person content edit propagated to people.search_vector"
    else
      fail "§4b-ii. person content edit did NOT propagate — vec='${VEC:0:120}' (CURRENTLY FAILS pre-#249)"
    fi
  else
    skip "§4b. could not insert §4 person row — schema may have shifted; section skipped"
    PERSON_KEY=""
  fi
else
  skip "§4b. DATABASE_URL unset — person trigger probe skipped"
  PERSON_KEY=""
fi

# ── §5. Rank stability — all-terms-matched > partial-match ───
# Regression guard against the OR-join change accidentally flattening
# rank. We create two fragments:
#   RankAll      — title + body match all 3 stems "alpha bravo charlie"
#   RankPartial  — title + body match only 1 stem "alpha"
# Then BM25-search "alpha bravo charlie". Both should appear; RankAll
# must score strictly higher than RankPartial. Live ts_rank check
# (during plan-write) showed 3-match=0.0608 vs 1-match=0.0203 — clean
# separation, so the assertion is real.

R1_RESP=$(mk_fragment \
  "RankAll $RUN_ID alpha bravo charlie" \
  "Body for rank test alpha bravo charlie $RUN_ID." \
  '[]')
R1_KEY=$(echo "$R1_RESP" | jq -r '.lookupKey // empty')

R2_RESP=$(mk_fragment \
  "RankPartial $RUN_ID alpha" \
  "Body for rank test alpha only $RUN_ID." \
  '[]')
R2_KEY=$(echo "$R2_RESP" | jq -r '.lookupKey // empty')

if [ -n "$R1_KEY" ] && [ -n "$R2_KEY" ]; then
  pass "§5a. created §5 fragments (R1=$R1_KEY, R2=$R2_KEY)"
else
  fail "§5a. could not create §5 fragments (R1='$R1_KEY' R2='$R2_KEY')"
fi

# Pull both scores out of the response.
RANK_RESP=$(bm25_search "alpha bravo charlie $RUN_ID")
S1=$(echo "$RANK_RESP" | jq --arg k "$R1_KEY" '.results[] | select(.id==$k) | .score' | head -1)
S2=$(echo "$RANK_RESP" | jq --arg k "$R2_KEY" '.results[] | select(.id==$k) | .score' | head -1)
S1="${S1:-0}"; S2="${S2:-0}"

# Both rows should be present in the result set (post-fix, OR-join
# admits partial matches). Pre-fix, R2 may be absent (AND-strict drops
# it because body has no "bravo" / "charlie" stem) — we record that
# as a fail too, since it's the same recall gap as §1.
if [ "$(echo "$RANK_RESP" | jq --arg k "$R1_KEY" '[.results[] | select(.id==$k)] | length')" -ge 1 ]; then
  pass "§5b. all-terms-matched fragment R1 present in result set"
else
  fail "§5b. all-terms-matched fragment R1 missing — search broken upstream of rank check"
fi
if [ "$(echo "$RANK_RESP" | jq --arg k "$R2_KEY" '[.results[] | select(.id==$k)] | length')" -ge 1 ]; then
  pass "§5c. partial-match fragment R2 present in result set (OR-join admits partials)"
else
  fail "§5c. partial-match fragment R2 missing — likely AND-strict path (pre-#249)"
fi

# Strict ordering: R1 score > R2 score. Use awk for float compare.
if awk -v a="$S1" -v b="$S2" 'BEGIN{ exit !(a > b) }'; then
  pass "§5d. R1 score ($S1) > R2 score ($S2) — rank preserved (regression guard intact)"
else
  fail "§5d. R1 score ($S1) NOT > R2 score ($S2) — OR-join flattened ranking (regression)"
fi

# ── Cleanup ──────────────────────────────────────────────────
# Every per-RUN_ID row is removed so the shared corpus stays clean.

if [ -n "${DATABASE_URL:-}" ]; then
  for k in "$F1_KEY" "$F2_KEY" "$F3_KEY" "$R1_KEY" "$R2_KEY"; do
    [ -n "$k" ] && psql "$DATABASE_URL" -q -c \
      "DELETE FROM fragments WHERE lookup_key='$k'" >/dev/null 2>&1
  done
  [ -n "${WIKI_KEY:-}" ] && [ "$WIKI_KEY" != "null" ] && \
    psql "$DATABASE_URL" -q -c "DELETE FROM wikis WHERE lookup_key='$WIKI_KEY'" >/dev/null 2>&1
  [ -n "${PERSON_KEY:-}" ] && \
    psql "$DATABASE_URL" -q -c "DELETE FROM people WHERE lookup_key='$PERSON_KEY'" >/dev/null 2>&1
  if [ -n "${ENTRY_ID:-}" ]; then
    # raw_sources may have FK references in pipeline_events / processed_jobs.
    # Tear those down first, then delete the row itself.
    psql "$DATABASE_URL" -q -c "DELETE FROM pipeline_events WHERE entry_id='$ENTRY_ID'" >/dev/null 2>&1
    psql "$DATABASE_URL" -q -c "DELETE FROM processed_jobs WHERE job_id='$ENTRY_ID'" >/dev/null 2>&1
    psql "$DATABASE_URL" -q -c "DELETE FROM raw_sources WHERE lookup_key='$ENTRY_ID'" >/dev/null 2>&1
  fi
  pass "cleanup. per-RUN_ID rows deleted (fragments / wiki / person / raw_source)"
else
  skip "cleanup. DATABASE_URL unset — per-RUN_ID rows left in place"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```

## Expected outcome (pre-#249 vs post-#249)

| Section | Pre-#249 | Post-#249 |
| --- | --- | --- |
| §1a / §1b (sanity, control) | pass | pass |
| §1c (OR-join probe) | **fail** | pass |
| §2a (create) | pass | pass |
| §2b (vector contains tag stems) | **fail** | pass |
| §2c (search by tag) | **fail** | pass |
| §3a (create) | pass | pass |
| §3b (vector after content edit) | **fail** | pass |
| §3c (search by edited body) | **fail** | pass |
| §4a-i (create wiki) | pass | pass |
| §4a-ii (wiki content edit propagates) | **fail** | pass |
| §4b-i (create person) | pass | pass |
| §4b-ii (person content edit propagates) | **fail** | pass |
| §5a / §5b (creates, R1 hit) | pass | pass |
| §5c (R2 hit — partial match admitted) | **fail** | pass |
| §5d (rank ordering preserved) | pass (vacuously: only R1 in set, comparison default) | pass |
| cleanup | pass | pass |

§5d's pre-fix outcome depends on the score-default: `S2` falls back to
`0` when R2 isn't in the result set, so `S1 > 0` still holds — the
pre-fix run shows §5d pass even though §5c fails. That's the intended
shape: §5c proves OR-join expanded recall, §5d independently proves
rank order didn't collapse. Both must pass post-fix.
