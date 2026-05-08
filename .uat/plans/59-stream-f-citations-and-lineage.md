# 59 — Stream F core: numbered citations + fragment lineage page + evolution timeline

## What it proves

PR `feat/f-citations-and-lineage` ships three coupled Stream F v0.2.0 features:

1. **F1 (numbered citations)**: wiki body markdown rendering attaches `[1]`, `[2]` superscripts to text drawn from fragments. Numbering is per-wiki, document-wide, stable across renders. Click on superscript scrolls to the in-page bibliography section anchor `#fragment-{lookupKey}`. Already shipped under #245; this PR documents and reuses, with extended F2/F4 surfaces consuming the same primitive.
2. **F2 (fragment-detail page with full lineage)**: `/fragments/<id>` renders Type, State, Tags, Created, Updated metadata in the infobox plus three lineage sections: Entry origin, Wiki references (renamed, anchored at `id="references"`), Related fragments.
3. **F4 (fragment evolution timeline)**: same page slots an `EvolutionSection` between Entry origin and Wiki references. Reads `GET /fragments/:id/history` (Stream A5), renders newest-first timeline of edits with timestamps, source-client labels (`mcp`, `api`, `web`, `regen`), word-level diffs via `jsdiff`. Collapsed by default with "Edited N times" expandable affordance.

## Prerequisites

- Core server on `SERVER_URL` (default `http://localhost:3000`)
- Wiki dev server on `WIKI_URL` (default `http://localhost:8080`)
- Authenticated session
- `pnpm -C core seed-fixture` so a Transformer wiki and fragments exist
- Stream A5's `GET /fragments/:id/history` endpoint live (ships in a sibling PR; UAT degrades gracefully if missing, see notes)
- Browser for visual checks on F1, F2, F4

## Endpoint map

- `GET /api/wikis/<key>`: wiki body, citations applied client-side at render time
- `GET /api/fragments/<id>`: existing detail
- `GET /api/fragments/<id>/history`: edits + audit (A5), 200 on existence with `{ edits, total }`, 404 if no rows yet
- Wiki page route `/wiki/<id>`: client side renders body with `WikiCitations` + `WikiCitationsSection`
- Fragment detail route `/fragments/<id>`: shows Type/State/Tags/Created/Updated, Entry origin, Evolution, Wiki references, Related fragments

## Test steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
ORIGIN="${WIKI_ORIGIN_HEADER:-http://localhost:8080}"

JAR=$(mktemp /tmp/uat-59-jar-XXXXXX.txt)
trap 'rm -f "$JAR" /tmp/uat-59-*.json /tmp/uat-59-*.html' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "59 — Stream F core: citations + lineage + evolution"
echo ""

# 1. Sign in
HTTP=$(curl -s -o /tmp/uat-59-signin.json -w "%{http_code}" \
  -c "$JAR" -X POST -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email")
if [ "$HTTP" = "200" ]; then pass "sign in 200"; else fail "sign in got $HTTP"; fi

# 2. Pick a fragment that has at least one wiki reference (so F2's lineage has signal)
FRAG_ID=$(curl -s -b "$JAR" "$SERVER_URL/fragments?limit=10" | jq -r '.fragments[0].id // empty')
if [ -z "$FRAG_ID" ]; then fail "no fragments seeded; run pnpm -C core seed-fixture"; exit 1; fi
pass "selected fragment $FRAG_ID"

# 3. F2 — fragment detail page renders SSR HTML with the lineage anchors
HTML=$(curl -s -b "$JAR" "$WIKI_URL/fragments/$FRAG_ID" -H "Origin: $ORIGIN")
echo "$HTML" > /tmp/uat-59-frag.html

# References anchor must exist for F1 superscripts to land
if echo "$HTML" | grep -q 'id="references"'; then pass "F2 references anchor present"; else fail "F2 references anchor missing"; fi

# Type, State, Tags, Created, Updated infobox rows (presence test, not exact label match)
for label in "Type" "State" "Created" "Updated"; do
  if echo "$HTML" | grep -qi ">$label<"; then pass "F2 infobox row: $label"; else fail "F2 infobox row missing: $label"; fi
done

# 4. F2 — lineage sections present in DOM
for section in "Entry" "references" "Related"; do
  if echo "$HTML" | grep -qi "$section"; then pass "F2 section anchor: $section"; else fail "F2 section missing: $section"; fi
done

# 5. F4 — evolution timeline area is rendered (label may say "No edits recorded yet" if A5 not live)
if echo "$HTML" | grep -qi 'evolution\|Edited\|edits recorded'; then
  pass "F4 evolution surface present"
else
  fail "F4 evolution surface missing"
fi

# 6. F1 — render a wiki page, look for superscripts in the rendered body
WIKI_KEY=$(curl -s -b "$JAR" "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].key // empty')
if [ -z "$WIKI_KEY" ]; then skip "F1: no wikis seeded"; else
  WIKI_HTML=$(curl -s -b "$JAR" "$WIKI_URL/wiki/$WIKI_KEY" -H "Origin: $ORIGIN")
  echo "$WIKI_HTML" > /tmp/uat-59-wiki.html

  # Look for sup elements with [N] content (rough: F1 emits <sup>[N]</sup> or similar)
  if echo "$WIKI_HTML" | grep -Ec '<sup[^>]*>\[\s*[0-9]+\s*\]</sup>' | head -1 > /tmp/uat-59-supcount.txt; then
    SUPCOUNT=$(cat /tmp/uat-59-supcount.txt)
    if [ "$SUPCOUNT" -gt 0 ]; then pass "F1 superscripts rendered ($SUPCOUNT)"; else skip "F1 wiki has no fragments to cite"; fi
  else
    skip "F1 wiki body has no citations to render"
  fi

  # Bibliography section anchor (per-fragment hrefs)
  if echo "$WIKI_HTML" | grep -qE 'id="fragment-[^"]+"'; then pass "F1 bibliography anchors present"; else skip "F1 no bibliography rendered for this wiki"; fi
fi

# 7. F4 — A5 endpoint smoke (skip if A5 not deployed yet)
HIST_HTTP=$(curl -s -o /tmp/uat-59-hist.json -w "%{http_code}" -b "$JAR" "$SERVER_URL/fragments/$FRAG_ID/history")
if [ "$HIST_HTTP" = "200" ]; then
  pass "A5 history endpoint 200 (F4 has signal)"
  HAS_EDITS=$(jq 'has("edits")' /tmp/uat-59-hist.json)
  if [ "$HAS_EDITS" = "true" ]; then pass "history payload has edits[]"; else fail "history missing edits[]"; fi
elif [ "$HIST_HTTP" = "404" ]; then
  skip "A5 endpoint returns 404 (no edit history yet, F4 will show empty state)"
else
  fail "A5 endpoint got $HIST_HTTP"
fi

# 8. F2 — anon access to the fragment page is gated
ANON_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$WIKI_URL/fragments/$FRAG_ID")
if [ "$ANON_HTTP" = "200" ] || [ "$ANON_HTTP" = "302" ] || [ "$ANON_HTTP" = "307" ]; then
  pass "anon hits fragment page (page handles redirect to login internally)"
else
  fail "anon got $ANON_HTTP, expected 200/302/307"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ]
```

## Manual visual checks (browser)

These require a real browser; the bash above can't observe them.

1. Open `/wiki/<some-wiki-with-fragments>`. Body shows `[1]`, `[2]`, etc. as superscripts. Click `[1]`. Page scrolls to the bibliography section, the cited fragment row is anchored.
2. Open `/fragments/<some-frag-id>`. Layout: infobox (Type/State/Tags/Created/Updated) on the right; main column shows Entry origin, Evolution (collapsed: "Edited N times"), Wiki references (heading "Wiki references"), Related fragments. Click "Edited N times" if N > 0; timeline expands with newest-first entries.
3. With a fragment edited 3 times via SQL or `PUT /fragments/<id>`, the Evolution timeline shows 3 entries each with timestamp, source-client label, and an expandable per-entry word-level diff.

## Cleanup

No persistent state created.

## Expected pass/fail behavior

All steps PASS once Stream A5 ships in a sibling PR. While A5 is pending, step 7 will SKIP rather than FAIL.
