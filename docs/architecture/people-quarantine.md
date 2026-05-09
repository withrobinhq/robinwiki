# People Quarantine

Robin's people pipeline went from a matcher-only design (the LLM never proposed new people) to an extractor that surfaces every person-like mention. New persons land in a quarantine queue by default, gated behind an operator approval step. This document describes the model and the read-site exclusion matrix.

## The matcher to extractor flip

`people-extraction.yaml` v2 told the LLM "you NEVER propose new people, drop unfamiliar names silently". A live deployment ingested 89 entries (534 fragments) and produced zero new Person rows because the prompt filtered them out before they reached the worker.

v3 (Stream P, 2026-05-09) flips Elfie from matcher to extractor. The LLM now returns every person-like mention split into two buckets:

- `matched`: the mention maps to an entry in KNOWN PEOPLE (verified row).
- `candidates`: the mention does not map to anyone in KNOWN PEOPLE.

The shared `resolveOrDrop` helper handles dedup and creation downstream. Both the worker pipeline (entityExtract) and the MCP `log_fragment` fast path call it, so the same input produces the same outcome graph regardless of how the fragment arrived.

## The four statuses

Every row in `people` carries a status. Migration 0017 added the column with a CHECK constraint pinning it to one of the four:

- `verified`: graph-visible. Default for legacy rows and for any row created via MCP.
- `pending`: in the quarantine queue. Auto-extracted persons land here by default.
- `rejected`: operator rejected. Edges stay attached but invisible; row stays in the table for audit.
- (deleted via `deletedAt`): soft-deleted, invisible to all read sites. Functionally a fourth state.

## The five entry paths

Every Person row carries a `created_via` label that records how it entered the system:

1. `seeded`: bootstrap rows (e.g. owner-Person from the onboarding flow). Status `verified`.
2. `mcp_create`: explicit AI-agent or operator creation via `create_person` MCP tool. Status `verified`. The "I know who this is" path; bypasses quarantine by design.
3. `mcp_update`: a row promoted from pending to verified via `update_person` with `promoteFromQuarantine: true`. Status `verified` after the call.
4. `extractor_pending`: surfaced by the extractor and routed through quarantine. Status `pending`.
5. `extractor_auto`: surfaced by the extractor when `app_settings.auto_accept_persons` is true. Status `verified`. Operators flip the toggle when they trust extraction enough to skip the queue.

## Read-site exclusion matrix

The matrix locked 2026-05-09. Pending persons are EXCLUDED from hybrid search entirely (no marker, just absent), and all other read sites surface pending rows WITH a status marker so consumers can render the quarantine indicator without a second fetch.

| Site | Pending visible | Notes |
| --- | --- | --- |
| Person wiki render | yes | minimal fact card with status='pending'; no regen body |
| MCP find_person | yes | status field in payload |
| MCP brief_person | yes | status field in payload, body shows quarantine notice |
| GET /people | yes default with `?status=verified`, filterable | each row carries status |
| Hybrid search (user query) | NO | excluded entirely |
| FRAGMENT_MENTIONS_PERSON edge reads | yes | attrs include person status |
| Marcel classification target | NO | excluded from candidate-target wikis |
| Quill regen citation | NO | edges to pending filtered when assembling prompt |
| `wiki_agent_schema` rows | NO | not written until verified |
| `embedding-retry-worker` heal | NO | skip pending |

## Approval flow

Approval and rejection are HTTP-only via the admin UI:

- `POST /admin/people/:lookupKey/approve`: flips status to `verified`. Existing FRAGMENT_MENTIONS_PERSON edges become fully involved with no backfill (read sites carry status through, so they self-heal). The wiki_agent_schema heal pass picks up the newly-verified row on its next tick.
- `POST /admin/people/:lookupKey/reject`: default `status='rejected'`, edges stay attached but invisible. Pass `{ "hardDelete": true }` to cascade delete the row plus its edges.

There are NO MCP approve or reject tools by design. AI agents read the queue via `list_pending_persons` (read-only), and the actual approve or reject call is a deliberate operator action behind admin session auth. The MCP tool `set_auto_accept_persons` is the one operator-state lever that AI agents can flip; it toggles the instance-wide `auto_accept_persons` flag.

## Telemetry

`pipeline_events` rows for the entity-extract substage carry:

- `rawMentionsSeen`: count of mentions the LLM surfaced (matched + candidates).
- `matchedMentions`: count that landed in `peopleMap` after resolveOrDrop.
- `createdPersons`: count of rows minted by the helper.
- `unmatchedDropped`: matched bucket entries the resolver disagreed with.
- `dropRatePct`: `(rawMentionsSeen - matchedMentions - createdPersons) / rawMentionsSeen`, rounded to integer percent.
- `autoAccept`: snapshot of `app_settings.auto_accept_persons` at the time of extract.

A spike in `dropRatePct` is the signal that the matcher is too strict for the current corpus.
