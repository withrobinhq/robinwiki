# 04 — Verdict: Live POVs (Sub-Agent C, "Verdict")

**Role:** Final arbiter. I read all three reports in full, re-verified the load-bearing code
claims myself where the agents conflicted, and render a single path with conviction. I am not
producing "three views." I am deciding.

**Citation convention.** `[verified]` = I ran Grep/Read on the cited file this session and confirmed it.
`[agent X]` = a sub-agent's claim I did *not* independently re-verify. `[infer]` = my reasoning.

---

## 1. The verdict

**Build the POV as a *thin, anchored, derived* stance — not a new stored facade object, and not a
per-signal conviction engine.** Concretely: (a) reuse the `belief`/`decision` wiki that already
exists as the stance's stable named anchor — do **not** introduce a parallel `pov` table; (b) make
"liveness" piggyback on the regen worker's existing `dirty_since` + 5-min debounce + ≤50/tick cron —
do **not** add a synchronous per-signal "does this change me?" re-weigh; (c) derive a *conviction
read* from a bipolar (For/Against) weighting of the stance's member fragments, computed on the
existing debounced cadence and cached as one scalar to diff against, exposed render-time. What I am
**killing outright**: the maximalist per-signal For/Against re-evaluation engine (counter's target),
the standalone POV-as-stored-aggregate with curated 3–9 membership and successor-spin-on-churn, and
any cost surface that fans out over live POVs rather than over the existing top-k retrieval. The
contrarian has the right *architecture* (derive, don't store the aggregate); the counter has the
right *cost verdict* (no per-signal engine); the validate report has the right *reuse map* (the regen
subsystem is the substrate). The synthesis is: **counter's "no" to the engine + contrarian's "derive
it" model + validate's "ride the regen plumbing" — anchored on the wiki that already exists.**

---

## 2. Adjudicating the three

### Counter (01) — right about the engine, overreaches on the facade

**Right, and I verified it:**
- The regen worker really did remove time-based re-evaluation and cap the batch. `BATCH_LIMIT = 50`
  at `regen-worker.ts:24`; the comment `Stale threshold removed — wikis only regen when they have new
  fragments or are stuck` at `:26`; the debounce gate (`filterDebouncedWikiKeys`) and the explicit
  "pay LLM cost for ground that shifts under them when fragments are still arriving — gate via the
  per-wiki debounce" reasoning at `:143`. `autoregen` defaults `false` at `schema.ts:328`. **[verified]**
  The architecture-reversal argument is real and load-bearing: a per-signal conviction engine re-adds
  exactly the continuous re-evaluation this code deleted.
- The cost shape is correct: a For/Against re-weigh over a working set is a *reasoning* call, not a
  0–1 relevance score, and fanning it out per-live-POV-per-signal loses the constant-cost-per-fragment
  property that today's top-k-gated pipeline has. I did not re-price the tokens, but the structural
  claim (fan-out over POVs, not over a fixed top-k) is sound. **[infer, from verified pipeline shape]**

**Overreach:** Counter concludes "build the facade as a render-time object, kill only the engine."
But it treats the facade as a *stored* object with an authored statement bound to a working set, and
then spends Vector 2 and Vector 5 correctly showing that *that stored object* leaks (concept drift,
unspecifiable cardinality, successor sprawl). Counter diagnoses the disease of the stored facade and
then prescribes the stored facade anyway. The contrarian's move — don't store the aggregate at all —
dissolves Vectors 2, 3, and 5 that counter itself raised. Counter got to the right "no" on the engine
but stopped one step short on the object.

### Validate (02) — right about the substrate, overreaches on "70% built"

**Right, and I verified it:**
- The reuse map is real. `dirty_since` column (`schema.ts:335`), debounce (`regen-debounce.ts`),
  batched ≤50/tick (`regen-worker.ts:24`), per-stage `cost_usd_micros` (`schema.ts:569`),
  `app_settings` budget cap (`limit_usd_micros`, `schema.ts:587`), typed `edges` with `attrs jsonb`
  (`schema.ts:495–496`), soft-delete membership. **[verified]** The cost objection genuinely *is*
  closeable with machinery that already runs.
- The immutability concession is **confirmed true**: `PUT /fragments/:id` mutates `content` in place
  (`fragments.ts:329,338–340`) and writes an `edits` before/after snapshot (`:366–376`). The LOCKED
  "immutable, superseded-not-deleted" decision is *aspirational in code*. **[verified]** This is a
  finding, not a license to discard the constraint — see §4.

**Overreach:** "~70% already built" conflates *generic plumbing* (debounce, batch, cost tracking —
genuinely reusable) with the *load-bearing AI capability* (bipolar For/Against + "is this delta worth
re-expressing"). The 70% is the cheap 70%. The expensive 30% — directional support/attack judgment —
is exactly what does **not** exist, and validate's own concession #4 admits it. Validate also leans on
JTMS/ATMS as a *pro*; counter leans on TMS as a *con* (Σ₂ᵖ-complete, abandoned). Both cite TMS — the
honest reading is that TMS validates the *representation* (justification sets, multi-context) and
indicts the *automatic global consistency maintenance*. Robin's design must take the representation
and refuse the global maintenance. Validate's design (§5 gates) actually does refuse it; its rhetoric
oversells it as nearly free.

### Contrarian (03) — right about the model, overreaches on "zero migration"

**Right, and I verified the substrate claims:**
- `edges.attrs` is `jsonb` and already stores weights: `FRAGMENT_IN_WIKI` writes
  `{ score: 1 - frag.distance }` at `wikis.ts:281`. **[verified]**
- `frag-relate` emits a bare relevance `score` today (`frag-relate.ts:26,37–38`, `THRESHOLD=0.5`). **[verified]**
- `belief.yaml` and `decision.yaml` wiki-type specs exist (`packages/shared/src/prompts/specs/wiki-types/`). **[verified]**
- `fragments.confidence` is a declared column (`schema.ts:271`). **[verified — but see below]**
- The graph package has adjacency/BFS. **[agent — not re-verified this session; consistent with cited file]**

**Two overreaches I caught by reading the code the contrarian cited:**

1. **"Bipolar edges are a JSON-shape change, not a migration" understates it badly.** The
   `frag-relate` prompt (`fragment-relevance.yaml`) is built on *symmetric* relevance — it states
   explicitly: *"The relationship is symmetric — order should not affect the score."* **[verified]**
   For/Against is *directional* (A-supports-B is not B-supports-A; attack is not symmetric with
   support). Emitting `{polarity, weight}` is not a JSON tweak on top of the existing prompt — it
   requires **replacing the scoring task with a new directional bipolar judgment prompt and its own
   eval set.** That is precisely validate's concession #4 and the one unproven AI risk all three
   circle. The contrarian's "few-dozen-lines pure function" is true for the *propagation*; it is false
   for the *edge labeling that feeds it*. The hard part is upstream of the graph math.

2. **`fragments.confidence` is declared but effectively unwritten.** The fragment insert path
   (`fragments.ts:297`) does not set it; the `confidence` hits elsewhere are on *edge attrs*
   (authorship bylines, `authorship.ts`) and *dedup input* (`dedup.ts`), not the
   `fragments.confidence` column. **[verified]** The contrarian's base-strength source for the QBAF
   fixed-point is a null column. Usable eventually, but it is *not* "already there" — it needs to be
   populated, which is more new pipeline work the contrarian's "zero new cost surface" framing hides.

**Where the contrarian is most right:** the open-questions list (cardinality, attach/detach rules,
POV-as-object, narration) *are* artifacts of storing a derived aggregate, and a derived projection
should be disposable, not authoritative. That reframe is correct and it is the spine of my verdict.

---

## 3. The resolved model: derived stance, anchored on the existing wiki

**Stored facade? No. Per-signal engine? No. Emergent/derived view? Yes — but "emergent fixed-point"
is oversold; "derived bipolar read on the existing cadence" is the honest version.**

The real seam between "facade as stored object" (counter/validate) and "facade as emergent view"
(contrarian) is this: **storage of *identity* vs storage of *conviction*.** A stance needs a stable,
addressable, narratable identity — a name, a URL, a thing the user points at and the Socrates layer
addresses. A stance does **not** need its conviction *stored as an authoritative aggregate*. Robin
already separates these two axes for wikis: a `wiki` row is a stable named anchor whose `content` is
*derived* from member-fragment edges and re-rendered on `dirty_since`. The contrarian is correct that
this is the same deal a stance wants. So:

- **Identity = the existing `belief`/`decision` wiki.** Stable id, name, URL, narratable. No new table.
- **Conviction = derived**, computed from a bipolar weighting of the wiki's member fragments,
  on the existing debounced cron, cached as *one scalar in `wikis.metadata` jsonb* (already exists,
  `schema.ts:366`) purely so liveness can diff successive passes. The cached scalar is a
  *disposable materialized value*, not an authoritative facade — rebuildable from edges at any time.
- **Liveness = the delta of that scalar across two cron passes**, surfaced as a staleness/"moved"
  signal. This is counter's staleness-flag and contrarian's propagation-delta converging on the same
  cheap mechanism.

**Addressing the contrarian's "it's just the belief wiki" claim directly: I half-accept it.** The
contrarian is *right* that the named-stance-backed-by-churning-fragments-re-rendered lifecycle already
exists as the belief/decision wiki, and that re-opening cardinality/attach/detach as "novel" is
re-litigating solved problems. I **refute** the stronger version ("there is no POV, build nothing new")
because the *bipolar polarity on the edges* and the *conviction read derived from it* genuinely do
not exist today — the existing wiki renders prose from membership; it has no notion of For vs Against,
no conviction scalar, no "this belief moved" delta. So the verdict is not "the belief wiki already
does this" (it doesn't) and not "build a new POV object" (don't) — it is **"teach the existing belief
wiki to carry a derived bipolar conviction."** That is a strictly smaller build than any of the three
proposed, and it is the only one that survives all the verified facts.

**Why not the full QBAF fixed-point the contrarian wants?** Because the fixed-point's inputs are not
ready: the bipolar edge labels require a new directional prompt + eval (overreach #1), and the base
strengths (`fragments.confidence`) are unwritten (overreach #2). A damped multi-hop propagation over a
graph whose edge polarities are produced by an unvalidated LLM judgment is *more* risk, not less — it
launders an unproven labeling step through impressive-looking math. **Start with a one-hop bipolar
aggregation over direct member fragments (a weighted For-minus-Against sum), not multi-hop propagation.**
Same conviction-read product surface, but the quality risk is isolated to one testable step (the edge
labeling) instead of compounded across propagation passes. Graduate to full QBAF propagation only if
the one-hop read proves valuable and the labeling proves reliable.

---

## 4. The four open threads — rulings

**1. Cardinality / coherence ("how many fragments, is the stance one coherent claim?")**
*Ruling: dissolve it for evidence, keep it for expression.* For *evidence*, there is no fixed working
set — conviction reads over **all** member fragments of the anchor wiki, weighted by For/Against; "3–9"
becomes top-k-by-weight *at display time* only (contrarian is right here). For *expression*, the stance
text is the wiki's existing rendered `content` under the `belief`/`decision` spec — coherence is the
wiki-type prompt's job, already solved. No new cardinality policy is authored. The counter's "3–9 is a
vibe, not a cap" objection is correct and is neutralized by never storing a fixed working set.

**2. Attach/detach rules**
*Ruling: no curation engine. Attachment = the fragment is a member of the anchor wiki AND carries a
bipolar edge to its claim; detachment = the source fragment was superseded (drops out of the next
pass) or its edge fell below threshold.* This reuses the existing `FRAGMENT_IN_WIKI` membership +
soft-delete (`edges.deletedAt`) verbatim. The **one genuinely new piece** is the directional polarity
label — and that is the single thing to de-risk (§5), not an open-ended judgment to hand-wave. Counter's
"unbounded judgment" fear is real *only if* you let attach run over the whole KB; gated to anchor-wiki
membership (already top-k bounded), it is bounded.

**3. POV-as-named-object**
*Ruling: NO new object. The anchor is the existing `belief`/`decision` wiki.* This is the contrarian's
sharpest correct point and I adopt it fully. A parallel `pov` table re-creates the wiki's entire
lifecycle (membership, dirty signal, regen, lineage) and violates the user's own one-source-of-truth
directive. The conviction scalar lives in `wikis.metadata`, not a new entity. Counter's Vector 5
(successor sprawl, five wikis chasing a lineage head) is *entirely avoided* because there is no separate
POV object to spin successors of — the wiki's existing supersede/edit machinery already handles text
change, and conviction is derived, so it never needs a successor at all.

**4. Cost / opt-in gating**
*Ruling: inherit the regen worker's gating; do NOT invent "citation-impact gating."* Conviction
recompute rides the same `dirty_since` + 5-min debounce + ≤50/tick + `autoregen` opt-in that already
gates wiki regen (`regen-worker.ts:24`, `:143`; `schema.ts:328`). Add `stage='conviction'` to
`usage_events` so spend is observable and cappable from day one via `app_settings.limit_usd_micros`
(`schema.ts:569,587`). Critically: a **one-hop weighted aggregation has near-zero LLM cost at read
time** — the only LLM cost is the bipolar edge *labeling*, which happens once per fragment-pair at
ingest (reusing the `frag-relate` slot that already runs), not per-signal-per-POV. This is where
counter's strongest argument lands and is honored: the cost stays O(ingest top-k), not O(live POVs).
The validate report's "citation-impact gating" and the thesis's version are, as both counter and
contrarian note, worse-specified reinventions of `autoregen`+`dirty_since`+debounce. Drop them.

---

## 5. Build order

Each step independently shippable, read-only-on-source recommendation (not applied work). The ordering
front-loads the one unproven risk and gates the rest behind it.

**Step 0 (DE-RISK FIRST — gate everything behind this): Bipolar edge-labeling spike.**
Replace/extend the symmetric `fragment-relevance` prompt with a *directional* For/Against/neutral
bipolar judgment, build a small hand-labeled eval set (counter is right that this is where quality
lives or dies; validate's concession #4 and contrarian's overreach #1 both point here). **Verify:**
on a held-out set of real fragment pairs, bipolar precision clears an agreed bar (e.g. ≥0.8 on the
For/Against direction, not just relevance). *If this fails, the whole feature is a no-build* — stop
here, ship nothing, because every downstream step consumes these labels. This is the load-bearing risk
all three reports independently flagged and the one fact that decides the feature.

**Step 1 (ships only if Step 0 passes): Bipolar edges at ingest.**
`frag-relate` writes `attrs: { polarity, weight }` alongside the existing `score` (additive, polarity
optional/defaults neutral so existing edges still parse). **Verify:** new edges carry polarity; old
edges unaffected; no migration (additive jsonb).

**Step 2: One-hop conviction read, derived, render-time.**
`GET /wikis/:id/conviction` aggregates the For/Against bipolar edges among the anchor wiki's member
fragments into a single signed scalar + per-fragment contributions. Base weight = edge `weight`;
treat null `fragments.confidence` as a constant prior for now (do *not* block on populating it).
**Verify:** a `belief` wiki returns a conviction derivable by hand from its edges; zero new tables.

**Step 3: Liveness = delta on the existing cron.**
On the regen worker's `dirty_since`/debounce pass, recompute the conviction scalar for affected
`belief`/`decision` wikis, store *only the latest value* in `wikis.metadata`, expose `now - last_pass`
as the staleness signal and the value-delta as the "moved" signal. **Verify:** a new bipolar edge on a
quiet belief wiki moves its conviction after the debounce window; a wiki with no new bipolar edges
shows zero delta (the conservativity property counter's staleness-flag and contrarian's QBAF both want).
Add `stage='conviction'` cost rows. **Verify:** spend appears in `usage_events`, capped by `app_settings`.

**Step 4 (optional, gated on Steps 2–3 proving value): Socrates narration.**
Read the conviction delta + the landed/superseded fragments behind it. **Verify:** every narrated
"your view moved" cites real fragment keys and real edge polarities.

**Explicit no-builds:** the per-signal synchronous re-weigh engine; a standalone `pov` table;
curated 3–9 working sets; successor-spin-on-churn; multi-hop QBAF propagation (deferred until one-hop
proves out); "citation-impact gating" as a new mechanism.

**Cost-control design (one line):** conviction is a cheap weighted sum over already-bounded member
edges, recomputed only on the existing debounced/capped/opt-in cron, with a new `stage='conviction'`
metered against the existing budget cap — so the spend is O(ingest), observable, and cappable from day one.

**On the immutability finding:** `PUT /fragments/:id` mutating in place (`fragments.ts:338`) is a real
gap against the LOCKED constraint, surfaced by validate and confirmed. It is *not* a blocker for this
feature (conviction derives from edges, which already soft-delete), but it should be filed as a
separate constraint-enforcement task — derived conviction over silently-mutable fragments would let a
stance's evidence change under it without a supersede event, which undermines the provenance the
narration layer needs. Tighten to append-only successor-spin *before* Step 4, independently of Steps 0–3.

---

## Verdict block
**VERDICT:** Teach the existing `belief`/`decision` wiki to carry a *derived* bipolar (For/Against)
conviction read on the regen worker's existing debounced cron — no new POV table, no per-signal engine,
one-hop aggregation before any multi-hop propagation.
**CONVICTION:** high — every contested code-fact resolves toward "reuse the wiki + cron substrate"
(`regen-worker.ts:24,143`, `schema.ts:328,366,495`, `wikis.ts:281` all verified), the only real risk
is one isolated, testable step (directional bipolar labeling), and the design keeps cost O(ingest)
which is the bar counter set and validate's gates meet.
**Where I overrode an agent:**
- *Counter:* kept its "no engine" but overrode its "build a stored facade" — its own Vectors 2/5 prove
  the stored object leaks; deriving instead dissolves them.
- *Validate:* kept its reuse map but overrode "~70% built" — the reusable 70% is generic plumbing; the
  load-bearing bipolar-labeling 30% does not exist, and `fragments.confidence` is an unwritten column.
- *Contrarian:* adopted its "derive, anchor on the existing wiki" model but overrode "zero migration /
  few-dozen lines" — the `frag-relate` prompt is explicitly *symmetric* (`fragment-relevance.yaml`,
  verified), so directional For/Against is a prompt+eval replacement, not a JSON tweak; and I downgraded
  full QBAF multi-hop propagation to one-hop until labeling proves out.
**The one thing to de-risk first:** the directional bipolar edge-labeling spike (Step 0) — can an LLM
judge For/Against/neutral over real fragment pairs at acceptable precision, replacing the symmetric
relevance scorer? If no, the feature is a no-build.
