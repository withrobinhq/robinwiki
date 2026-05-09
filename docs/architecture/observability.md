# Observability

`/admin/graph/stats` is Robin's read-only operator surface for graph health and pipeline behaviour. One snapshot, eight blocks, computed on demand. No persisted aggregates, no histogram, no alerting. Polling cadence and threshold rules live with the operator, not in this endpoint.

## Endpoint

`GET /admin/graph/stats` (session-cookie gated, same as the rest of `/admin/*`). Returns a single JSON object covering persons, wikis, fragments, edges, wiki_agent_schema coverage, last 24h people-extraction telemetry, and last 24h regen activity.

## Metric definitions

| block | metric | source | window |
|---|---|---|---|
| persons | total, verified, pending, rejected, owner | `people` table, `deleted_at IS NULL` | live |
| wikis | total, populated, empty, autoregenEnabled, dirty | `wikis` table; populated derived from `FRAGMENT_IN_WIKI` edge count | live |
| wikis.editorialState | empty, learning, dreaming, filed | `editorialStateWhere` SQL fragments in `core/src/lib/wiki-editorial-state.ts` | live |
| fragments | total, withMention, withoutMention | `fragments` table; withMention via EXISTS over `FRAGMENT_MENTIONS_PERSON` edges | live |
| edges | per edge_type | `edges` table, `deleted_at IS NULL` | live |
| agentSchema | wikisWithDescription, wikisWithHyde, wikisMissingEither, wikisMissingBoth | `wiki_agent_schema` left-joined to `wikis` | live |
| peopleExtraction24h | rawMentionsSeen, matched, dropped, dropRatePct, telemetryStarted | `pipeline_events` rows with `stage='classify'`, `metadata.substage='entity-extract'` | last 24h |
| regen24h | total, debounced, onDemand | `pipeline_events` with `stage='regen'`, `status='started'`, bucketed by `metadata.triggeredBy` (scheduler vs other) | last 24h |
| lastUpdated | ISO timestamp at response time | `now()` | n/a |

## telemetryWarning

Stream P (PR 362) added the `rawMentionsSeen` and `dropRatePct` counters to `pipeline_events.metadata` for entity-extract events. Counters started populating from merge time forward. When `peopleExtraction24h.rawMentionsSeen` is 0 AND `peopleExtraction24h.telemetryStarted` is null, the response includes:

```
"telemetryWarning": "people-extraction telemetry started after Stream P merged on 2026-05-08; counters reflect post-merge data only."
```

This lets an operator distinguish "extraction is broken, no mentions seen" from "telemetry has not started yet, no data exists". Once any entity-extract event with `rawMentionsSeen` lands, `telemetryStarted` flips to that timestamp and the warning drops out.

## Suggested usage

This is a snapshot endpoint, not a time series. Pair it with a scheduled poll (a minute apart is fine, an hour apart is fine) and watch the trend:

- `peopleExtraction24h.dropRatePct` sustained above 80% over an hour points to a matcher problem. Stream P's drop rate dropped to ~5% after the matcher fix; anything above ~30% sustained is worth investigating.
- `peopleExtraction24h.rawMentionsSeen` at 0 over an hour, with `telemetryStarted` non-null, means no fragments are being processed. Check the `classify` queue and the entity-extract worker.
- `wikis.dirty` climbing without `regen24h.total` climbing means regen is stuck. Check the regen worker and the per-wiki debounce window.
- `agentSchema.wikisMissingBoth` climbing means `wiki_agent_schema` rows are not being seeded. Trigger a backfill via `POST /admin/backfill/wiki-agent-schema` and watch this number drop.

## What this endpoint is not

It is not a metrics service. There are no histograms, no rates, no per-tag dimensions. It does not push events anywhere. It does not write rows. It is one snapshot, computed on demand, designed to be read by a human or a future settings-panel widget.

If you need real-time pipeline state per job, read `pipeline_events` directly. If you need cost telemetry, read `usage_events`. If you need scheduled-worker heartbeats, read `scheduled_jobs`.
