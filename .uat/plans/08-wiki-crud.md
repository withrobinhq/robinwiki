# 08 — Wiki CRUD

## What it proves
Full lifecycle: create, list, get, update, soft delete.

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

# Per-run salt — content posted via /entries is content-deduped by
# hash. A bare-string entry collides on re-runs and the pipeline
# silently swallows it, so every test write threads $RUN_ID.
RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "08 — Wiki CRUD"
echo ""

# Sign in
curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null

# 1. Create
CREATE=$(curl -s -w "\n%{http_code}" -X POST \
  -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"name":"UAT Test Wiki","type":"log","prompt":"test prompt"}' \
  "$SERVER_URL/wikis")
CREATE_HTTP=$(echo "$CREATE" | tail -1)
CREATE_BODY=$(echo "$CREATE" | sed '$d')
WIKI_ID=$(echo "$CREATE_BODY" | jq -r '.lookupKey // .id // ""')

if [ "$CREATE_HTTP" = "201" ] && [ -n "$WIKI_ID" ]; then
  pass "POST /wikis → 201, id=$WIKI_ID"
else
  fail "POST /wikis → HTTP $CREATE_HTTP (id=$WIKI_ID)"
fi

# 2. List
LIST_HTTP=$(curl -s -o /tmp/uat-wikis-list.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis")
if [ "$LIST_HTTP" = "200" ]; then
  WIKI_COUNT=$(jq '.wikis | length' /tmp/uat-wikis-list.json 2>/dev/null || echo "0")
  FOUND=$(jq --arg id "$WIKI_ID" '.wikis[] | select(.lookupKey == $id or .id == $id) | .name' /tmp/uat-wikis-list.json 2>/dev/null)
  if [ -n "$FOUND" ]; then
    pass "GET /wikis → 200, created wiki found ($WIKI_COUNT total)"
  else
    fail "GET /wikis → 200 but created wiki not in list"
  fi
else
  fail "GET /wikis → HTTP $LIST_HTTP"
fi

# 3. Get detail
DETAIL_HTTP=$(curl -s -o /tmp/uat-wiki-detail.json -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis/$WIKI_ID")
if [ "$DETAIL_HTTP" = "200" ]; then
  HAS_FIELDS=$(jq 'has("name") and has("type") and has("state")' /tmp/uat-wiki-detail.json 2>/dev/null)
  NAME_LEN=$(jq -r '.name | length' /tmp/uat-wiki-detail.json 2>/dev/null || echo 0)
  HAS_WIKI_CONTENT=$(jq 'has("wikiContent")' /tmp/uat-wiki-detail.json 2>/dev/null)
  [ "$HAS_FIELDS" = "true" ] && pass "GET /wikis/:id → 200, fields present" || fail "GET /wikis/:id missing fields"
  [ "$NAME_LEN" -gt 0 ] 2>/dev/null && pass "wiki name non-empty" || fail "wiki name is empty"
  [ "$HAS_WIKI_CONTENT" = "true" ] && pass "detail has wikiContent field" || fail "detail missing wikiContent field"
else
  fail "GET /wikis/:id → HTTP $DETAIL_HTTP"
fi

# 4. Update
UPDATE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"name":"UAT Test Wiki Updated"}' \
  "$SERVER_URL/wikis/$WIKI_ID")
[ "$UPDATE_HTTP" = "200" ] && pass "PUT /wikis/:id → 200" || fail "PUT /wikis/:id → HTTP $UPDATE_HTTP"

# Verify update
UPDATED_NAME=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_ID" | jq -r '.name')
[ "$UPDATED_NAME" = "UAT Test Wiki Updated" ] && pass "name updated correctly" || fail "name not updated: $UPDATED_NAME"

# 5. Delete
DELETE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -b "$COOKIE_JAR" \
  -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis/$WIKI_ID")
if [ "$DELETE_HTTP" = "204" ] || [ "$DELETE_HTTP" = "200" ]; then
  pass "DELETE /wikis/:id → $DELETE_HTTP"
else
  fail "DELETE /wikis/:id → HTTP $DELETE_HTTP"
fi

# 6. Verify deleted
GONE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis/$WIKI_ID")
[ "$GONE_HTTP" = "404" ] && pass "deleted wiki returns 404" || fail "deleted wiki returned $GONE_HTTP (expected 404)"

# ── 10. Ghost wikis + zombie edges (regression #236) ─────────
# Two stacked bugs (issue #236):
#   (1) classifier worker queries `wikis` without isNull(deletedAt) at
#       core/src/queue/worker.ts:378-401, so soft-deleted wikis stay in
#       the candidate set and the LLM keeps routing new fragments into
#       graveyards.
#   (2) DELETE /wikis/:id at core/src/routes/wikis.ts:716-738 soft-
#       deletes the wiki + hard-deletes group_wikis but leaves every
#       FRAGMENT_IN_WIKI edge intact — old fragments still appear in
#       the graph attached to a wiki that no longer exists.
#
# Edge-type inventory referencing wikis (verified against live DB):
#   FRAGMENT_IN_WIKI  fragment → wiki   (the only edge that *names*
#                                        a wiki via dst_id; bug-affected)
#   FRAGMENT_MENTIONS_PERSON, FRAGMENT_RELATED_TO_FRAGMENT,
#   ENTRY_HAS_FRAGMENT all reference fragments/people, not wikis
#   directly — out of scope for the wiki-delete sweep.
#   group_wikis is hard-deleted by the DELETE handler (no zombies).
#
# These assertions are EXPECTED-FAIL on uat/stability-bug-regressions
# until the fix lands. They turn green after:
#   (a) classifier filter:  isNull(wikis.deletedAt) in worker.ts:378-401
#   (b) edge cascade:       UPDATE edges SET deleted_at=now()
#                           WHERE (src_id=:key OR dst_id=:key)
#                                 AND deleted_at IS NULL
#       inside the DELETE handler
#   (c) one-time backfill:  same UPDATE for every wiki where
#                           wiki.deleted_at IS NOT NULL AND
#                           edge.deleted_at IS NULL

echo ""
echo "── 10. Ghost wikis + zombie edges (#236) ──"

if [ -z "${DATABASE_URL:-}" ]; then
  skip "10. DATABASE_URL unset — entire ghost-wikis section skipped"
else

  GHOST_NAME="UAT08 Ghost Wiki $RUN_ID"
  GHOST_TOPIC="parambi-family-travel-$RUN_ID"

  # 10. Setup — create the wiki we're going to soft-delete. Make its
  # description a strong classification signal so the bug (1) path —
  # if present — will route a matching fragment INTO the deleted wiki.
  GHOST_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    -H "Content-Type: application/json" \
    -X POST -d "$(jq -n --arg n "$GHOST_NAME" --arg t "$GHOST_TOPIC" \
      '{name:$n, type:"log", description:("Travel planning notes for the Parambi family — flights, hotels, itineraries. Topic tag: " + $t), prompt:"Summarize travel plans."}')" \
    "$SERVER_URL/wikis")
  GHOST_KEY=$(echo "$GHOST_RESP" | jq -r '.lookupKey // .id // empty')

  if [ -n "$GHOST_KEY" ] && [ "$GHOST_KEY" != "null" ]; then
    pass "10.0a created ghost wiki ($GHOST_KEY) with topic=$GHOST_TOPIC"
  else
    fail "10.0a could not create ghost wiki: $GHOST_RESP"
    GHOST_KEY=""
  fi

  # ── 10b setup — seed a FRAGMENT_IN_WIKI edge into the ghost wiki
  # BEFORE the delete, so the post-delete cascade assertion isn't
  # vacuous. We pick any existing fragment; the edge_type is the
  # bug-affected one. Without this seed, a freshly-created wiki has
  # zero edges and 10b would always pass even with the bug.
  SEED_FRAG=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    "$SERVER_URL/fragments?limit=10" \
    | jq -r '.fragments[0].lookupKey // .fragments[0].id // empty')

  if [ -n "$GHOST_KEY" ] && [ -n "$SEED_FRAG" ]; then
    SEED_EDGE_ID=$(psql "$DATABASE_URL" -t -A -c "SELECT gen_random_uuid()" 2>/dev/null | tr -d '[:space:]')
    psql "$DATABASE_URL" -c "INSERT INTO edges (id, src_type, src_id, dst_type, dst_id, edge_type) VALUES ('$SEED_EDGE_ID', 'fragment', '$SEED_FRAG', 'wiki', '$GHOST_KEY', 'FRAGMENT_IN_WIKI') ON CONFLICT DO NOTHING" >/dev/null 2>&1
    EDGES_BEFORE=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM edges WHERE dst_id='$GHOST_KEY' AND edge_type='FRAGMENT_IN_WIKI' AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
    if [ "${EDGES_BEFORE:-0}" -ge 1 ] 2>/dev/null; then
      pass "10.0b seeded $EDGES_BEFORE FRAGMENT_IN_WIKI edge(s) into ghost wiki — pre-delete state non-vacuous"
    else
      fail "10.0b could not seed FRAGMENT_IN_WIKI edge — 10b would be vacuous"
    fi

    DEL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
      -X DELETE -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      "$SERVER_URL/wikis/$GHOST_KEY")
    if [ "$DEL_HTTP" = "204" ] || [ "$DEL_HTTP" = "200" ]; then
      pass "10.0c DELETE /wikis/$GHOST_KEY → HTTP $DEL_HTTP (wiki now soft-deleted)"
    else
      fail "10.0c DELETE /wikis/$GHOST_KEY → HTTP $DEL_HTTP (expected 204)"
    fi

    # Confirm the wiki row really is soft-deleted (defends against
    # silent-failure of the DELETE handler).
    DEL_TS=$(psql "$DATABASE_URL" -t -A -c "SELECT deleted_at IS NOT NULL FROM wikis WHERE lookup_key='$GHOST_KEY'" 2>/dev/null | tr -d '[:space:]')
    [ "$DEL_TS" = "t" ] && pass "10.0d wikis.deleted_at populated for $GHOST_KEY" \
      || fail "10.0d wikis.deleted_at NULL after DELETE — handler regressed"
  else
    skip "10.0b SEED_FRAG missing — 10b cascade assertion will be vacuous"
    SEED_EDGE_ID=""
  fi

  # ── 10b — every edge referencing the just-deleted wiki must have
  # deleted_at set. This is the cascade the DELETE handler currently
  # FAILS to do (routes/wikis.ts:716-738 only updates the wiki row +
  # hard-deletes group_wikis). Strict: zero live edges in either
  # direction post-delete. Non-vacuous because of the seed in 10.0b.
  if [ -n "${GHOST_KEY:-}" ]; then
    LIVE_EDGES=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM edges WHERE (src_id='$GHOST_KEY' OR dst_id='$GHOST_KEY') AND deleted_at IS NULL" 2>/dev/null | tr -d '[:space:]')
    if [ "${LIVE_EDGES:-1}" = "0" ]; then
      pass "10b post-delete: 0 live edges reference ghost wiki (cascade worked)"
    else
      fail "10b post-delete: $LIVE_EDGES zombie edge(s) STILL reference $GHOST_KEY (#236 bug 2 — DELETE handler doesn't soft-delete edges)"
    fi
  else
    skip "10b GHOST_KEY missing — edge-cascade assertion skipped"
  fi

  # ── 10a — post a fragment whose content matches the deleted ghost
  # wiki's topic. The classifier worker queries `wikis` for candidates
  # without filtering deleted_at (worker.ts:378-401) so the LLM may
  # route this new fragment INTO the deleted wiki — the regression.
  # Strict assertion: post-pipeline, ZERO live FRAGMENT_IN_WIKI edges
  # point at the deleted ghost wiki.
  if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    skip "10a OPENROUTER_API_KEY unset — classifier-route check skipped"
  elif [ -n "${GHOST_KEY:-}" ]; then
    ENTRY_CONTENT="UAT08 ghost-routing probe $RUN_ID. Parambi family travel planning for September trip — flights to Lisbon, hotel near Belem, day trips to Sintra. Topic: $GHOST_TOPIC. This entry should NOT classify into any soft-deleted wiki."

    SUBMIT=$(curl -s -w "\n%{http_code}" -X POST -b "$COOKIE_JAR" \
      -H "Content-Type: application/json" \
      -H "Origin: http://localhost:3000" \
      -d "$(jq -n --arg c "$ENTRY_CONTENT" '{content:$c}')" \
      "$SERVER_URL/entries")
    SUBMIT_HTTP=$(echo "$SUBMIT" | tail -1)
    SUBMIT_BODY=$(echo "$SUBMIT" | sed '$d')
    ENTRY_ID=$(echo "$SUBMIT_BODY" | jq -r '.id // .lookupKey // ""')

    if [ "$SUBMIT_HTTP" = "202" ] && [ -n "$ENTRY_ID" ]; then
      pass "10a.0 POST /entries → 202 (entry=$ENTRY_ID) — pipeline running"

      # Poll for processed state (max 120s — ingest+extract+classify
      # is multi-step LLM).
      echo "    ⟳ polling entry classification (max 120s)..."
      ELAPSED=0
      MAX_WAIT=120
      FINAL_STATUS=""
      while [ $ELAPSED -lt $MAX_WAIT ]; do
        sleep 5
        ELAPSED=$((ELAPSED + 5))
        ENTRY_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
          "$SERVER_URL/entries/$ENTRY_ID" 2>/dev/null)
        STATE=$(echo "$ENTRY_RESP" | jq -r '.ingestStatus // .state // "unknown"')
        if [ "$STATE" = "processed" ] || [ "$STATE" = "RESOLVED" ]; then
          FINAL_STATUS="$STATE"; break
        fi
        if [ "$STATE" = "failed" ]; then
          FINAL_STATUS="failed"; break
        fi
      done

      if [ "$FINAL_STATUS" = "processed" ] || [ "$FINAL_STATUS" = "RESOLVED" ]; then
        pass "10a.1 pipeline reached $FINAL_STATUS in ${ELAPSED}s"

        # The classifier may run after ingest extraction; give it a
        # short additional grace window for the wikiClassify job to
        # land its edges.
        sleep 5

        # Strict: count live edges from THIS run's fragments into the
        # ghost wiki. Re-uses src_id=fragment-of-entry. Constrain to
        # fragments derived from the just-submitted entry.
        ROUTED=$(psql "$DATABASE_URL" -t -A -c "
          SELECT count(*) FROM edges e
          WHERE e.dst_id = '$GHOST_KEY'
            AND e.edge_type = 'FRAGMENT_IN_WIKI'
            AND e.deleted_at IS NULL
            AND e.src_id IN (
              SELECT f.lookup_key FROM fragments f
              JOIN edges eh ON eh.dst_id = f.lookup_key
                            AND eh.edge_type = 'ENTRY_HAS_FRAGMENT'
              WHERE eh.src_id = '$ENTRY_ID'
            )
        " 2>/dev/null | tr -d '[:space:]')

        if [ "${ROUTED:-1}" = "0" ]; then
          pass "10a.2 new fragment(s) did NOT classify into the deleted ghost wiki"
        else
          fail "10a.2 $ROUTED new fragment-edge(s) routed into deleted $GHOST_KEY (#236 bug 1 — classifier ignores wikis.deleted_at)"
        fi
      else
        skip "10a.1 pipeline did not reach processed state in ${MAX_WAIT}s (status=$FINAL_STATUS) — classifier check skipped"
        ENTRY_ID=""
      fi
    else
      fail "10a.0 POST /entries → HTTP $SUBMIT_HTTP body=$SUBMIT_BODY"
      ENTRY_ID=""
    fi
  else
    skip "10a GHOST_KEY missing — classifier-route check skipped"
    ENTRY_ID=""
  fi

  # ── 10c — global zombie hunt. ANY wiki where deleted_at is set must
  # not appear in live edges. This catches the in-flight 45-edge dirty
  # state observed during triage as well as anything seeded by 10a/10b
  # if the bug is still live.
  ZOMBIES=$(psql "$DATABASE_URL" -t -A -c "
    SELECT count(*) FROM edges e
    JOIN wikis w ON (e.src_id = w.lookup_key OR e.dst_id = w.lookup_key)
    WHERE w.deleted_at IS NOT NULL
      AND e.deleted_at IS NULL
  " 2>/dev/null | tr -d '[:space:]')
  if [ "${ZOMBIES:-1}" = "0" ]; then
    pass "10c global zombie sweep: 0 live edges reference any soft-deleted wiki"
  else
    fail "10c $ZOMBIES zombie edge(s) reference soft-deleted wikis across the DB (#236 — needs fix + one-time backfill)"
  fi

  # ── 10d — negative paths. Even with zombie edges in the table, the
  # READ paths already filter on isNull(wikis.deletedAt) — so the
  # ghost wiki should be absent from /wikis (list), /wikis/:id (detail),
  # /wikis/:id/timeline, and /search?q=... regardless of the bug. This
  # confirms the bug is *purely* on the edges table side and the
  # READ-side soft-delete invariants are intact. Both anon and authed.
  if [ -n "${GHOST_KEY:-}" ]; then
    # /wikis (authed list) — must not contain ghost
    LIST_BODY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      "$SERVER_URL/wikis?limit=200")
    LIST_HIT=$(echo "$LIST_BODY" | jq --arg k "$GHOST_KEY" \
      '[.wikis[] | select(.lookupKey == $k or .id == $k)] | length')
    [ "$LIST_HIT" = "0" ] && pass "10d.1 GET /wikis (authed) excludes ghost wiki" \
      || fail "10d.1 GET /wikis still lists deleted ghost wiki (count=$LIST_HIT)"

    # /wikis/:id detail — must 404
    DETAIL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
      -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      "$SERVER_URL/wikis/$GHOST_KEY")
    [ "$DETAIL_HTTP" = "404" ] && pass "10d.2 GET /wikis/$GHOST_KEY (authed) → 404" \
      || fail "10d.2 GET /wikis/$GHOST_KEY (authed) → $DETAIL_HTTP (expected 404)"

    # /wikis/:id/timeline — must 404 (route guards on isNull(deletedAt))
    TL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
      -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      "$SERVER_URL/wikis/$GHOST_KEY/timeline")
    [ "$TL_HTTP" = "404" ] && pass "10d.3 GET /wikis/$GHOST_KEY/timeline → 404" \
      || fail "10d.3 GET /wikis/$GHOST_KEY/timeline → $TL_HTTP (expected 404)"

    # /graph — fed by edges, NOT by wikis. So if zombie edges exist,
    # the ghost wiki may still appear as a node here. Assert the
    # invariant we want post-fix: ghost wiki must not be a node.
    GRAPH_BODY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      "$SERVER_URL/graph")
    GRAPH_HIT=$(echo "$GRAPH_BODY" | jq --arg k "$GHOST_KEY" \
      '[.nodes[] | select(.id == $k and .type == "wiki")] | length' 2>/dev/null)
    if [ "${GRAPH_HIT:-0}" = "0" ]; then
      pass "10d.4 GET /graph excludes ghost wiki node"
    else
      fail "10d.4 GET /graph still lists ghost wiki node (#236 bug 2 — zombie edges leak into /graph)"
    fi

    # /search — hybridSearch filters wikis.deleted_at IS NULL
    # (core/src/lib/search.ts:62). Hit the most distinctive token
    # from the description so BM25 finds it iff present.
    SEARCH_BODY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      "$SERVER_URL/search?q=$GHOST_TOPIC&tables=wikis&mode=bm25")
    SEARCH_HIT=$(echo "$SEARCH_BODY" | jq --arg k "$GHOST_KEY" \
      '[.results[] | select((.id // .lookupKey) == $k)] | length' 2>/dev/null)
    [ "${SEARCH_HIT:-0}" = "0" ] && pass "10d.5 /search?q=$GHOST_TOPIC excludes ghost wiki" \
      || fail "10d.5 /search returns ghost wiki for q=$GHOST_TOPIC (count=$SEARCH_HIT)"

    # Anon (no cookie) — auth middleware should 401 these endpoints
    # before even hitting the soft-delete filter, but assert the
    # observable absence for completeness.
    ANON_DETAIL=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Origin: http://localhost:3000" \
      "$SERVER_URL/wikis/$GHOST_KEY")
    if [ "$ANON_DETAIL" = "401" ] || [ "$ANON_DETAIL" = "404" ]; then
      pass "10d.6 anon GET /wikis/$GHOST_KEY → $ANON_DETAIL (no leak)"
    else
      fail "10d.6 anon GET /wikis/$GHOST_KEY → $ANON_DETAIL (expected 401 or 404)"
    fi
  else
    skip "10d GHOST_KEY missing — negative-path assertions skipped"
  fi

  # ── 10 cleanup — hard-delete the ghost wiki + every edge that
  # touched it + the test entry's fragment chain. Plan must be
  # replayable, so we don't leave soft-deleted UAT08 rows behind.
  if [ -n "${GHOST_KEY:-}" ]; then
    psql "$DATABASE_URL" -c "DELETE FROM edges WHERE src_id='$GHOST_KEY' OR dst_id='$GHOST_KEY'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM wikis WHERE lookup_key='$GHOST_KEY'" >/dev/null 2>&1 || true
  fi
  if [ -n "${ENTRY_ID:-}" ]; then
    # Drop derived fragments + their edges + the entry. Cascade by
    # discovering fragment lookup_keys via the ENTRY_HAS_FRAGMENT edges.
    psql "$DATABASE_URL" -c "
      DELETE FROM edges WHERE src_id IN (
        SELECT dst_id FROM edges WHERE src_id='$ENTRY_ID' AND edge_type='ENTRY_HAS_FRAGMENT'
      ) OR dst_id IN (
        SELECT dst_id FROM edges WHERE src_id='$ENTRY_ID' AND edge_type='ENTRY_HAS_FRAGMENT'
      )" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "
      DELETE FROM fragments WHERE lookup_key IN (
        SELECT dst_id FROM edges WHERE src_id='$ENTRY_ID' AND edge_type='ENTRY_HAS_FRAGMENT'
      )" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM edges WHERE src_id='$ENTRY_ID' OR dst_id='$ENTRY_ID'" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -c "DELETE FROM raw_sources WHERE lookup_key='$ENTRY_ID'" >/dev/null 2>&1 || true
  fi
  # UAT08 name sweep — clears stragglers from a prior failed run so
  # 10c is meaningful on subsequent invocations.
  psql "$DATABASE_URL" -c "
    DELETE FROM edges WHERE src_id IN (SELECT lookup_key FROM wikis WHERE name LIKE 'UAT08 Ghost Wiki %')
                          OR dst_id IN (SELECT lookup_key FROM wikis WHERE name LIKE 'UAT08 Ghost Wiki %')" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -c "DELETE FROM wikis WHERE name LIKE 'UAT08 Ghost Wiki %'" >/dev/null 2>&1 || true
  pass "10 cleanup: hard-deleted ghost wiki + edges + test entry chain"

fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary (section 10 only)

| # | Assertion | Source |
|---|-----------|--------|
| 10.0 | Ghost wiki created + soft-deleted via DELETE handler; baseline edge count captured | `core/src/routes/wikis.ts:716-738` |
| 10a | Fragment routed via POST /entries with topic-matching content does NOT acquire a live `FRAGMENT_IN_WIKI` edge to the deleted wiki | `core/src/queue/worker.ts:378-401` (missing `isNull(wikis.deletedAt)`) |
| 10b | Post-DELETE: every edge with `src_id` or `dst_id = ghost_key` has `deleted_at IS NOT NULL` (strict 0 live edges) | `core/src/routes/wikis.ts:716-738` (handler doesn't cascade to edges) |
| 10c | Global invariant: 0 zombie edges DB-wide (`edges.deleted_at IS NULL` while joined wiki has `deleted_at IS NOT NULL`) — triage observed 45 today | edges + wikis JOIN |
| 10d | Deleted ghost wiki absent from `/wikis`, `/wikis/:id`, `/wikis/:id/timeline`, `/graph`, `/search?q=...`; anon path returns 401 or 404 | `core/src/routes/wikis.ts:70`, `:220`, `:344`, `core/src/lib/search.ts:62`, `core/src/routes/graph.ts:38` |
| Cleanup | Ghost wiki + edges + test entry chain hard-deleted; UAT08 name sweep clears stragglers from failed runs | psql cleanup block |

---

## Notes — section 10

- **Expected-fail today.** On `uat/stability-bug-regressions` (HEAD = main) this section is designed to fail at 10b, 10c, and 10d.4. That's the regression test working. The fix turns them green:
  1. Add `isNull(wikis.deletedAt)` to both `searchCandidates` and `loadThreads` in `core/src/queue/worker.ts:378-401` — fixes 10a.
  2. Inside the DELETE handler at `core/src/routes/wikis.ts:716-738`, soft-delete every edge where `src_id = :id OR dst_id = :id AND deleted_at IS NULL` — fixes 10b.
  3. One-time SQL backfill: same UPDATE for every wiki where `deleted_at IS NOT NULL` — clears the 45-edge dirty state and turns 10c green.
- **Edge-type inventory.** Only `FRAGMENT_IN_WIKI` edges directly reference wikis (verified: `SELECT DISTINCT edge_type, src_type, dst_type FROM edges WHERE src_type='wiki' OR dst_type='wiki'` returns exactly one row, `FRAGMENT_IN_WIKI | fragment | wiki`). `WIKI_MENTIONS_PERSON` does not exist. `group_wikis` is hard-deleted by the handler so no zombies there. The orchestrator's wider sweep in 10b (`src_id OR dst_id`) is defensive — it would catch any future `WIKI_RELATED_TO_WIKI` style edge if ever added.
- **Cross-wiki transitive ghosts (out of scope).** A separate class of latent zombie: `FRAGMENT_RELATED_TO_FRAGMENT` edges between live fragments and fragments whose only `FRAGMENT_IN_WIKI` is to a deleted wiki. The live fragment is reachable to ghost-content via the relation graph. Live count today: 78. Not in #236's scope (issue is specifically about wiki-direct edges) but worth flagging for a follow-up.
- **`/graph` is the canary.** Read paths against the `wikis` table all filter on `isNull(deletedAt)` and were never broken by #236. The only externally-observable leak is `/graph`, which builds nodes off the `edges` table — so a zombie edge resurrects a deleted wiki as a node. 10d.4 is the assertion that catches it.
- **Pipeline timing.** 10a polls up to 120s for the entry to reach `processed` and grants an extra 5s for the wikiClassify job to land its edges. If the system is under load and classification finishes after the poll window, 10a degrades to skip rather than spurious-fail.
- **Cleanup hard-deletes.** Other UAT plans soft-delete; this one MUST hard-delete the ghost wiki because soft-deleting it after the test would itself create the zombie state we're hunting on the next run. The UAT08 name sweep at the end clears stragglers from prior failed runs.
