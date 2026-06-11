# Plan 002: Gate every PR on typecheck and the full test suite in CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 21533c8..HEAD -- .github/workflows/pre-merge.yml turbo.json package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-restore-verification-baseline.md
- **Category**: dx
- **Planned at**: commit `21533c8`, 2026-06-11

## Why this matters

The only CI workflow, `.github/workflows/pre-merge.yml`, runs three jobs —
drizzle `db:push` destructive-op detection, a core boot `/health` probe, and a
wiki build against core's openapi manifest. It never runs `pnpm typecheck` or
`pnpm test`, even though both scripts exist and turbo defines both tasks. The
direct consequence was measured on 2026-06-11: main had a failing typecheck
and 27+ failing tests across three workspaces. This plan makes that class of
rot impossible to merge.

## Current state

- `.github/workflows/pre-merge.yml` — jobs `db-push` → `core-boot-health` →
  `wiki-build`, chained with `needs:`. All use: `actions/checkout@v4`,
  `pnpm/action-setup@v4`, `actions/setup-node@v4` with `node-version: 20` and
  `cache: pnpm`, then `pnpm install --frozen-lockfile`. Header comment calls
  it the "Three-job CI gate (Phase A2)".
- Root `package.json` scripts: `"typecheck": "turbo run typecheck"`,
  `"test": "turbo run test"`.
- `turbo.json`: both `test` and `typecheck` declare `"dependsOn": ["^build"]`,
  so turbo builds workspace deps automatically before running them.
- The test suites do **not** need live Postgres or Redis: core tests mock the
  DB (env stub at `core/src/__tests__/helpers/validEnvStub.ts` sets dummy
  `DATABASE_URL`/`REDIS_URL`), and the full core suite completes in ~5s.
  Wiki tests run under jsdom.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Workflow lint (optional, if installed) | `actionlint .github/workflows/pre-merge.yml` | no errors |

## Scope

**In scope**:
- `.github/workflows/pre-merge.yml`

**Out of scope** (do NOT touch):
- Any source or test file — if `pnpm test`/`pnpm typecheck` fail locally on
  your branch base, plan 001 has not landed; STOP.
- The three existing jobs' steps — extend the workflow, don't restructure it.
- Branch-protection settings (GitHub UI) — note in your report that the
  operator should add the new job to required checks.

## Git workflow

- Branch: `advisor/002-ci-typecheck-test-gate`
- Single commit, e.g. `ci: gate PRs on typecheck and full test suite`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm green baseline locally

Run `pnpm install --frozen-lockfile`, then `pnpm typecheck` and `pnpm test`.
Both must exit 0. If not, STOP (plan 001 not landed).

**Verify**: both commands exit 0.

### Step 2: Add a `typecheck-test` job to pre-merge.yml

Add a fourth job that runs in parallel with `db-push` (no `needs:`), matching
the existing setup steps exactly:

```yaml
  # ─── Job 4: typecheck + tests ────────────────────────────────────────────
  typecheck-test:
    name: typecheck + test (all workspaces)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test
```

Also update the header comment ("Three-job CI gate") to describe four jobs.
Do not add Postgres/Redis services — the suites are mocked (see Current
state); if a test fails in CI asking for a connection, that is a STOP
condition, not a reason to add services.

**Verify**: YAML parses — `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/pre-merge.yml'))"` → exit 0.

### Step 3: Prove the gate fires

Run the same commands the job will run, from a clean state:
`pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` → exit 0.

**Verify**: exit 0. In your report, remind the operator to (a) confirm the job
appears on the next PR, and (b) add `typecheck + test (all workspaces)` to the
branch-protection required checks for `main`.

## Test plan

No new test files. The deliverable is the gate itself; Step 3 is its dry run.

## Done criteria

- [ ] `.github/workflows/pre-merge.yml` contains the `typecheck-test` job with both `pnpm typecheck` and `pnpm test` steps
- [ ] Workflow YAML parses cleanly
- [ ] `pnpm typecheck && pnpm test` exit 0 locally
- [ ] No other file modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm typecheck` or `pnpm test` fail on your branch base (plan 001 missing
  or regressed).
- Any test fails only in the CI-shaped environment (e.g. tries to open a real
  Postgres/Redis connection) — report which test; do not add service
  containers to make it pass.
- The workflow file at HEAD no longer matches the three-job structure
  described above.

## Maintenance notes

- When someone adds a workspace with a `test`/`typecheck` script, turbo picks
  it up automatically — no workflow change needed.
- If suite runtime grows past ~5 minutes, split typecheck and test into
  separate jobs rather than dropping either.
- Deferred (deliberately): adding `pnpm lint` to CI. Core/packages use Biome,
  wiki uses ESLint; decide a unified policy first.
