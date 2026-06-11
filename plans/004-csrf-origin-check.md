# Plan 004: Block cross-site request forgery on session-authenticated mutations with an Origin check

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 21533c8..HEAD -- core/src/middleware/session.ts core/src/index.ts core/src/auth.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-restore-verification-baseline.md (test gate)
- **Category**: security
- **Planned at**: commit `21533c8`, 2026-06-11

## Why this matters

In production, session cookies are issued with `SameSite=None; Secure`
(`core/src/auth.ts:48` — deliberate, because the wiki frontend and core API
run on different origins in the documented Railway deployment). That means
the browser attaches the session cookie to **any** cross-site request. CORS
does not stop "simple" requests from being *sent* — it only blocks reading
responses — and several state-changing endpoints accept bodyless POSTs:
`POST /wikis/:id/publish`, `POST /wikis/:id/unpublish`,
`POST /wikis/:id/regenerate` (`core/src/routes/wikis.ts:707-760`). A malicious
page the logged-in user visits can therefore publish a private wiki to the
public reader surface, or trigger regens that spend the user's OpenRouter
budget. Wiki lookup keys are human-readable slugs, so targets are guessable.
The standard fix — reject state-changing requests whose `Origin` header is
present but not allowlisted — is small and applies in one place.

## Current state

- `core/src/middleware/session.ts` (entire file, 15 lines):

```ts
import type { MiddlewareHandler } from 'hono'
import { auth } from '../auth.js'

// Attach better-auth session to Hono context.
// Note: post-M2 single-user collapse, route handlers no longer use `userId`
// for filtering domain queries — it remains on context only for auth checks
// (e.g. mutating the user row, signing MCP tokens, crypto envelope reads).
export const sessionMiddleware: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  c.set('userId', session.user.id)
  c.set('user', session.user)
  await next()
}
```

- Every authenticated router self-applies it, e.g.
  `core/src/routes/wikis.ts:118`: `wikisRouter.use('*', sessionMiddleware)`.
  It also guards `/admin/queues/*` (`core/src/index.ts:225`) and the admin
  routers. So adding the check inside `sessionMiddleware` covers the whole
  session-cookie surface at once.
- The CORS allowlist is built in `core/src/index.ts:~107-115` (drift check —
  around the `const allowedOrigins = new Set(...)` block):

```ts
const isProd = process.env.NODE_ENV === 'production'
const allowedOrigins = new Set(
  (process.env.WIKI_ORIGIN ?? 'http://localhost:8080,http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
allowedOrigins.add(process.env.SERVER_PUBLIC_URL ?? 'http://localhost:3000')
```

- `core/src/auth.ts:42-51` sets `trustedOrigins` from `WIKI_ORIGIN` and the
  cookie attributes (`sameSite: isProd ? 'none' : 'lax'`). better-auth
  protects **its own** `/api/auth/*` endpoints with `trustedOrigins`; custom
  Hono routes get no such check today.
- Non-browser clients (MCP via bearer/API key — see
  `core/src/middleware/api-key.ts` — curl, the wiki's server-side fetches)
  typically send no `Origin` header.
- Test conventions: `core/src/__tests__/bull-board-auth.test.ts` tests
  session gating with mocked `auth.api.getSession`; use it as the structural
  pattern.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm --filter @robin/core typecheck` | exit 0 |
| Tests | `pnpm --filter @robin/core test` | exit 0 |
| Lint | `pnpm --filter @robin/core lint` | exit 0 |

## Scope

**In scope**:
- `core/src/lib/allowed-origins.ts` (create — single source for the allowlist)
- `core/src/middleware/session.ts`
- `core/src/index.ts` (replace the inline allowlist with the new helper)
- `core/src/__tests__/session-origin.test.ts` (create)

**Out of scope** (do NOT touch):
- `core/src/auth.ts` — do NOT change `sameSite`; cross-origin deploys need
  `None`. The fix is the Origin check, not the cookie.
- `core/src/middleware/api-key.ts` and the MCP auth path — bearer-token auth
  is not CSRF-able.
- Public routes (`/published`, `/health`, `/auth/recover`) — unauthenticated
  by design; not in scope.
- CORS config behavior in `index.ts` (the allowlist *contents* move to the
  helper; the cors() semantics must not change).

## Git workflow

- Branch: `advisor/004-csrf-origin-check`
- Commits: `feat(security): extract shared origin allowlist`, then
  `feat(security): reject cross-origin state-changing requests in sessionMiddleware`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the allowlist into `core/src/lib/allowed-origins.ts`

Export a function (e.g. `getAllowedOrigins(): Set<string>`) producing exactly
the set currently built inline in `index.ts` (WIKI_ORIGIN entries +
SERVER_PUBLIC_URL, with the same defaults). Compute lazily or at call time —
note `index.ts` builds it at module load; preserve observable behavior. Update
`index.ts` to use the helper.

**Verify**: `pnpm --filter @robin/core typecheck` → exit 0; `pnpm --filter @robin/core test` → exit 0 (existing CORS-dependent tests unchanged).

### Step 2: Add the Origin check to `sessionMiddleware`

Before the `getSession` call, add: if `c.req.method` is one of
`POST | PUT | PATCH | DELETE`, read `c.req.header('origin')`. If the header is
**present** and not in `getAllowedOrigins()` (and, in non-prod, not equal to
the request's own origin — mirror the dev-reflect behavior of the CORS config:
in non-prod, allow any present Origin), return
`c.json({ error: 'Forbidden — cross-origin request rejected' }, 403)`.
If the header is **absent**, proceed (non-browser clients). GET/HEAD/OPTIONS
are never blocked.

Keep the comment explaining why: SameSite=None cookies + simple-request CSRF.

**Verify**: `pnpm --filter @robin/core typecheck` → exit 0.

### Step 3: Tests

Create `core/src/__tests__/session-origin.test.ts`, modeled on
`core/src/__tests__/bull-board-auth.test.ts` (mock `auth.api.getSession` to
return a valid session). Cases:

1. POST with `Origin: https://evil.example` + valid session, `NODE_ENV=production`, `WIKI_ORIGIN=https://wiki.example` → 403.
2. POST with `Origin: https://wiki.example` (allowlisted) + valid session → passes through (next() reached).
3. POST with no Origin header + valid session → passes through.
4. GET with `Origin: https://evil.example` → passes through (reads unaffected).
5. Non-prod: POST with arbitrary Origin → passes through (dev reflect parity).

**Verify**: `pnpm --filter @robin/core test` → exit 0 including 5 new tests.

## Test plan

See Step 3. Also confirm no existing test regresses: the suites covering
session-gated routes (`bull-board-auth.test.ts`, `content-write.test.ts`,
`wiki-update.test.ts`) issue requests without an Origin header, so they must
keep passing untouched — that's the backward-compatibility proof.

## Done criteria

- [ ] `pnpm --filter @robin/core typecheck` exits 0
- [ ] `pnpm --filter @robin/core test` exits 0; `session-origin.test.ts` has the 5 cases above
- [ ] `grep -n 'allowedOrigins = new Set' core/src/index.ts` returns no match (allowlist lives in the helper)
- [ ] `core/src/auth.ts` unmodified (`git diff --stat` confirms)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The wiki frontend performs state-changing fetches **without** an Origin
  header in some path (would be blocked? no — absent Origin passes; but if you
  find wiki code sending a *different* origin, e.g. a proxy rewriting it, STOP).
- Any existing test fails because it sends an Origin header you'd now reject —
  that means real clients do too; report instead of loosening the check.
- `sessionMiddleware` turns out to also guard a webhook or server-to-server
  endpoint that legitimately sends a foreign Origin.

## Maintenance notes

- If a second frontend origin is ever added, it goes in `WIKI_ORIGIN`
  (comma-separated) and both CORS and CSRF pick it up — that's the point of
  the shared helper.
- Reviewer focus: the absent-Origin allowance is deliberate (non-browser
  clients); the dangerous regression would be blocking on absent Origin and
  breaking MCP/CLI flows.
- Deferred: rate limiting on the public `/published` reads, and validating
  `X-Forwarded-Host` on publish against the allowlist (see
  `plans/README.md` deferred list).
