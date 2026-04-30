# 45 — Wiki type renames: collection→research, principles→principle (#247)

## What it proves

The two wiki types are renamed end-to-end:

1. YAML filenames: `research.yaml`, `principle.yaml` (singular).
2. YAML internal fields: `display_label` and `description` reflect
   the new names; `task:` token uses the new slug.
3. Codebase references across `core/src/`, `packages/agent/src/`,
   `packages/shared/src/` all use the new identifiers.
4. A migration exists that updates the seeded `wiki_types` table
   (single-tenant — no `user_id`).

POSITIVE: presence of `research`, `principle` in code + yaml + migration.

NEGATIVE: literal `collection` / `principles` strings absent from
yaml filenames, the `WikiType` union, the `WIKI_TYPE_TO_GUIDE_KEY`
map, the schemaMap, the `WIKI_TYPE_DESCRIPTORS` map, and
`DEFAULT_WIKIS`.

## Prerequisites

- prior issues already merged.

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

echo "45 — Type renames collection→research, principles→principle (#247)"

YAML_DIR=packages/shared/src/prompts/specs/wiki-types
WIKI_TYPES_TS=packages/shared/src/types/wiki.ts
CONFIG_TS=packages/shared/src/types/config.ts
LOADER=packages/shared/src/prompts/loaders/wiki-generation.ts
INFERENCE=core/src/mcp/wiki-type-inference.ts

# ── A. POSITIVE — new yaml files exist ──
if [ -f "$YAML_DIR/research.yaml" ]; then
  pass "A1. research.yaml exists"
else
  fail "A1. research.yaml MISSING"
fi
if [ -f "$YAML_DIR/principle.yaml" ]; then
  pass "A2. principle.yaml exists"
else
  fail "A2. principle.yaml MISSING"
fi

# ── A3. POSITIVE — new schema files exist ──
if [ -f "$YAML_DIR/research.schema.ts" ]; then
  pass "A3. research.schema.ts exists"
else
  fail "A3. research.schema.ts MISSING"
fi
if [ -f "$YAML_DIR/principle.schema.ts" ]; then
  pass "A4. principle.schema.ts exists"
else
  fail "A4. principle.schema.ts MISSING"
fi

# ── A5. POSITIVE — WikiType union contains the new slugs ──
if grep -qE "'research'" "$WIKI_TYPES_TS"; then
  pass "A5. WikiType union contains 'research'"
else
  fail "A5. WikiType union does NOT contain 'research'"
fi
if grep -qE "'principle'\$|'principle'\b" "$WIKI_TYPES_TS"; then
  pass "A6. WikiType union contains 'principle'"
else
  fail "A6. WikiType union does NOT contain 'principle'"
fi

# ── A7. POSITIVE — schemaMap uses new slugs ──
if grep -qE 'research:' "$LOADER"; then
  pass "A7. wiki-generation schemaMap has 'research'"
else
  fail "A7. wiki-generation schemaMap MISSING 'research'"
fi
if grep -qE 'principle:' "$LOADER"; then
  pass "A8. wiki-generation schemaMap has 'principle'"
else
  fail "A8. wiki-generation schemaMap MISSING 'principle'"
fi

# ── A9. POSITIVE — descriptor map updated ──
if grep -qE 'research:' "$INFERENCE"; then
  pass "A9. inference descriptor map has 'research'"
else
  fail "A9. inference descriptor map MISSING 'research'"
fi
if grep -qE 'principle:' "$INFERENCE"; then
  pass "A10. inference descriptor map has 'principle'"
else
  fail "A10. inference descriptor map MISSING 'principle'"
fi

# ── A11. POSITIVE — guide keys updated ──
if grep -qE "wiki-guide-research" "$CONFIG_TS"; then
  pass "A11. WIKI_TYPE_TO_GUIDE_KEY has wiki-guide-research"
else
  fail "A11. WIKI_TYPE_TO_GUIDE_KEY MISSING wiki-guide-research"
fi
if grep -qE "wiki-guide-principle\b" "$CONFIG_TS"; then
  pass "A12. WIKI_TYPE_TO_GUIDE_KEY has wiki-guide-principle"
else
  fail "A12. WIKI_TYPE_TO_GUIDE_KEY MISSING wiki-guide-principle"
fi

# ── A13. POSITIVE — migration adds rename ──
MIG_DIR=core/drizzle/migrations
if grep -RqE "UPDATE.*wiki_types.*SET.*slug.*= 'research'" "$MIG_DIR" || \
   grep -RqE "research" "$MIG_DIR"; then
  pass "A13. migration references 'research'"
else
  fail "A13. no migration references 'research'"
fi
if grep -RqE "UPDATE.*wiki_types.*SET.*slug.*= 'principle'" "$MIG_DIR" || \
   grep -RqE "wiki_types.*principle" "$MIG_DIR"; then
  pass "A14. migration references 'principle'"
else
  fail "A14. no migration references singular 'principle'"
fi

# ── B. NEGATIVE — old slug filenames are gone ──
if [ ! -e "$YAML_DIR/collection.yaml" ]; then
  pass "B1. collection.yaml is gone"
else
  fail "B1. collection.yaml STILL exists"
fi
if [ ! -e "$YAML_DIR/principles.yaml" ]; then
  pass "B2. principles.yaml is gone"
else
  fail "B2. principles.yaml STILL exists"
fi

# ── B3. NEGATIVE — old slug not in WikiType union ──
# Slice the WikiType type-union block (between `export type WikiType =`
# and the next `export`).
UNION_BLOCK=$(awk '/export type WikiType =/{f=1} f; /^export (interface|const)/{if(f){f=0}}' "$WIKI_TYPES_TS")
if echo "$UNION_BLOCK" | grep -qE "\| 'collection'"; then
  fail "B3. WikiType union STILL contains 'collection'"
else
  pass "B3. WikiType union no longer contains 'collection'"
fi
if echo "$UNION_BLOCK" | grep -qE "\| 'principles'"; then
  fail "B4. WikiType union STILL contains 'principles' as a type variant"
else
  pass "B4. WikiType union no longer contains 'principles' as a type variant"
fi

# ── B5. NEGATIVE — old slug not in schemaMap (loader) ──
if grep -qE "^[[:space:]]*collection:" "$LOADER"; then
  fail "B5. wiki-generation schemaMap STILL has 'collection:'"
else
  pass "B5. wiki-generation schemaMap no longer has 'collection:'"
fi
if grep -qE "^[[:space:]]*principles:" "$LOADER"; then
  fail "B6. wiki-generation schemaMap STILL has 'principles:'"
else
  pass "B6. wiki-generation schemaMap no longer has 'principles:'"
fi

# ── B7. NEGATIVE — old slug not in descriptor map ──
if grep -qE "^[[:space:]]*collection:" "$INFERENCE"; then
  fail "B7. inference descriptor map STILL has 'collection:'"
else
  pass "B7. inference descriptor map no longer has 'collection:'"
fi
if grep -qE "^[[:space:]]*principles:" "$INFERENCE"; then
  fail "B8. inference descriptor map STILL has 'principles:'"
else
  pass "B8. inference descriptor map no longer has 'principles:'"
fi

# ── B9. NEGATIVE — config guide-key map old keys gone ──
if grep -qE "wiki-guide-collection" "$CONFIG_TS"; then
  fail "B9. config STILL has wiki-guide-collection"
else
  pass "B9. config no longer has wiki-guide-collection"
fi
if grep -qE "wiki-guide-principles\b" "$CONFIG_TS"; then
  fail "B10. config STILL has wiki-guide-principles (plural)"
else
  pass "B10. config no longer has wiki-guide-principles (plural)"
fi

# ── B11. NEGATIVE — yaml internal fields don't say Collection/Principles ──
if grep -qE 'display_label: "Collection"' "$YAML_DIR/research.yaml"; then
  fail "B11. research.yaml display_label still says 'Collection'"
else
  pass "B11. research.yaml display_label rewritten"
fi
if grep -qE 'display_label: "Principles"' "$YAML_DIR/principle.yaml"; then
  fail "B12. principle.yaml display_label still says 'Principles' (plural)"
else
  pass "B12. principle.yaml display_label rewritten"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
```
