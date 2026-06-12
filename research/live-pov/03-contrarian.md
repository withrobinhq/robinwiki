# 03 — Contrarian: Reject the Facade. Conviction Is a Fixed-Point of the Edge Graph.

**Role:** Sub-agent D ("Contrarian"). Agents A/B argue against/for the Live-POV thesis *as framed*. My job is to reject the framing. I take the third vector and commit to it.

---

## The reframe (one paragraph)

**There is no POV. There is no facade. Conviction is not a property anyone stores — it is the fixed-point you get when you propagate For/Against weights across the fragment edge graph, and "liveness" is just the next iteration of that propagation when an edge lands or decays.** The thesis invents a new first-class stored object ("a POV is a facade wrapping ONE stance backed by 3–9 fragments") and then spends its entire open-questions section bleeding from the wounds that object creates: cardinality, attach/detach rules, POV-as-named-thing, per-signal cost, narration surface. Every one of those is self-inflicted. Drop the object and they vanish. Robin already ships the substrate to do this: `edges.attrs jsonb` already carries per-edge weights (`FRAGMENT_IN_WIKI` stores `{score}` today), fragment↔fragment `RELATED_TO` edges already exist, the graph package already does adjacency/BFS/ranking, and a debounced cron already re-derives wiki state from edges on a quiet-window. The "live POV" the thesis wants to build is a **read-time projection over a weighted bipolar graph** — a materialized view, disposable and rebuildable — not a node that owns conviction. Build the weights on the edges and the gradual-semantics pass over them. Don't build the facade.

---

## Why the thesis's framing is the trap

The thesis's load-bearing move is "liveness isn't a fragment property — it's a property of a *stance*, and a POV is a facade wrapping that stance." It sounds like a clean separation. It is actually the introduction of a **stateful denormalized aggregate** into a system whose entire architecture is built on the opposite principle. Three reasons it's a trap, each grounded in Robin's real code:

**1. Robin has exactly one facade already, and it's `wikis`. A POV object is a second one that duplicates its job.** Look at the schema (`core/src/db/schema.ts`): a wiki is a row whose `content` is *rendered from* its member fragments via `FRAGMENT_IN_WIKI` edges (`core/src/routes/wikis.ts:142,266,281,338`), goes dirty via the `dirty_since` column when an edge lands or detaches, and gets re-derived by the regen worker. There are already `belief` and `decision` wiki types (`packages/shared/src/prompts/specs/wiki-types/{belief,decision}.yaml`). **The "named stance backed by bearing fragments that churns as edges attach/detach and re-renders" is the wiki that already exists.** The thesis is proposing to build a parallel object with the same lifecycle — attach/detach edges, dirty signal, re-render — and calling its open questions "novel." They are not novel; they are the wiki's solved problems re-opened under a new name. One-source-of-truth (the user's own global directive) says: don't introduce a second aggregate that re-answers questions the first one already answered.

**2. The hard problems the thesis lists are *aggregate-boundary* problems, and aggregate boundaries only hurt because the aggregate is stored.** "Cardinality" (how many fragments per POV), "attach/detach rules" (when does a bearing fragment join/leave the working set), "POV-as-named-object" (is it addressable) — these are all the question "where do I draw the box and who maintains the box's membership?" If the POV is *materialized on read* from a query over weighted edges, there is no box to maintain. Cardinality becomes "top-k by edge weight at read time" (the graph package already ranks — `shouldShowLabel` takes a `rank`). Attach/detach becomes "the edge's For/Against weight crossed a threshold," computed, not curated. The CQRS/event-sourcing literature is blunt about this: a materialized view "is completely disposable because it can be entirely rebuilt from the source data stores" ([Microsoft Azure Architecture Center — Materialized View pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view)). Storing the projection as a first-class entity is the thing you do only when read cost forces you to — and even then you keep it disposable, never authoritative.

**3. "Conviction moves For/Against; text never mutates" is *already* the description of a weighted bipolar graph — the thesis just put the weights in the wrong place.** It wants conviction to live *on the facade*. But conviction over For/Against propositions is a solved formal object in the literature: a **Quantitative Bipolar Argumentation Framework (QBAF)**, where each argument has a base strength and gains strength from supporters / loses it from attackers, propagated iteratively to a damped fixed point ([Emergent Mind — QBAF](https://www.emergentmind.com/topics/quantitative-bipolar-argumentation-framework-qbaf); [Amgoud & Ben-Naim, "Acceptability Semantics for Weighted Argumentation Frameworks," IJCAI 2017](https://www.ijcai.org/proceedings/2017/0009.pdf); [Bipolar Weighted Argumentation Graphs, arXiv:1611.08572](https://arxiv.org/pdf/1611.08572)). In QBAF, conviction is *not stored on a node* — it is the emergent acceptability degree of the propagation. The thesis reinvents half of QBAF (For/Against, push/pull) and then bolts the result onto a stored facade, which QBAF explicitly does not need. **The motion belongs to the edges. The facade is the mistake.**

---

## The alternative path (grounded + buildable)

Call it **Conviction-on-Edges**: liveness as graph propagation, POV as read-time projection, zero new tables.

### The model

- **Fragments stay exactly as locked:** atomic, immutable, superseded-not-deleted. Untouched.
- **Polarity lives on the edge, not a new object.** Robin already has `RELATED_TO` fragment↔fragment edges (`packages/agent/src/stages/frag-relate.ts` produces them with a relevance `score`; `attrs jsonb` is on every edge). The single change is: the `frag-relate` LLM call, which today emits one relevance `score`, instead emits **`{ polarity: 'for' | 'against', weight: 0..1 }`** into `attrs`. This is a *bipolar* edge — exactly the QBAF support/attack incidence. No schema migration: `attrs` is already `jsonb`. (One enum-ish convention in a JSON blob, not a column.)
- **A "stance" is a query, not a row.** A stance is identified by an anchor — most naturally the `belief`/`decision` **wiki that already exists**. Its conviction is computed by running gradual semantics over the bipolar sub-graph reachable from its member fragments: base strength = fragment `confidence` (already a column — `fragments.confidence real`), propagate For/Against `attrs.weight` along `RELATED_TO` edges to a damped fixed point. The graph package already has `buildAdjacencyMap` and BFS ego-extraction (`packages/graph/src/graphUtils.ts`); the propagation is a few dozen lines of pure function next to them, fully unit-testable, no DB.
- **Liveness is the *delta* of that fixed-point between two propagation runs.** A stance is "live" not because someone flagged it but because a new bipolar edge landed (a fresh fragment took a side) and the recomputed acceptability moved. The magnitude of the move *is* the churn signal the thesis wants — and it's a number, not a curated working-set. No attach/detach rules to author; attachment is "this edge exists and carries weight," detachment is "the supporting fragment was superseded, so its base strength drops out of the next pass."

### Where it runs (this is the part Robin already built)

The thesis worries about "per-signal cost" and proposes "opt-in via citation-impact gating." Robin **already solved this for wikis** and the contrarian path inherits it for free:

- The regen worker (`core/src/queue/regen-worker.ts`) runs on a 12-hour batch + midnight cron, gated by the `dirty_since` column and a **5-minute debounce** (`core/src/queue/regen-debounce.ts`, `DEFAULT_REGEN_DEBOUNCE_MS`). That debounce exists *precisely because* "most runs were superseded by the next batch of fragment arrivals before the output mattered" (the file's own QA Issue 6 note). That is the exact cost concern the thesis raises — **already mitigated, in production, for the facade that already exists.**
- Conviction propagation rides the same trigger: when `dirty_since` is set, recompute the bipolar fixed-point for the affected stance-wikis in the same pass that re-renders them. The recommender-systems literature frames this correctly — precompute-on-write vs recompute-on-read is "moving work from read time to write or refresh time… a tunable," with TTL-style debounce balancing freshness against cost ([Space-Time Tradeoff in Recommender Systems](https://medium.com/@23bt04175/space-time-tradeoff-in-recommender-systems-netflix-amazon-memory-heavy-precomputation-vs-on-64d57ba02b17); [Materialized View production tradeoffs](https://technori.com/news/materialized-views-production-tradeoffs/)). Robin already sits at the right point on that spectrum (debounced cron). The thesis's "opt-in citation-impact gating" is a *worse-specified reinvention* of `autoregen` + `dirty_since` + debounce.

### What this kills, cleanly

| Thesis open question | Conviction-on-Edges answer |
|---|---|
| Cardinality (3–9 fragments?) | None. Top-k by propagated weight at read time. No fixed working set. |
| Attach/detach rules | None to author. Edge exists ⇒ attached; base fragment superseded ⇒ drops out next pass. |
| POV-as-named-object | The `belief`/`decision` wiki already is the named anchor. No new object. |
| Per-signal cost | Inherited: `dirty_since` + 5-min debounce + 12h cron, already shipping. |
| Narration surface ("Socrates") | Reads the *delta* of the fixed-point ("your conviction on X moved For because fragment Y landed and Z was superseded") — a graph diff, derivable, not a stored event stream. |

---

## Steelman vs. the advocate (B)

**B's strongest objection:** *"A query-time projection has no identity. Users need to point at 'my view on remote work' and watch it evolve, link to it, let the narrator address it by name. A fixed-point recomputed from edges is anonymous math — you've optimized away the product. The facade exists so the POV is a thing the user has a relationship with."*

This is the real objection and I'll meet it head-on, not dodge into "it depends":

1. **Identity and storage are different axes.** A stance needs a stable *anchor* (an addressable id, a name, a URL) — it does **not** need a stored *aggregate of conviction*. Robin already separates these: a wiki row is a stable named anchor whose `content`/state is *derived* from edges and re-rendered. Conviction-on-Edges gives the stance the same deal: the `belief` wiki is the named, linkable, narratable thing; its conviction is the derived view. The user points at a name; the name resolves to a fixed-point. B conflates "needs a name" with "needs to store the conviction on a facade." It doesn't.

2. **A stored facade actively *lies* about liveness; a fixed-point can't.** The thesis's core promise is "live when the working set churns." A stored working-set is a cache, and caches go stale silently — the facade can claim 3 bearing fragments while a 4th superseded one of them an hour ago and no job has run. The recomputed fixed-point is *constitutively* current as of its last pass, and its staleness is exactly `now - last_propagation`, a number you can surface honestly. QBAF's **conservativity** property guarantees unconnected arguments keep their base score — so a stance with no new bipolar edges correctly shows *no* churn, no false liveness ([Amgoud & Ben-Naim 2017](https://www.ijcai.org/proceedings/2017/0009.pdf)). The facade has no such guarantee; it's whatever the last writer left in it.

3. **The narrator gets *more* to say, not less.** B fears anonymity. But "your conviction on remote work moved from +0.3 to +0.6 For, because fragment Y landed (weight 0.7 For) and fragment Z was superseded (it was your strongest Against)" is a *richer, fully-grounded* narration than "the POV's working set churned." It's a graph diff with provenance baked in — every term traces to an immutable fragment and a weighted edge. The Socrates layer is *better* served by the propagation than by the facade, because the propagation hands it causes, not just a state change.

Where B genuinely wins, and I concede it: **if Robin's actual product bet is that users want to *curate* their stances — hand-pick the 3–9 fragments, manually attach/detach — then a stored facade is the right object and my reframe is wrong.** Curation needs a stored membership set. But the thesis explicitly says "wikis render POVs, never own conviction" and "conviction moves For/Against; text never mutates" — that is an *automatic, derived* conviction, not a curated one. Taken at its word, the thesis is describing a derived view and then storing it anyway. That's the contradiction I'm exploiting.

---

## What Robin builds instead, and in what order

Smallest viable path, each step independently shippable, each riding existing infrastructure. (Read-only on source — this is the recommended order, not applied work.)

1. **Bipolar edges.** Change `frag-relate` (`packages/agent/src/stages/frag-relate.ts`) to emit `attrs: { polarity, weight }` instead of a bare `score`. → *verify:* new `RELATED_TO` edges carry polarity in `attrs`; existing relevance-only edges still parse (polarity optional, defaults to neutral). Pure pipeline change, no migration.

2. **Propagation as a pure function.** Add `propagateConviction(edges, baseStrengths)` to `packages/graph` next to `buildAdjacencyMap` — damped iterative fixed-point per QBAF gradual semantics, base strength from `fragments.confidence`. → *verify:* unit tests for monotonicity (adding a For edge raises acceptability), conservativity (isolated fragment keeps base), convergence (damped iteration terminates). No DB, no LLM — fully testable in isolation.

3. **Stance = anchored read-time projection.** A `GET /wikis/:id/conviction` route that runs propagation over the wiki's member-fragment sub-graph and returns the fixed-point + per-fragment contribution. → *verify:* a `belief` wiki returns a conviction score derivable by hand from its edges. Zero new tables.

4. **Liveness = propagation delta on the existing cron.** Hook propagation into the regen worker's `dirty_since`/debounce pass (`core/src/queue/regen-worker.ts`); store *only* the last fixed-point value (one number, in `wikis.metadata` jsonb which already exists) to diff against. → *verify:* landing a new bipolar edge on a quiet wiki moves its conviction after the debounce window; a wiki with no new bipolar edges shows zero delta.

5. **Narration reads the delta.** The Socrates surface consumes the fixed-point diff + the superseded/landed fragments behind it. → *verify:* narration cites real fragment keys and real edge weights for every claimed conviction move.

Steps 1–3 prove the model with no schema change and no new cost surface. Only step 4 touches the cron, and it reuses the debounce that already exists. There is no POV table, no attach/detach rules engine, no cardinality decision, no new cost-gating mechanism. The thesis's entire open-questions list never gets opened.

---

## Verdict block
**VERDICT:** Don't build a POV facade — make conviction the emergent fixed-point of a bipolar (For/Against) weighted edge graph, expose a "stance" as a read-time projection anchored on the belief/decision wiki that already exists, and let liveness be the propagation delta computed on Robin's existing debounced regen cron.
**CONVICTION:** high — the thesis's five open questions are all artifacts of storing a derived aggregate; Robin already ships every primitive needed to derive it instead (`edges.attrs jsonb`, weighted `FRAGMENT_IN_WIKI`/`RELATED_TO` edges, `fragments.confidence`, the graph package's adjacency/BFS/rank, and a `dirty_since`+debounce cron), and the formal object (QBAF) exists and matches For/Against exactly.
**Strongest evidence:**
- QBAF computes argument conviction as a damped iterative fixed-point over support/attack edges with no stored facade — conservativity guarantees no false liveness ([Emergent Mind — QBAF](https://www.emergentmind.com/topics/quantitative-bipolar-argumentation-framework-qbaf); [Amgoud & Ben-Naim, IJCAI 2017](https://www.ijcai.org/proceedings/2017/0009.pdf)).
- A derived projection should be "completely disposable… entirely rebuilt from the source data stores," not a first-class stored entity ([Azure — Materialized View pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view)).
- Robin's `edges.attrs jsonb` already stores per-edge weights (`FRAGMENT_IN_WIKI` ⇒ `{score}`, `core/src/routes/wikis.ts:281`) and the `frag-relate` stage already emits scored fragment↔fragment edges (`packages/agent/src/stages/frag-relate.ts`) — bipolar edges are a JSON-shape change, not a migration. *(inference from code)*
- The thesis's "per-signal cost" worry is already solved for the existing facade: `dirty_since` + 5-min debounce + 12h/midnight cron exist precisely because most recomputes were superseded before mattering (`core/src/queue/regen-debounce.ts` QA Issue 6 note). *(inference from code)*
**What would change my mind:**
- If user research shows people want to **manually curate** which 3–9 fragments back a stance (hand attach/detach) — then membership is real state, a stored facade is correct, and my "derive it" reframe collapses.
- If propagation latency over realistic graph sizes can't fit the existing debounced cron budget (12h/midnight, ~70–180s/wiki regen window) — then precomputing a stored conviction aggregate becomes a justified read-cost optimization after all.
- If the narrator demonstrably needs an append-only *history* of conviction moves (not just the current delta) — that's an event log, which is real stored state the projection-only model doesn't provide.
