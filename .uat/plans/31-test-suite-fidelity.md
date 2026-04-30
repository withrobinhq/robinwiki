# 31 — Test Suite Fidelity

## What it proves

Three facets of issue #222 (closes the false-green gap surfaced in PR
#214 review):

**(A) `regen.test.ts` runs without swallowed `TypeError`.** A vitest run
of `core/src/lib/regen.test.ts` produces zero `TypeError` lines on
stderr/stdout. Specifically the line
`TypeError: database.select(...).from(...).where(...).limit is not a function`
emitted from `core/src/lib/regen.ts:211` (inside
`classifyUnfiledFragments`) must be absent. Today every one of the 10
tests triggers this error and the throw is swallowed by the
`try/catch` at `core/src/lib/regen.ts:381` (`'unfiled fragment
classification failed — continuing with existing fragments'`), so the
suite passes 10/10 green while the classification pre-step is never
actually exercised under test.

**(B) The classify codepath is mechanically reachable from at least
one test.** Static check on `core/src/lib/regen.test.ts`: the fake DB
chain returned from `selectChain().from().where()` exposes a `.limit`
function (the missing terminal that `classifyUnfiledFragments` calls
at `regen.ts:211`). This is the structural fix the issue asks for.
Belt-and-braces, the test file should also stage at least one
DB-response queue entry intended to be popped by `.limit(1)` — i.e.
the suite must demonstrate awareness that `classifyUnfiledFragments`
runs. Without this, fixing the mock alone could still leave the
codepath unverified.

**(C) Codebase-wide warn-and-continue surface is documented AND the
four MASKING sites have audit-row contracts.** Hunt for
`} catch (...) { log.warn(...) }` patterns elsewhere in `core/src/`.
Each is surfaced as a SKIP entry (intentional list is not load-bearing).
On top of the surface scan, the four MASKING sites originally
flagged by #265 triage (issues #271–#274) FAIL the plan unless their
swallow-side catch emits an `audit_log` row with the named
`event_type`, AND a per-site vitest unit test (mocking the throwing
dependency) asserts that emit. This is the structural fix #271–#274
shipped — without it, a test of the surrounding code can stay green
while the swallowed branch is broken.

## Prerequisites

- Repo at the commit being audited; `pnpm install` has run at the
  workspace root.
- `pnpm` available; vitest runs via `pnpm -C core test` (the package's
  configured test script under `core/package.json`).
- No running stack required — vitest is a unit-test runner and these
  tests fully mock `../db/client.js` and `@robin/agent`.

## Fixture identity this plan references

- Target test file: `core/src/lib/regen.test.ts` (10 tests, all
  exercise `regenerateWiki` which calls `classifyUnfiledFragments`).
- Production code under test: `core/src/lib/regen.ts:200-244`
  (`classifyUnfiledFragments`, the function whose `.limit(1)` call at
  line 211 throws against the current mock).
- Swallow site: `core/src/lib/regen.ts:381-383`.
- Vitest output capture: `/tmp/uat-31-vitest.log` (overwritten each
  run).

## Restoring downstream-plan state

Read-only — no DB writes, no stack changes, no env mutation. Leaves no
residue for downstream plans.

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

echo "31 — Test Suite Fidelity (#222 false-green audit)"
echo ""

VITEST_LOG=/tmp/uat-31-vitest.log
: > "$VITEST_LOG"

# ── 0. Sanity: target files exist ────────────────────────────
# If the test file or its production target moved, every assertion below
# would skip silently — fail loud here so the operator notices.

if [ -f core/src/lib/regen.test.ts ]; then
  pass "0a. core/src/lib/regen.test.ts exists"
else
  fail "0a. core/src/lib/regen.test.ts missing — file moved or renamed?"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

if [ -f core/src/lib/regen.ts ]; then
  pass "0b. core/src/lib/regen.ts exists"
else
  fail "0b. core/src/lib/regen.ts missing — file moved or renamed?"
  echo ""
  echo "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# Confirm the swallow site still matches the issue's quoted location.
# If line 381 no longer holds the catch+warn, the assertions below may
# be auditing the wrong surface.
SWALLOW_LINE=$(grep -n "unfiled fragment classification failed" core/src/lib/regen.ts | head -1 | cut -d: -f1)
if [ -n "$SWALLOW_LINE" ]; then
  pass "0c. swallow site found at core/src/lib/regen.ts:$SWALLOW_LINE"
else
  skip "0c. swallow site log message not found — fix may already be in"
fi

# ── 1. §1 — vitest run produces ZERO TypeError lines ─────────
# This is the behavioral assertion. Run regen.test.ts in isolation,
# capture combined stdout+stderr, and grep for TypeError. The bug is
# present iff the swallowed TypeError is logged. The test suite is
# expected to PASS green either way (that's the whole bug); the
# fidelity signal is the absence of TypeError lines.
#
# We DO NOT fail on test exit code here — a green suite with TypeError
# logs is exactly the false-green condition we're auditing. The
# assertion is on the log shape.

echo "  ▸ running pnpm -C core test src/lib/regen.test.ts (capturing to $VITEST_LOG)..."
pnpm -C core test src/lib/regen.test.ts > "$VITEST_LOG" 2>&1
VITEST_EXIT=$?

# Sanity: the test suite should at least have RUN (exit 0 or 1, not
# crashed mid-collection). A crash means the mock fix introduced a
# different failure we want to surface.
if [ $VITEST_EXIT -eq 0 ] || [ $VITEST_EXIT -eq 1 ]; then
  pass "1a. vitest produced a result (exit=$VITEST_EXIT)"
else
  fail "1a. vitest crashed (exit=$VITEST_EXIT) — see $VITEST_LOG"
fi

# Primary assertion: the specific TypeError signature from #222 is gone.
TYPE_ERR_HITS=$(grep -c 'database\.select(\.\.\.)\.from(\.\.\.)\.where(\.\.\.)\.limit is not a function' "$VITEST_LOG" || true)
if [ "${TYPE_ERR_HITS:-0}" -eq 0 ]; then
  pass "1b. zero '.where(...).limit is not a function' lines in vitest output (#222 fixed)"
else
  fail "1b. found $TYPE_ERR_HITS '.where(...).limit is not a function' lines — #222 still present (mock chain missing .limit())"
fi

# Broader assertion: any TypeError anywhere in the vitest output is a
# false-green smell. Pino logs the type on one line and the message on
# the next, so we count BOTH 'TypeError:' (message line) and
# '"type": "TypeError"' (pino-formatted err object line) and require
# both to be zero.
TYPE_ERR_MSG=$(grep -cE '^[[:space:]]*TypeError:' "$VITEST_LOG" || true)
TYPE_ERR_PINO=$(grep -cE '"type":[[:space:]]*"TypeError"' "$VITEST_LOG" || true)
TOTAL_TYPE_ERRS=$((TYPE_ERR_MSG + TYPE_ERR_PINO))
if [ "$TOTAL_TYPE_ERRS" -eq 0 ]; then
  pass "1c. zero TypeError lines in vitest output (msg=$TYPE_ERR_MSG, pino-err=$TYPE_ERR_PINO)"
else
  fail "1c. found $TOTAL_TYPE_ERRS TypeError lines (msg=$TYPE_ERR_MSG, pino-err=$TYPE_ERR_PINO) — false-green vector"
fi

# Belt-and-braces: the swallow log itself ('unfiled fragment
# classification failed — continuing with existing fragments') should
# also be absent under a real fix. If the mock now lets .limit() run
# clean, the catch block at regen.ts:381 should never trigger.
SWALLOW_HITS=$(grep -c 'unfiled fragment classification failed' "$VITEST_LOG" || true)
if [ "${SWALLOW_HITS:-0}" -eq 0 ]; then
  pass "1d. zero 'unfiled fragment classification failed' warns — catch block at regen.ts:381 never fired"
else
  fail "1d. found $SWALLOW_HITS swallow-warn lines — classify path still throwing under the hood"
fi

# Suite must still be green. A fix that makes regen.test.ts go red is
# itself a regression — the production code's behavior under correct
# mocks is the new bar.
PASSING=$(grep -E 'Tests +[0-9]+ passed' "$VITEST_LOG" | head -1)
if echo "$PASSING" | grep -q 'passed'; then
  pass "1e. vitest summary reports tests passed: '$PASSING'"
else
  fail "1e. vitest summary missing or shows failures — see $VITEST_LOG"
fi

# ── 2. §2 — classify codepath is reachable from the mock ─────
# Static check: the fake DB chain in regen.test.ts must expose .limit()
# on the .where() return. Without this, classifyUnfiledFragments throws
# at regen.ts:211 and the codepath stays unverified.
#
# Strategy: parse the test file. The selectChain mock starts at the
# `function selectChain()` declaration. .where()'s return must include
# a `limit:` key (function or arrow). If it's only `then:`, `orderBy:`,
# `groupBy:`, the bug is still present.

# Pull the lines of regen.test.ts that contain the selectChain inner
# return and check for a `limit:` key DIRECTLY inside the .where()
# return object (depth=1 relative to the `return {` after `.where(...)`).
# Naive grep would false-positive on the nested `orderBy: () => ({ limit: ... })`
# which is depth=2 — different scope. Track brace depth manually.
WHERE_RETURN_HAS_LIMIT=$(awk '
  function count_char(s, c,    n, i) {
    n = 0
    for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == c) n++
    return n
  }
  /function selectChain/ { in_chain = 1 }
  in_chain && !in_where && /where:[[:space:]]*\(/ {
    in_where = 1
    depth = 0
    next
  }
  in_where {
    opens = count_char($0, "{")
    closes = count_char($0, "}")
    # Detect the where-handlers return-object opener: `return {` on the
    # line AFTER the deferred-promise plumbing. Once depth > 0, we are
    # INSIDE the returned object; depth==1 entries are siblings of `then`.
    if (depth == 1 && $0 ~ /^[[:space:]]*limit:/) { found = 1; exit }
    depth += opens - closes
    if (depth < 0) { in_where = 0; depth = 0 }
  }
  END { print (found ? "yes" : "no") }
' core/src/lib/regen.test.ts)

if [ "$WHERE_RETURN_HAS_LIMIT" = "yes" ]; then
  pass "2a. regen.test.ts selectChain.where() returns a .limit (mock now realistic)"
else
  fail "2a. regen.test.ts selectChain.where() return is missing .limit — #222's structural fix not applied"
fi

# Classifier-awareness: at least one stage in the response queue should
# be intended for the .limit(1) wiki lookup at regen.ts:201-211. We
# can't directly attribute a queue entry to a specific call, but we
# can check that the test file references either `classifyUnfiledFragments`
# directly OR has a comment block describing the classify pre-step's
# response staging.
CLASSIFY_AWARE=$(grep -cE 'classifyUnfiledFragments|classify (pre-)?step|wiki lookup.*limit\(1\)|unfiled' core/src/lib/regen.test.ts || true)
if [ "${CLASSIFY_AWARE:-0}" -ge 1 ]; then
  pass "2b. regen.test.ts shows awareness of classify pre-step ($CLASSIFY_AWARE references)"
else
  fail "2b. regen.test.ts has zero references to the classify pre-step — fix may have patched the mock without staging responses for the new codepath"
fi

# ── 3. §3 — warn-and-continue surface + masking-site audit contract ───
# Codebase-wide hunt for `} catch (...) { log.warn(...) }` blocks in
# core/src/. Each is a candidate for the same false-green class as
# #222: an exception is swallowed, a warn is logged, the test (if any)
# sees green even though the codepath is broken.
#
# Issue #265 triaged each site into INTENTIONAL (best-effort by design;
# failure is observable elsewhere) vs MASKING (failure was silent, no
# downstream surface). The four MASKING sites named in #265 (#271–#274)
# are now paired with audit-row contracts — the swallow-side catch emits
# an `audit_log` row whose event_type names the failure class. This
# section asserts the audit contract holds at each site by running the
# per-site vitest unit test that mocks the throwing dependency and
# checks `emitAuditEvent` was called.
#
# The INTENTIONAL list is still surfaced as SKIP entries below for
# future hardening but is not load-bearing.

echo ""
echo "  ── §3 surface scan: catch + log.warn blocks in core/src/ ──"
SURFACE_COUNT=0
while IFS= read -r line; do
  SURFACE_COUNT=$((SURFACE_COUNT+1))
  # Each line is "<file>-<lineno>-  } catch (<var>) {" — strip to file:line.
  LOC=$(echo "$line" | sed -E 's/^([^-]+)-([0-9]+)-.*/\1:\2/')
  skip "    $LOC — catch+log.warn block"
done < <(grep -rn -B2 'log\.warn' core/src/ --include='*.ts' 2>/dev/null | grep -E 'catch \(' || true)

echo "  ▸ surfaced $SURFACE_COUNT catch+log.warn block(s) in core/src/"

# MASKING gate (#271–#274): each named-masking site must have a vitest
# unit test that mocks the throwing dependency and asserts
# `emitAuditEvent` was called with the expected event_type. The test
# files live alongside the source — running them here closes the loop.
echo ""
echo "  ── §3 MASKING audit-contract gate (issues #271–#274) ──"

# Per-site config. Each row is: <issue> <test-file>:<expected-event-type>
declare -A MASKING_TESTS=(
  ["#271 routes/fragments accept regen-enqueue"]="src/routes/fragments.audit.test.ts:regen_enqueue_failed"
  ["#272 routes/fragments reject regen-enqueue"]="src/routes/fragments.audit.test.ts:regen_enqueue_failed"
  ["#273 queue/regen-worker batch enqueue"]="src/queue/regen-worker.audit.test.ts:regen_batch_item_failed"
  ["#274 lib/regen RELATED_TO edge"]="src/lib/regen.audit.test.ts:related_edge_create_failed"
)

# First: confirm each event_type string is present in the source. Cheap
# gate that catches the case where the audit emit was reverted but the
# test file still exists.
declare -A EVENT_TYPE_FILE=(
  ["regen_enqueue_failed"]="core/src/routes/fragments.ts"
  ["regen_batch_item_failed"]="core/src/queue/regen-worker.ts"
  ["related_edge_create_failed"]="core/src/lib/regen.ts"
)
for evt in "${!EVENT_TYPE_FILE[@]}"; do
  src="${EVENT_TYPE_FILE[$evt]}"
  if grep -q "eventType: '$evt'" "$src" 2>/dev/null; then
    pass "    audit-emit-present: $evt → $src"
  else
    fail "    audit-emit-MISSING: $evt → $src (swallow-side catch lacks emitAuditEvent call)"
  fi
done

# Second: run the per-site vitest audit tests in isolation. Each test
# mocks the throwing dependency (producer.enqueueRegen or the inner
# embedding select) and asserts emitAuditEvent was called with the
# matching event_type. A green run proves the audit contract.
TEST_FILES_RUN=()
for label in "${!MASKING_TESTS[@]}"; do
  spec="${MASKING_TESTS[$label]}"
  test_file="${spec%%:*}"
  expected_evt="${spec##*:}"
  # Avoid re-running the same test file (fragments covers both #271+#272).
  already_run=0
  for prev in "${TEST_FILES_RUN[@]:-}"; do
    if [ "$prev" = "$test_file" ]; then already_run=1; break; fi
  done
  if [ "$already_run" -eq 1 ]; then
    pass "    audit-test-pass (shared run): $label — $test_file"
    continue
  fi
  TEST_FILES_RUN+=("$test_file")
  log_file="/tmp/uat-31-audit-$(echo "$test_file" | tr '/.' '__').log"
  if pnpm -C core test "$test_file" > "$log_file" 2>&1; then
    if grep -q "$expected_evt" "$log_file" || grep -q "Tests .*passed" "$log_file"; then
      pass "    audit-test-pass: $label — $test_file"
    else
      fail "    audit-test-INDETERMINATE: $label — $test_file (vitest exited 0 but expected event_type '$expected_evt' not referenced; see $log_file)"
    fi
  else
    fail "    audit-test-FAIL: $label — $test_file (vitest exited non-zero; see $log_file)"
  fi
done

# regen.ts:381 historical site — kept for delta-tracking with #222.
REGEN_SWALLOW_PRESENT=$(grep -n 'unfiled fragment classification failed' core/src/lib/regen.ts | head -1 | cut -d: -f1)
if [ -n "$REGEN_SWALLOW_PRESENT" ]; then
  fail "  §3-named: core/src/lib/regen.ts:$REGEN_SWALLOW_PRESENT — the #222 swallow itself is back; re-throw or assert on the warn in tests"
else
  pass "  §3-named: core/src/lib/regen.ts swallow log removed (#222 fix held)"
fi

# ── Cleanup — none required ──────────────────────────────────
# Vitest writes only to /tmp/uat-31-vitest.log; downstream plans don't
# read it. No DB writes, no stack mutation. Plan is read-only.

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
```

---

## Pass/Fail Summary

| # | Assertion | Source |
|---|-----------|--------|
| 0 | `regen.test.ts` and `regen.ts` exist; swallow site at `regen.ts:381` still matches | `core/src/lib/regen.{ts,test.ts}` |
| 1a | vitest produces a result (no mid-collection crash) | `pnpm -C core test src/lib/regen.test.ts` |
| 1b | Zero `'.where(...).limit is not a function'` lines in vitest output | `core/src/lib/regen.ts:211` |
| 1c | Zero `TypeError` stack frames originating in `regen.ts` | vitest stderr |
| 1d | Zero `'unfiled fragment classification failed'` warns — catch at `regen.ts:381` never fires | `core/src/lib/regen.ts:381-383` |
| 1e | vitest summary reports tests passed (suite stays green under the fix) | vitest summary line |
| 2a | `selectChain.where()` return in test file exposes a `.limit` key (mock realistic) | `core/src/lib/regen.test.ts:79-101` |
| 2b | Test file references the classify pre-step (`classifyUnfiledFragments`, `unfiled`, etc.) — proves awareness, not just mechanical mock patch | `core/src/lib/regen.test.ts` |
| 3a | Each `} catch { log.warn() }` block in `core/src/` is surfaced as a SKIP entry (intentional list, not load-bearing) | `grep -rn -B2 'log\.warn' core/src/` |
| 3b | Each MASKING-site (#271–#274) emits an audit row of the named `event_type` from its swallow-side catch — verified by source grep | `core/src/routes/fragments.ts`, `core/src/queue/regen-worker.ts`, `core/src/lib/regen.ts` |
| 3c | Per-site vitest audit tests pass: `fragments.audit.test.ts` (#271 + #272), `regen-worker.audit.test.ts` (#273), `regen.audit.test.ts` (#274). Each test mocks the throwing dependency and asserts `emitAuditEvent` was called with the matching `event_type`. | `core/src/routes/fragments.audit.test.ts`, `core/src/queue/regen-worker.audit.test.ts`, `core/src/lib/regen.audit.test.ts` |
| 3d | `regen.ts:381` swallow log is gone — the #222 fix held | `core/src/lib/regen.ts` |
| Cleanup | None — read-only plan | n/a |

---

## Notes

- **§1 is expected to FAIL until #222 is fixed.** That's the point. A
  passing §1 means either the mock chain now exposes `.limit()` (the
  structural fix) or the swallow at `regen.ts:381` has been replaced
  with a re-throw or a warn-assertion — both are acceptable resolutions
  of #222. A green §1 on current `main` would indicate the assertion is
  matching the wrong substring; verify the literal grep against the
  vitest log if that ever happens.
- **§1d is the deeper signal.** §1b checks the literal TypeError
  message; §1d checks the warn line that the catch emits. A fix that
  changes the error type (e.g. typed mock returns `undefined` instead
  of throwing) could pass §1b while §1d still flags. The combination
  is harder to false-pass.
- **§2a uses awk, not jq, to parse the test file.** TypeScript isn't
  JSON; the cheap structural check is "between `where: (` and the
  matching `})`, does a `limit:` key appear?". This catches the common
  fix shape but accepts variations (function, arrow, async). If the
  test file is restructured (e.g. extracted into a helper), §2a may
  false-fail; the operator should re-check by hand and update the awk
  block.
- **§3 — INTENTIONAL list is SKIP, MASKING list now has audit
  contracts.** Issue #265 triaged each catch+log.warn block in
  `core/src/`. Most are intentional best-effort handlers (audit emit
  at `db/audit.ts:31-33`, embedding-retry config-skip at
  `queue/embedding-retry-worker.ts:40`, bootstrap pgvector at
  `bootstrap/ensure-pgvector.ts:30`, etc.) — the failure is either
  observable elsewhere or the documented contract. The four MASKING
  sites originally surfaced by #265 (issues #271–#274) are now paired
  with audit-row contracts: each swallow-side catch emits an
  `audit_log` row whose `event_type` names the failure class. §3b
  greps for the event_type literal in source and §3c runs the
  per-site vitest audit test that mocks the throwing dependency and
  asserts `emitAuditEvent` was called. Tier-3 retry/DLQ is out of
  scope; the audit row is the surface.
- **Why not just run all of `pnpm -C core test`?** Two reasons. First,
  `regen.test.ts` is the file #222 names — focusing on it keeps the
  signal strong and the run fast (~1s vs ~30s for the full suite).
  Second, other test files have their own DB mocks with their own
  quirks; broadening §1 to the full suite would mix #222's signal
  with unrelated noise from other modules. A future plan can extend
  to the full suite once §3's surface scan is hardened.
- **Live confirmation on `main` at the plan-write commit.** Before
  writing this plan, the operator ran
  `pnpm -C core test src/lib/regen.test.ts` and observed: 10/10 tests
  pass green AND every `regenerateWiki` call (one per test) emits the
  swallowed TypeError on stderr. The error count scales linearly with
  test count — confirming the path is silently broken in every test,
  not just one edge case. §1b on current `main` should report ~10
  hits and FAIL; that's the assertion design working as intended.
- **Storage is Postgres-only for the production code under test.** The
  classify path queries `wikis`, `fragments`, `edges` — all DB rows.
  No filesystem reads, no git-backed markdown. The mock under audit
  reflects that: it stubs `../db/client.js`, nothing else.
