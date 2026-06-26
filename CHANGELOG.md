# Changelog

All notable changes to Robin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-05-09

People extraction overhaul, quarantine model, settings shell, graph observability, wiki state rationalization, and classifier citation maps. Ships 12 PRs across 3 waves.

### Breaking changes

- **Regen is now fully opt-in per wiki.** The `regenerate` flag is dropped. `autoregen` (renamed from `auto_regen`) is the sole gate, default `false`. Existing instances: run migration 0014 with `--preserve-existing` to keep current behavior, or adopt the new opt-in default and enable `autoregen` per wiki via the settings UI. `regen_now` MCP tool bypasses the flag for on-demand use.
- **People-extraction prompt flips from matcher-only to extractor.** The LLM now surfaces all person-like mentions, not just matches against known people. Unknown names create `status='pending'` rows (quarantine) by default. Operators triage via `/settings/people` or set `auto_accept_persons=true` to skip quarantine. MCP `create_person` auto-verifies (no quarantine for intentional creation).
- **`wikis.lifecycle_state` column dropped.** Editorial state is now derived from `{state, dirty_since, last_rebuilt_at}` via the `editorialStateOf(...)` Zod helper. Code that read `lifecycle_state` directly must switch to the helper or the `editorialStateWhere` SQL fragments.

### Added

- `/settings` shell with three panels: Wikis (per-wiki autoregen toggle, regen-now button, last-regen time-ago, agent-schema gap indicator), People (pending-person triage with Approve/Reject, auto-accept toggle), Backfill (gap detection, on-demand triggers via `/admin/backfill` endpoints).
- `create_person`, `update_person`, `add_relationship` MCP tools. `create_person` auto-verifies. `update_person` accepts an explicit `promoteFromQuarantine` flag (default false) for promoting pending persons while adding context.
- `list_pending_persons` and `set_auto_accept_persons` MCP tools for operator triage flows.
- `POST /admin/people/:key/approve` and `POST /admin/people/:key/reject` HTTP endpoints (UI-only approval, no MCP approve/reject by design).
- `GET /admin/graph/stats` endpoint for graph and pipeline observability: person counts by status, wiki editorial-state breakdown, edge counts by type, 24h people-extraction telemetry (rawMentionsSeen, dropRate), agent-schema gap counts, regen counts.
- `GET /admin/backfill/audit`, `POST /admin/backfill/wiki-agent-schema`, `GET /admin/backfill/runs` HTTP endpoints for operator-controlled backfill.
- `wikis.dirty_since` column replaces v0.2.1's query-time derivation for regen debounce. Set on FRAGMENT_IN_WIKI edge arrival, cleared on regen completion.
- `people.status` column (`verified`, `pending`, `rejected`) with quarantine propagation: pending persons excluded from hybrid search, Marcel classification, Quill regen citations, and agent_schema rows; visible with status marker in find_person, brief_person, GET /people, and person wiki page (full-width quarantine topbar).
- `people.created_via`, `people.extracted_from_fragment_id`, `people.context_notes` columns for traceability and context accumulation.
- `app_settings.auto_accept_persons` toggle (default false) for bypassing quarantine on future ingest.
- `WIKI_RELATED_TO_WIKI` edges from Marcel's secondary candidates above 0.4 confidence. Graph now records co-occurrence signal that was previously discarded after classification.
- `FRAGMENT_MENTIONS_PERSON` edges now carry `attrs.{mention, sourceSpan, confidence}` on every new write. Enables provenance display, matcher auditing, and offline re-matching.
- Marcel emits `citationSpans` per matched wiki: character offsets plus literal text of spans that drove the classification. FRAGMENT_IN_WIKI edges persist these in attrs. Wiki rendering reads them directly with fallback to legacy reconstruction for older edges.
- `ensureAgentSchema(wikiKey, options)` helper centralizes all `wiki_agent_schema` writes through a single entry point with 5 modes (create, refresh, heal, regen-bump, backfill). Contract test enforces no direct writes outside the helper.
- `editorialStateOf(...)` Zod helper and `editorialStateWhere` SQL fragments derive editorial state from `{state, dirty_since, last_rebuilt_at}` without a dedicated column.
- `source_client` columns on `fragments`, `wikis`, `wiki_types`, `groups` tables. All audit-log writers converted from `detail.source_client` JSON to direct column writes. `AuditDetail` type guard prevents regression.
- `rawMentionsSeen` and `dropRatePct` telemetry on entity-extract pipeline events, surfacing the real LLM drop rate for people extraction.
- Shared `resolveOrDrop` helper unifies the worker pipeline and MCP `log_fragment` paths for person resolution. No more behavioral divergence between the two ingest paths.
- Architecture docs for wiki state, people quarantine, observability, citation rendering, and seed data (now consolidated into `docs/ARCHITECTURE.md`), plus `docs/operator-guide/settings.md`.

### Changed

- Regen partition YAML aligned with E1 implementation: `[NEW FRAGMENTS]`, `[UPDATED FRAGMENTS]`, `[REMOVED FRAGMENTS]` headers across all 10 wiki-type Quill prompts. Legacy `[USER EDITS]` block dropped from all wiki-type YAMLs. Contract test asserts Quill never sees old-style flat lists.
- `edges.src_type` canonicalized: `'entry'` backfilled to `'raw_source'` with CHECK constraint preventing reintroduction. Persist stage rewritten to emit canonical value.
- Seed-person edge creation path audited and documented. The 15 edges from QA Issue 4c traced to `core/src/lib/seedFixture.ts` (first-user provisioning for "Attention Is All You Need" test data).

### Fixed

- `wikis.lifecycle_state` eliminated as a redundant column. Editorial state is now a deterministic function of existing columns, removing a class of drift bugs where the two state machines could disagree.
- `ENTRY_HAS_FRAGMENT` edges no longer use inconsistent `src_type` values. Graph traversal queries that filter by src_type return complete result sets.

### Migrations

- 0014: `wikis` state rationalization (destructive, BREAKING). Drops `regenerate`, drops `lifecycle_state`, renames `auto_regen` to `autoregen`, adds `dirty_since`.
- 0015: `source_client` columns on fragments, wikis, wiki_types, groups (additive).
- 0016: `edges.src_type` canonicalization plus CHECK constraint (additive, backfill).
- 0017: `people.status`, `created_via`, `extracted_from_fragment_id`, `context_notes` columns plus `auto_accept_persons` setting (additive).

## [0.2.1] - 2026-05-09

Stability + cost-visibility release. Fragmentation prompt v3, regen debounce during active ingest, on-demand regen surface for MCP clients, scheduled-job heartbeat infrastructure.

### Added

- `regen_now` MCP tool. Triggers an on-demand regen for a single wiki, bypassing the auto-regen flag and the debounce. Pairs with the new `regen_status` tool that surfaces per-wiki regen counts and last-run cost so MCP clients can size the request before firing.
- `validateOpenRouterKey` helper plus `POST /users/openrouter-key/validate`. Onboarding now blocks completion until the key resolves against OpenRouter; existing instances get a fail-loud warning at boot when the key is missing or rejected.
- `scheduled_jobs` table with `recordJobRun` helper. Replaces the prune-pipeline-events audit-log entry as the canonical heartbeat surface. New jobs register through the helper; the existing prune cron is migrated over.
- `core/scripts/backfill-wiki-agent-schema.ts` one-shot script for healing instances whose `wiki_agent_schema` rows drifted against the wiki body.
- Full favicon set generated from the canonical Robin logo, plus web-app manifest and Next metadata wiring. Browser tab and PWA install both render the brand asset.
- `ensureAgentSchema` helper unifying agent_schema writes across POST `/wikis`, PUT `/wikis/:id`, regen, embedding-retry-worker, and the heal path.

### Changed

- Per-wiki regen debounce during active ingest. While entries for a wiki are still in the pipeline, regen suppresses re-fires until the in-flight batch settles. Reduces redundant regens when capturing a long thread.
- Fragmentation prompt promoted to v3. Targets richer fragments and retains reflective claims that v2 tended to drop.
- `wiki_agent_schema` rows now refresh automatically when a wiki's `description` changes, and the description-kind row is seeded at wiki creation rather than on first regen.
- Audit-log detail for entry-ingest no longer double-stamps `source_client`; the column on `entries` is the single source of truth.
- Generated wiki SDK regenerated against the current OpenAPI spec; the `publishedOrigin` cast that masked a type drift was dropped.

### Fixed

- Wiki-type validation contract restored for `slug`, `belief`, `research`, and `decision` types. A regression in v0.2.0's validation pass was rejecting valid YAML for these four types.
- Stale `wiki_agent_schema` rows that survived a description change are now healed by the auto-refresh path. Combined with the one-shot backfill script for instances already in drift.

## [0.2.0] - 2026-05-08

First feature-complete Robin release. Adds AI cost telemetry, the wiki retrieval substrate (graph package, agent-schema, HyDE), incremental regen, citation rendering, fragment lineage, publishing surface, MCP skill packs, and a markdown export.

### Breaking changes

- **Wiki regen behavior changed for wikis with new fragments.** v0.2.0 introduces incremental regen (E1): the partition handed to Quill is now `{NEW, UPDATED, REMOVED}` against `last_rebuilt_at`, not the full fragment set. Wikis regenned for the first time post-deploy may show 1 to 3 regens of body drift before the partition settles. No action required; the drift self-corrects.
- **`migrations_meta` table required.** A new `migrations_meta` table backs the journal-hash drift detector. The migration is idempotent, but the boot path now refuses to start in production when the on-disk Drizzle journal SHA does not match the recorded value (forced push, cherry-pick, or rebased migration scenarios).
- **MCP tools reinstated.** `publish_wiki` and `unpublish_wiki` are back on the MCP surface after being temporarily removed during v0.1.0 hardening. Re-paste your MCP URL is not required; tools become available on next handshake.
- **Wiki-type taxonomy renames.** `collection` is now `research`; `principles` is now `principle`. Existing rows migrate automatically. Custom YAMLs that referenced the old slugs need to be updated.

### Added

#### AI cost telemetry and budget caps
- `usage_events` table records every OpenRouter call with model, prompt tokens, completion tokens, and cost.
- `/settings/spend` dashboard renders rolling 7-day and 30-day spend by model and by feature, plus configurable budget caps.
- `GET /fragments/:id/history` surfaces the per-fragment edit timeline.

#### Knowledge graph and retrieval substrate
- `@robin/graph` workspace package with utilities and a typed edge adapter.
- `wiki_agent_schema` table holding retrieval-optimized representations distinct from the human-edited wiki body. See `docs/ARCHITECTURE.md`.
- `wiki_types.internal_framing` column.
- HyDE retrieval-index generator wired into regen. Synthetic example fragments per wiki improve cosine retrieval over the prose body alone.
- Retrieval cutover: search and the classifier read `wiki_agent_schema` first, with legacy fallback.
- Hand-curated retrieval eval corpus and queries for regression tracking.

#### Citations, lineage, and evolution
- Numbered superscript citations rendered inline in wiki bodies, threaded with a doc-wide bibliography section. Fragment refs become `[1]`, `[2]`, ... with anchors on the references list (#245).
- Fragment detail page expanded into a full lineage view: infobox (type, state, tags, dates), entry origin, evolution timeline, wiki references, related fragments. One page, full lineage.
- Fragment evolution timeline with word-level diffs across edit history.

#### Wiki management
- Incremental regen partition (E1). Quill receives `{NEW, UPDATED, REMOVED}` against `last_rebuilt_at`, not the full fragment set. Reduces token spend per regen.
- `wikis.lifecycle_state` column with values `learning`, `dreaming`, `filed`. Bumps to `learning` on every `FRAGMENT_IN_WIKI` edge insert.
- `wikis.auto_regen` and `wikis.last_regen_at` columns (migration 0004). Auto-regen defaults to `false`, opt-in per wiki.
- Regen-batch worker sweeps `auto_regen=true` wikis with `learning` state on a schedule.
- `DELETE /wikis/:id/fragments/:fragmentId` un-attach endpoint.
- `PATCH /wikis/:id/auto-regen` toggle endpoint.
- `attach_fragments` MCP tool.
- Fragment-relationship backfill (cron + admin endpoint + settings counter) for instances that ingested before the `RELATED_TO` edge type existed.

#### MCP skill packs and source-client telemetry
- Top-level `skills/` directory shipping the Capture pack alongside imported `log-to-robin` and `knowledge-system-guide` skills.
- `list_skills` MCP tool plus a server-side alias registry with install and remove APIs.
- MCP `clientInfo` handshake captured into `entries.source_client` column. Audit detail no longer needs to re-derive client identity.

#### Publishing
- Publish flow extracted into `services/publish` with `publish_wiki` and `unpublish_wiki` MCP tools reinstated.
- Published URL on the AddWiki success modal is now clickable and uses `publishedOrigin`.

#### Backups and providers
- `GET /users/export?format=zip` returns markdown bodies plus a graph dump, suitable for offline backup.
- `/settings/providers` read-only page showing the active OpenRouter configuration.

#### Recovery and onboarding
- Forgot-password link on `/login`.
- `/account/initial-password-reset` page gated behind `mustResetPassword` session field.
- `POST /users/clear-reset-flag` endpoint clears the flag after successful reset.
- Drizzle journal-hash drift detection at boot. Production refuses to start when the on-disk migration journal SHA does not match the recorded value; dev and test auto-heal with a warning.
- `migrations_meta` table backing the drift detector.
- Daily prune-pipeline-events cron, with audit + pipeline event emission from embedding-retry, regen-worker, and the fragment-stage workers.
- `GET /admin/diagnose/:entryKey` surfaces the full pipeline state for an entry.

### Changed

- Wiki body retrieval and the classifier now read `wiki_agent_schema` rows; the legacy "embed the rendered prose" path remains as a fallback only.
- Fragment classification emits `RELATED_TO` edges between similar fragments at classify time, plus `related_detected` audit events surfacing in the timeline.
- Wiki sidecar payloads (refs, infobox, citation declarations) persist on regen rather than being recomputed per request.
- Spawn endpoint now writes `WIKI_RELATED_TO_WIKI` edges between parent and spawned child.
- `pipeline_events.entry_key` relaxed to nullable so queue-internal events without an entry context can be recorded.
- `pipeline_events` stage taxonomy standardized to a 5-name union.
- Shared package barrels split into explicit browser and node surfaces; the wiki bundle no longer pulls `node:fs` transitively.
- Generated wiki SDK regenerated against the current OpenAPI spec, including entry sidecar fields and wiki bouncer/publish/collections endpoints.

### Fixed

- MCP `search` tool and HTTP `/search` now emit identical payloads, validated through `searchResponseSchema`.
- Wiki infobox floats right so prose wraps around it (#229 visual regression).
- `additionalFields.fieldName` for `mustResetPassword` now points at the drizzle schema key, not the column name.

### Security

- `assertProdSafety` aggregator wired into the boot path, with a `PUBLIC_ROUTES` allowlist asserted by `route-allowlist.test.ts`.
- Process crash handlers (`uncaughtException`, `unhandledRejection`) now `NODE_ENV`-aware (SEC-L4). Production exits the process; dev logs and continues.
- YAML loaders use `FAILSAFE_SCHEMA` to disallow custom tags and prototype pollution paths in user-supplied wiki-type prompts (SEC-L3).
- `GET /users/activity` capped at limit 200 to prevent unbounded reads (SEC-L1).

This release closes Phase 6 of the v0.1.0 security audit alongside the feature work.

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

[0.2.1]: https://github.com/withrobinhq/robinwiki/releases/tag/v0.2.1
[0.2.0]: https://github.com/withrobinhq/robinwiki/releases/tag/v0.2.0
[0.1.0]: https://github.com/withrobinhq/robinwiki/releases/tag/v0.1.0
