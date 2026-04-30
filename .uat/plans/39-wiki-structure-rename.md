# 39 — Rename Wiki Prompt → Wiki Structure (#240)

## What it proves

The per-wiki override field is renamed and reshaped:

1. **Label rename** — every UI-visible label / header / placeholder / aria
   for the prompt override now says **Wiki Structure** (not "Wiki Prompt").
2. **Inline textarea** — the field is an inline `<Textarea>` matching the
   Description field's shape; the Pencil-button popup dialog is gone.
3. **Revert to default** — a "Revert to default" button restores the
   current type's default structure. Disabled when value already matches.

POSITIVE: source contains "Wiki Structure" + an inline textarea + a Revert
button.

NEGATIVE: source no longer contains the literal "Wiki Prompt" string, the
`promptDialogOpen` state, the `promptDraft` state, or a Pencil button used
for the prompt edit popup.

NOTE — `wikis.prompt` storage stays as a `system_message` override (per
project memory). This plan only asserts UI labels / shape, not storage.

## Prerequisites

- wiki source in tree
- `grep`

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "39 — Rename Wiki Prompt → Wiki Structure (#240)"

MODAL=wiki/src/components/layout/AddWikiModal.tsx

# ── A. POSITIVE — Wiki Structure label and revert button ────────────
if grep -q "Wiki Structure" "$MODAL"; then
  pass "A1. AddWikiModal contains the literal 'Wiki Structure'"
else
  fail "A1. AddWikiModal does NOT contain 'Wiki Structure'"
fi

if grep -qE 'Revert' "$MODAL"; then
  pass "A2. Revert (to default) button exists"
else
  fail "A2. no Revert button exists"
fi

# ── B. NEGATIVE — old Wiki Prompt copy / popup state are gone ───────
if grep -q "Wiki Prompt" "$MODAL"; then
  fail "B1. literal 'Wiki Prompt' still present"
else
  pass "B1. literal 'Wiki Prompt' is gone"
fi

if grep -qE 'promptDialogOpen|promptDraft' "$MODAL"; then
  fail "B2. popup state (promptDialogOpen/promptDraft) is still in source"
else
  pass "B2. popup state removed"
fi

# Inline textarea check — the prompt field is now a <Textarea>.
# Heuristic: count the number of Textarea elements; the post-fix shape has
# >= 2 (Description + Wiki Structure) where the previous shape had 1
# (Description) plus the popup dialog's Textarea.
TA_COUNT=$(grep -cE '<Textarea\b' "$MODAL")
# Also assert that the structure section uses an inline Textarea, not a
# button-opens-modal pattern. Look for a 'Wiki Structure' label followed
# within a few lines by '<Textarea'.
if awk '/Wiki Structure/{flag=40} flag>0 && /<Textarea/{print "ok"; exit} flag>0{flag--}' "$MODAL" | grep -q ok; then
  pass "B3. inline Textarea follows the Wiki Structure label"
else
  fail "B3. Wiki Structure label is not followed by an inline Textarea ($TA_COUNT total)"
fi

# Pencil import (only used for the popup edit button) should be gone if it
# isn't used elsewhere in the modal.
PENCIL_USES=$(grep -cE '<Pencil\b' "$MODAL")
if [ "$PENCIL_USES" -eq 0 ]; then
  pass "B4. Pencil icon is no longer rendered in AddWikiModal"
else
  fail "B4. Pencil icon still rendered $PENCIL_USES time(s) — pop-up shape may persist"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```
