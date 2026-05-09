# 71, Fragmenter prompt v3 (richer fragments, reflective-claim retention)

## What it proves

The v6 prompt at `packages/shared/src/prompts/specs/fragmentation.yaml`
was over-splitting reflective entries. Baseline measurement: 69% of
fragments at 1 sentence, average 24 words each, 35% under 20 words.
Reflective claims like "Naming the feeling doesn't fix it" were being
cut by the fluff filter as essay scaffolding.

v3 (spec `version: 7`) tightens the prompt across five points:

1. Rule 4 no longer mandates splitting on compound sentences. The new
   bar is topic distinctness, not surface punctuation.
2. Rule 7 now states explicit word and sentence targets (30 to 60
   words, 2 to 3 sentences) plus an upper guardrail at 80 words.
3. New Rule 8 on PARAGRAPH STRUCTURE, treat author paragraphs as the
   default unit of fragmentation.
4. The fluff filter (now Rule 9) gains a reflective-claim exception,
   "does this sentence make a claim someone could disagree with?" If
   yes, preserve it.
5. Two new examples show claim-plus-reasoning belonging together
   (Kenya forest walk) and three distinct claims belonging apart
   (Robin model plus Outsourcing 2.0 plus 200 community members).

Calibration evidence (head-to-head on 8 entries): median word count
rises 24 to 32, under-20w share drops 35% to 25%, in-band 20-80w
share rises 64% to 74%, zero overshoot above 80w.

## Negative + positive assertions

| section | kind | check |
|---|---|---|
| 1a | POS | `fragmentation.yaml` is at `version: 7` |
| 1b | NEG | YAML contains zero em-dash characters (U+2014) |
| 2a | POS | Rule 4 mentions "ONLY when they are about distinct topics" |
| 2b | NEG | Rule 4 no longer says "compound sentence with multiple claims" must be split |
| 3a | POS | Rule 7 mentions "30 to 60 words" target |
| 3b | POS | Rule 7 mentions "Under 20 words indicates over-splitting" |
| 3c | POS | Rule 7 mentions "over 80 indicates aggregating distinct claims" |
| 4a | POS | New Rule 8 mentions "PARAGRAPH STRUCTURE" |
| 5a | POS | Rule 9 fluff filter has "EXCEPTION: reflective claims are NOT fluff" |
| 5b | POS | Rule 9 has "does this sentence make a claim someone could disagree with" |
| 6a | POS | Examples include "Kenya" or "forest" claim-plus-reasoning case |
| 6b | POS | Examples include "Outsourcing 2.0" distinct-claims case |
| 7a | POS | FOMO fixture exists at `core/eval/fragmentation/fixtures/21-reflective-fomo.json` |
| 7b | POS | FOMO fixture mustContain lists the four philosophical claims |
| 8a | POS | YAML parses without errors |

## AI-quality assertions (manual, behavioural)

These cannot be greppable, they require a live ingest run. Track
manually after deploy:

- Run a small test ingest with 5 to 8 reflective entries.
- Compute average fragment word count, expect rise into the 28 to 35
  range.
- Compute "under 20 word" share, expect drop versus current run
  baseline (was 35%, target sub-30%).
- Sample a FOMO-style post, assert key reflective claims (1st order
  losses, grief work, naming the feeling, ghost walking beside you)
  are present in produced fragments.
- Compute "over 80 word" share, expect zero.

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

echo "71, Fragmenter prompt v3"
echo ""

YAML="packages/shared/src/prompts/specs/fragmentation.yaml"
FIXTURE="core/eval/fragmentation/fixtures/21-reflective-fomo.json"

if [ ! -f "$YAML" ]; then
  fail "0a. $YAML missing"
  echo "$PASS passed, $FAIL failed, $SKIP skipped"; exit 1
fi
pass "0a. fragmenter yaml present"

# 1. Version + em-dash hygiene
if grep -qE '^version:\s*7\b' "$YAML"; then
  pass "1a. version: 7"
else
  CURRENT_VERSION=$(grep -E '^version:' "$YAML" | head -1)
  fail "1a. version is not 7 (saw: $CURRENT_VERSION)"
fi

if LC_ALL=C grep -q $'\xe2\x80\x94' "$YAML"; then
  fail "1b. yaml still contains em-dash (U+2014)"
else
  pass "1b. zero em-dashes in yaml"
fi

# 2. Rule 4 softened
if grep -q 'ONLY when they are about' "$YAML"; then
  pass "2a. Rule 4 mentions distinct-topics-only split"
else
  fail "2a. Rule 4 missing distinct-topics phrasing"
fi

if grep -q 'compound sentence with multiple claims' "$YAML"; then
  fail "2b. yaml still has the old must-split-compound-sentence text"
else
  pass "2b. old must-split-compound-sentence text removed"
fi

# 3. Rule 7 explicit word/sentence targets
if grep -q '30 to 60 words' "$YAML"; then
  pass "3a. Rule 7 mentions 30 to 60 words target"
else
  fail "3a. Rule 7 missing 30 to 60 words target"
fi

if grep -q 'Under 20 words indicates over-splitting' "$YAML"; then
  pass "3b. Rule 7 has under-20w guidance"
else
  fail "3b. Rule 7 missing under-20w guidance"
fi

if grep -q 'over 80 indicates' "$YAML"; then
  pass "3c. Rule 7 has over-80w guardrail"
else
  fail "3c. Rule 7 missing over-80w guardrail"
fi

# 4. Paragraph structure rule
if grep -q 'PARAGRAPH STRUCTURE' "$YAML"; then
  pass "4a. PARAGRAPH STRUCTURE rule present"
else
  fail "4a. PARAGRAPH STRUCTURE rule missing"
fi

# 5. Fluff filter reflective-claim exception
if grep -q 'EXCEPTION: reflective claims are NOT fluff' "$YAML"; then
  pass "5a. fluff filter has reflective-claim exception"
else
  fail "5a. fluff filter missing reflective-claim exception"
fi

if grep -q 'someone could disagree with' "$YAML"; then
  pass "5b. fluff filter has disagreement-test heuristic"
else
  fail "5b. fluff filter missing disagreement-test heuristic"
fi

# 6. New examples (Kenya, Outsourcing 2.0)
if grep -q 'Kenya' "$YAML"; then
  pass "6a. Kenya claim-plus-reasoning example present"
else
  fail "6a. Kenya example missing"
fi

if grep -q 'Outsourcing' "$YAML"; then
  pass "6b. Outsourcing 2.0 distinct-claims example present"
else
  fail "6b. Outsourcing 2.0 example missing"
fi

# 7. FOMO fixture
if [ ! -f "$FIXTURE" ]; then
  fail "7a. FOMO fixture missing at $FIXTURE"
else
  pass "7a. FOMO fixture present"

  for claim in '1st order losses' 'grief work' 'Naming the feeling' 'ghost walking beside you'; do
    if grep -q "$claim" "$FIXTURE"; then
      pass "7b. fixture mustContain has '$claim'"
    else
      fail "7b. fixture mustContain missing '$claim'"
    fi
  done
fi

# 8. YAML parses
if python3 -c "import yaml,sys; yaml.safe_load(open('$YAML'))" 2>/dev/null; then
  pass "8a. yaml parses"
else
  fail "8a. yaml does not parse"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
```
