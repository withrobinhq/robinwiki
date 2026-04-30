# 44 — Prose, not chips: weave fragments into sentences (#243)

## What it proves

Each wiki-type yaml's [RULES] block tells Quill to weave fragment
content into prose. Quill must NOT bare-string the fragment title as a
chip in the markdown body.

POSITIVE: every yaml's RULES block contains a "weave" or "synthesize"
or "into prose" directive plus an explicit prohibition against
emitting bare fragment titles as chips.

NEGATIVE: no yaml says "use the title as a chip" or any analogous
phrase.

## Prerequisites

- #244 / #248 / #254 already merged.

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
skip() { echo "  skip $1"; }

echo "44 — Prose, not chips (#243)"

YAML_DIR=packages/shared/src/prompts/specs/wiki-types
yamls=( agent belief collection decision log objective principles project skill voice )

extract_rules() {
  awk '/\[RULES — READ CAREFULLY\]/{f=1;next} /\[CITATIONS — PER SECTION/{f=0} f' "$1"
}

# ── A. POSITIVE — weave-into-prose directive present in every yaml ──
for slug in "${yamls[@]}"; do
  RULES=$(extract_rules "$YAML_DIR/$slug.yaml")
  # Match weave/synthesize/into prose anywhere in the rules block.
  if echo "$RULES" | grep -qiE 'weave|into prose|synthesi[sz]e'; then
    pass "A1.$slug rules invoke 'weave/synthesize/into prose'"
  else
    fail "A1.$slug rules MISSING weave/synthesize/into prose directive"
  fi
done

# ── A2. POSITIVE — explicit anti-chip language for fragment titles ──
for slug in "${yamls[@]}"; do
  RULES=$(extract_rules "$YAML_DIR/$slug.yaml")
  if echo "$RULES" | grep -qiE 'fragment title|bare.*title|title as a chip|do not.*chip'; then
    pass "A2.$slug rules forbid emitting fragment titles as chips"
  else
    fail "A2.$slug rules do NOT forbid bare fragment titles as chips"
  fi
done

# ── B. NEGATIVE — no yaml encourages bare-title chip rendering ──
for slug in "${yamls[@]}"; do
  if grep -qiE 'use the title as a chip|emit.*title.*as a chip' "$YAML_DIR/$slug.yaml"; then
    fail "B1.$slug yaml unexpectedly encourages bare-title chip rendering"
  else
    pass "B1.$slug yaml does NOT encourage bare-title chips"
  fi
done

# ── C. SKIP — prose-quality assertion (Quill output adheres) ──
# Asserting "the rendered wiki body weaves fragment content into sentences"
# requires running the LLM and parsing markdown. This is prose quality, not
# structural shape — out of scope for bash. Pre-fix this would be unverifiable.
skip "C1. prose-quality (Quill output weaves fragments) — runtime/LLM, not bash"

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
```
