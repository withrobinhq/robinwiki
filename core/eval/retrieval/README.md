# Retrieval evals

Hand-curated query/relevance pairs for Robin's hybrid retrieval. Sealed
v1 golden set used to gate ranking changes (Wave G6).

## Files

- `corpus.json` — wiki seed corpus the eval runner installs into a
  fresh test database before running queries
- `queries.json` — labeled queries with expected top-3 wiki targets and
  the retrieval pathway each query is intended to exercise

## Status

Until the eval-runner harness is wired up, this directory holds the inputs
as raw fixtures. To run them, wire the fixture loader into evalite via:

```ts
import corpus from './corpus.json'
import queries from './queries.json'
// register an evalite suite that:
//   1. seeds wikis from corpus
//   2. waits for regen to populate wiki_agent_schema
//   3. for each query, calls hybridSearch and asserts the expected
//      wiki id is in the top-3
```

Pathway labels (used to slice eval results by mechanism so a regression
in one lane shows up cleanly):

- `bm25` — literal lookup; BM25 should win on its own
- `description` — semantic lookup against wikis.description
- `hyde` — conversational query that benefits from the HyDE synthetic
  passage rather than the source body
- `blend` — ambiguous query where RRF across BM25 + description + HyDE
  is expected to outperform any single lane

## Sourcing

Per Andrew (2026-05-07): "source from internet topics (e.g. Wikipedia
article content) or archive websites for v1 golden set." The current
corpus uses public-domain factual content trimmed to the shape Robin
expects — title, description, body — so the eval is reproducible and
does not leak Andrew's vault.
