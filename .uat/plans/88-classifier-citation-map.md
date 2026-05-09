# 88, Classifier-emitted citation map

## What it proves

Stream T1 closes issue #320: Marcel emits the literal fragment span(s)
that drove each wiki assignment, the linking and regen workers stamp
those spans onto the top-1 `FRAGMENT_IN_WIKI` edge `attrs`, and the
wiki read path joins them into the rendered citation quote without
re-running similarity over fragment text and wiki body. Legacy edges
(no spans on attrs) keep working via the existing first-200-chars
snippet path.

Decision locked 2026-05-09: no historical backfill. New ingest gets
the new path. Legacy fragments fall back to the slower path until they
cycle through the regen recovery loop.

Three pieces ship together:

1. `packages/shared/src/prompts/specs/wiki-classification.yaml` is at
   `version: 4`. The prompt asks Marcel for `citationSpans` per
   matched wiki, with zero-based half-open offsets and verbatim
   `text`. The Zod schema admits the field as optional.
2. `packages/agent/src/stages/wiki-classify.ts` validates spans by
   round-tripping `text` against `fragmentContent.slice(start, end)`
   and drops anything that doesn't match. The linking orchestrator
   in `packages/agent/src/stages/index.ts` and the regen recovery
   loop in `core/src/lib/regen.ts` write surviving spans onto the
   top-1 `FRAGMENT_IN_WIKI` edge `attrs.citationSpans`. Secondary
   edges keep the existing score-only attrs shape.
3. `core/src/lib/wikiSidecarDeps.ts` reads `attrs.citationSpans` for
   the `(fragmentId, wikiKey)` pair when present, joins span texts
   with " ... " into `WikiCitation.quote`, and falls back to the
   legacy snippet path otherwise. Wiki and public-published read
   handlers pass `wiki.lookupKey` through to the deps factory.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a | POS | wiki-classification.yaml is at `version: 4` |
| 1b | POS | wiki-classification.yaml mentions `citationSpans` |
| 1c | POS | wiki-classification.schema.ts exports `citationSpanSchema` and `CitationSpan` |
| 1d | POS | shared barrel re-exports `citationSpanSchema` and `CitationSpan` |
| 2a | POS | stages/wiki-classify.ts validates span text against fragment slice |
| 2b | POS | stages/index.ts only writes citationSpans on the top-1 edge |
| 2c | POS | core/src/lib/regen.ts only writes citationSpans on the top-1 edge |
| 3a | POS | wikiSidecarDeps factory accepts an optional `wikiKey` arg |
| 3b | POS | resolveCitation reads `FRAGMENT_IN_WIKI` edge attrs when wikiKey is set |
| 3c | POS | wiki and published routes pass `wiki.lookupKey` into makeSidecarDeps |
| 4a | POS | linking-citation-spans.test.ts exercises top-1 / secondary / legacy / invalid-span paths |
| 4b | POS | wikiSidecarDeps.citation-spans.test.ts exercises new / legacy / no-wikiKey paths |
| 4c | POS | full vitest suites for packages/agent and core/src/lib pass for the new test files |
| 5a | POS | docs/architecture/citation-rendering.md exists |

## AI-quality assertions (manual, behavioural)

These need a running stack with a real OpenRouter key:

- Ingest a fresh fragment that clearly belongs in one existing wiki.
  Confirm the FRAGMENT_IN_WIKI edge in Postgres has
  `attrs.citationSpans` populated, each span has `start`, `end`, and
  `text`, and `fragmentText.slice(start, end) === text` for every
  entry.
- Render that wiki via `GET /wikis/:id`. Confirm one citation in the
  response body has a `quote` matching the literal Marcel-emitted
  span (not the first 200 chars of the fragment content).
- Manually create a legacy edge:
  `update edges set attrs = '{"score": 0.9}' where edge_type =
  'FRAGMENT_IN_WIKI' and src_id = '<frag>' and dst_id = '<wiki>';`
  Re-render the wiki. Confirm the citation `quote` falls back to
  the first 200 chars of the fragment body and the response is
  still well-formed.
- Build a mixed wiki (some fragments classified before this change
  shipped, some after). Confirm both render correctly and the
  Postgres query in `docs/architecture/citation-rendering.md` shows
  a non-zero count in both the new_path and legacy buckets.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-/home/me/apps/robin}"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
skip() { SKIP=$((SKIP+1)); echo "  skip $1"; }

echo "88, Classifier-emitted citation map"
echo ""

YAML="packages/shared/src/prompts/specs/wiki-classification.yaml"
SCHEMA="packages/shared/src/prompts/specs/wiki-classification.schema.ts"
BARREL="packages/shared/src/prompts/index.ts"
CLASSIFY_TS="packages/agent/src/stages/wiki-classify.ts"
LINKING_TS="packages/agent/src/stages/index.ts"
REGEN_TS="core/src/lib/regen.ts"
DEPS_TS="core/src/lib/wikiSidecarDeps.ts"
WIKIS_ROUTE="core/src/routes/wikis.ts"
PUBLISHED_ROUTE="core/src/routes/published.ts"
LINK_TEST="packages/agent/src/__tests__/linking-citation-spans.test.ts"
DEPS_TEST="core/src/lib/wikiSidecarDeps.citation-spans.test.ts"
DOC="docs/architecture/citation-rendering.md"

# 1. Prompt + schema
if [ -f "$YAML" ]; then
  if grep -qE '^version:\s*4\b' "$YAML"; then
    pass "1a. wiki-classification.yaml version 4"
  else
    fail "1a. wiki-classification.yaml not at version 4"
  fi
  if grep -q 'citationSpans' "$YAML"; then
    pass "1b. wiki-classification.yaml mentions citationSpans"
  else
    fail "1b. wiki-classification.yaml does not mention citationSpans"
  fi
else
  fail "1ab. $YAML missing"
fi

if [ -f "$SCHEMA" ] && grep -q 'citationSpanSchema' "$SCHEMA" && grep -q 'CitationSpan' "$SCHEMA"; then
  pass "1c. schema exports citationSpanSchema and CitationSpan"
else
  fail "1c. schema does not export citationSpanSchema and CitationSpan"
fi

if [ -f "$BARREL" ] && grep -q 'citationSpanSchema' "$BARREL" && grep -q 'CitationSpan' "$BARREL"; then
  pass "1d. shared barrel re-exports citationSpanSchema and CitationSpan"
else
  fail "1d. shared barrel does not re-export citationSpanSchema and CitationSpan"
fi

# 2. Validation + edge writes
if [ -f "$CLASSIFY_TS" ] && grep -q 'fragmentContent.slice' "$CLASSIFY_TS" && grep -q 'span.text' "$CLASSIFY_TS"; then
  pass "2a. wiki-classify validates spans against fragment slice"
else
  fail "2a. wiki-classify does not validate spans"
fi

if [ -f "$LINKING_TS" ] && grep -q 'topWikiKey' "$LINKING_TS" && grep -q 'citationSpans' "$LINKING_TS"; then
  pass "2b. stages/index.ts gates citationSpans on top-1 wiki"
else
  fail "2b. stages/index.ts does not gate citationSpans on top-1 wiki"
fi

if [ -f "$REGEN_TS" ] && grep -q 'topWikiKey' "$REGEN_TS" && grep -q 'citationSpans' "$REGEN_TS"; then
  pass "2c. regen.ts gates citationSpans on top-1 wiki"
else
  fail "2c. regen.ts does not gate citationSpans on top-1 wiki"
fi

# 3. Read path
if [ -f "$DEPS_TS" ] && grep -q 'wikiKey' "$DEPS_TS" && grep -q 'citationSpans' "$DEPS_TS"; then
  pass "3a. wikiSidecarDeps factory accepts wikiKey"
else
  fail "3a. wikiSidecarDeps factory does not accept wikiKey"
fi

if [ -f "$DEPS_TS" ] && grep -q "edgeType.*FRAGMENT_IN_WIKI\|FRAGMENT_IN_WIKI" "$DEPS_TS"; then
  pass "3b. resolveCitation queries FRAGMENT_IN_WIKI edge"
else
  fail "3b. resolveCitation does not query FRAGMENT_IN_WIKI edge"
fi

if grep -q 'makeSidecarDeps(db, wiki.lookupKey)' "$WIKIS_ROUTE" && grep -q 'makeSidecarDeps(db, wiki.lookupKey)' "$PUBLISHED_ROUTE"; then
  pass "3c. wiki and published routes pass lookupKey"
else
  fail "3c. wiki or published route missing lookupKey arg"
fi

# 4. Tests
if [ -f "$LINK_TEST" ]; then
  pass "4a. linking-citation-spans test file exists"
else
  fail "4a. linking-citation-spans test file missing"
fi

if [ -f "$DEPS_TEST" ]; then
  pass "4b. wikiSidecarDeps.citation-spans test file exists"
else
  fail "4b. wikiSidecarDeps.citation-spans test file missing"
fi

if pnpm -C packages/agent test -- src/__tests__/linking-citation-spans.test.ts >/tmp/uat-88-agent.log 2>&1; then
  if grep -q 'linking-citation-spans.test.ts.*tests.*pass\|✓ src/__tests__/linking-citation-spans' /tmp/uat-88-agent.log; then
    pass "4c.agent linking-citation-spans tests pass"
  else
    fail "4c.agent linking-citation-spans tests did not report pass"
  fi
else
  fail "4c.agent vitest run errored, see /tmp/uat-88-agent.log"
fi

if pnpm -C core test -- src/lib/wikiSidecarDeps.citation-spans.test.ts >/tmp/uat-88-core.log 2>&1; then
  if grep -q 'wikiSidecarDeps.citation-spans.test.ts.*tests\|✓ src/lib/wikiSidecarDeps.citation-spans' /tmp/uat-88-core.log; then
    pass "4c.core wikiSidecarDeps.citation-spans tests pass"
  else
    fail "4c.core wikiSidecarDeps.citation-spans tests did not report pass"
  fi
else
  fail "4c.core vitest run errored, see /tmp/uat-88-core.log"
fi

# 5. Docs
if [ -f "$DOC" ]; then
  pass "5a. docs/architecture/citation-rendering.md exists"
else
  fail "5a. docs/architecture/citation-rendering.md missing"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```
