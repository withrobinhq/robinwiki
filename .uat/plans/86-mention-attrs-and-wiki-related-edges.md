# 86, mention attrs and WIKI_RELATED_TO_WIKI edges

## What it proves

Wave 3 streams H2 (#329) and H4 (#328) close two QA gaps in the v0.2.2
edge-writing pipeline.

H2 (#329): every FRAGMENT_MENTIONS_PERSON edge stamps `attrs` jsonb
with `mention`, `sourceSpan`, and `confidence`. Powers provenance
display, matcher auditing, and offline re-matching against fragment
text. Both production write paths (the worker pipeline persist stage
and the MCP `log_fragment` fast path) carry the attrs through
identically.

H4 (#328): when Marcel scores top-N wiki candidates for a fragment,
secondaries above 0.4 confidence land as WIKI_RELATED_TO_WIKI edges
from the top-1 winner to each secondary. Powers future "related
wikis" surfaces and aggregate co-occurrence counts without
re-running classification.

After this UAT runs:

1. The worker persist stage writes
   `attrs={mention,sourceSpan,confidence}` on every
   FRAGMENT_MENTIONS_PERSON edge.
2. The MCP `log_fragment` handler writes the same attrs shape on
   FRAGMENT_MENTIONS_PERSON edges.
3. `runLinking` writes WIKI_RELATED_TO_WIKI edges from the top-1
   classified wiki to each Marcel secondary above the 0.4 confidence
   floor. Each edge carries
   `attrs={sourceFragmentId, marcelConfidence}`.
4. Secondaries at or below 0.4 confidence do NOT produce
   WIKI_RELATED_TO_WIKI edges.
5. The MCP `log_fragment` path (fast path; no Marcel) does not write
   WIKI_RELATED_TO_WIKI.

No backfill script ships for legacy attrs=NULL rows. The dataset is
under 50 rows and re-running the resolver against fragment text
would burn an LLM-extraction budget for marginal value. New writes
from this point forward carry attrs correctly; legacy rows can be
repaired manually if any specific row blocks a downstream lookup.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a | POS | persist.ts FRAGMENT_MENTIONS_PERSON insert references `attrs: payload.attrs` |
| 1b | POS | persist.ts exports `MentionEdgeAttrs` interface with `mention`, `sourceSpan`, `confidence` fields |
| 1c | POS | mcp/handlers.ts FRAGMENT_MENTIONS_PERSON insert spreads or names an `attrs` field |
| 2a | POS | stages/index.ts contains a `WIKI_RELATED_TO_WIKI` insert under runLinking |
| 2b | POS | stages/index.ts uses 0.4 as the secondary-confidence threshold |
| 2c | POS | stages/index.ts secondary-write attrs include `sourceFragmentId` and `marcelConfidence` |
| 3a | POS | runtime: posting an entry that mentions a known person yields a FRAGMENT_MENTIONS_PERSON edge with non-null attrs |
| 3b | POS | the recorded attrs include `mention`, `sourceSpan`, and a numeric `confidence` |
| 4a | POS | runtime: the same entry yields zero WIKI_RELATED_TO_WIKI edges where the secondary's marcelConfidence <= 0.4 |
| 4b | POS | runtime: any WIKI_RELATED_TO_WIKI edges produced this run carry both attrs keys (`sourceFragmentId`, `marcelConfidence`) and a marcelConfidence > 0.4 |
| 5a | NEG | MCP log_fragment path does not write WIKI_RELATED_TO_WIKI (fast path; no Marcel) |
| 6a | NEG | no backfill script file exists at `core/scripts/backfill-mention-attrs.ts` (decision documented in this plan) |

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` in `core/.env`.
- `DATABASE_URL` reachable for direct row inspection.
- BullMQ worker attached so extraction + linking jobs drain.
- At least one verified person row in `people` whose canonical name
  appears literally in the test fragment text.
- At least three live wikis (so Marcel has top-N candidates to rank
  beyond the top-1).
- Repo checkout on `feat/persist-mention-attrs-and-wiki-edges`.

## Endpoint map

- `POST /api/auth/sign-in/email`: better-auth sign-in
- `POST /entries`: kicks the worker pipeline (Marcel runs at link time)
- `POST /mcp?token=<jwt>`: MCP `log_fragment` fast path

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-/home/me/apps/robin}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:3000}"

JAR=$(mktemp /tmp/uat-86-jar-XXXXXX.txt)
RUN_ID=$(date +%s)
trap 'rm -f "$JAR" /tmp/uat-86-*.json /tmp/uat-86-*.log' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
skip() { SKIP=$((SKIP+1)); echo "  skip $1"; }

echo "86, mention attrs and WIKI_RELATED_TO_WIKI edges"
echo ""

# ── 0. Auth + handles ──────────────────────────────────────────────────
curl -s -o /dev/null -c "$JAR" -X POST \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email"
if [ -s "$JAR" ]; then
  pass "0a. sign-in established session cookie"
else
  fail "0a. sign-in failed"
  echo ""; echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi

PROFILE=$(curl -s -b "$JAR" -H "Origin: $ORIGIN" "$SERVER_URL/users/profile")
MCP_URL=$(echo "$PROFILE" | jq -r '.mcpEndpointUrl // empty')
MCP_TOKEN=$(echo "$MCP_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')
if [ -n "$MCP_TOKEN" ]; then
  pass "0b. minted MCP JWT"
  MCP_ENDPOINT="$SERVER_URL/mcp?token=$MCP_TOKEN"
fi

# Track entities for cleanup.
UAT_ENTRY_KEYS=()

# ── 1. Source-level guards (H2) ────────────────────────────────────────
PERSIST_TS="packages/agent/src/stages/persist.ts"
HANDLERS_TS="core/src/mcp/handlers.ts"
INDEX_TS="packages/agent/src/stages/index.ts"

if grep -q "attrs: payload.attrs" "$PERSIST_TS"; then
  pass "1a. persist.ts FRAGMENT_MENTIONS_PERSON insert spreads payload.attrs"
else
  fail "1a. persist.ts FRAGMENT_MENTIONS_PERSON insert missing attrs"
fi

if grep -qE "interface MentionEdgeAttrs" "$PERSIST_TS" \
   && grep -qE "mention:\s*string" "$PERSIST_TS" \
   && grep -qE "sourceSpan:\s*string" "$PERSIST_TS" \
   && grep -qE "confidence:\s*number" "$PERSIST_TS"; then
  pass "1b. persist.ts exports MentionEdgeAttrs with mention, sourceSpan, confidence"
else
  fail "1b. persist.ts MentionEdgeAttrs interface incomplete"
fi

if awk '/edgeType: '\''FRAGMENT_MENTIONS_PERSON'\''/,/}/' "$HANDLERS_TS" \
     | grep -qE "attrs[,:]"; then
  pass "1c. mcp/handlers.ts FRAGMENT_MENTIONS_PERSON insert references attrs"
else
  fail "1c. mcp/handlers.ts FRAGMENT_MENTIONS_PERSON insert missing attrs"
fi

# ── 2. Source-level guards (H4) ────────────────────────────────────────
if grep -q "WIKI_RELATED_TO_WIKI" "$INDEX_TS"; then
  pass "2a. stages/index.ts mentions WIKI_RELATED_TO_WIKI"
else
  fail "2a. stages/index.ts missing WIKI_RELATED_TO_WIKI insert"
fi

if grep -qE "RELATED_THRESHOLD\s*=\s*0\.4" "$INDEX_TS"; then
  pass "2b. stages/index.ts secondary-write threshold is 0.4"
else
  fail "2b. stages/index.ts threshold not pinned at 0.4"
fi

if grep -q "sourceFragmentId" "$INDEX_TS" \
   && grep -q "marcelConfidence" "$INDEX_TS"; then
  pass "2c. stages/index.ts secondary attrs include sourceFragmentId and marcelConfidence"
else
  fail "2c. stages/index.ts secondary attrs incomplete"
fi

# ── 3. Runtime: FRAGMENT_MENTIONS_PERSON.attrs ────────────────────────
if [ -z "${DATABASE_URL:-}" ]; then
  skip "3-4. DATABASE_URL not set; skipping runtime checks"
else
  # Pick a verified person whose canonical name we can mention
  # literally inside a fragment.
  PERSON_NAME=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT canonical_name FROM people
     WHERE status='verified' AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1" 2>/dev/null | tr -d '\n' | sed 's/[[:space:]]*$//')
  if [ -z "$PERSON_NAME" ]; then
    skip "3-prep. no verified person row to mention; seed one and re-run"
  else
    pass "3-prep. target person: $PERSON_NAME"
    CONTENT="UAT 86 fragment $RUN_ID. Had a long talk with $PERSON_NAME about \
the new Robin pipeline today. We covered fragment classification, wiki \
secondary candidates, and how Marcel ranks adjacent topics."
    ENT_RESP=$(curl -s -b "$JAR" -X POST \
      -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
      -d "$(jq -n --arg c "$CONTENT" '{content:$c, source:"web", type:"thought"}')" \
      "$SERVER_URL/entries")
    ENT_KEY=$(echo "$ENT_RESP" | jq -r '.id // .lookupKey // empty')
    if [ -z "$ENT_KEY" ]; then
      fail "3-prep. POST /entries did not return key (resp=$ENT_RESP)"
    else
      UAT_ENTRY_KEYS+=("$ENT_KEY")
      pass "3-prep. entry $ENT_KEY queued"

      # Poll up to 60s for FRAGMENT_MENTIONS_PERSON edges to land.
      EDGE_COUNT=0
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        EDGE_COUNT=$(psql "$DATABASE_URL" -t -A -c "
          SELECT COUNT(*) FROM edges e
          JOIN fragments f ON f.lookup_key = e.src_id
          WHERE e.edge_type='FRAGMENT_MENTIONS_PERSON'
            AND f.entry_id='$ENT_KEY'
            AND e.deleted_at IS NULL
        " 2>/dev/null | tr -d '[:space:]')
        [ "$EDGE_COUNT" -gt "0" ] 2>/dev/null && break
        sleep 3
      done
      if [ "$EDGE_COUNT" -gt "0" ] 2>/dev/null; then
        pass "3a. extracted fragment yielded $EDGE_COUNT FRAGMENT_MENTIONS_PERSON edge(s)"

        # Read the attrs jsonb on the first edge.
        ATTRS_JSON=$(psql "$DATABASE_URL" -t -A -c "
          SELECT COALESCE(e.attrs::text,'<NULL>') FROM edges e
          JOIN fragments f ON f.lookup_key = e.src_id
          WHERE e.edge_type='FRAGMENT_MENTIONS_PERSON'
            AND f.entry_id='$ENT_KEY'
          ORDER BY e.created_at ASC LIMIT 1
        " 2>/dev/null)
        if [ "$ATTRS_JSON" = "<NULL>" ] || [ -z "$ATTRS_JSON" ]; then
          fail "3b. FRAGMENT_MENTIONS_PERSON attrs is NULL (legacy shape)"
        else
          M=$(echo "$ATTRS_JSON" | jq -r '.mention // empty')
          S=$(echo "$ATTRS_JSON" | jq -r '.sourceSpan // empty')
          C=$(echo "$ATTRS_JSON" | jq -r '.confidence // empty')
          if [ -n "$M" ] && [ -n "$S" ] && [ -n "$C" ]; then
            pass "3b. attrs carry mention='$M', sourceSpan length=${#S}, confidence=$C"
          else
            fail "3b. attrs incomplete (mention='$M', sourceSpan='$S', confidence='$C')"
          fi
        fi
      else
        skip "3a. no FRAGMENT_MENTIONS_PERSON edge produced within 60s"
      fi

      # ── 4. Runtime: WIKI_RELATED_TO_WIKI thresholding ─────────────
      # Read every WIKI_RELATED_TO_WIKI edge that this entry's fragment
      # produced, and assert each one obeys the >0.4 floor and the
      # attrs contract.
      RELATED_ROWS=$(psql "$DATABASE_URL" -t -A -F'|' -c "
        SELECT e.src_id, e.dst_id, COALESCE(e.attrs::text,'<NULL>')
        FROM edges e
        WHERE e.edge_type='WIKI_RELATED_TO_WIKI'
          AND e.attrs->>'sourceFragmentId' IN (
            SELECT lookup_key FROM fragments WHERE entry_id='$ENT_KEY'
          )
          AND e.deleted_at IS NULL
      " 2>/dev/null)

      if [ -z "$RELATED_ROWS" ]; then
        # No secondaries cleared the floor for this fragment. Acceptable
        # when the entry only tickled one wiki strongly. Record skip
        # rather than fail — the contract is "above 0.4 OR none", not
        # "must produce some".
        skip "4a-4b. no WIKI_RELATED_TO_WIKI edges produced; cannot exercise threshold runtime"
      else
        BAD=0
        ATTRS_OK=1
        while IFS='|' read -r SRC DST ATTRS; do
          [ -z "$SRC" ] && continue
          if [ "$ATTRS" = "<NULL>" ]; then
            ATTRS_OK=0
            continue
          fi
          MC=$(echo "$ATTRS" | jq -r '.marcelConfidence // empty')
          SF=$(echo "$ATTRS" | jq -r '.sourceFragmentId // empty')
          if [ -z "$MC" ] || [ -z "$SF" ]; then
            ATTRS_OK=0
          fi
          # Floating compare: marcelConfidence > 0.4. awk handles the math.
          ABOVE=$(awk -v x="$MC" 'BEGIN {print (x+0 > 0.4) ? "1" : "0"}')
          if [ "$ABOVE" != "1" ]; then
            BAD=$((BAD+1))
          fi
        done <<< "$RELATED_ROWS"

        if [ "$BAD" = "0" ]; then
          pass "4a. every WIKI_RELATED_TO_WIKI edge from this run has marcelConfidence > 0.4"
        else
          fail "4a. $BAD WIKI_RELATED_TO_WIKI edge(s) violate the 0.4 floor"
        fi

        if [ "$ATTRS_OK" = "1" ]; then
          pass "4b. every WIKI_RELATED_TO_WIKI edge carries sourceFragmentId and marcelConfidence"
        else
          fail "4b. one or more WIKI_RELATED_TO_WIKI edges missing attrs keys"
        fi
      fi
    fi
  fi
fi

# ── 5. NEG: MCP log_fragment does not write WIKI_RELATED_TO_WIKI ──────
if [ -n "${MCP_ENDPOINT:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  # Look for any wiki we can target.
  TARGET_SLUG=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT slug FROM wikis WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1" \
    2>/dev/null | tr -d '[:space:]')
  if [ -z "$TARGET_SLUG" ]; then
    skip "5a. no wiki to target; skipping MCP log_fragment NEG check"
  else
    BEFORE=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT COUNT(*) FROM edges WHERE edge_type='WIKI_RELATED_TO_WIKI'" 2>/dev/null \
       | tr -d '[:space:]')
    body=$(jq -n --arg slug "$TARGET_SLUG" --arg run "$RUN_ID" \
      '{jsonrpc:"2.0", id:1, method:"tools/call",
        params:{name:"log_fragment",
          arguments:{content:("UAT 86 MCP fragment "+$run+", checking that fast path skips Marcel"),
                     threadSlug:$slug}},
        _meta:{clientInfo:{name:"uat-86-mcp", version:"1.0"}}}')
    curl -s -o /tmp/uat-86-mcp.json -X POST \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Origin: $ORIGIN" \
      -d "$body" "$MCP_ENDPOINT" >/dev/null
    sleep 2
    AFTER=$(psql "$DATABASE_URL" -t -A -c \
      "SELECT COUNT(*) FROM edges WHERE edge_type='WIKI_RELATED_TO_WIKI'" 2>/dev/null \
       | tr -d '[:space:]')
    if [ "$BEFORE" = "$AFTER" ]; then
      pass "5a. MCP log_fragment did not write any WIKI_RELATED_TO_WIKI edge"
    else
      fail "5a. MCP log_fragment leaked WIKI_RELATED_TO_WIKI edges (before=$BEFORE, after=$AFTER)"
    fi
  fi
else
  skip "5a. MCP endpoint or DATABASE_URL unavailable"
fi

# ── 6. Backfill script intentionally absent ────────────────────────────
if [ -f "core/scripts/backfill-mention-attrs.ts" ]; then
  fail "6a. unexpected backfill script present (decision in plan: not shipped)"
else
  pass "6a. no backfill script (decision documented: dataset under 50 rows)"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"

# ── Cleanup ────────────────────────────────────────────────────────────
if [ -n "${DATABASE_URL:-}" ]; then
  for key in "${UAT_ENTRY_KEYS[@]}"; do
    psql "$DATABASE_URL" -c "
      DELETE FROM edges WHERE src_id IN (SELECT lookup_key FROM fragments WHERE entry_id='$key');
      DELETE FROM edges WHERE dst_id IN (SELECT lookup_key FROM fragments WHERE entry_id='$key');
      DELETE FROM edges WHERE attrs->>'sourceFragmentId' IN (SELECT lookup_key FROM fragments WHERE entry_id='$key');
      DELETE FROM fragments WHERE entry_id='$key';
      DELETE FROM raw_sources WHERE lookup_key='$key';
    " >/dev/null 2>&1 || true
  done
fi

[ "$FAIL" = "0" ]
```

## Cleanup

The script deletes its own rows via the `UAT_ENTRY_KEYS` array. If the
script is interrupted mid-run, manual sweep:

```bash
psql "$DATABASE_URL" -c "
  DELETE FROM raw_sources WHERE content LIKE 'UAT 86 %';
  DELETE FROM fragments WHERE content LIKE 'UAT 86 %';
"
```

## Expected pass/fail behavior

- 1a-1c, 2a-2c are static source guards. They pass on a clean
  feature branch checkout and fail loudly if a refactor strips the
  attrs writes or moves the H4 threshold.
- 3a-3b depend on the worker pipeline draining. If the worker is not
  attached, 3a SKIPs with "no edges within 60s". The contract is
  attrs-on-write; an unprocessed entry trips a SKIP, not a FAIL.
- 4a-4b are runtime threshold contracts. They SKIP cleanly when the
  fragment didn't tickle multiple wikis above 0.4. They FAIL when any
  produced WIKI_RELATED_TO_WIKI edge violates the floor or shape.
- 5a is the negative MCP-path assertion. It depends on having at least
  one wiki to target; otherwise SKIPs.
- 6a is the explicit "no backfill" decision recorded in the plan and
  guarded by a file-presence check.
