# 99 — Endpoint Sweep

## What it proves
Every top-level authenticated HTTP endpoint responds (200 or documented auth-gated status) and returns schema-valid JSON against the seeded fixture. Catches whole-surface regressions — response-shape drift, enum mismatches between DB values and schema, a route handler that throws on realistic seeded data — that feature-specific plans miss because they only exercise the endpoints they care about.

This plan is the cheapest regression net in the suite: ~30 seconds, no browser automation, just `curl | jq` per endpoint. It would have caught issue #153 (`/graph` 500 on `raw_source` edges) in the run that seeded the Transformer fixture.

## Prerequisites
- Plan 22 has already run (or `pnpm -C core seed-fixture` is complete) so the Transformer demo wiki + its edges exist.
- Core server reachable at `SERVER_URL` (default `http://localhost:3000`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `jq` installed.

## Coverage philosophy
- **200 or documented code** — every endpoint either returns 2xx against seeded data, or returns a documented non-2xx (401 without cookies, 404 for a known-missing id). Anything else is a fail.
- **JSON-valid** — every 2xx body must parse as JSON. A 200 with `<html>` is a reverse-proxy misconfiguration, and a 200 with a raw stack trace is a server bug.
- **Shape smoke** — each endpoint gets one `jq -e` assertion on a key that must exist (`.nodes | length > 0` for `/graph`, `.wikis | length > 0` for `/wikis`). Not exhaustive — just enough to catch "entire payload was silently stripped by a response schema" (the failure mode in #139).

## Out of scope
- Unauthenticated surface (handled by `/health` + published routes in other plans).
- MCP surface (handled by `98-mcp-tools.md` when it lands).
- Write endpoints — we only sweep reads here. Write-path UAT lives per-feature.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WIKI_URL="${WIKI_URL:-http://localhost:8080}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-99-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "99 — Endpoint Sweep"
echo ""

# ── 0. Sign in ───────────────────────────────────────────────
curl -s -o /dev/null -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email"

if [ -s "$COOKIE_JAR" ]; then
  pass "0. sign-in established a session cookie"
else
  fail "0. sign-in failed — all sweep steps will be skipped"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# Resolve a known wiki key + fragment key + person key + entry key from
# the seeded fixture so we can hit detail endpoints with real ids.
WIKI_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis?limit=50" \
  | jq -r '.wikis[] | select(.slug=="transformer-architecture") | .lookupKey // .id' \
  | head -1)

PERSON_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/people?limit=50" \
  | jq -r '.people[] | select(.slug=="ashish-vaswani") | .lookupKey // .id' \
  | head -1)

FRAGMENT_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/fragments?limit=50" \
  | jq -r '.fragments[] | select(.slug=="self-attention-replaces-recurrence") | .lookupKey // .id' \
  | head -1)

if [ -z "$WIKI_KEY" ] || [ "$WIKI_KEY" = "null" ]; then
  fail "0a. Transformer fixture not seeded — run plan 22 first"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# ── Helper: sweep one endpoint ───────────────────────────────
# Args: $1 = step id, $2 = URL path, $3 = jq expression (must eval truthy)
sweep() {
  local step="$1"
  local path="$2"
  local shape="$3"
  local code body
  body=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    -w "\n__HTTP__%{http_code}" "$SERVER_URL$path")
  code="${body##*__HTTP__}"
  body="${body%__HTTP__*}"

  if [ "$code" != "200" ]; then
    fail "$step $path returned $code"
    echo "    body: ${body:0:200}"
    return
  fi

  if ! echo "$body" | jq -e . >/dev/null 2>&1; then
    fail "$step $path returned 200 but body is not valid JSON"
    echo "    body: ${body:0:200}"
    return
  fi

  if ! echo "$body" | jq -e "$shape" >/dev/null 2>&1; then
    fail "$step $path shape check failed (\`$shape\`)"
    echo "    body: ${body:0:200}"
    return
  fi

  pass "$step $path — 200, valid JSON, shape OK"
}

# ── Helper: sweep one binary endpoint ────────────────────────
# Like sweep, but for binary responses — verifies status, content-type
# prefix, and non-empty body. The base URL is configurable so the same
# helper handles both core (favicon) and the wiki frontend (image
# assets) without duplicating the curl shape.
# Args: $1 = step id, $2 = URL path, $3 = expected content-type prefix,
#       $4 = optional base URL (default: $SERVER_URL)
sweep_binary() {
  local step="$1"
  local path="$2"
  local expected_ct_prefix="$3"
  local base="${4:-$SERVER_URL}"
  local body tmp_body http_code ct body_len
  tmp_body=$(mktemp /tmp/uat-99-binary-XXXXXX)
  # GET (not HEAD): some Hono static handlers omit Content-Length on
  # HEAD responses (favicon does this), so measure the actual download.
  http_code=$(curl -s -o "$tmp_body" -w "%{http_code}|%{content_type}|%{size_download}" \
    -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$base$path")
  ct=$(echo "$http_code" | awk -F'|' '{print $2}')
  body_len=$(echo "$http_code" | awk -F'|' '{print $3}')
  http_code=$(echo "$http_code" | awk -F'|' '{print $1}')
  rm -f "$tmp_body"
  if [ "$http_code" = "200" ]; then
    if echo "$ct" | grep -q "^$expected_ct_prefix"; then
      if [ -n "$body_len" ] && [ "$body_len" -gt "0" ]; then
        pass "$step $base$path 200 + $expected_ct_prefix + ${body_len}B body"
      else
        fail "$step $base$path 200 + correct CT but empty body"
      fi
    else
      fail "$step $base$path 200 but content-type='$ct' (expected prefix '$expected_ct_prefix')"
    fi
  else
    fail "$step $base$path non-200: HTTP $http_code"
  fi
}

# ── 1. Listing endpoints ─────────────────────────────────────
sweep "1a." "/wikis?limit=10"                    '.wikis | type == "array"'
sweep "1b." "/fragments?limit=10"                '.fragments | type == "array"'
sweep "1c." "/people?limit=10"                   '.people | type == "array"'
sweep "1d." "/entries?limit=10"                  '(.entries // .raw_sources) | type == "array"'
sweep "1e." "/wiki-types"                        '.wikiTypes // .types | type == "array"'

# ── 2. Detail endpoints ──────────────────────────────────────
# Known-good IDs from the fixture. #139-era regression: a response schema
# that silently stripped fields would pass a pure-200 check but fail the
# shape assertion below.
sweep "2a." "/wikis/$WIKI_KEY"                   '.wikiContent | type == "string"'
sweep "2b." "/wikis/$WIKI_KEY"                   '.sections | type == "array"'
sweep "2c." "/wikis/$WIKI_KEY"                   '.refs | type == "object"'
sweep "2d." "/wikis/$WIKI_KEY/timeline"          '.events | type == "array"'
sweep "2e." "/wikis/$WIKI_KEY/history"           '.edits | type == "array"'
[ -n "$FRAGMENT_KEY" ] && [ "$FRAGMENT_KEY" != "null" ] \
  && sweep "2f." "/fragments/$FRAGMENT_KEY"      '.lookupKey // .id | type == "string"' \
  || skip "2f. fragment key not resolved"
[ -n "$PERSON_KEY" ] && [ "$PERSON_KEY" != "null" ] \
  && sweep "2g." "/people/$PERSON_KEY"           '.name | type == "string"' \
  || skip "2g. person key not resolved"

# ── 3. Graph endpoint — regression guard for #153 ────────────
# The Transformer fixture creates edges with src_type='raw_source' in the
# edges table. Before #153, the graph route's response schema enum
# ('wiki'|'fragment'|'person'|'entry') rejected 'raw_source' and the whole
# endpoint 500'd. The sweep below would have caught this.
sweep "3a." "/graph"                             '.nodes | type == "array" and length > 0'
sweep "3b." "/graph"                             '.edges | type == "array" and length > 0'
sweep "3c." "/graph?wikiId=$WIKI_KEY"            '.nodes | type == "array"'

# Every node must have a type in the schema enum. If any node survives
# with an unknown type, the schema.parse at the end of the route is the
# next place to add it — but the sweep catches the drift here first.
GRAPH_BODY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/graph")
UNKNOWN_TYPES=$(echo "$GRAPH_BODY" | jq -r \
  '.nodes[]? | select((.type | IN("wiki","fragment","person","entry")) | not) | .type' \
  | sort -u)
if [ -z "$UNKNOWN_TYPES" ]; then
  pass "3d. every graph node has a known type"
else
  fail "3d. graph nodes have unknown types: $UNKNOWN_TYPES"
fi

# ── 4. Search ────────────────────────────────────────────────
sweep "4a." "/search?q=attention&limit=5"        '.results // .hits | type == "array"'

# ── 5. System / misc ─────────────────────────────────────────
sweep "5a." "/system/status"                     '.status | type == "string"'

# 5b. Favicon — covers #156. The route was added so MCP clients (and
# browsers hitting the core URL directly) stop falling back to an ugly
# placeholder. Pre-fix this 404'd; the smoke is one-line on $SERVER_URL.
sweep_binary "5b." "/favicon.ico" "image/x-icon"

# 5c. Seeded demo image asset — covers #160. The Transformer fixture's
# infobox.image.url points at /images/transformer-architecture.svg; the
# asset is served by the wiki Next.js frontend (NOT core), so this sweep
# targets $WIKI_URL. Pre-#160 the SVG didn't exist and the renderer's
# image branch had nothing to load.
sweep_binary "5c." "/images/transformer-architecture.svg" "image/svg+xml" "$WIKI_URL"

# ── 5d. Branding — favicon + public page logo wrap ───────────
# Covers #252 (partial). The favicon route is already handled by 5b
# above (covers #156), but #252 also calls out the public-wiki header
# at wiki/src/app/(public)/p/[nanoid]/PublishedWikiArticle.tsx:42 which
# renders bare "Robin Wiki" text — no logo SVG, no link to
# withrobin.ai/knowledge. Two checks:
#   5d-1 favicon byte signature looks non-default (size > 1024B is a
#         cheap proxy for "not the empty Lovable/Vercel placeholder";
#         the repo-checked-in core/assets/favicon.ico is ~15KB).
#   5d-2 a published wiki page rendered at /p/<nanoid> on $WIKI_URL
#         contains BOTH (a) a link to withrobin.ai/knowledge and (b) a
#         logo element (svg or img) inside the <header>. Bare text
#         fails this. We need a published wiki to hit /p/<slug>; if
#         none is seeded we publish one transiently and unpublish in
#         cleanup so downstream plans see no residue.

# 5d-1. favicon size sanity. Default empty ICOs are ≤1024B.
FAVICON_BYTES=$(curl -s -o /tmp/uat-99-favicon.ico -w "%{size_download}" "$SERVER_URL/favicon.ico")
if [ "${FAVICON_BYTES:-0}" -gt 1024 ]; then
  pass "5d-1. favicon is ${FAVICON_BYTES}B (>1024B — likely Robin-branded, not default placeholder)"
else
  fail "5d-1. favicon is ${FAVICON_BYTES}B (≤1024B — looks like default placeholder)"
fi

# 5d-2. public page header has a logo + withrobin.ai/knowledge link.
# Reach for a published wiki; fall back to publishing one transiently.
PUB_SLUG=$(psql "$DATABASE_URL" -tA -c \
  "SELECT published_slug FROM wikis WHERE published = true AND published_slug IS NOT NULL LIMIT 1" 2>/dev/null)
PUB_TRANSIENT_KEY=""
if [ -z "$PUB_SLUG" ]; then
  # Publish the first available wiki so /p/<slug> exists. We'll
  # unpublish it in cleanup. The publish endpoint is POST /wikis/:id/publish.
  CAND_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].id // empty')
  if [ -n "$CAND_KEY" ]; then
    PUB_RES=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      -X POST "$SERVER_URL/wikis/$CAND_KEY/publish")
    PUB_SLUG=$(echo "$PUB_RES" | jq -r '.publishedSlug // empty')
    if [ -n "$PUB_SLUG" ]; then
      PUB_TRANSIENT_KEY="$CAND_KEY"
    fi
  fi
fi

if [ -z "$PUB_SLUG" ]; then
  skip "5d-2. no published wiki and could not publish one — skip header logo check"
else
  PAGE_HTML=$(curl -s "$WIKI_URL/p/$PUB_SLUG")
  HAS_WITHROBIN_LINK=$(echo "$PAGE_HTML" | grep -c 'withrobin\.ai/knowledge' || true)
  HAS_LOGO_ELEM=$(echo "$PAGE_HTML" | grep -cE '<header[^>]*>.*(<svg|<img)' || true)
  # The header may span multiple lines after Next.js' RSC render — fall
  # back to a presence-anywhere-on-page check that flags missing logo
  # specifically inside any element labelled header/branding.
  if [ "${HAS_LOGO_ELEM:-0}" -eq 0 ]; then
    HAS_LOGO_ELEM=$(echo "$PAGE_HTML" | tr -d '\n' | grep -cE '<header[^>]*>[^<]*(<svg|<img)' || true)
  fi
  if [ "${HAS_WITHROBIN_LINK:-0}" -ge 1 ]; then
    pass "5d-2a. /p/$PUB_SLUG contains withrobin.ai/knowledge link"
  else
    fail "5d-2a. /p/$PUB_SLUG missing withrobin.ai/knowledge link (#252 logo wrap)"
  fi
  if [ "${HAS_LOGO_ELEM:-0}" -ge 1 ]; then
    pass "5d-2b. /p/$PUB_SLUG header contains a logo element (svg/img)"
  else
    fail "5d-2b. /p/$PUB_SLUG header has no <svg>/<img> logo — bare text only (#252)"
  fi

  # 5d-3. GitHub star button (#219). The published wiki header is a
  # stable surface (#252) so we anchor the star CTA there. Three
  # assertions:
  #   5d-3a a link to github.com/withrobinhq/robinwiki exists
  #   5d-3b that link opens in a new tab — target="_blank" AND
  #         rel containing both "noopener" and "noreferrer" (mandatory
  #         for external links — opening external links without
  #         rel-noopener is a tabnabbing security smell)
  #   5d-3c a visible star indicator: literal text "Star" or a
  #         star-shaped SVG (presence, not aesthetics).
  HAS_GH_LINK=$(echo "$PAGE_HTML" | grep -cE 'href="https://github\.com/withrobinhq/robinwiki' || true)
  # Locate the anchor tag containing the github link and verify its
  # target/rel attributes. The tag may span lines after Next.js render.
  GH_ANCHOR=$(echo "$PAGE_HTML" | tr -d '\n' | grep -oE '<a[^>]*href="https://github\.com/withrobinhq/robinwiki[^>]*>' | head -1)
  HAS_GH_BLANK=0
  HAS_GH_NOOPENER=0
  HAS_GH_NOREFERRER=0
  if [ -n "$GH_ANCHOR" ]; then
    echo "$GH_ANCHOR" | grep -q 'target="_blank"' && HAS_GH_BLANK=1
    echo "$GH_ANCHOR" | grep -qE 'rel="[^"]*noopener' && HAS_GH_NOOPENER=1
    echo "$GH_ANCHOR" | grep -qE 'rel="[^"]*noreferrer' && HAS_GH_NOREFERRER=1
  fi
  # Visible star indicator: text "Star" anywhere on the published page,
  # or an svg/icon hint (lucide ships <svg class="lucide-star"...>; an
  # inline path with the canonical 5-point star "M12 2l..." also counts).
  HAS_STAR_TEXT=$(echo "$PAGE_HTML" | grep -cE '>[^<]*Star[^<]*<' || true)
  HAS_STAR_ICON=$(echo "$PAGE_HTML" | grep -cE 'lucide-star|class="[^"]*star[^"]*"' || true)

  if [ "${HAS_GH_LINK:-0}" -ge 1 ]; then
    pass "5d-3a. /p/$PUB_SLUG contains github.com/withrobinhq/robinwiki link (#219)"
  else
    fail "5d-3a. /p/$PUB_SLUG missing github.com/withrobinhq/robinwiki link (#219)"
  fi
  if [ "${HAS_GH_BLANK}" = "1" ] && [ "${HAS_GH_NOOPENER}" = "1" ] && [ "${HAS_GH_NOREFERRER}" = "1" ]; then
    pass "5d-3b. github star link opens in new tab with rel=\"noopener noreferrer\" (#219)"
  else
    fail "5d-3b. github star link missing target=_blank or rel=noopener/noreferrer (target=$HAS_GH_BLANK noopener=$HAS_GH_NOOPENER noreferrer=$HAS_GH_NOREFERRER) (#219)"
  fi
  if [ "${HAS_STAR_TEXT:-0}" -ge 1 ] || [ "${HAS_STAR_ICON:-0}" -ge 1 ]; then
    pass "5d-3c. /p/$PUB_SLUG shows visible star indicator (text or icon) (#219)"
  else
    fail "5d-3c. /p/$PUB_SLUG has no visible star text or star icon (#219)"
  fi

  # Cleanup: only unpublish if WE published this wiki. Don't touch
  # pre-published ones; downstream plans may depend on them.
  if [ -n "$PUB_TRANSIENT_KEY" ]; then
    curl -s -o /dev/null -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      -X POST "$SERVER_URL/wikis/$PUB_TRANSIENT_KEY/unpublish"
  fi
fi
rm -f /tmp/uat-99-favicon.ico

# ── 6. Cross-kind: every response referenced by the sidecar parses ───
# Walks the wiki detail's `refs` map — every person/fragment/wiki/entry
# reference must resolve to a live detail endpoint. Catches "seed created
# an edge but the target row is missing" and "detail schema rejects the
# seeded shape" in one pass.
REFS_JSON=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$WIKI_KEY" | jq '.refs // {}')
BROKEN_REFS=0
while IFS=$'\t' read -r kind slug id; do
  [ -z "$kind" ] && continue
  case "$kind" in
    person)   detail_path="/people/$id" ;;
    fragment) detail_path="/fragments/$id" ;;
    wiki)     detail_path="/wikis/$id" ;;
    entry)    detail_path="/entries/$id" ;;
    *)        continue ;;
  esac
  detail_code=$(curl -s -o /dev/null -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    -w "%{http_code}" "$SERVER_URL$detail_path")
  if [ "$detail_code" != "200" ]; then
    BROKEN_REFS=$((BROKEN_REFS+1))
    echo "    broken ref: $kind:$slug → $detail_path returned $detail_code"
  fi
done < <(echo "$REFS_JSON" | jq -r 'to_entries[] | "\(.value.kind)\t\(.value.slug)\t\(.value.id)"')

if [ "$BROKEN_REFS" = "0" ]; then
  pass "6. every sidecar ref resolves to a live detail endpoint"
else
  fail "6. $BROKEN_REFS sidecar refs point at missing or erroring detail rows"
fi

# ── 7. Cross-asset linkage — sidecar infobox.image.url resolves ──
# Covers #160. The wiki sidecar's infobox may carry an image URL; the
# renderer's image branch is dead weight unless that URL is fetchable.
# This step closes the loop: take the URL the API serves and confirm
# it returns 200 from the wiki frontend (which is where /images/* is
# hosted — NOT core). If the seeded fixture doesn't include an image,
# this is a documented SKIP.
IMAGE_URL=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
  "$SERVER_URL/wikis/$WIKI_KEY" | jq -r '.infobox.image.url // empty')
if [ -n "$IMAGE_URL" ]; then
  CODE=$(curl -sI -o /dev/null -w "%{http_code}" "$WIKI_URL$IMAGE_URL")
  if [ "$CODE" = "200" ]; then
    pass "7a. infobox.image.url ($IMAGE_URL) resolves 200 on \$WIKI_URL"
  else
    fail "7a. infobox.image.url $IMAGE_URL returned $CODE on \$WIKI_URL"
  fi
else
  skip "7a. infobox.image.url not present on this wiki — nothing to resolve"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0 | Authenticated session established; Transformer fixture keys resolved | prerequisite |
| 1 | Listing endpoints (`/wikis`, `/fragments`, `/people`, `/entries`, `/wiki-types`) all 200 + shape | top-level surface |
| 2 | Detail endpoints (`/wikis/:id` incl. sidecar keys, `/wikis/:id/timeline`, `/wikis/:id/history`, `/fragments/:id`, `/people/:id`) all 200 + shape | detail surface; #139 regression guard |
| 3 | `/graph` returns valid nodes + edges; every node has a schema-known type | #153 regression guard |
| 4 | `/search` returns results shape | search endpoint |
| 5 | `/system/status` returns 200 + `.status`; `/favicon.ico` (5b) returns 200 + `image/x-icon` on `$SERVER_URL`; `/images/transformer-architecture.svg` (5c) returns 200 + `image/svg+xml` on `$WIKI_URL` | system endpoint; #156 (favicon); #160 (SVG asset) |
| 5d-1 | `/favicon.ico` byte size > 1024B (Robin-branded, not default placeholder) | #252 |
| 5d-2a | `/p/<slug>` page contains a `withrobin.ai/knowledge` link | #252 (`PublishedWikiArticle.tsx:42`) |
| 5d-2b | `/p/<slug>` `<header>` contains an `<svg>` or `<img>` logo element | #252 (`PublishedWikiArticle.tsx:42`) |
| 5d-3a | `/p/<slug>` page contains a `github.com/withrobinhq/robinwiki` link | #219 |
| 5d-3b | The GitHub star anchor has `target="_blank"` AND `rel="noopener noreferrer"` | #219 |
| 5d-3c | A visible star indicator (text "Star" or star icon SVG) is rendered on the page | #219 |
| 6 | Every ref in the wiki sidecar resolves to a live detail endpoint | cross-kind integrity |
| 7 | The wiki sidecar's `infobox.image.url`, when present, resolves 200 on `$WIKI_URL` (cross-asset linkage) | #160 |

---

## Notes

- The sweep is deliberately authenticated-only. Unauthenticated surface (published routes, `/health`) has narrower contracts and is covered by plan 01 and published-route plans.
- Shape checks are minimal (`type == "array"`, key existence). They're designed to catch "entire payload was stripped" and "endpoint returns a string instead of an object" — not exhaustive validation. Per-feature plans still own deep assertions.
- When a new top-level endpoint ships, add a `sweep` line here. The sweep should grow with the API surface.
- If `agent-browser` or the wiki frontend changes port convention, this plan is unaffected — it only hits `SERVER_URL`.
