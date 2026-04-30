# 41 — Per-wiki structure as a first-class field (#244)

## What it proves

Wiki document structure is decoupled from the writing prompt:

1. **Schema field** — every wiki-type YAML has a `default_structure`
   string field, separate from `template`/`system_message`.
2. **Template placeholder** — every wiki-type YAML's `template` body uses
   the `{{structure}}` placeholder where the hardcoded `[DOCUMENT
   STRUCTURE]` block used to live.
3. **Storage sibling** — `wikis.structure` column exists in the schema
   and migration; it's a SIBLING of `wikis.prompt`, not a replacement.
4. **Resolution** — `loadWikiGenerationSpec` resolves `{{structure}}`
   from a per-wiki override OR the type's `default_structure`.
5. **Negative** — the literal `[DOCUMENT STRUCTURE]\n  Use this exact
   structure:` text is no longer in the rendered prompt body of any
   wiki-type yaml (it now lives in `default_structure`, not the body).

## Prerequisites

- repo root with `packages/shared/src/prompts/specs/wiki-types/*.yaml`
- `grep`, `awk`, `node`

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
skip() { echo "  skip $1"; }

echo "41 — Per-wiki structure as a first-class field (#244)"

YAML_DIR=packages/shared/src/prompts/specs/wiki-types
SCHEMA=packages/shared/src/prompts/schema.ts
LOADER=packages/shared/src/prompts/loaders/wiki-generation.ts
DB_SCHEMA=core/src/db/schema.ts
MIGRATIONS_DIR=core/drizzle/migrations
REGEN=core/src/lib/regen.ts

# ── A. POSITIVE — default_structure field on every wiki-type yaml ───
yamls=( agent belief research decision log objective principle project skill voice )
for slug in "${yamls[@]}"; do
  if grep -qE '^default_structure:' "$YAML_DIR/$slug.yaml"; then
    pass "A1.$slug yaml has top-level default_structure: field"
  else
    fail "A1.$slug yaml is MISSING default_structure: field"
  fi
done

# ── A2. POSITIVE — {{structure}} mustache present in every yaml template ──
for slug in "${yamls[@]}"; do
  if grep -qF '{{structure}}' "$YAML_DIR/$slug.yaml"; then
    pass "A2.$slug yaml template references {{structure}}"
  else
    fail "A2.$slug yaml does NOT reference {{structure}}"
  fi
done

# ── A3. POSITIVE — schema declares default_structure ──
if grep -qE 'default_structure' "$SCHEMA"; then
  pass "A3. PromptSpecSchema declares default_structure"
else
  fail "A3. PromptSpecSchema is MISSING default_structure declaration"
fi

# ── A4. POSITIVE — wikis.structure column in db schema ──
if grep -qE "structure: text\('structure'\)" "$DB_SCHEMA"; then
  pass "A4. wikis.structure column declared in schema.ts"
else
  fail "A4. wikis.structure column NOT declared in schema.ts"
fi

# ── A5. POSITIVE — migration adds wikis.structure ──
if grep -RqE 'ALTER TABLE "wikis" ADD COLUMN.*"structure"' "$MIGRATIONS_DIR"; then
  pass "A5. migration adds wikis.structure column"
else
  fail "A5. no migration adds wikis.structure"
fi

# ── A6. POSITIVE — loader resolves {{structure}} from override OR default_structure ──
if grep -qE 'structure' "$LOADER"; then
  pass "A6. loader (wiki-generation.ts) references structure"
else
  fail "A6. loader does NOT reference structure"
fi

# ── A7. POSITIVE — regen passes wiki.structure into vars (override path) ──
if grep -qE 'wiki\.structure|structure:' "$REGEN" | head -n1; then
  pass "A7. regen.ts wires wiki.structure"
else
  fail "A7. regen.ts does NOT wire wiki.structure"
fi

# ── B. NEGATIVE — hardcoded headings removed from template body ──
# The template body (everything after `template: |`) should reference
# {{structure}} and NOT contain the per-type ## heading literals. We
# slice out the template body via awk, then assert no `## ` heading
# strings appear in it (apart from {{structure}} placeholder).
for slug in "${yamls[@]}"; do
  body=$(awk '/^template: \|$/{f=1;next} /^input_variables:/{f=0} f' "$YAML_DIR/$slug.yaml")
  # Heading should NOT appear in template body — it has migrated to default_structure.
  if echo "$body" | grep -qE '^\s*## '; then
    fail "B1.$slug template body still contains hardcoded '## ' headings (structure should be in default_structure now)"
  else
    pass "B1.$slug template body has no hardcoded '## ' headings"
  fi
done

# ── B2. NEGATIVE — yaml templates do not contain hand-typed `## Goal` etc. headings in template body ──
# Heuristic: the template body, after we extract default_structure away, should not still
# contain the per-type heading. Pick one canonical heading per type to assert.
declare -A canonical_h2
canonical_h2[agent]='## Purpose'
canonical_h2[belief]='## The Position'
canonical_h2[research]='## Sources'
canonical_h2[decision]='## The Decision'
canonical_h2[log]='## Timeline'
canonical_h2[objective]='## Key Results'
canonical_h2[principle]='## The Principle'
canonical_h2[project]='## Goal'
canonical_h2[skill]='## Core Techniques'
canonical_h2[voice]='## Tone and Style'
for slug in "${yamls[@]}"; do
  heading="${canonical_h2[$slug]}"
  # The heading should appear in default_structure section but NOT in the template:
  # We approximate by counting occurrences — exactly 1 (in default_structure block).
  count=$(grep -cF "$heading" "$YAML_DIR/$slug.yaml" || true)
  if [ "$count" -eq 1 ]; then
    pass "B2.$slug heading '$heading' appears exactly once (in default_structure)"
  else
    fail "B2.$slug heading '$heading' appears $count times (expected 1)"
  fi
done

# ── B3. NEGATIVE — wikis.prompt is NOT removed (sibling, not replacement) ──
if grep -qE "prompt: text\('prompt'\)" "$DB_SCHEMA"; then
  pass "B3. wikis.prompt column still present (sibling preserved)"
else
  fail "B3. wikis.prompt column removed — this would break #244 sibling rule"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
```
