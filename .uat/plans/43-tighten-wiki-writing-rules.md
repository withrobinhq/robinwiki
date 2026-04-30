# 43 — Tighten wiki-writing rules (#254)

## What it proves

Three coordinated edits to the [RULES — READ CAREFULLY] block of every
wiki-type yaml:

1. **Drop hardcoded layout rule 3** — the current rule 3 in each yaml
   restates layout-shape content (e.g. "Organize entries chronologically",
   "Present the decision first") that is now driven by `{{structure}}`.
   Removing it eliminates duplicate sources of truth.
2. **Strengthen structure-as-source-of-truth language** — rule 2 should
   explicitly call out the [DOCUMENT STRUCTURE] block as the canonical
   layout authority. The literal phrase "structure block is the source
   of truth" should appear in every yaml.
3. **Tighten chip-discipline rule** — the infobox rule (currently rule 11)
   should explicitly forbid restating the same value as a markdown chip
   in the body. The literal phrase "do not duplicate" or
   "Do not restate infobox values" should appear in the rule.

## Prerequisites

- #244 + #248 already merged.

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

echo "43 — Tighten wiki-writing rules (#254)"

YAML_DIR=packages/shared/src/prompts/specs/wiki-types
yamls=( agent belief research decision log objective principle project skill voice )

# Per-type sentinel strings that USED TO live in rule 3 (the layout-shape
# rule we're killing). After the fix, NONE of these should appear in the
# yaml's [RULES] block.
declare -A killed_rule3
killed_rule3[agent]='Focus on configuration details and performance observations'
killed_rule3[belief]='Present the position clearly, then supporting evidence'
killed_rule3[research]='Group items by sub-theme where it aids organization'
killed_rule3[decision]='Present the decision first, then context and reasoning'
killed_rule3[log]='Organize entries chronologically, most recent last'
killed_rule3[objective]='Focus on measurable outcomes and progress signals'
killed_rule3[principle]='State each principle as a clear commitment'
killed_rule3[project]='Reflect the current state of the project from the fragments'
killed_rule3[skill]='Focus on actionable techniques and practical knowledge'
killed_rule3[voice]='Focus on concrete language patterns and style observations'

# Helper — slice the [RULES — READ CAREFULLY] block.
extract_rules() {
  awk '/\[RULES — READ CAREFULLY\]/{f=1;next} /\[CITATIONS — PER SECTION/{f=0} f' "$1"
}

# ── A. NEGATIVE — rule-3 hardcoded layout language is gone ──
for slug in "${yamls[@]}"; do
  RULES=$(extract_rules "$YAML_DIR/$slug.yaml")
  needle="${killed_rule3[$slug]}"
  if echo "$RULES" | grep -qF "$needle"; then
    fail "A1.$slug RULES block STILL contains rule-3 layout text: '$needle'"
  else
    pass "A1.$slug rule-3 layout text removed"
  fi
done

# ── A2. NEGATIVE — literal '  3. ' rule numbering is gone (rules now start at 2 or jump ─
# Actually after killing rule 3 we'd renumber 4..n down by 1. So '  3. '
# can still exist (it's the new rule 4). Instead assert the structure-of-truth
# language is the new rule 2 follow-up.

# ── B. POSITIVE — structure-as-source-of-truth language present ──
for slug in "${yamls[@]}"; do
  RULES=$(extract_rules "$YAML_DIR/$slug.yaml")
  if echo "$RULES" | grep -qE 'source of truth'; then
    pass "B1.$slug structure source-of-truth phrase present"
  else
    fail "B1.$slug structure source-of-truth phrase MISSING"
  fi
done

# ── C. POSITIVE — tightened chip discipline ──
# Match "Do not\n duplicate" across lines using awk + state.
for slug in "${yamls[@]}"; do
  RULES=$(extract_rules "$YAML_DIR/$slug.yaml")
  hit=$(echo "$RULES" | awk '
    /[Dd]o not[[:space:]]*$/ { prev=1; next }
    prev && /^[[:space:]]+duplicate/ { print "ok"; exit }
    /[Dd]o not duplicate/ { print "ok"; exit }
    /[Dd]o not[[:space:]]+(re)?state/ { print "ok"; exit }
    { prev=0 }
  ')
  if [ "$hit" = "ok" ]; then
    pass "C1.$slug chip-discipline tightened"
  else
    fail "C1.$slug chip-discipline NOT tightened"
  fi
done

# ── D. NEGATIVE — rule numbering is sequential after dropping rule 3 ──
# After dropping rule 3 + renumbering, rules 1..N must be present in order
# in each yaml. We pull all top-level numbered lines and sanity-check.
for slug in "${yamls[@]}"; do
  RULES=$(extract_rules "$YAML_DIR/$slug.yaml")
  # Extract leading "N." numbers from numbered list lines
  nums=$(echo "$RULES" | grep -oE '^\s*[0-9]+\.' | grep -oE '[0-9]+' | tr '\n' ' ')
  # Expect first three to be: 1 2 3 (sequence), allowing pause for sub-bullets
  first3=$(echo "$nums" | awk '{print $1, $2, $3}')
  if [ "$first3" = "1 2 3" ]; then
    pass "D1.$slug rule numbering starts 1 2 3"
  else
    fail "D1.$slug rule numbering does NOT start 1 2 3 (got: $first3)"
  fi
done

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
```
