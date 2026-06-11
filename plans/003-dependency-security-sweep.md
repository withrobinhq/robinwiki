# Plan 003: Patch the known-vulnerable dependencies (next, hono, better-auth, vitest, transitive)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 21533c8..HEAD -- package.json core/package.json wiki/package.json packages pnpm-lock.yaml`
> If the manifests changed since this plan was written, re-run `pnpm audit`
> and reconcile before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-restore-verification-baseline.md (green tests are the safety net for these bumps)
- **Category**: security
- **Planned at**: commit `21533c8`, 2026-06-11

## Why this matters

`pnpm audit --prod` on 2026-06-11 reported **39 vulnerabilities (2 critical,
12 high, 21 moderate, 4 low)**. The high-severity set includes multiple
Next.js advisories directly relevant to this app (middleware/proxy bypass in
App Router, SSRF, DoS), a better-auth HIGH (device authorization
approve/deny), and a stack of Hono moderates (bodyLimit bypass, cache
middleware ignoring `Vary: Authorization`, JWT middleware scheme laxity —
advisory GHSA-hm8q-7f3q-5f36, patched in hono ≥4.12.18). Robin's core API is
internet-facing in the documented Railway deployment, so framework-level
bypasses are real exposure, not hygiene.

## Current state

Resolved versions from `pnpm-lock.yaml` at `21533c8` (verified, not manifest
ranges):

| Package | Resolved | Where | Advisories (from `pnpm audit`) |
|---|---|---|---|
| `next` | 16.2.3 | wiki | 4× HIGH (Server-Components DoS, App Router middleware/proxy bypass ×2, Pages Router bypass, SSRF via WebSocket upgrade, connection exhaustion), 4× MODERATE (XSS ×2, image DoS, RSC cache poisoning) |
| `hono` | 4.12.12 | core | LOW GHSA-hm8q-7f3q-5f36 (JWT NumericDate, patched ≥4.12.18) + MODERATEs: bodyLimit bypass, cache `Vary` handling, IP-restriction bypass, JSX attr handling, `app.mount()` prefix strip, cookie helper sanitization |
| `better-auth` | 1.6.2 | core + wiki | HIGH — device authorization approve/deny |
| `vitest` | 3.2.4 | core, wiki, caslock (dev) | CRITICAL — Vitest UI server arbitrary file read / code execution |
| `fast-uri` | (transitive) | `core>autoevals>ajv>fast-uri` (dev) | 2× HIGH — path traversal, host confusion |
| `kysely` | (transitive via better-auth) | core | HIGH — JSON-path traversal injection |
| `@ai-sdk/provider-utils` | (transitive) | `packages/agent>@mastra/core>...` | LOW — uncontrolled resource consumption, **no patched version exists** |

Manifest ranges to touch: `wiki/package.json` `"next": "^16.2.3"`,
`core/package.json` `"hono": "^4.4.0"` and `"better-auth": "^1.0.0"`,
`wiki/package.json` `"better-auth": "^1.6.2"`, `vitest` devDeps in core
(`^3.2.1`), wiki (implied by `@vitest/ui ^3.2.4`), and `packages/caslock`.
Root `package.json` already carries pnpm `overrides` for `esbuild`/`vite` —
follow that pattern for transitive pins if needed.

Note: core's `better-auth: ^1.0.0` and wiki's `^1.6.2` both resolve to 1.6.2
today — align core's range to wiki's while you're in the file (cosmetic, but
prevents future skew).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Audit | `pnpm audit --prod` | target: 0 critical / 0 high (see Done criteria) |
| Install | `pnpm install` | exit 0, lockfile updated |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Build (both apps) | `pnpm build` | exit 0 |
| Wiki client regen check | `pnpm --filter @robin/wiki build` | exit 0 |

## Scope

**In scope**:
- `package.json` (root — `pnpm.overrides` only), `core/package.json`,
  `wiki/package.json`, `packages/*/package.json` (vitest only), `pnpm-lock.yaml`

**Out of scope** (do NOT touch):
- Source code. If a bump forces a code change beyond a trivial import/type
  fix, STOP and report which package and what it demands.
- `@ai-sdk/provider-utils` — no patched version exists; record it as accepted
  residual risk in your report.
- Major-version jumps (e.g. drizzle, zod, react). This plan is patch/minor
  within current majors only.

## Git workflow

- Branch: `advisor/003-dependency-security-sweep`
- One commit per package family, e.g. `chore(deps): next 16.2.3 → 16.2.x (security)`, `chore(deps): hono → ^4.12.18`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Baseline

`pnpm audit --prod > /tmp/audit-before.txt` and record the severity counts.
Run `pnpm typecheck && pnpm test` — must be green before any bump (else STOP;
plan 001 missing).

**Verify**: both exit 0.

### Step 2: Bump next (wiki)

Set `wiki/package.json` `"next"` to the lowest version that clears all listed
advisories per `pnpm audit` output (the advisories named ≥16.2.5 / ≥16.2.6 at
planning time; trust the live audit output over this file). `pnpm install`.

**Verify**: `pnpm --filter @robin/wiki build` → exit 0; `pnpm --filter @robin/wiki test` → exit 0; `pnpm audit --prod 2>&1 | grep -c "next"` shows the next advisories gone.

### Step 3: Bump hono and better-auth (core)

`core/package.json`: `"hono": "^4.12.18"` (or later patched), and align
`"better-auth"` to a patched 1.x per the audit (also update wiki's
better-auth to the same patched version — both must resolve identically;
verify with `grep -n 'better-auth@' pnpm-lock.yaml`). `pnpm install`.

**Verify**: `pnpm --filter @robin/core test` → exit 0; `pnpm typecheck` → exit 0. Auth still works: `pnpm --filter @robin/core build && grep -c 'better-auth' core/dist/auth.js || true` (sanity only). The real gate is the core test suite, which covers auth-recover and BullBoard session gating.

### Step 4: Bump vitest everywhere (dev)

Update `vitest` (and `@vitest/ui` in wiki) to the patched version per audit
(≥3.2.6 at planning time) in `core/package.json`, `wiki/package.json`,
`packages/caslock/package.json`. `pnpm install`.

**Verify**: `pnpm test` → exit 0 (vitest still runs every suite).

### Step 5: Clear transitive HIGHs (fast-uri, kysely)

For each remaining HIGH in `pnpm audit`: if a parent bump fixes it
(better-auth bump may fix kysely), prefer that; otherwise add a pnpm override
in root `package.json` next to the existing `esbuild`/`vite` overrides, e.g.
`"fast-uri": ">=3.1.2"`. `pnpm install`.

**Verify**: `pnpm audit --prod` → 0 critical, 0 high. `pnpm test` → exit 0.

### Step 6: Full sweep

**Verify**: `pnpm typecheck && pnpm test && pnpm build` → all exit 0. Save `pnpm audit --prod > /tmp/audit-after.txt` and include before/after counts in your report.

## Test plan

No new tests. The existing suites (restored by plan 001) are the regression
net — especially `core/src/__tests__/bull-board-auth.test.ts`,
`route-allowlist.test.ts`, and the auth-recover UAT tests for the
hono/better-auth bumps, and wiki's component tests for the next bump.

## Done criteria

- [ ] `pnpm audit --prod` reports 0 critical and 0 high (moderates: only those without patched versions may remain — list them in the report)
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` all exit 0
- [ ] core and wiki resolve the identical `better-auth` version in `pnpm-lock.yaml`
- [ ] No source files modified (`git status` shows only manifests + lockfile)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A bump requires source-code changes beyond imports/types (e.g. next minor
  changes routing behavior, better-auth changes a config shape in
  `core/src/auth.ts`).
- The patched better-auth for the device-authorization HIGH is only available
  in a new major.
- After Step 5, a critical/high advisory remains with no patched version —
  document it; do not chase forks or aliases.
- `pnpm install` wants to change packages you didn't touch by a major version.

## Maintenance notes

- Schedule `pnpm audit --prod` as a recurring check (a future CI step —
  coordinate with plan 002's workflow rather than adding a second one).
- `@ai-sdk/provider-utils` (LOW, via @mastra/core) has no fix upstream;
  revisit when @mastra/core updates.
- The `@hey-api/client-fetch` package wiki uses for its generated API client
  is deprecated upstream — out of scope here, flagged in `plans/README.md`
  rejected/deferred list.
