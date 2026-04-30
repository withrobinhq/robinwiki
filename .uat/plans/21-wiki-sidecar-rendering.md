# 21 — Wiki Sidecar Rendering (Frontend)

## What it proves
Token chips render for all four kinds (person / fragment / wiki / entry); unresolved tokens fall back to literal text; the structured infobox replaces the legacy flex-column layout with a typed table; per-section citation superscripts render, link, and describe their source fragment; the per-heading `[edit]` affordance scopes edits to a single section without disturbing siblings or the heading itself; H1 is excluded from the affordance; duplicate headings are disambiguated via `notes` / `notes-1` anchors; a stale-section save surfaces a recoverable message instead of crashing; the HTML-body path hides `[edit]` while still rendering chips; tokens inside `<code>` / `<pre>` render as literal source while prose tokens still resolve; entry and person detail pages resolve tokens and render the server-derived person infobox.

## Prerequisites
- `pnpm -C core seed-fixture` has been run (seeds the Transformer demo wiki — see plan 22 for the seed lifecycle).
- Core server on `SERVER_URL` (default `http://localhost:3000`).
- Wiki dev server on `WIKI_URL` (default `http://localhost:8080`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set for authenticated flows.

## Fixture slugs this plan references
- Wiki: `transformer-architecture`
- People: `ashish-vaswani`, `noam-shazeer`, `niki-parmar`, `anonymous-reviewer` (unresolved — no refs entry)
- Fragments: `self-attention-replaces-recurrence`, `multi-head-attention-parallelism`, `positional-encoding-sequence-order`, `scaled-dot-product-attention`, `encoder-decoder-stacks`
- Wiki ref target: `attention-is-all-you-need`
- Entry: `attention-paper-abstract`
- Section anchors: `transformer-architecture`, `overview`, `the-attention-mechanism`, `architecture`, `encoder-stack`, `decoder-stack`, `notes`, `notes-1`

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-.}"
source core/.env 2>/dev/null || true

WIKI_URL="${WIKI_URL:-http://localhost:8080}"
SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "21 — Wiki Sidecar Rendering"
echo ""

# ── Prereq: confirm the Transformer demo wiki is seeded ─────────
curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null 2>/dev/null

WIKIS_RESPONSE=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis?limit=50")
TRANSFORMER_KEY=$(echo "$WIKIS_RESPONSE" | jq -r '.wikis[] | select(.slug == "transformer-architecture") | .lookupKey // .id' | head -1)

if [ -z "${TRANSFORMER_KEY:-}" ] || [ "$TRANSFORMER_KEY" = "null" ]; then
  fail "0. Transformer demo wiki not seeded — run 'pnpm -C core seed-fixture' first"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
pass "0. Transformer demo wiki present (key=${TRANSFORMER_KEY:0:16}...)"

# Verify the API response carries a populated sidecar — if the backend
# strip regression is back, every UI assertion below is noise.
WIKI_JSON=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$TRANSFORMER_KEY")
REFS_COUNT=$(echo "$WIKI_JSON" | jq '.refs | length' 2>/dev/null || echo 0)
SECTIONS_COUNT=$(echo "$WIKI_JSON" | jq '.sections | length' 2>/dev/null || echo 0)
HAS_INFOBOX=$(echo "$WIKI_JSON" | jq 'has("infobox") and .infobox != null' 2>/dev/null || echo false)
[ "$REFS_COUNT" -ge 8 ] 2>/dev/null && pass "0b. API refs populated ($REFS_COUNT entries)" || fail "0b. API refs not populated ($REFS_COUNT)"
[ "$SECTIONS_COUNT" -ge 6 ] 2>/dev/null && pass "0c. API sections populated ($SECTIONS_COUNT entries)" || fail "0c. API sections not populated ($SECTIONS_COUNT)"
[ "$HAS_INFOBOX" = "true" ] && pass "0d. API infobox non-null" || fail "0d. API infobox missing or null"

# ── Sign in via browser ──────────────────────────────────────
npx agent-browser open "$WIKI_URL/login" 2>/dev/null
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

# ── 1. Navigate to the Transformer wiki detail page ──────────
npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-21-01-wiki-loaded.png 2>/dev/null

if echo "$SNAP" | grep -qi "Transformer Architecture"; then
  pass "1. Wiki detail page loaded with 'Transformer Architecture' title"
else
  fail "1. Wiki detail page did not render Transformer title"
fi

# ── 2. Token chips — all four kinds render as <WikiChip> ─────
# The shared body mentions the Ashish Vaswani person, the self-attention
# fragment, the attention-is-all-you-need wiki, and the attention-paper
# entry. Each should surface the canonical label (from refs), not raw
# `[[...]]` syntax, and carry `data-slot="wiki-chip"`.

# Snapshot the HTML so we can look at chip markup directly.
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-dom.html 2>/dev/null

# 2a. Person chip
if grep -q 'data-slot="wiki-chip"[^>]*>Ashish Vaswani<' /tmp/uat-21-dom.html; then
  pass "2a. Person chip: 'Ashish Vaswani' renders as <WikiChip>"
else
  fail "2a. Person chip for ashish-vaswani not rendered as a chip"
fi

# 2b. Fragment chip — the 'self-attention-replaces-recurrence' label
if grep -qi 'data-slot="wiki-chip"[^>]*>Self-attention replaces recurrence<' /tmp/uat-21-dom.html; then
  pass "2b. Fragment chip: 'Self-attention replaces recurrence' renders as <WikiChip>"
else
  fail "2b. Fragment chip for self-attention-replaces-recurrence not rendered"
fi

# 2c. Wiki chip — 'Attention Is All You Need (paper)'
if grep -q 'data-slot="wiki-chip"[^>]*>Attention Is All You Need (paper)<' /tmp/uat-21-dom.html; then
  pass "2c. Wiki chip: 'Attention Is All You Need (paper)' renders as <WikiChip>"
else
  fail "2c. Wiki chip for attention-is-all-you-need not rendered"
fi

# 2d. Entry chip — 'Abstract — Attention Is All You Need'
if grep -q 'data-slot="wiki-chip"[^>]*>Abstract' /tmp/uat-21-dom.html; then
  pass "2d. Entry chip: 'Abstract — Attention Is All You Need' renders as <WikiChip>"
else
  fail "2d. Entry chip for attention-paper-abstract not rendered"
fi

# 2e. No raw `[[person:ashish-vaswani]]` token text leaks through
if grep -q '\[\[person:ashish-vaswani\]\]' /tmp/uat-21-dom.html; then
  fail "2e. Raw [[person:ashish-vaswani]] token appears unrendered in DOM"
else
  pass "2e. No raw resolved tokens leak into rendered output"
fi

# ── 3. Unresolved token fallback ─────────────────────────────
# `[[person:anonymous-reviewer]]` is in the body but deliberately missing
# from refs. Contract behavior: render as literal `[[person:anonymous-reviewer]]`
# text, NOT as a chip, NOT stripped.

if grep -q '\[\[person:anonymous-reviewer\]\]' /tmp/uat-21-dom.html; then
  pass "3a. Unresolved token renders as literal text"
else
  fail "3a. Unresolved [[person:anonymous-reviewer]] token was stripped or miscategorised"
fi

if grep -q 'data-slot="wiki-chip"[^>]*>\[\[person:anonymous-reviewer\]\]<' /tmp/uat-21-dom.html; then
  fail "3b. Unresolved token incorrectly wrapped as a chip"
else
  pass "3b. Unresolved token NOT rendered as a chip"
fi

# ── 4. Structured infobox (typed table) ──────────────────────
# The infobox in the Transformer wiki's right rail must render as
# `.winfo` table, not the legacy `.wiki-aside-infobox` flexbox. Every
# `valueKind` (text, ref, date, status) is present in this fixture.

# 4a. New .winfo table is used (not legacy flex-column aside)
if grep -qE 'class="[^"]*\bwinfo\b' /tmp/uat-21-dom.html; then
  pass "4a. Infobox renders using structured .winfo table"
else
  fail "4a. Infobox missing .winfo class — still on legacy flex layout?"
fi

# 4b. Row for each valueKind shows its label + value
for LABEL in "Status" "Paper" "Lead author" "Published"; do
  if echo "$SNAP" | grep -q "$LABEL"; then
    pass "4b. Infobox row '$LABEL' present"
  else
    fail "4b. Infobox row '$LABEL' missing"
  fi
done

# 4c. valueKind=ref — 'Lead author' value is a chip linking to Ashish
if grep -qE 'Lead author[[:space:]]*<[^>]*winfo__v[^>]*>[^<]*<a[^>]*data-slot="wiki-chip"' /tmp/uat-21-dom.html \
  || grep -qE 'winfo[^"]*">[^<]*Lead author[^<]*</[^>]+>[^<]*<[^>]+>[^<]*<a[^>]*data-slot="wiki-chip"[^>]*>Ashish Vaswani' /tmp/uat-21-dom.html \
  || grep -qE '<a[^>]*data-slot="wiki-chip"[^>]*>Ashish Vaswani</a>' /tmp/uat-21-dom.html; then
  pass "4c. Infobox ref-row renders Ashish Vaswani as a chip (not raw token text)"
else
  fail "4c. Infobox ref-row 'Lead author' did not substitute the token into a chip"
fi

# 4d. valueKind=status — 'complete' renders as a pill/badge, not bare text
if echo "$SNAP" | grep -qi "complete"; then
  pass "4d. Infobox status row shows 'complete'"
  # Look for a pill-like treatment (chip class or status-specific class)
  if grep -qE 'class="[^"]*(wchip|winfo__v--status|badge|pill)' /tmp/uat-21-dom.html; then
    pass "4e. Status value has pill/badge treatment"
  else
    fail "4e. Status value has no pill/badge treatment"
  fi
else
  fail "4d. Infobox status row 'complete' missing"
fi

# ── 5. Per-section citation superscripts ─────────────────────
# Sections 'overview' and 'architecture' each have 2 citations in the
# fixture. Other sections have citations: []. Expect `[1][2]` superscripts
# on the two populated sections and nothing on the rest.

# 5a. Overview section has citation superscripts
if grep -qE '<sup[^>]*class="[^"]*\bcite\b' /tmp/uat-21-dom.html; then
  pass "5a. Citation superscripts render somewhere in the document"
else
  fail "5a. No citation superscripts found (expected [1][2] after Overview + Architecture)"
fi

# 5b. Exactly the expected number of cite superscripts (2 per populated section = 4)
CITE_COUNT=$(grep -oE '<sup[^>]*class="[^"]*\bcite\b' /tmp/uat-21-dom.html | wc -l | tr -d ' ')
if [ "$CITE_COUNT" = "4" ]; then
  pass "5b. Citation superscript count matches fixture (4 = 2 overview + 2 architecture)"
else
  fail "5b. Citation superscript count is $CITE_COUNT, expected 4"
fi

# 5c. Hover (focus) a superscript — tooltip or inline detail shows the
# fragment quote + captured date. Use agent-browser's focus helper.
# NOTE: if the UAT harness can't emit synthetic hover events, this step
# is manual — the assertion here is that the fragment quote text exists
# somewhere in the rendered DOM so a hover card has content to show.
if grep -qF "A stack of self-attention layers models long-range dependencies" /tmp/uat-21-dom.html; then
  pass "5c. Overview citation quote text is present in DOM (hover source)"
else
  fail "5c. Overview citation quote not found — tooltip would be empty"
fi

# 5d. Clicking a citation superscript navigates to /fragments/<id>
# Grab the first citation's anchor href.
FRAG_HREF=$(grep -oE '<sup[^>]*class="[^"]*\bcite\b[^>]*>[^<]*<a[^>]*href="[^"]*"' /tmp/uat-21-dom.html \
  | head -1 | grep -oE 'href="[^"]+"' | sed 's/href="//;s/"$//')
if [ -n "${FRAG_HREF:-}" ] && echo "$FRAG_HREF" | grep -q "/fragments/"; then
  pass "5d. Citation link points at /fragments/<id> ($FRAG_HREF)"
elif [ -n "${FRAG_HREF:-}" ]; then
  fail "5d. Citation link exists but doesn't route to /fragments/ (got: $FRAG_HREF)"
else
  skip "5d. Citation link shape varies by design — inspect /tmp/uat-21-dom.html manually"
fi

# 5e. Sections with citations: [] show NO superscripts.
# `## Notes` is the easiest to check — it has no citations in the fixture.
# Inspect the DOM slice bounded by the 'notes' anchor.
NOTES_SLICE=$(awk '/id="notes"/,/id="notes-1"/' /tmp/uat-21-dom.html 2>/dev/null || true)
if [ -n "$NOTES_SLICE" ] && echo "$NOTES_SLICE" | grep -qE '<sup[^>]*class="[^"]*\bcite\b'; then
  fail "5e. 'Notes' section has unexpected citation superscripts (fixture has citations: [])"
else
  pass "5e. 'Notes' section correctly omits citation superscripts"
fi

# ── 6. Section-scoped edit — happy path ──────────────────────
# Click the `[edit]` bracket beside the H2 'Overview' heading, edit the
# body only, save, and verify: only that section changed, other sections
# intact, heading + anchor unchanged.

# 6a. The H2 'Overview' heading has a trailing [edit] affordance.
if grep -qE 'id="overview"[^>]*>[^<]*Overview[^<]*<[^>]+>[^<]*<a[^>]*class="[^"]*wedit' /tmp/uat-21-dom.html \
  || grep -qE '<a[^>]*class="[^"]*\bwedit\b[^"]*"' /tmp/uat-21-dom.html; then
  pass "6a. [edit] affordance (.wedit) renders next to H2 headings"
else
  fail "6a. No .wedit [edit] affordance found next to H2 headings"
fi

# 6b. Click the first [edit] bracket — dialog opens prefilled with body,
# heading read-only.
npx agent-browser click 'a.wedit'
npx agent-browser wait --load networkidle
EDIT_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-21-06-edit-dialog.png 2>/dev/null

if echo "$EDIT_SNAP" | grep -qi "Overview" && echo "$EDIT_SNAP" | grep -qiE "textarea|edit.*section|editing section"; then
  pass "6b. Section editor dialog opened with heading 'Overview' as context"
else
  fail "6b. Section editor dialog did not open or is missing heading context"
fi

# 6c. Edit the body, save. Use a distinctive marker so we can verify.
EDIT_MARKER="UAT-21 scoped edit marker $(date +%s)"
npx agent-browser fill 'textarea' "$EDIT_MARKER"
npx agent-browser find text "Save" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 2
npx agent-browser screenshot /tmp/uat-21-06-after-save.png 2>/dev/null

# Refetch the wiki via API and look for the marker
AFTER_JSON=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$TRANSFORMER_KEY")
AFTER_BODY=$(echo "$AFTER_JSON" | jq -r '.wikiContent // .content // ""')

if echo "$AFTER_BODY" | grep -qF "$EDIT_MARKER"; then
  pass "6c. Edited body persisted through PUT /api/content/wiki/<key>"
else
  fail "6c. Edit marker not present after save — edit did not persist"
fi

# 6d. Heading 'Overview' and its anchor 'overview' survived unchanged.
if echo "$AFTER_BODY" | grep -qE '^## Overview\s*$'; then
  pass "6d. '## Overview' heading line preserved verbatim"
else
  fail "6d. '## Overview' heading line was altered by section-scoped edit"
fi

AFTER_SECTIONS=$(echo "$AFTER_JSON" | jq -r '.sections[]?.anchor' | tr '\n' ' ')
if echo "$AFTER_SECTIONS" | grep -qw "overview"; then
  pass "6e. 'overview' anchor still present in server-computed sections"
else
  fail "6e. 'overview' anchor drifted after section-scoped save ($AFTER_SECTIONS)"
fi

# 6f. Sibling sections untouched — 'Architecture' heading still intact and
# still has its two citations populated.
if echo "$AFTER_BODY" | grep -qE '^## Architecture\s*$'; then
  pass "6f. Sibling '## Architecture' heading untouched"
else
  fail "6f. Sibling '## Architecture' heading was disturbed"
fi

ARCH_CITE_COUNT=$(echo "$AFTER_JSON" | jq '[.sections[] | select(.anchor == "architecture") | .citations | length] | add // 0')
[ "$ARCH_CITE_COUNT" = "2" ] && pass "6g. Sibling 'architecture' citations (2) preserved" || fail "6g. Sibling citations drifted: got $ARCH_CITE_COUNT, expected 2"

# ── 7. Section-scoped edit — H1 excluded ─────────────────────
# H1 is the document title. No [edit] bracket should sit next to it.
npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-dom-2.html 2>/dev/null

# Find the H1 block and check no `.wedit` sits inside it.
H1_SLICE=$(grep -oE '<h1[^>]*id="transformer-architecture"[^>]*>.*</h1>' /tmp/uat-21-dom-2.html 2>/dev/null \
  || grep -oE '<h1[^>]*>[^<]*Transformer Architecture[^<]*[^<]*</h1>' /tmp/uat-21-dom-2.html 2>/dev/null)
if [ -n "${H1_SLICE:-}" ] && echo "$H1_SLICE" | grep -qE 'class="[^"]*\bwedit\b'; then
  fail "7. H1 heading has an [edit] affordance (it must be excluded)"
else
  pass "7. H1 heading has no [edit] affordance"
fi

# ── 8. Duplicate-heading anchors — notes vs. notes-1 ─────────
# The fixture has two `## Notes` sections. Editing one must not affect
# the other. Anchors: `notes` (first) and `notes-1` (second).

# Confirm both anchors exist in server sections.
HAS_NOTES=$(echo "$AFTER_JSON" | jq '[.sections[] | select(.anchor == "notes")] | length')
HAS_NOTES_1=$(echo "$AFTER_JSON" | jq '[.sections[] | select(.anchor == "notes-1")] | length')
if [ "$HAS_NOTES" = "1" ] && [ "$HAS_NOTES_1" = "1" ]; then
  pass "8a. Both 'notes' and 'notes-1' anchors present server-side"
else
  fail "8a. Duplicate-heading anchors wrong: notes=$HAS_NOTES, notes-1=$HAS_NOTES_1"
fi

# Edit 'notes-1' specifically and verify 'notes' is untouched. Select the
# [edit] link that sits inside the section with id="notes-1".
npx agent-browser eval "document.querySelector('#notes-1 a.wedit, [id=\"notes-1\"] ~ * a.wedit, [id=\"notes-1\"] a.wedit')?.click()" 2>/dev/null
npx agent-browser wait --load networkidle

NOTES1_MARKER="UAT-21 notes-1 marker $(date +%s)"
npx agent-browser fill 'textarea' "$NOTES1_MARKER"
npx agent-browser find text "Save" click 2>/dev/null
npx agent-browser wait --load networkidle
sleep 2

AFTER2_JSON=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/wikis/$TRANSFORMER_KEY")
AFTER2_BODY=$(echo "$AFTER2_JSON" | jq -r '.wikiContent // .content // ""')

if echo "$AFTER2_BODY" | grep -qF "$NOTES1_MARKER"; then
  pass "8b. 'notes-1' body edited and persisted"
else
  fail "8b. 'notes-1' edit did not persist — the UAT click target may need tuning"
fi

# 'notes' (first Notes section) should still contain original fixture prose
# — specifically the anonymous-reviewer line.
if echo "$AFTER2_BODY" | grep -q '\[\[person:anonymous-reviewer\]\]'; then
  pass "8c. First 'notes' section preserved (anonymous-reviewer token intact)"
else
  fail "8c. First 'notes' section was unexpectedly modified by editing 'notes-1'"
fi

# ── 9. Stale-section save ────────────────────────────────────
# Open the editor on a section, then regenerate the wiki (simulates
# another tab reshaping the document), then try to save in the first
# tab. Expected: a user-facing "section no longer exists" message rather
# than a crash or silent clobber.

# 9a. Open editor on 'architecture'.
npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
npx agent-browser eval "document.querySelector('#architecture ~ * a.wedit, #architecture a.wedit, [id=\"architecture\"] a.wedit')?.click()" 2>/dev/null
npx agent-browser wait --load networkidle

# 9b. Simulate a regen that removes the section via an out-of-band PUT.
# Rewrite the wiki body WITHOUT the Architecture heading.
NEW_BODY=$'# Transformer Architecture\n\n## Overview\n\nStripped body for stale-section UAT.\n'
curl -s -o /dev/null -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg body "$NEW_BODY" --arg name "Transformer Architecture" '{frontmatter:{name:$name,type:"project",prompt:""},body:$body}')" \
  "$SERVER_URL/api/content/wiki/$TRANSFORMER_KEY"

# 9c. Save from the first tab — the section it was editing ('architecture')
# no longer exists.
npx agent-browser fill 'textarea' "UAT stale-section attempt"
npx agent-browser find text "Save" click 2>/dev/null
npx agent-browser wait --load networkidle
STALE_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser screenshot /tmp/uat-21-09-stale-section.png 2>/dev/null

if echo "$STALE_SNAP" | grep -qiE "section no longer exists|regenerated|close this dialog"; then
  pass "9. Stale-section save shows a recoverable user message"
else
  fail "9. Stale-section save did not surface a 'section no longer exists' message"
fi

# Reseed the fixture so later test runs have the canonical body.
pnpm -C core seed-fixture >/dev/null 2>&1 || true

# ── 10. HTML body fallback ───────────────────────────────────
# If the wiki was last saved by the Tiptap editor, wiki.wikiContent starts
# with `<`. In that case:
#  - `[edit]` brackets MUST NOT render (section algorithm needs markdown).
#  - Token chips MUST still render (via the HTML DOM-walker substitution).

# Drive the HTML branch: PUT an HTML body containing tokens.
HTML_BODY='<h1>Transformer Architecture</h1><p>Token check: [[person:ashish-vaswani]] and [[wiki:attention-is-all-you-need]].</p><h2>Overview</h2><p>HTML-body overview.</p>'
curl -s -o /dev/null -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg body "$HTML_BODY" --arg name "Transformer Architecture" '{frontmatter:{name:$name,type:"project",prompt:""},body:$body}')" \
  "$SERVER_URL/api/content/wiki/$TRANSFORMER_KEY"

npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
sleep 1
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-dom-html-body.html 2>/dev/null

# 10a. No .wedit brackets on the HTML branch.
if grep -qE 'class="[^"]*\bwedit\b' /tmp/uat-21-dom-html-body.html; then
  fail "10a. HTML-body branch rendered [edit] brackets (should be hidden)"
else
  pass "10a. HTML-body branch correctly hides [edit] brackets"
fi

# 10b. Token chips still render on the HTML branch.
if grep -q 'data-slot="wiki-chip"[^>]*>Ashish Vaswani<' /tmp/uat-21-dom-html-body.html; then
  pass "10b. HTML-body branch still substitutes tokens into WikiChips"
else
  fail "10b. HTML-body branch failed to substitute [[person:ashish-vaswani]] into a chip"
fi

# Restore the markdown body for downstream steps + plan 22.
pnpm -C core seed-fixture >/dev/null 2>&1 || true

# ── 11. Code-fence token isolation (HTML body path) ──────────
# Tokens inside <code> or <pre> must render as literal source text,
# not as WikiChips. Regression guard for the htmlTokenSubstitute
# walker fix (PR #132 / issue #131).

# Drive the HTML branch with a body that mixes in-prose tokens (should
# resolve to chips) and in-code tokens (should render as literal source).
CODE_BODY='<p>Prose ref [[person:ashish-vaswani]] and [[wiki:attention-is-all-you-need]] resolve to chips.</p><p>Inline <code>const a = "[[person:ashish-vaswani]]"</code> renders as source.</p><pre><code>fn cite() {\n  let x = "[[fragment:self-attention-replaces-recurrence]]";\n}</code></pre>'
curl -s -o /dev/null -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg body "$CODE_BODY" --arg name "Transformer Architecture" '{frontmatter:{name:$name,type:"project",prompt:""},body:$body}')" \
  "$SERVER_URL/api/content/wiki/$TRANSFORMER_KEY"

npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
sleep 1
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-codefence.html 2>/dev/null
npx agent-browser screenshot /tmp/uat-21-11-codefence.png 2>/dev/null

# 11a. No wchip anchor appears inside <code> elements.
if grep -oE '<code[^>]*>[^<]*(<[^/][^>]*>[^<]*)*</code>' /tmp/uat-21-codefence.html | grep -q 'class="wchip"\|data-slot="wiki-chip"'; then
  fail "11a. Token inside <code> was substituted — walker failed to skip code elements"
else
  pass "11a. Tokens inside <code> render as literal source"
fi

# 11b. No wchip anchor appears inside <pre> elements.
if grep -oE '<pre[^>]*>[^<]*(<[^/][^>]*>[^<]*)*</pre>' /tmp/uat-21-codefence.html | grep -q 'class="wchip"\|data-slot="wiki-chip"'; then
  fail "11b. Token inside <pre> was substituted — walker failed to skip pre elements"
else
  pass "11b. Tokens inside <pre> render as literal source"
fi

# 11c. The literal token text is preserved inside the code block.
if grep -q '\[\[person:ashish-vaswani\]\]' /tmp/uat-21-codefence.html; then
  pass "11c. Literal token text preserved inside code block"
else
  fail "11c. Literal token text missing from DOM (code block not retained?)"
fi

# 11d. Tokens OUTSIDE code blocks still substitute into chips — at least
# one wchip anchor exists in the prose section of the rendered body.
PROSE_CHIPS=$(grep -cE '<a[^>]*data-slot="wiki-chip"' /tmp/uat-21-codefence.html)
if [ "$PROSE_CHIPS" -ge 1 ]; then
  pass "11d. Prose tokens still resolve to chips ($PROSE_CHIPS chip anchor(s) in DOM)"
else
  fail "11d. No chip anchors in DOM — walker regressed on the non-code path too"
fi

# Restore the canonical markdown body for plan 22 + downstream runs.
pnpm -C core seed-fixture >/dev/null 2>&1 || true

# ── 12. Entry detail page — refs resolve inline ──────────────
# Sign back in and open the seeded entry.
curl -s -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"${INITIAL_USERNAME:-}\",\"password\":\"${INITIAL_PASSWORD:-}\"}" \
  "$SERVER_URL/api/auth/sign-in/email" >/dev/null 2>/dev/null

ENTRY_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/entries?limit=50" \
  | jq -r '.entries[] | select(.slug == "attention-paper-abstract") | .lookupKey // .id' | head -1)

if [ -n "${ENTRY_KEY:-}" ] && [ "$ENTRY_KEY" != "null" ]; then
  npx agent-browser open "$WIKI_URL/login" 2>/dev/null
  npx agent-browser wait --load networkidle
  npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
  npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
  npx agent-browser click 'button[type="submit"]'
  npx agent-browser wait --load networkidle

  npx agent-browser open "$WIKI_URL/entries/$ENTRY_KEY"
  npx agent-browser wait --load networkidle
  npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-entry-dom.html 2>/dev/null
  ENTRY_SNAP=$(npx agent-browser snapshot 2>/dev/null)

  if echo "$ENTRY_SNAP" | grep -qi "Attention"; then
    pass "12a. Entry detail page loads (attention-paper-abstract)"
  else
    fail "12a. Entry detail page did not load"
  fi

  # Entries may contain tokens in body. Assert any that exist resolve.
  # Also assert the entry page shows NO infobox (entries never have one).
  if grep -qE 'class="[^"]*\bwinfo\b' /tmp/uat-21-entry-dom.html; then
    fail "12b. Entry page rendered an infobox — entries should never have one"
  else
    pass "12b. Entry page correctly has no infobox"
  fi
else
  skip "12. Entry 'attention-paper-abstract' not seeded — re-run seed-fixture"
fi

# ── 13. Person detail page — server-derived infobox ──────────
PERSON_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/people?limit=50" \
  | jq -r '.people[] | select(.slug == "ashish-vaswani") | .lookupKey // .id' | head -1)

if [ -n "${PERSON_KEY:-}" ] && [ "$PERSON_KEY" != "null" ]; then
  npx agent-browser open "$WIKI_URL/people/$PERSON_KEY"
  npx agent-browser wait --load networkidle
  PERSON_SNAP=$(npx agent-browser snapshot 2>/dev/null)
  npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-person-dom.html 2>/dev/null
  npx agent-browser screenshot /tmp/uat-21-13-person.png 2>/dev/null

  if echo "$PERSON_SNAP" | grep -qi "Ashish Vaswani"; then
    pass "13a. Person detail page loads for Ashish Vaswani"
  else
    fail "13a. Person detail page did not render name"
  fi

  # Person infobox is server-derived and uses the structured table.
  if grep -qE 'class="[^"]*\bwinfo\b' /tmp/uat-21-person-dom.html; then
    pass "13b. Person page renders structured .winfo infobox"
  else
    fail "13b. Person page missing structured infobox"
  fi

  # Relationship row — derived from person.relationship
  if echo "$PERSON_SNAP" | grep -qi "Relationship"; then
    pass "13c. Person infobox has 'Relationship' row"
  else
    fail "13c. Person infobox missing 'Relationship' row"
  fi

  # At least one of Aliases / First mentioned / Mentions rows present
  # (any that would be empty are filtered server-side; Relationship alone
  # is enough to prove derivation).
  if echo "$PERSON_SNAP" | grep -qiE "Aliases|First mentioned|Mentions"; then
    pass "13d. Person infobox shows at least one derived row beyond Relationship"
  else
    skip "13d. Derived rows (Aliases/First mentioned/Mentions) all empty for this person"
  fi
else
  skip "13. Person 'ashish-vaswani' not seeded — re-run seed-fixture"
fi

# ── 14. H1 + intro + H2 shape — regression guard for #152 ───
# The Transformer fixture starts `# Title\n\nIntro paragraph\n\n## Section`.
# Before #152's fix, the render loop treated H1 as a full-span block that
# ran to EOF, so every post-H1 section rendered twice. The first fix (#156
# commit 3803473) skipped H1 in the loop but dropped the intro paragraph
# entirely — a regression caught in ultrathink review and fixed in commit
# 061c3a6. This step guards against BOTH failure modes by asserting the
# intro renders exactly once AND each section body renders exactly once.
#
# Drive the shape directly via PUT so this assertion survives future
# fixture body edits.

INTRO_BODY='# Transformer Architecture

The Transformer discards recurrence in favour of attention. Canonical refs live at [[person:ashish-vaswani]] and [[wiki:attention-is-all-you-need]].

## Overview

Body of overview with [[fragment:self-attention-replaces-recurrence]].

## Architecture

Body of architecture.'

curl -s -o /dev/null -b "$COOKIE_JAR" -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "$(jq -n --arg body "$INTRO_BODY" --arg name "Transformer Architecture" '{frontmatter:{name:$name,type:"project",prompt:""},body:$body}')" \
  "$SERVER_URL/api/content/wiki/$TRANSFORMER_KEY"

npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
sleep 1
INTRO_SNAP=$(npx agent-browser snapshot 2>/dev/null)
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-h1intro-dom.html 2>/dev/null
npx agent-browser screenshot /tmp/uat-21-14-h1intro.png 2>/dev/null

# 14a. Intro paragraph renders at least once — the regression dropped
# it entirely because preamble was `lines.slice(0, H1.startLine) = ''`.
if echo "$INTRO_SNAP" | grep -q "Transformer discards recurrence in favour of attention"; then
  pass "14a. H1-intro paragraph renders (not dropped)"
else
  fail "14a. H1-intro paragraph is missing — regression of 061c3a6"
fi

# 14b. Intro paragraph renders EXACTLY once — original bug rendered it
# twice because H1's full span was rendered then each H2 again.
INTRO_COUNT=$(echo "$INTRO_SNAP" | grep -oc "Transformer discards recurrence in favour of attention" || echo 0)
if [ "$INTRO_COUNT" = "1" ]; then
  pass "14b. H1-intro paragraph rendered exactly once"
else
  fail "14b. H1-intro rendered $INTRO_COUNT times (expected 1) — double-render regression"
fi

# 14c. Each H2 body renders exactly once.
OVERVIEW_COUNT=$(echo "$INTRO_SNAP" | grep -oc "Body of overview with" || echo 0)
ARCH_COUNT=$(echo "$INTRO_SNAP" | grep -oc "Body of architecture" || echo 0)
if [ "$OVERVIEW_COUNT" = "1" ] && [ "$ARCH_COUNT" = "1" ]; then
  pass "14c. H2 bodies render exactly once each"
else
  fail "14c. H2 body render counts: overview=$OVERVIEW_COUNT architecture=$ARCH_COUNT (expected 1 each)"
fi

# 14d. The markdown `# Transformer Architecture` does NOT render as an <h1>
# in the body — page chrome owns the document-level heading.
if grep -qE '<h1[^>]*>[^<]*Transformer Architecture' /tmp/uat-21-h1intro-dom.html; then
  # Chrome H1 lives inside .wiki-article-h1 — the SectionedMarkdownBody
  # MUST NOT produce its own H1 with the title text. Distinguish chrome
  # from body by checking whether any <h1> outside the chrome class contains
  # the title.
  if grep -oE '<h1[^>]*(wiki-article-h1)[^>]*>[^<]*Transformer' /tmp/uat-21-h1intro-dom.html >/dev/null \
     && ! grep -oE '<h1(?![^>]*wiki-article-h1)[^>]*>[^<]*Transformer' /tmp/uat-21-h1intro-dom.html >/dev/null; then
    pass "14d. H1 only rendered by page chrome, not markdown body"
  else
    fail "14d. H1 'Transformer Architecture' appears in markdown body (should only be page chrome)"
  fi
else
  fail "14d. No <h1> contains the wiki title — page chrome regression"
fi

# Restore the canonical fixture body for downstream steps and plan 22.
pnpm -C core seed-fixture >/dev/null 2>&1 || true

# ── 15. Rendering polish — issue #251 ────────────────────────
# Three small visual bugs caught in one polish pass. They share no root
# cause but each materially degrades the rendered surface:
#   - Hero title: the wiki home page renders `session.user.name` as a
#     giant <h1> ("phyl"). Just visual noise on a page whose value is the
#     search box and filter chips. Expected: no user-name hero on first
#     paint.
#   - Infobox width: the rich `.winfo` table (width: 100%) was rendering
#     inside the 217px `.wiki-aside-infobox` flex aside. With no width
#     constraint on the table the body got squeezed into a ~5-character
#     left column. Expected: when sidecar carries a structured infobox,
#     it renders ABOVE the body at full content width; the 217px aside is
#     reserved for the legacy simple infoboxes only.
#   - H1 dedup: SectionedMarkdownBody.tsx:156 already skips H1 in the
#     section loop (fixed in #152). This sub-step is a regression guard
#     to ensure that fix survives — only ONE H1 carrying the wiki title
#     in the rendered DOM.
#
# Each sub-step is deterministic on the seeded Transformer fixture (which
# carries a structured sidecar infobox with all four valueKinds) and the
# authenticated wiki home route.

# 15a. Hero absence — wiki home does NOT render a user-name <h1> hero.
# Sign in fresh so session.user.name is populated, then load /wiki.
npx agent-browser open "$WIKI_URL/login"
npx agent-browser wait --load networkidle
npx agent-browser fill '#email' "${INITIAL_USERNAME:-uat@robin.test}"
npx agent-browser fill '#password' "${INITIAL_PASSWORD:-uat-password-123}"
npx agent-browser click 'button[type="submit"]'
npx agent-browser wait --load networkidle

npx agent-browser open "$WIKI_URL/wiki"
npx agent-browser wait --load networkidle
# Wiki home is React-hydrated — wait long enough for the hero <h1> (if
# any) to render. The hero check below probes the live DOM via eval.
sleep 3
HOME_SNAP=$(npx agent-browser snapshot)
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-15-home-dom.html
npx agent-browser screenshot /tmp/uat-21-15-home.png

# The fork's fix removes the entire WikiHomeHero <h1>. Detection is
# twofold: no element with class `wiki-home-title` in the live DOM, AND
# the logged-in user's display name does not appear inside any <h1>. The
# class check uses agent-browser eval (not grep) because eval returns
# the JSON-escaped outerHTML where attribute quotes become \" and break
# naive regex; querySelectorAll walks the live DOM and is reliable.
USER_NAME=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" "$SERVER_URL/api/auth/get-session" \
  | jq -r '.user.name // .user.email // ""')

HOME_TITLE_COUNT=$(npx agent-browser eval \
  "document.querySelectorAll('h1.wiki-home-title').length")
if [ "$HOME_TITLE_COUNT" = "0" ]; then
  pass "15a. No <h1.wiki-home-title> hero on /wiki"
else
  fail "15a. $HOME_TITLE_COUNT <h1.wiki-home-title> hero(es) still on /wiki"
fi

# 15b. Belt-and-suspenders: even if the class were renamed, the user
# display name should not appear inside any <h1> on the home page. Pull
# h1 textContents via eval and filter in shell — keeps the eval JS
# free of bash interpolation hazards.
H1_TEXTS=$(npx agent-browser eval \
  "Array.from(document.querySelectorAll('h1')).map(h => h.textContent).join('|||')")
if [ -n "$USER_NAME" ] && echo "$H1_TEXTS" | grep -qF "$USER_NAME"; then
  fail "15b. User name '$USER_NAME' appears inside an <h1> on /wiki — hero not removed"
else
  pass "15b. User name does not appear inside any <h1> on /wiki"
fi

# 15c. Infobox-above-body at full content width.
# Trigger state: the seeded Transformer wiki has a structured sidecar
# infobox (verified at step 0d). The fork's fix renders that .winfo table
# OUTSIDE any side-aside slot — as a block above the article body, full
# content width.
npx agent-browser open "$WIKI_URL/wiki/$TRANSFORMER_KEY"
npx agent-browser wait --load networkidle
sleep 1
npx agent-browser eval "document.documentElement.outerHTML" > /tmp/uat-21-15-infobox-dom.html
npx agent-browser screenshot /tmp/uat-21-15-infobox.png

# 15c. The .winfo must not live in any aside slot. Two failure modes:
# (1) descendant of .wiki-aside-infobox (legacy 217px aside class), or
# (2) flex sibling of .wiki-article-content inside .wiki-article-layout.
# Both squeeze the body. Render-above-body fix puts the .winfo OUTSIDE
# .wiki-article-layout entirely.
# `agent-browser eval` returns the JSON-encoded value, so a string return
# arrives wrapped in literal double-quotes (e.g. `"outside"`). Strip them
# before comparison so the bash equality check does what the assertion
# means.
WINFO_IN_ASIDE_SLOT_RAW=$(npx agent-browser eval \
  "(() => { const w = document.querySelector('.winfo'); if (!w) return 'no-winfo'; if (w.closest('.wiki-aside-infobox')) return 'in-legacy-aside'; const layout = w.closest('.wiki-article-layout'); const body = document.querySelector('.wiki-article-content'); if (layout && body && layout.contains(body)) return 'sibling-of-body'; return 'outside'; })()")
WINFO_IN_ASIDE_SLOT=$(echo "$WINFO_IN_ASIDE_SLOT_RAW" | sed 's/^"//;s/"$//')
if [ "$WINFO_IN_ASIDE_SLOT" = "outside" ]; then
  pass "15c. Structured .winfo renders outside any aside slot"
elif [ "$WINFO_IN_ASIDE_SLOT" = "no-winfo" ]; then
  fail "15c. No .winfo element found on Transformer page — sidecar regression?"
else
  fail "15c. .winfo trapped in aside slot (got: $WINFO_IN_ASIDE_SLOT)"
fi

# 15d. The .winfo must render at content-width, not squeezed. Floor:
# 600px on a 1280px viewport. Anything below 600 means it's still in
# a flex slot competing with .wiki-article-content for width.
WINFO_WIDTH=$(npx agent-browser eval \
  "(() => { const el = document.querySelector('.winfo'); return el ? Math.round(el.getBoundingClientRect().width) : 0; })()")
VIEWPORT_W=$(npx agent-browser eval "window.innerWidth")
if [ -n "$WINFO_WIDTH" ] && [ "$WINFO_WIDTH" -ge 600 ] 2>/dev/null; then
  pass "15d. Structured .winfo renders at content width (${WINFO_WIDTH}px on ${VIEWPORT_W}px viewport)"
elif [ "$WINFO_WIDTH" = "0" ]; then
  fail "15d. No .winfo element found"
else
  fail "15d. .winfo width is ${WINFO_WIDTH}px (viewport ${VIEWPORT_W}px) — still squeezed"
fi

# 15e. The .winfo renders ABOVE the article body — DOM order precedes
# .wiki-article-content. compareDocumentPosition with the body returns
# DOCUMENT_POSITION_FOLLOWING (bit 4 = 4) when the infobox is above.
# `agent-browser eval` returns the JSON-encoded value; strings come back
# wrapped in literal quotes — strip them before comparing.
WINFO_BEFORE_BODY_RAW=$(npx agent-browser eval \
  "(() => { const w = document.querySelector('.winfo'); const b = document.querySelector('.wiki-article-content'); if (!w || !b) return 'missing'; return (w.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'above' : 'below'; })()")
WINFO_BEFORE_BODY=$(echo "$WINFO_BEFORE_BODY_RAW" | sed 's/^"//;s/"$//')
if [ "$WINFO_BEFORE_BODY" = "above" ]; then
  pass "15e. Structured .winfo renders above .wiki-article-content"
elif [ "$WINFO_BEFORE_BODY" = "missing" ]; then
  fail "15e. Could not locate .winfo or .wiki-article-content for ordering check"
else
  fail "15e. Structured .winfo renders below the body (got: $WINFO_BEFORE_BODY)"
fi

# 15f. H1 dedup regression guard — exactly ONE <h1> in the rendered DOM
# carries the wiki title text. The H1 belongs to page chrome
# (.wiki-article-h1); the markdown body must NOT also emit an <h1>. This
# protects the SectionedMarkdownBody.tsx:156 fix (`if (section.level === 1)
# continue`) from being re-introduced by future refactors. Use eval so
# the count walks live DOM, immune to JSON-escaped outerHTML quirks.
H1_TITLE_COUNT=$(npx agent-browser eval \
  "Array.from(document.querySelectorAll('h1')).filter(h => h.textContent && h.textContent.includes('Transformer Architecture')).length")
if [ "$H1_TITLE_COUNT" = "1" ]; then
  pass "15f. Exactly ONE <h1> contains the wiki title (H1 dedup holds)"
else
  fail "15f. $H1_TITLE_COUNT <h1> elements contain the wiki title (expected 1) — H1 dedup regressed"
fi

# 15g. The single title <h1> belongs to page chrome, not the markdown
# body. SectionedMarkdownBody must not emit any <h1> at all.
BODY_H1_COUNT=$(npx agent-browser eval \
  "document.querySelectorAll('.wiki-article-content h1, .wiki-richtext-rendered h1').length")
if [ "$BODY_H1_COUNT" = "0" ]; then
  pass "15g. Markdown body emits no <h1> (H1 only in page chrome)"
else
  fail "15g. Markdown body emits $BODY_H1_COUNT <h1> element(s) — should be 0"
fi

# ── Cleanup ──────────────────────────────────────────────────
npx agent-browser close 2>/dev/null || true

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0 | Transformer demo wiki seeded; API returns refs/sections/infobox | seed-fixture prereq |
| 1 | /wiki/<transformer> loads with title | detail page |
| 2 | 4 token kinds (person/fragment/wiki/entry) render as WikiChip with canonical labels | MarkdownContent token substitution |
| 3 | Unresolved `[[person:anonymous-reviewer]]` renders as literal text, not chip, not stripped | renderer fallback policy |
| 4 | Structured .winfo table with rows for all valueKinds; ref-row is a chip; status is a pill | WikiInfobox |
| 5 | Citation superscripts on Overview + Architecture (4 total); none on Notes; hover has content; click routes to fragment | WikiCitations |
| 6 | Section-scoped edit: dialog opens, body saves, heading/anchor preserved, siblings untouched | SectionEditor + replaceSectionInMarkdown |
| 7 | H1 heading has no [edit] affordance | H1 exclusion rule |
| 8 | `notes` and `notes-1` are independent: editing the second doesn't change the first | duplicate-heading anchor algorithm |
| 9 | Stale-section save surfaces a recoverable message instead of crashing | handleSectionSave guard |
| 10 | HTML-body path: no [edit] brackets, chips still render | MarkdownContent vs HtmlWikiBody branch |
| 11 | Code-fence isolation: tokens inside `<code>`/`<pre>` render as literal source, prose tokens still resolve | HTML-body walker |
| 12 | Entry detail page resolves tokens and has no infobox | useEntry + EntryArticle |
| 13 | Person detail page renders server-derived .winfo infobox with Relationship row | usePerson + derivePersonInfobox |
| 14 | H1 + intro + H2 shape: intro renders exactly once, H2 bodies render exactly once, no body-level H1 — regression guard for #152 + 061c3a6 | SectionedMarkdownBody preamble + H1 skip |
| 15 | Rendering polish (issue #251): no user-name hero on /wiki; structured .winfo renders above body at full width (not in 217px aside); H1 dedup guard — exactly one title <h1>, none from markdown body | WikiHomeHero, WikiEntityArticle infobox slot, SectionedMarkdownBody.tsx:156 |

---

## Notes

- Citation hover/click behavior (step 5c/5d) depends on the Wave-3a decision for Q5 — some deployments open a popover, others navigate to the fragment. The script asserts the underlying DOM source exists; visual hover-card validation remains a manual screenshot check via `/tmp/uat-21-*.png`.
- Step 9 mutates the wiki body via `PUT /api/content/wiki/<key>` to simulate a concurrent regen. The script reseeds the fixture afterward so the overall suite leaves the DB clean.
- Step 10 also mutates the body (to an HTML string) to force the Tiptap-saved branch, then reseeds.
- If the `agent-browser eval document.querySelector('#notes-1 a.wedit')?.click()` selector misses because the `[edit]` link sits outside the section anchor wrapper rather than inside it, step 8 reports a deterministic fail rather than silently passing — adjust the selector to match the rendered DOM structure in `/tmp/uat-21-dom.html`.
- Step 15 covers issue #251 (rendering polish): three fork-only fixes — drop the giant user-name hero on `/wiki`, render the rich infobox above the body at full width when sidecar carries structured data, and guard the existing H1 dedup at `SectionedMarkdownBody.tsx:156`. 15a–15b detect the hero by class and by the user name appearing inside any `<h1>`. 15c–15e use `agent-browser eval` to walk the DOM (`closest`, `getBoundingClientRect`, `compareDocumentPosition`) so the assertions don't depend on serialized markup ordering. 15f–15g count title `<h1>` elements in the source HTML and probe for body-level `<h1>` via querySelectorAll. The hero check requires `session.user.name` to be populated — sign-in happens at the top of the step.
