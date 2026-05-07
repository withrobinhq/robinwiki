# Changelog

All notable changes to Robin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-07

First public release. Internal security hardening sweep across six phases of audit remediation.

### Breaking changes

- **MCP token URL must be re-pasted into every MCP client.** The `kid` in the JWT header lengthened from 16 to 32 hex chars; legacy 16-char tokens are rejected with `Unknown key`. Generate a new MCP URL from `/users/profile` (or click "Regenerate MCP link" on the profile page) and update Claude Desktop / Cursor / any other MCP client config.
- **`POST /auth/recover` body changed.** Now `{ secretKey, newPassword }`. Previously `{ secretKey }` only and reset to `INITIAL_PASSWORD`. Rotate any scripts or tooling that hit this endpoint.
- **`GET /users/keypair` no longer returns the private key.** Returns only `{ algorithm, publicKey, fingerprint }`. Use `POST /users/keypair/reveal { password }` to retrieve the decrypted private key after re-authentication.
- **New required env vars in production.** Server refuses to boot in `NODE_ENV=production` without all of: `WIKI_ORIGIN`, `SERVER_PUBLIC_URL` (must start with `https://`), `RECOVERY_SECRET` (32+ chars), `JOB_SIGNING_SECRET` (32+ chars). Generate each with `openssl rand -hex 32`.
- **MCP JWT no longer expires by design.** The `setExpirationTime` call was removed; revocation is via `users.mcpTokenVersion` bump only. Stable URL = stable client config.

### Added

- `POST /users/keypair/reveal` — password-gated endpoint for retrieving the Ed25519 private key. Rate-limited per user (5 failures within 30 min → 30-min lockout; counter resets on success).
- Profile page UI for regenerating the MCP link with a 2-step confirmation flow (#309).
- `RECOVERY_SECRET` env var for password recovery, separate from `BETTER_AUTH_SECRET`.
- `JOB_SIGNING_SECRET` env var. All BullMQ job payloads are now signed with HMAC-SHA256; workers reject unsigned or tampered jobs.
- `assertProdSafety` boot-time aggregator that fails-loud in production when prod-required env vars are missing.
- `sanitizeWikiHtml` chokepoint backed by `isomorphic-dompurify` for every `dangerouslySetInnerHTML` site in the wiki frontend.
- DB unique partial index `users_singleton_uidx` enforcing the single-tenant invariant at the database level.
- `caslock`-backed serialization around `POST /wikis/:id/regenerate` with TTL recovery for crashed regens.
- `LK_REGEX_STRICT` and `safeRefToHref` exports in `@robin/shared` for navigation-safe lookup-key validation.
- Audit-log rows for password recovery attempts (success and failure), each carrying the source IP from `x-forwarded-for`.
- Programmatic test asserting render-template context never contains process secrets.
- Integration tests covering the recovery rate limiter, audit emission, and BullBoard auth gate.
- `passwordPromptDialog` helper in the wiki frontend (currently backed by `window.prompt`; designed as a swap-later seam for a proper modal).
- `DEPLOY.md` documenting reverse-proxy / XFF-trust requirements and the cookie boot gate.

### Changed

- CORS now gates on `NODE_ENV`. Production uses a strict allowlist from `WIKI_ORIGIN`; non-production reflects any origin for dev/UAT flexibility.
- `WIKI_ORIGIN` and `SERVER_PUBLIC_URL` promoted from `recommended[]` to `required[]` for production boot.
- Cookie `useSecureCookies` / `SameSite` / `Secure` flags now derive from `NODE_ENV` rather than URL prefix inference.
- `/auth/recover` rate limit moved from in-memory to Redis-backed (5/min, 60/day per IP). Fail-closed on Redis outage.
- `LOOKUP_KEY_RE` renamed to `LK_REGEX` repo-wide.
- Wiki Handlebars template rendering escapes user-controlled delimiter sequences (defense-in-depth; render context is also asserted free of named secrets).
- Wiki-type YAML overrides reject `system_message` at the HTTP boundary; runtime parser silently strips and audit-logs.
- BullBoard route always behind `sessionMiddleware` regardless of `NODE_ENV`.
- `publishedSlug` now NULL'd on unpublish; re-publishing mints a fresh nanoid slug. `publishedAt` is preserved across the round-trip.
- `assertProdEnv` refactored to throw `ProdSafetyError` instead of `process.exit(1)` so the aggregator can collect failures.

### Fixed

- `kid` cache invalidation wired into all `users.publicKey` / `users.mcpTokenVersion` mutation sites: `POST /users/regenerate-mcp`, JIT provisioning, and the worker provision-job keypair backfill.
- `findUserByKid` no longer returns stale rows after key rotation.
- TOCTOU race in `/sign-up/email`'s single-tenant check now caught by the DB unique index — concurrent sign-ups produce one success and one rejection rather than two users.
- `/wikis/:id/regenerate` no longer races with concurrent calls; second concurrent caller receives `409 Conflict`.
- Graph navigation in the wiki frontend validates `node.lookupKey` against `LK_REGEX_STRICT` before `router.push`, preventing forged-node-payload navigation.

### Security

This release closes the findings from an internal security audit dated 2026-04-20: four critical, eight high, nine medium, four low. Phases 1 through 5 ship with this release. Phase 6 (low-severity cleanup, prod-safety aggregator wiring, default-deny route test) is queued and will ship in a follow-up release.

[0.1.0]: https://github.com/withrobinhq/robinwiki/releases/tag/v0.1.0
