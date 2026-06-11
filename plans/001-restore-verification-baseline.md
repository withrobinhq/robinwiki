# Plan 001: Restore the verification baseline — typecheck and all test suites green on main

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 21533c8..HEAD -- packages/shared core/src wiki/src tsconfig.base.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `21533c8`, 2026-06-11

## Why this matters

On a clean checkout of `main`, `pnpm typecheck` fails and three of the six
workspaces have failing test suites (core: 24 failed tests, shared: 3 failed +
collection errors, wiki: 1 file fails to collect). CI (`.github/workflows/pre-merge.yml`)
runs neither typecheck nor tests, so the suite has silently rotted as source
code evolved. Every other plan in `plans/` uses `pnpm typecheck` and
`pnpm test` as its verification gate, so nothing else can be trusted until
this is green. Plan 002 (CI gate) depends on this directly.

## Current state

Verified on `main` at `21533c8` on 2026-06-11:

**Typecheck** — `pnpm typecheck` fails:

```
@robin/shared:typecheck: tsconfig.json(3,3): error TS5090: Non-relative paths are not allowed when 'baseUrl' is not set. Did you forget a leading './'?
```

`packages/shared/tsconfig.json` is:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/**/*.spec.ts"]
}
```

The TS5090 message points at `tsconfig.json(3,3)` — likely a non-relative
path inherited from `tsconfig.base.json` (check its `paths`/`typeRoots`/
`extends` entries) interacting with the repo's TypeScript 5.9.3 (root
`package.json` devDependency). Diagnose which non-relative path triggers it
before changing anything; the fix is usually a leading `./` or an explicit
`baseUrl`.

**Test failures** (all fail in milliseconds — these are assertion/collection
drift, not missing-services errors; the suites run without Postgres/Redis):

- `@robin/core` (`pnpm --filter @robin/core test`): **24 failed | 424 passed | 73 skipped** across 19 files. Failure clusters:
  - `regenerateWiki` — override hierarchy, sidecar persistence, E1 partition (state transitions: tests expect `fromState 'PENDING'` etc., e.g. `core/src/routes/wikis.regen.lock.test.ts:144`)
  - `POST /wikis/:id/regenerate` lock-wrapping and `processRegenJob` CasLock params
  - wiki-types: `PUT /wiki-types/:slug`, `POST /wiki-types/:slug/reset`
  - auth-recover UAT 1–6 (`assertProdEnv`, `/auth/recover`, rate limit, Redis-down 503, audit `detail.ip`, BullBoard 401)
  - Content Write API (EDIT-02) `PUT /api/content/:type/:key`
  - `processProvisionJob` missing `KEY_ENCRYPTION_SECRET`
- `@robin/shared` (`pnpm --filter @robin/shared test`): **3 failed | 308 passed**, 5 files failed (some are collection errors). Named failures: `extracts [[slug]] and [[type:slug]] from text`, `uses type hint directly for qualified links like [[thread:x]]`, `renders user template with substituted variables` — these live around `packages/shared/src/wiki-links.ts` and the prompt template loaders.
- `@robin/wiki` (`pnpm --filter @robin/wiki test`): **1 suite fails to collect, 75/75 individual tests pass**:
  ```
  FAIL src/components/wiki/WikiEntityArticle.test.tsx
  Error: Failed to resolve import "@robin/shared/browser" from "src/components/wiki/useWikiEntityEditMode.ts". Does the file exist?
  ```
  The import is `import { generateUlid } from "@robin/shared/browser"` — check `packages/shared/package.json` `exports` map for a `./browser` subpath and whether `packages/shared/dist` must be built first (wiki's vitest resolves the workspace package by its export map, Next's bundler resolution may differ).
- `@robin/caslock`: passes.

**Conventions**: core tests live in `core/src/__tests__/*.test.ts` (Vitest,
heavy use of `vi.mock`; env stub at `core/src/__tests__/helpers/validEnvStub.ts`).
Biome is the linter for core/packages (`pnpm lint`); wiki uses eslint-config-next.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Typecheck (all) | `pnpm typecheck` | exit 0 |
| Test one workspace | `pnpm --filter @robin/core test` | exit 0, all pass |
| Test all | `pnpm test` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (modify only what the diagnosis requires):
- `packages/shared/tsconfig.json`, `tsconfig.base.json` (typecheck fix only)
- Failing test files under `core/src/__tests__/`, `core/src/routes/*.test.ts`, `packages/shared/src/**/*.test.ts`, `wiki/src/**/*.test.tsx`
- `packages/shared/package.json` (only if the `./browser` export subpath is genuinely missing)
- Source files ONLY when a test failure is a confirmed source regression (see STOP conditions)

**Out of scope** (do NOT touch):
- `.github/workflows/pre-merge.yml` — that is plan 002.
- Dependency versions in any `package.json` / `pnpm-lock.yaml` — that is plan 003.
- Skipped tests (73 in core) — leave them skipped; do not unskip.
- `wiki/src/lib/generated/` — generated openapi client.

## Git workflow

- Branch: `advisor/001-restore-verification-baseline`
- One commit per failure cluster (e.g. `test(core): realign regen lock-wrapping tests with PENDING→LINKING states`). Repo uses conventional-commit-ish messages, e.g. `fix(wiki): only scroll when the hook actually opened a closed <details>`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the @robin/shared typecheck error

Reproduce with `pnpm --filter @robin/shared typecheck`. Inspect
`tsconfig.base.json` for the non-relative path TS5090 complains about and fix
it (leading `./` or add `baseUrl`) so the error disappears **without changing
emitted output** (compare `packages/shared/dist` file list before/after a
build).

**Verify**: `pnpm typecheck` → exit 0 across all workspaces.

### Step 2: Triage each failing test cluster — stale test vs. real regression

For each cluster listed in "Current state", run
`git log --oneline -10 -- <source file>` and `git log --oneline -10 -- <test file>`.
Classify:

- **Stale test** — the source change was deliberate (a feature commit/PR
  changed behavior, e.g. regen state machine renames) and the test was not
  updated. Update the test to assert the current, intended behavior. Cite the
  commit that changed the behavior in your commit message.
- **Real regression** — the test encodes a documented contract (several cite
  issue/plan numbers like `#audit-M5`, `EDIT-02`, `UAT 1–6` in their names)
  and no commit shows a deliberate behavior change. This is a STOP condition:
  report the cluster instead of "fixing" the test to match broken code.

Work cluster by cluster; commit each cluster separately.

**Verify** (after each cluster): `pnpm --filter <workspace> test` → failure count strictly decreases; previously passing tests still pass.

### Step 3: Fix the wiki collection error

Diagnose `@robin/shared/browser` resolution: check `packages/shared/package.json`
`exports` for `./browser`, confirm `packages/shared/src/browser.ts` exists
(it is listed in the shared build entry points), and whether
`pnpm --filter @robin/shared build` must run before wiki's vitest can resolve
it. Prefer a config fix (vitest alias or shared exports map) over editing the
component or test.

**Verify**: `pnpm --filter @robin/wiki test` → exit 0, 10/10 files pass.

### Step 4: Full sweep

**Verify**: `pnpm typecheck` → exit 0. `pnpm test` → exit 0 (all workspaces). `pnpm lint` → exit 0. `pnpm build` → exit 0.

## Test plan

This plan repairs tests rather than adding them. Net-new tests: none required.
Guard against regression by recording in your final report, per cluster:
which commit caused the drift, and whether you updated the test or stopped.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 — 0 failed test files in core, shared, wiki, caslock, graph
- [ ] `pnpm lint` and `pnpm build` exit 0
- [ ] No skipped test was unskipped; no test deleted (renames allowed)
- [ ] Every test edit's commit message names the source commit that justified it
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A failing test encodes a contract (UAT/issue-numbered) and you cannot find a
  deliberate source change that supersedes it — likely a real production bug.
- Fixing the TS5090 error requires changing compiler options that alter
  emitted JS for `@robin/shared` (other workspaces consume its dist).
- The `@robin/shared/browser` resolution failure turns out to affect the
  production Next.js build, not just vitest.
- A cluster's failure count does not decrease after two fix attempts.

## Maintenance notes

- Plan 002 adds these commands to CI so this rot cannot recur — land it
  immediately after this plan.
- Reviewer focus: every changed assertion should trace to a deliberate
  behavior-change commit; be suspicious of test edits that merely invert an
  expectation.
