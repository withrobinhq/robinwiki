# 11 — Search (advanced filters: ?tables= and ?tags=)

## What it proves

Issue #46 — advanced search filters at the REST surface.

**(§1) `?tables=` already does what `?type=` asked for.** Existing schema
already accepts `tables=fragment,wiki,person` as a union over the row
discriminator. We assert the basics still hold: omitting `tables=`
returns a mixed result set; restricting to a single table returns only
that type.

**(§2) `?tags=` filter (NEW — added in #46).** The new
`?tags=foo,bar` parameter restricts BM25 results to fragments whose
`tags` jsonb array intersects (UNION semantics — *any* of the listed
tags qualifies). Wikis and people have no `tags` column, so the filter
is a no-op for those tables. Semantics chosen to mirror `?tables=`,
which already means "any of these tables" — picking AND would be
asymmetric and surprising.

The new assertion has TWO sides:
- **Positive:** a fragment tagged with `["foo"]` surfaces when we
  search with `?tags=foo`.
- **Negative:** an untagged fragment with the same body text does NOT
  surface when we search with `?tags=foo`.

Without the negative, a missing-filter regression (e.g. param parsed
but never applied) would silently pass.

## Pre-fix expectations

- §1a / §1b (existing `?tables=` behaviour): pass on both pre- and
  post-#46.
- §2a (positive: tagged fragment surfaces with `?tags=foo`): **fails**
  pre-#46 (the param is unknown to the schema → 400, or ignored → both
  fragments returned and the test still fails on the negative side).
- §2b (negative: untagged fragment hidden with `?tags=foo`): **fails**
  pre-#46 — without filter implementation, both fragments come back.

## Prerequisites

- Core running on `SERVER_URL`.
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `jq` and `curl` installed.

## Fixture identity this plan references

- Per-run salt `RUN_ID="$(date +%s)-$$"`.
- Per-run UAT raw_source: `uat11-search-<RUN_ID>`.
- Per-run UAT fragments:
  - `Tagged Probe <RUN_ID>` (tags=`["uat11-foo"]`) — §2 positive.
  - `Untagged Probe <RUN_ID>` (tags=`[]`) — §2 negative. Body text
    intentionally shares the salt so a no-filter search would match
    both.

## Restoring downstream-plan state

Cleanup deletes every per-RUN_ID row + the parent raw_source. No
shared-corpus drift.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:${PORT:-3000}}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-11-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

RUN_ID="$(date +%s)-$$"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "11 — Search (advanced filters: ?tables= and ?tags=)"
echo ""

# ── 0. Sign in ──────────────────────────────────────────────
curl -s -o /dev/null -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVER_URL" \
  -d "$(jq -n --arg u "${INITIAL_USERNAME:-}" --arg p "${INITIAL_PASSWORD:-}" \
    '{email:$u,password:$p}')" \
  "$SERVER_URL/api/auth/sign-in/email"

if [ -s "$COOKIE_JAR" ]; then
  pass "0a. sign-in established a session cookie"
else
  fail "0a. sign-in failed"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# Parent entry.
ENTRY_RESP=$(curl -s -b "$COOKIE_JAR" -H "Origin: $SERVER_URL" \
  -H "Content-Type: application/json" \
  -X POST -d "$(jq -n --arg c "uat11-search-$RUN_ID" '{content:$c}')" \
  "$SERVER_URL/entries")
ENTRY_ID=$(echo "$ENTRY_RESP" | jq -r '.lookupKey // .id // empty')
if [ -n "$ENTRY_ID" ] && [ "$ENTRY_ID" != "null" ]; then
  pass "0b. created parent entry ($ENTRY_ID)"
else
  fail "0b. could not create parent entry: $ENTRY_RESP"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

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

bm25_search() {
  local q="$1" extra="$2"
  curl -s -b "$COOKIE_JAR" -H "Origin: $SERVER_URL" \
    --get \
    --data-urlencode "q=$q" \
    --data-urlencode "mode=bm25" \
    $extra \
    "$SERVER_URL/search"
}

# ── §1. ?tables= as the single source of type-filtering ──────
# Existing behaviour; must keep passing.

F_TABLE_RESP=$(mk_fragment \
  "Tables Probe $RUN_ID" \
  "Distinctive uat11tables $RUN_ID body content." \
  '[]')
F_TABLE_KEY=$(echo "$F_TABLE_RESP" | jq -r '.lookupKey // empty')
if [ -n "$F_TABLE_KEY" ]; then
  pass "§1a-i. created §1 control fragment '$F_TABLE_KEY'"
else
  fail "§1a-i. could not create §1 fragment: $F_TABLE_RESP"
fi

# tables=fragment must include our fragment.
T_HITS=$(bm25_search "uat11tables $RUN_ID" "--data-urlencode tables=fragment" \
  | jq --arg k "$F_TABLE_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${T_HITS:-0}" -ge 1 ]; then
  pass "§1a-ii. tables=fragment returns the §1 fragment"
else
  fail "§1a-ii. tables=fragment did not return §1 fragment"
fi

# tables=wiki must NOT include the fragment.
W_HITS=$(bm25_search "uat11tables $RUN_ID" "--data-urlencode tables=wiki" \
  | jq --arg k "$F_TABLE_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${W_HITS:-0}" -eq 0 ]; then
  pass "§1b. tables=wiki excludes the fragment (table-discriminator works)"
else
  fail "§1b. tables=wiki returned the fragment — type-discriminator broken"
fi

# ── §2. ?tags= filter — new in #46 ──────────────────────────
# Two fragments share the same distinctive body salt so a no-filter
# search would match both. Tags differentiate them. With ?tags=uat11-foo:
#   POSITIVE — Tagged Probe must surface (its tags array contains foo).
#   NEGATIVE — Untagged Probe must NOT surface (empty tags array).

F_TAG_RESP=$(mk_fragment \
  "Tagged Probe $RUN_ID" \
  "Distinctive uat11tagsalt $RUN_ID body — tagged variant." \
  '["uat11-foo"]')
F_TAG_KEY=$(echo "$F_TAG_RESP" | jq -r '.lookupKey // empty')

F_NOTAG_RESP=$(mk_fragment \
  "Untagged Probe $RUN_ID" \
  "Distinctive uat11tagsalt $RUN_ID body — untagged variant." \
  '[]')
F_NOTAG_KEY=$(echo "$F_NOTAG_RESP" | jq -r '.lookupKey // empty')

if [ -n "$F_TAG_KEY" ] && [ -n "$F_NOTAG_KEY" ]; then
  pass "§2-setup. created tagged ($F_TAG_KEY) + untagged ($F_NOTAG_KEY) fragments"
else
  fail "§2-setup. could not create §2 fragments"
fi

# Sanity — no filter, both surface.
NOFILTER=$(bm25_search "uat11tagsalt $RUN_ID" "")
SANITY_TAG=$(echo "$NOFILTER"   | jq --arg k "$F_TAG_KEY"   '[.results[] | select(.id==$k)] | length')
SANITY_NOTAG=$(echo "$NOFILTER" | jq --arg k "$F_NOTAG_KEY" '[.results[] | select(.id==$k)] | length')
if [ "${SANITY_TAG:-0}" -ge 1 ] && [ "${SANITY_NOTAG:-0}" -ge 1 ]; then
  pass "§2-sanity. no-filter search surfaces both probes (control)"
else
  fail "§2-sanity. no-filter search missed a probe — recall broken upstream"
fi

# Apply ?tags=uat11-foo.
TAG_RESP=$(bm25_search "uat11tagsalt $RUN_ID" "--data-urlencode tags=uat11-foo")

POS_HITS=$(echo "$TAG_RESP" | jq --arg k "$F_TAG_KEY"   '[.results[] | select(.id==$k)] | length')
NEG_HITS=$(echo "$TAG_RESP" | jq --arg k "$F_NOTAG_KEY" '[.results[] | select(.id==$k)] | length')

# Positive: tagged fragment surfaces.
if [ "${POS_HITS:-0}" -ge 1 ]; then
  pass "§2a (POSITIVE). tags=uat11-foo surfaces tagged fragment"
else
  fail "§2a (POSITIVE). tags=uat11-foo did NOT surface tagged fragment (CURRENTLY FAILS pre-#46)"
fi

# Negative: untagged fragment excluded.
if [ "${NEG_HITS:-0}" -eq 0 ]; then
  pass "§2b (NEGATIVE). tags=uat11-foo excludes untagged fragment"
else
  fail "§2b (NEGATIVE). tags=uat11-foo did NOT exclude untagged fragment — filter ignored (CURRENTLY FAILS pre-#46)"
fi

# ── Cleanup ──────────────────────────────────────────────────
if [ -n "${DATABASE_URL:-}" ]; then
  for k in "$F_TABLE_KEY" "$F_TAG_KEY" "$F_NOTAG_KEY"; do
    [ -n "$k" ] && psql "$DATABASE_URL" -q -c \
      "DELETE FROM fragments WHERE lookup_key='$k'" >/dev/null 2>&1
  done
  if [ -n "${ENTRY_ID:-}" ]; then
    psql "$DATABASE_URL" -q -c "DELETE FROM pipeline_events WHERE entry_id='$ENTRY_ID'" >/dev/null 2>&1
    psql "$DATABASE_URL" -q -c "DELETE FROM processed_jobs WHERE job_id='$ENTRY_ID'" >/dev/null 2>&1
    psql "$DATABASE_URL" -q -c "DELETE FROM raw_sources WHERE lookup_key='$ENTRY_ID'" >/dev/null 2>&1
  fi
  pass "cleanup. per-RUN_ID rows deleted"
else
  skip "cleanup. DATABASE_URL unset — per-RUN_ID rows left in place"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```

## Expected outcome (pre-#46 vs post-#46)

| Section | Pre-#46 | Post-#46 |
| --- | --- | --- |
| §1a-i / §1a-ii / §1b (`?tables=`) | pass | pass |
| §2-setup / §2-sanity | pass | pass |
| §2a (POSITIVE: tagged fragment surfaces) | **fail** | pass |
| §2b (NEGATIVE: untagged excluded) | **fail** | pass |
| cleanup | pass | pass |

## Tag-filter semantics — UNION (any-of)

`?tags=a,b` returns rows whose tag array intersects `{a, b}`. Picked
to mirror `?tables=`, which is also union over the discriminator. AND
(intersect-all) was rejected because no consumer asked for it and
asymmetric semantics across two filter parameters is the kind of
papercut that bites integrators six months later.
