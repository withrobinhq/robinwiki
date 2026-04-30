# 33 — Quill Writer Agent (regen output)

## What it proves

Four facets of issue #257 — wiki regeneration ("Quill") is currently
piggy-backing on the wiki-classifier agent (Haiku-class, 4k default
output cap), which silently truncates large wikis on regen:

**(A) Source-level: regen.ts no longer routes through `wikiClassifier`.**
Today `core/src/lib/regen.ts:393-396` constructs the regen caller with
`agents.wikiClassifier`:

```
const callLlm = createTypedCaller(
  agents.wikiClassifier,
  regenOutputSchema as unknown as ...,
)
```

That agent is wired to the `models.classification` slot in
`packages/agent/src/openrouter-config.ts:5` — Haiku-class. The fix is a
new `wikiWriter` (or similarly-named) agent backed by the
`models.wikiGeneration` slot, with a higher output cap. §1 asserts the
regen.ts callsite no longer references `wikiClassifier` AND does
reference a writer-class agent name.

**(B) `caller.ts` AGENT_MODEL_SETTINGS exposes a 16k output cap.**
`packages/agent/src/agents/caller.ts:25-27` currently ships
`AGENT_MODEL_SETTINGS = { maxRetries: ... }` — no `maxOutputTokens`.
That falls through to the OpenRouter SDK's default (~4096), so any
generated wiki content longer than ~4k tokens gets cut mid-sentence.
The fix surfaces a `maxOutputTokens: 16000` somewhere reachable by
the writer agent — either as a per-agent override or as the global
default. §2 greps for the literal `16000` (or `16_000`) within
`caller.ts` or the agent factory.

**(C) Functional: a regen on a content-bloated wiki returns text that
ends on a sensible boundary.** The classic failure mode is a
mid-sentence cutoff: `"...the architecture combines self-attention
with feed-forw"` — last 200 chars end mid-word. We seed extra content
into a wiki, trigger regen, and assert the result's last 200 chars
end on punctuation OR a whitespace-followed word. We snap the wiki
content back at the end so downstream plans see the original. Note:
regen is gated by `wikis.regenerate = true`; we toggle if needed and
restore.

**(D) Wiki-type yaml has the double-quote → single-quote/italics rule.**
The issue body recommends adding a typography rule to wiki-type
prompts so the LLM doesn't emit smart-quote-collision artifacts. §4
greps `packages/shared/src/prompts/specs/wiki-types/log.yaml` (and
peers) for a rule mentioning `quote` + (`single` OR `italic`).

## Prerequisites

- Plan 22 has run (Transformer fixture seeded) so a regen-eligible
  wiki exists.
- Core server reachable at `SERVER_URL` (default `http://localhost:3000`).
- `INITIAL_USERNAME` / `INITIAL_PASSWORD` set in `core/.env`.
- `psql` with `DATABASE_URL` from `core/.env`.
- `jq`, `grep` installed.
- OpenRouter API key configured (regen calls the live LLM).

## Fixture identity this plan references

- regen callsite: `core/src/lib/regen.ts:393-396`.
- agent factory: `packages/agent/src/agent-factory.ts` (whatever
  exports `createIngestAgents`).
- agent caller: `packages/agent/src/agents/caller.ts:25` (the
  `AGENT_MODEL_SETTINGS` const).
- model config: `packages/agent/src/openrouter-config.ts:1-9` (the
  `models.wikiGeneration` slot).
- wiki-type prompts: `packages/shared/src/prompts/specs/wiki-types/*.yaml`.
- target wiki: the seeded Transformer wiki (or any wiki with
  `regenerate=true` or one we can flip).

## Restoring downstream-plan state

§3 takes a snapshot of the target wiki's `content`, `description`,
`updated_at` before mutating, then restores at the end. If §3 had to
flip `regenerate` from false to true, we flip it back. No fragments
created, no cascades touched.

---

## Test Steps

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${PROJECT_ROOT:-/home/me/apps/robin}"
source core/.env 2>/dev/null || true

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
COOKIE_JAR=$(mktemp /tmp/uat-cookies-33-XXXXXX.txt)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ $1"; }

echo "33 — Quill Writer Agent (#257)"
echo ""

# ── 0. Sanity: target files exist ────────────────────────────
for f in core/src/lib/regen.ts packages/agent/src/agents/caller.ts \
         packages/agent/src/openrouter-config.ts; do
  if [ -f "$f" ]; then pass "0a. $f exists"
  else fail "0a. $f missing"; fi
done

# Sign in for §3.
curl -s -o /dev/null -c "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d "{\"email\":\"$INITIAL_USERNAME\",\"password\":\"$INITIAL_PASSWORD\"}" \
  "$SERVER_URL/api/auth/sign-in/email"
if [ -s "$COOKIE_JAR" ]; then
  pass "0b. signed in"
else
  fail "0b. login failed — §3 will skip"
fi

# ── 1. §1 — regen.ts no longer routes through wikiClassifier ─
# Look at the createTypedCaller call inside regen.ts. The current line
# is `agents.wikiClassifier` — after fix, this should reference a
# writer agent. We grep with line context.
REGEN_CALLSITE=$(grep -nE 'createTypedCaller\(\s*agents\.[A-Za-z]+' \
  core/src/lib/regen.ts | head -1)
echo "  ▸ regen callsite: $REGEN_CALLSITE"
if echo "$REGEN_CALLSITE" | grep -q 'wikiClassifier'; then
  fail "1a. regen.ts still uses agents.wikiClassifier (#257 unfixed)"
else
  pass "1a. regen.ts no longer references agents.wikiClassifier"
fi

# Stronger: assert it references a writer-class agent name (writer/
# generator/quill/wikiGeneration). If the fix renames the agent,
# allow any of these candidates.
WRITER_REF=$(grep -cE 'agents\.(wikiWriter|wikiGenerator|quill|wikiGeneration|writer)' \
  core/src/lib/regen.ts || true)
if [ "${WRITER_REF:-0}" -ge 1 ]; then
  pass "1b. regen.ts references a writer-class agent ($WRITER_REF match(es))"
else
  skip "1b. regen.ts has no writer-class agent name yet — fix may use a new name; review manually"
fi

# ── 2. §2 — 16k output cap surfaced ──────────────────────────
# AGENT_MODEL_SETTINGS at caller.ts:25 currently ships only maxRetries.
# A correct fix exposes maxOutputTokens: 16000 either there or in the
# agent factory where the writer agent is constructed.
CAP_HITS_CALLER=$(grep -cE '16[_]?000|16384' packages/agent/src/agents/caller.ts || true)
CAP_HITS_FACTORY=$(grep -cE 'maxOutputTokens.*16[_]?000|16[_]?000.*maxOutputTokens' \
  packages/agent/src/agent-factory.ts 2>/dev/null || true)
TOTAL_CAP=$((CAP_HITS_CALLER + CAP_HITS_FACTORY))
if [ "$TOTAL_CAP" -ge 1 ]; then
  pass "2a. 16k output cap present (caller=$CAP_HITS_CALLER, factory=$CAP_HITS_FACTORY)"
else
  fail "2a. no 16k output cap found in caller.ts or agent-factory.ts (#257 cap unraised)"
fi

# Numeric extract: print the actual maxOutputTokens value found, if any.
ACTUAL_CAP=$(grep -EhoR 'maxOutputTokens[[:space:]]*:[[:space:]]*[0-9_]+' \
  packages/agent/src 2>/dev/null | grep -oE '[0-9_]+' | head -1)
if [ -n "$ACTUAL_CAP" ]; then
  pass "2b. maxOutputTokens literal found: $ACTUAL_CAP"
else
  skip "2b. no maxOutputTokens literal found in packages/agent/src — fix may surface elsewhere"
fi

# ── 3. §3 — large-content regen doesn't truncate mid-word ────
# Pick a regen-eligible wiki, snapshot, bloat content past 4k tokens,
# trigger regen, inspect output. Restore at the end.
if [ -s "$COOKIE_JAR" ]; then
  WIKI_KEY=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
    "$SERVER_URL/wikis?limit=1" | jq -r '.wikis[0].id // empty')
  if [ -z "$WIKI_KEY" ]; then
    skip "3a. no wiki to regen — Transformer fixture missing"
  else
    # Snapshot ORIGINAL state for restore.
    ORIG_CONTENT=$(psql "$DATABASE_URL" -tA -c \
      "SELECT content FROM wikis WHERE lookup_key = '$WIKI_KEY'")
    ORIG_REGEN=$(psql "$DATABASE_URL" -tA -c \
      "SELECT regenerate FROM wikis WHERE lookup_key = '$WIKI_KEY'")

    # Ensure regenerate is enabled.
    if [ "$ORIG_REGEN" != "t" ]; then
      psql "$DATABASE_URL" -c \
        "UPDATE wikis SET regenerate = true WHERE lookup_key = '$WIKI_KEY'" \
        > /dev/null
    fi

    # Bloat: prepend ≥5k tokens of filler content to push past 4k cap.
    # ~5 chars/token average; 30000 chars ≈ 6k tokens. We'll generate
    # a deterministic-ish blob (no special chars to avoid yaml/markdown
    # escaping issues).
    FILLER=$(python3 -c \
      'print(("The architecture combines self-attention with feed-forward layers across many transformer blocks. " * 320))' \
      2>/dev/null || \
      yes "The architecture combines self-attention with feed-forward layers across many transformer blocks." | head -320 | tr '\n' ' ')
    BLOATED="${ORIG_CONTENT}

${FILLER}"
    psql "$DATABASE_URL" -c \
      "UPDATE wikis SET content = \$\$${BLOATED}\$\$ WHERE lookup_key = '$WIKI_KEY'" \
      > /dev/null

    # Trigger regen.
    REGEN_RES=$(curl -s -b "$COOKIE_JAR" -H "Origin: http://localhost:3000" \
      -X POST "$SERVER_URL/wikis/$WIKI_KEY/regenerate")
    REGEN_OK=$(echo "$REGEN_RES" | jq -r '.ok // false')
    if [ "$REGEN_OK" = "true" ]; then
      pass "3a. regen API returned ok=true"
    else
      fail "3a. regen failed: $REGEN_RES"
    fi

    # Inspect new content. Last 200 chars must end on punctuation or a
    # complete word (whitespace + word + .!?). Mid-word cutoff is the
    # truncation signature.
    NEW_CONTENT=$(psql "$DATABASE_URL" -tA -c \
      "SELECT content FROM wikis WHERE lookup_key = '$WIKI_KEY'")
    NEW_LEN=${#NEW_CONTENT}
    TAIL=${NEW_CONTENT: -200}
    LAST_CHAR=${TAIL: -1}
    case "$LAST_CHAR" in
      .|!|\?|\"|\'|\)|\]|\}|\>) BOUNDARY=ok ;;
      *) BOUNDARY=mid ;;
    esac
    echo "  ▸ new content ${NEW_LEN}B; last char=[$LAST_CHAR]; tail: ...${TAIL: -80}"
    if [ "$BOUNDARY" = "ok" ]; then
      pass "3b. regen output ends on a sensible boundary (last char='$LAST_CHAR')"
    else
      fail "3b. regen output ends mid-word (last char='$LAST_CHAR') — 4k truncation signature"
    fi

    # Length sanity: a fix that uplifts the cap to 16k should produce
    # output noticeably larger than the historical 4k cap (≥4500 chars
    # is a soft floor — Quill compresses, so don't expect 5x).
    if [ "$NEW_LEN" -gt 4500 ]; then
      pass "3c. regen output is ${NEW_LEN}B (>4500B — past 4k cutoff zone)"
    else
      skip "3c. regen output is ${NEW_LEN}B (≤4500B — could be Quill compressing, not necessarily truncation)"
    fi

    # Restore.
    psql "$DATABASE_URL" -c \
      "UPDATE wikis SET content = \$\$${ORIG_CONTENT}\$\$ WHERE lookup_key = '$WIKI_KEY'" \
      > /dev/null
    if [ "$ORIG_REGEN" != "t" ]; then
      psql "$DATABASE_URL" -c \
        "UPDATE wikis SET regenerate = false WHERE lookup_key = '$WIKI_KEY'" \
        > /dev/null
    fi
    pass "3z. wiki snapshot restored"
  fi
else
  skip "3a. login failed — skipping live regen"
fi

# ── 4. §4 — log.yaml double-quote rule ───────────────────────
# Issue #257 recommends adding a typography rule across wiki-type
# prompts: convert ASCII double-quotes to single-quotes or italics
# (so the renderer doesn't fight smart-quote pairing in user content).
# We grep the canonical type yaml — log.yaml — for a rule mentioning
# both `quote` and one of (`single`, `italic`).
LOG_YAML=packages/shared/src/prompts/specs/wiki-types/log.yaml
if [ -f "$LOG_YAML" ]; then
  QUOTE_RULE=$(grep -niE 'quote.*(single|italic)|(single|italic).*quote' "$LOG_YAML" || true)
  if [ -n "$QUOTE_RULE" ]; then
    pass "4a. log.yaml has a double-quote/single-quote/italics rule"
    echo "    $QUOTE_RULE"
  else
    fail "4a. log.yaml missing the double-quote → single/italic rule (#257 typography)"
  fi
else
  skip "4a. $LOG_YAML missing — yaml moved or renamed"
fi

# ── Cleanup — already handled inline (§3 restored snapshot) ──
# No global mutations remain. Cookie jar removed by trap.

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0a | Target files exist (`regen.ts`, `caller.ts`, `openrouter-config.ts`) | filesystem |
| 0b | Login succeeds | `/auth/login` |
| 1a | `regen.ts` no longer references `agents.wikiClassifier` | `core/src/lib/regen.ts:393-396` |
| 1b | `regen.ts` references a writer-class agent (writer/generator/quill/etc) | `core/src/lib/regen.ts` |
| 2a | A 16k literal (`16000` / `16_000`) appears in `caller.ts` or `agent-factory.ts` | `packages/agent/src/agents/caller.ts:25` |
| 2b | `maxOutputTokens: <n>` literal extractable from `packages/agent/src` | `packages/agent/src` |
| 3a | `POST /wikis/:id/regenerate` returns `ok=true` on a content-bloated wiki | `core/src/routes/wikis.ts:548` |
| 3b | Regen output's last char is punctuation/quote/bracket — not mid-word | `wikis.content` post-regen |
| 3c | Regen output length > 4500B (past historical 4k truncation zone) | `wikis.content` length |
| 3z | Wiki content + `regenerate` flag restored to pre-§3 snapshot | `psql UPDATE` |
| 4a | `log.yaml` has a `quote` + (`single` OR `italic`) rule | `packages/shared/src/prompts/specs/wiki-types/log.yaml` |
| Cleanup | None beyond §3z (in-line) | n/a |

---

## Notes

- **§1, §2, §3, §4 all expected to FAIL on current `main`.** That's
  the design — §0a-0b are the control signals.
- **§1b is a SKIP-on-no-match, not FAIL.** The fix may rename the agent
  (e.g. `quill` instead of `wikiWriter`); we don't want to false-fail
  on a legit rename. The hard signal is §1a (no longer using
  `wikiClassifier`).
- **§2's 16k literal is the cheapest grep.** A more thorough check
  would parse the actual model setting passed at the writer agent's
  construction site, but that requires knowing the post-fix shape. The
  grep catches the common fix shape (constant or per-agent override).
- **§3 uses `python3` for the filler if available, else `yes | head`.**
  Pure bash string-multiplication of a 30KB blob is slow on some
  shells. If the runner has Python and `python3` is on PATH, we use
  it. Either path produces ~30KB of filler.
- **§3b's boundary check is heuristic.** A correct LLM output can in
  rare cases legitimately end on a non-punctuation char (e.g. a code
  block ending with an identifier). False-positive rate is low because
  Quill's prompts target prose. The complement signal is §3c
  (length-based).
- **§3 has a snapshot-and-restore inline rather than at the end.**
  This minimises the residue window if the script is interrupted
  mid-§3. The snapshot is a single in-process variable; if the script
  dies between mutate and restore, manual cleanup is one psql line.
- **§4's literal rule wording is loose.** The issue body says "convert
  double quotes to single quotes or italics" but the actual yaml
  phrasing is up to the author. We accept any match where `quote` and
  one of `single`/`italic` co-occur in any order. If the author uses
  totally different wording (e.g. `“ ”` to `‘ ’`), §4a will
  false-fail — operator should re-check by hand.
- **Live confirmation on `main` at the plan-write commit:** §1a
  matches `agents.wikiClassifier` at `regen.ts:394`. §2a finds zero
  `16000` occurrences in `caller.ts` (only `maxRetries: 2` ships).
  §4a finds zero `quote` + `single`/`italic` in `log.yaml`. All three
  expected to FAIL pre-fix.
