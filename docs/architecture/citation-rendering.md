# Citation Rendering

When a wiki page surfaces a fragment as a citation, the rendered quote is the literal text Marcel pointed at when he routed the fragment to that wiki. The classifier emits the spans, the worker stamps them on the edge, the read path joins them into the response.

## The new path

1. Marcel returns each match with a `citationSpans` array. Each span has zero-based, half-open character offsets and the verbatim `text`. Validation in `wiki-classify.ts` drops any span where `text !== fragmentContent.slice(start, end)`.
2. The linking worker (`packages/agent/src/stages/index.ts`) and the regen-time recovery path (`core/src/lib/regen.ts`) write the validated spans onto the `attrs` jsonb of the top-1 `FRAGMENT_IN_WIKI` edge alongside `score`. Secondary matches keep the existing score-only attrs shape, so consumers can treat top-1 spans as authoritative for the fragment.
3. The wiki read path (`core/src/routes/wikis.ts`, `core/src/routes/published.ts`) passes `wiki.lookupKey` into `makeSidecarDeps(db, wikiKey)`. The resolver looks up the `FRAGMENT_IN_WIKI` edge for `(fragmentId, wikiKey)` and, when the edge carries `attrs.citationSpans`, joins the span texts with " ... " into the `WikiCitation.quote`.

## The fallback path

When `attrs.citationSpans` is missing, null, empty, or non-array, the resolver falls back to the legacy snippet path: `quote = fragment.content.slice(0, 200)`. This applies to:

- Legacy edges written before v0.2.2.
- Secondary `FRAGMENT_IN_WIKI` edges that intentionally do not carry spans.
- Edges where every span Marcel emitted failed validation.

Callers without a wiki context (entry and person read paths) skip the edge lookup entirely and always use the snippet path.

## Backfill

There is no historical backfill (decision locked 2026-05-09). Legacy fragments keep using the slower snippet path; new fragments use the fast direct-render path. Re-classifying a fragment via the regen recovery loop will upgrade its top-1 edge to the new shape.

## How to verify

Spot-check that new ingest is writing spans:

```sql
select src_id, dst_id, attrs
from edges
where edge_type = 'FRAGMENT_IN_WIKI'
  and attrs ? 'citationSpans'
  and deleted_at is null
order by created_at desc
limit 10;
```

Spot-check the legacy population that still relies on the fallback:

```sql
select count(*) filter (where attrs ? 'citationSpans') as new_path,
       count(*) filter (where not (attrs ? 'citationSpans')) as legacy
from edges
where edge_type = 'FRAGMENT_IN_WIKI'
  and deleted_at is null;
```
