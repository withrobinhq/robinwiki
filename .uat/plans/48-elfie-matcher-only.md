# 48 — Elfie matcher-only (#237)

## What it proves

Issue #237 re-positions Elfie (the `people-extraction` agent) as a
matcher, not an extractor. Pre-fix, Elfie surfaced unmatched person
mentions with `matchedKey: null`, and `entityExtract` then created new
Person rows for them via `resolvePerson({ isNew: true })` →
`newPeople.push(…)` → `persist.upsertPerson()`.

Post-fix:

1. **Prompt-side**: `people-extraction.yaml` (version: 2) instructs
   Elfie to ONLY return people that match an entry in KNOWN PEOPLE.
   Mentions with no match are dropped silently. Few-shot examples are
   replaced to demonstrate this — including a known-people-empty case
   that returns `{"people": []}`.
2. **Stage-side**: `entityExtract` uses `resolvePerson()` purely as a
   "did this match?" check. When `isNew: true`, the mention is dropped
   (no `peopleMap` entry, no `newPeople` push). The returned
   `extractions` array is filtered to matched-only so persist's
   mention-to-fragment edge logic can't re-introduce a dropped name.
3. **Persist invariant**: feeding text with an unknown person no longer
   creates a Person row, no longer creates a `FRAGMENT_MENTIONS_PERSON`
   edge to a non-existent key. Feeding text with a known person still
   creates the edge.

## Negative + positive assertions

| § | Kind | Check |
|---|------|-------|
| 1a | POS | `people-extraction.yaml` is version: 2 |
| 1b | POS | `people-extraction.yaml` calls Elfie a "matcher" (not "extractor") |
| 1c | POS | Prompt instructs to DROP unmatched mentions (e.g. "drop", "skip", "do not return") |
| 1d | NEG | Prompt no longer says "If a person is new, set matchedKey to null" |
| 2a | NEG | `entity-extract.ts` no longer pushes onto `newPeople` for unknown mentions inside the resolution loop |
| 2b | POS | `entity-extract.ts` references `unmatchedDropped` (the new metric in emitEvent metadata) |
| 3a | POS | Unit test updated: returns 0 newPeople even when LLM yields a `matchedKey: null` extraction |

## Notes on AI-quality assertions skipped

A live ingest test ("real entry mentioning a brand-new name 'Carol' in
text DOES NOT produce a `people` row for Carol") would prove the same
invariant end-to-end but requires booting the worker stack. The unit
test asserted in §3a covers the matcher-only invariant deterministically
without an LLM in the loop.

A negative DB-row-count assertion ("count of `people` rows after
ingesting an entry with one unmatched mention is unchanged") would also
require the full stack — captured structurally by §2a.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-/home/me/apps/robin}"

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "48 — Elfie matcher-only (#237)"
echo ""

YAML="packages/shared/src/prompts/specs/people-extraction.yaml"
STAGE="packages/agent/src/stages/entity-extract.ts"
TEST="packages/agent/src/__tests__/entity-extract.test.ts"

if [ ! -f "$YAML" ] || [ ! -f "$STAGE" ] || [ ! -f "$TEST" ]; then
  fail "0a. one of the target files is missing"
  echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi
pass "0a. all target files present"

# ── 1. Prompt re-positioned as matcher ───────────────────────
if grep -qE '^version:\s*2\b' "$YAML"; then
  pass "1a. people-extraction.yaml is version: 2"
else
  CV=$(grep -E '^version:' "$YAML" | head -1)
  fail "1a. people-extraction.yaml not version 2 (saw: $CV)"
fi

if grep -qiE '\b(entity matcher|matcher-only|the matcher)\b' "$YAML"; then
  pass "1b. yaml positions Elfie as a matcher"
else
  fail "1b. yaml does not position Elfie as a matcher"
fi

# Prompt MUST tell the agent what to do with unmatched mentions: drop / skip.
if grep -qiE 'drop (it|the unmatched)|skip (it|the unmatched)|drop them silently|do not return' "$YAML"; then
  pass "1c. yaml instructs to drop/skip unmatched mentions"
else
  fail "1c. yaml lacks an explicit drop/skip rule"
fi

# Pre-fix prompt instruction: "If a person is new, set matchedKey to null."
# (a positive directive to emit null). Post-fix the prompt may still
# contain matchedKey-null mentions in NEGATIVE contexts ("never",
# "do NOT", "drop instead"), which is fine — those forbid the old
# behaviour. The assertion is therefore: there must be no positive
# directive to set/return matchedKey: null.
POSITIVE_NULL=$(grep -inE 'matchedKey' "$YAML" \
  | grep -ivE 'never|not |no\b|drop|forbidden|don['"'"']t|MUST|valid')
if echo "$POSITIVE_NULL" | grep -qiE 'matchedKey.*null'; then
  fail "1d. yaml still has a positive directive to emit matchedKey: null"
  echo "      offending lines: $POSITIVE_NULL"
else
  pass "1d. yaml no longer instructs matchedKey: null for unknowns"
fi

# ── 2. Stage drops unmatched mentions ────────────────────────
# Pre-fix entity-extract.ts had `if (resolved.isNew) { newPeople.push(...) }`.
# Post-fix the if-isNew branch must be a `continue` / drop, not a push.
# Strict shape check: there must NOT be a `newPeople.push(` adjacent to
# a `resolved.isNew` block.
if awk '/resolved\.isNew/{flag=1} /newPeople\.push/{if(flag){print "HIT"; exit}} /^\s*}\s*$/{flag=0}' "$STAGE" | grep -q HIT; then
  fail "2a. stage still pushes onto newPeople for resolved.isNew mentions"
else
  pass "2a. stage no longer pushes onto newPeople for unmatched mentions"
fi

if grep -q 'unmatchedDropped' "$STAGE"; then
  pass "2b. stage tracks unmatchedDropped"
else
  fail "2b. stage missing unmatchedDropped metric"
fi

# ── 3. Test updated ──────────────────────────────────────────
if grep -q 'matcher-only\|#237' "$TEST"; then
  pass "3a. test references matcher-only / #237"
else
  fail "3a. test does not reference matcher-only / #237"
fi

# Tighten: the test must assert newPeople has length 0 even when an
# extraction with matchedKey: null is fed to the LLM mock.
if grep -q 'newPeople).toHaveLength(0)' "$TEST"; then
  pass "3b. test asserts 0 newPeople for the unmatched fixture"
else
  fail "3b. test does not assert 0 newPeople"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```
