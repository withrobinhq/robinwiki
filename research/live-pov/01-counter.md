# Live POVs — The Case Against (Sub-Agent A: Counter)

> **Stance:** Building "Live POVs" as described is the wrong investment for Robin right now. Not because the idea is dumb — because the specific mechanism (per-signal "does this change me?" re-evaluation over a churning 3–9-fragment working set) reintroduces the exact cost-and-coherence trap that this codebase already engineered *away* from, and that two generations of prior art abandoned for the same reason.
>
> I am not neutral. I argue the negative and defend it. Concessions are at the end.

---

## Framing: what "live" actually demands, and what the repo already decided

The thesis has two separable claims bundled into one:

1. **(Cheap, already true)** A claim/stance is backed by a *set* of fragments, and that set should change as evidence arrives. Robin already does this: `FRAGMENT_IN_WIKI` edges (soft-deletable — `edges.deletedAt`) are exactly "membership," and `wikis.dirtySince` already signals "the working set changed, re-render me."
2. **(Expensive, novel, contested)** Every incoming signal should *interrogate every live stance* — "does this change me?" — weighing For/Against and moving conviction. This is the part that is new, and this is the part the rest of this document attacks.

The critical grounding fact: **Robin's own pipeline already faced the per-signal re-evaluation question and chose the opposite answer.** The regen worker's own comment is the tell (`core/src/queue/regen-worker.ts:141–144`):

> "Reasons 1 and 2 are ingest-driven and **pay LLM cost for ground that shifts under them when fragments are still arriving** — gate via the per-wiki debounce."

And one line up (`:26`):

> "**Stale threshold removed** — wikis only regen when they have new fragments or are stuck."

The team already (a) removed time-based "re-check yourself" regeneration, (b) made auto-regen **opt-in** per wiki (`wikis.autoregen` default `false`, `schema.ts:328`), (c) **debounced** re-evaluation so "chatty" objects drop out of the batch (`regen-debounce.ts`, referenced `regen-worker.ts:234–247`), and (d) **capped** the batch at 50 wikis/tick (`BATCH_LIMIT = 50`, `regen-worker.ts:24`). Live POVs proposes to re-add continuous, per-signal, per-stance re-evaluation — the precise behavior this code deletes, debounces, and caps. **The burden of proof is on the thesis to explain why the bet that was already reversed should be re-placed.**

---

## The case

### Vector 1 — Per-signal re-evaluation is a multiplicative fan-out the pipeline is not shaped to absorb

**What a signal costs today (grounded).** Trace one entry through the real pipeline:

- **Extraction job** (`worker.ts:202`): 1 fragmentation call (Gemini 2.5 Pro, `$1.25/$10` per 1M — `usage-events.ts:55`) + 1 entity-extract call (Sonnet 4.6, `$3/$15` — `:43`) + per-fragment embedding.
- **Link job, per fragment** (`worker.ts:539`): **1 wiki-classify call** (Haiku 4.5, `$1/$5` — `:49`), batched over ≤10 candidate wikis in a *single* LLM call (`wiki-classify.ts:44,82`) — this is the design's one genuinely economical move — **plus up to 5 sequential frag-relate calls**, one LLM call *per candidate fragment* in a `for` loop (`frag-relate.ts:27–40`).

So today the marginal LLM cost of a fragment is **bounded and roughly constant**: ~1 classify + ≤5 relate calls. It does *not* scale with the size of the knowledge base, because classification is gated by a top-10 hybrid-search retrieval (`worker.ts:564`, `wiki-classify.ts:44`).

**What Live POVs adds.** "A live POV never stops asking 'does this change me?'" The honest reading of the thesis is: for each incoming fragment, every POV whose working set *could* be affected runs a For/Against re-weighing. That is a **second classification-shaped LLM pass, but stance-aware and reasoning-heavy** (For/Against is not a 0–1 relevance score; it is an argument). Two scaling problems:

1. **Fan-out is over POVs, not over a fixed top-10.** A fragment relevant to "remote work is net-positive" may bear on five wikis that render that POV. The thesis's own one-source-of-truth pitch ("a POV in five wikis evolves once") *reduces* duplicate evaluation — good — but the count of *distinct* live POVs a single fragment touches is unbounded and grows with the KB. The constant-cost property of today's pipeline is lost.
2. **The re-weigh is more expensive per call than classify.** Classification today is a Haiku call returning confidence scores. A For/Against conviction-motion judgment that must read the *current working set* (3–9 fragments) plus the new signal and produce a defensible stance delta is a Sonnet-class reasoning call — the `$3/$15` tier. Concretely: a 9-fragment working set + signal + stance ≈ 2–4k input tokens, ~500 output → on Sonnet 4.6 roughly **$0.012–$0.018 per POV per signal** (using the repo's own pricing table). At even 50 live POVs and 30 fragments/day that is **~$18–27/day in re-evaluation alone**, on top of ingest — for a single-user product (`schema.ts:32–55`, single-tenant). That is the same order as a paid SaaS seat, spent on *re-litigating beliefs nobody asked about today*.

**Does citation-impact gating save it?** The thesis proposes opt-in / "earned via citation-impact gating." This *moves* the cost; it doesn't *remove* the scaling shape. Gating means: before the expensive re-weigh, you must compute whether this signal plausibly impacts the POV. But that pre-filter is *itself* a relevance judgment over the working set — which is what `frag-relate` and `wiki-classify` already are. So gating collapses into "run a cheap classifier to decide whether to run the expensive one," and the cheap classifier is the existing `dirtySince` + edge-membership signal. **At which point you have re-derived the current debounced-regen architecture and added a Sonnet pass on top.** The gate doesn't justify the engine; it reveals the engine is redundant with what exists.

> **Robin-specific inference:** The cheapest correct version of "the POV's evidence changed" is *already implemented* as `dirtySince` stamping on edge insert (`worker.ts:184–197`) feeding debounced regen. Liveness-as-churn is a rename of an existing mechanism; liveness-as-per-signal-conviction-motion is a new, multiplicative cost.

---

### Vector 2 — "Facade over 3–9 fragments" is a leaky abstraction at exactly the seams that make it interesting

The model: a POV is one statement (a paragraph or two), tight on expression, loose on evidence, backed by ~3–9 fragments that push/pull. The leaks:

- **The statement-bound test has no owner.** "Tight on expression, one statement" implies a coherence invariant: the working set must remain *about* the statement. But fragments are immutable (locked) and the statement is authored separately. Nothing in the schema binds them. When churn pulls in a fragment that shifts what the POV is *actually about* (concept drift — a real, documented failure mode for evolving knowledge structures; see prior art below), either the statement silently goes stale (the POV now misrepresents its evidence) or you must **re-author the immutable-bounded statement**, which the thesis says spins a *successor with lineage*. So routine evidence churn triggers successor creation — see Vector 5.
- **3–9 is "feel, not a cap" — which means it's unspecifiable.** An attach/detach engine needs a decision rule. "More evidence is better, but the working set is ~3–9" is two rules in tension with no arbiter. What detaches the 10th fragment when a better one attaches? Lowest For/Against weight? Oldest? Least cited? Each choice is a *policy* that determines what the POV says, and none is given. The repo's analogous decision (which fragments a wiki renders) is settled by an explicit `THRESHOLD` (`wiki-classify.ts:4`, `frag-relate.ts:4`) — a number, tunable, auditable. The facade replaces a threshold with a vibe.
- **One statement over heterogeneous fragment kinds.** The relocation says only idea/decision fragments take a position. But a working set will mix idea/decision (stance-bearing) with fact/quote (evidence). The facade has to fuse "I believe X" fragments and "here is data" fragments into one coherent stance. That fusion is a generative act on every churn — i.e., it *is* regen. The facade is not a new primitive; it is wiki-regen scoped to one paragraph, with a conviction number bolted on.

> **Robin-specific inference:** `wikis` already carry `bouncerMode: 'auto' | 'review'` (`schema.ts:353`) and `structure`/`prompt` overrides. A "belief-type wiki that takes a position" is expressible today as a wiki *type* + a structured section, regenerated on `dirtySince`. The POV-as-first-class-object buys a conviction scalar and lineage — at the cost of a whole new object lifecycle.

---

### Vector 3 — Attach/detach "is the engine" hides an unbounded judgment problem

The thesis leans the entire liveness story on: "membership churn IS the motion. A live POV pulls in fragments that now bear on it and detaches stale ones." This sounds mechanical. It is not. It is two open-ended LLM judgments wearing a trench coat:

1. **Attach** = "does this new fragment *bear on* this stance?" — a relevance + contradiction judgment. Robin already does the relevance half (`wiki-classify`, `frag-relate`) and explicitly **discards low-confidence and hallucinated results** (`wiki-classify.ts:13–25` drops spans that don't round-trip; threshold filter at `:85`). The *contradiction* half — "this fragment argues *against* the stance" — is new and strictly harder; relevance is symmetric similarity (vectors are good at it), contradiction is directional entailment (vectors are bad at it, LLMs are inconsistent at it — see the truthfulness/coherence literature below).
2. **Detach** = "is this member now stale / superseded / no longer load-bearing?" There is no signal for this short of re-reading the whole working set against the world on every tick. "Detach ≠ delete" is correct and cheap to *represent* (`edges.deletedAt` already exists), but *deciding* to detach is the expensive part and the thesis hand-waves it.

The specification gap is fatal for a build decision: **you cannot cost or test an engine whose core operation is "an LLM decides relevance-and-contradiction over an unbounded candidate set with no threshold."** Every contradiction-maintenance system in history that tried to keep this consistent automatically hit combinatorial blow-up (next section).

---

### Vector 4 — Complexity vs. value: a staleness flag gets ~90% of the benefit for ~10% of the cost

Ask what the *user* observes from a Live POV that a cheaper mechanism cannot give:

| User-visible benefit | Live POV (per-signal conviction motion) | Cheap alternative |
|---|---|---|
| "My evidence set is current" | churn engine | **Already shipped:** `dirtySince` + debounced regen re-renders on new edges |
| "This belief might be out of date" | conviction weakens automatically | **Staleness flag:** `dirtySince` age → a "review?" chip (UI already has chip/tooltip surfaces, `schema.ts:336–341`) |
| "New evidence contradicts this" | For/Against re-weigh per signal | **Periodic re-rank:** one batched pass at regen time, not per-signal |
| "Walk me through what changed" | a "Socrates" narration surface | **Diff/edit log:** `edits` table already records before/after (`schema.ts:444–465`) |

The expensive 10% the Live POV adds over the cheap version is: a *continuously maintained conviction scalar that moves on every signal*. That scalar is the single thing a staleness flag + periodic re-rank can't replicate. The question for a build decision is whether a moving conviction number — for a single user, on beliefs they may never revisit — is worth re-introducing the multiplicative fan-out and the unbounded-judgment engine. **For a product still wiring its frontend to the API (CLAUDE.md: "Currently a UI prototype with hardcoded data"), the answer is no, not now.** You are buying a Ferrari engine for a car with no wheels yet.

---

### Vector 5 — Immutability + "successor with lineage on every genuine change" → lineage sprawl

Immutability is locked and correct. But the thesis pairs it with: *genuine content change spins a successor with lineage.* Combine with Vector 2 (routine churn shifts what a POV is about → re-authoring the bounded statement → genuine change → successor). The result: a high-churn POV generates a *chain* of successor POVs, each with lineage edges back. Robin has no successor/lineage table today — `edges` would carry it (`schema.ts:487`), but:

- A POV cited in five wikis (the one-source pitch) that spins a successor must **re-point five wikis' renders** at the successor, or fork. Either the wikis chase the lineage head (added read-time complexity on every wiki render) or they pin and drift. Both are bad.
- Lineage becomes unnavigable precisely for the *most active* beliefs — the ones a "second brain" most wants to surface. The thesis's flagged-open "who narrates change (Socrates)" is not a nice-to-have; it is **mandatory mitigation** for sprawl the design itself generates. Needing a narration layer to make your data model legible is a smell.

> This is the immutability tension turned against itself: immutability is free for *facts* (write once, never touch). It is expensive for *stances*, because stances are supposed to move — and the only way to move an immutable thing is to replace it, which under churn means replacing it constantly.

---

## Prior-art autopsy: automatic belief-liveness has been tried and abandoned, repeatedly

**1. Truth Maintenance Systems (TMS / ATMS), 1979–~2000s — abandoned for inherent exponential cost.** TMS is *precisely* Live POVs' ambition: track the justifications behind each belief and automatically revise when new information contradicts. The post-mortem is brutal and explicit: propositional TMS belief-revision tasks are **Σ₂ᵖ-complete** — among the hardest problems in AI — and "no clever dependency-directed backtracking can eliminate this explosion, making such systems practically useless" at scale.
- *Why it matters here:* Robin's attach/detach-with-contradiction engine is a TMS with an LLM as the inference engine. Swapping a logic engine for an LLM does not remove the combinatorial structure of "keep a web of mutually-supporting/contradicting beliefs consistent"; it makes each consistency check *non-deterministic and metered per token* on top of combinatorial.
- Sources: [What Happened to Truth Maintenance Systems? (KIE)](https://blog.kie.org/2011/06/what-happened-to-truth-maintenance-systems.html), [Propositional TMS: Classification and complexity (Springer)](https://link.springer.com/article/10.1007/BF01530952), [Reason maintenance (Wikipedia)](https://en.wikipedia.org/wiki/Reason_maintenance).

**2. NEPOMUK Semantic Desktop (2006–2014) — killed for maintenance burden and "store everything twice," replaced by the *simpler* Baloo.** NEPOMUK's vision was a self-maintaining semantic layer over your knowledge. In practice it "required storing everything twice," ran through a slow triple-store, "never delivered the performance and user experience anticipated," and KDE replaced it with **Baloo — a plain, fast file indexer** that dropped the semantic-maintenance ambition entirely.
- *Why it matters here:* Live POVs is "store everything twice" by construction — the immutable fragments *plus* the maintained conviction/working-set state that must be kept consistent with them. The industry's revealed preference, after a decade and EU funding, was to delete the maintenance layer and keep the index. Robin already *is* the index (pgvector + tsvector hybrid search). The lesson is to stay Baloo, not become NEPOMUK.
- Sources: [NEPOMUK (Wikipedia)](https://en.wikipedia.org/wiki/NEPOMUK_(software)), [KDE semantic desktop: Nepomuk vs Baloo](https://www.xmodulo.com/kde-semantic-desktop-nepomuk-baloo.html).

**3. "Managed Forgetting" research line — even the academics who want evidence-driven knowledge bases concluded the right primitive is *forgetting/demotion on a schedule*, not continuous re-evaluation.** The arXiv "Managed Forgetting to Support Information Management" work frames the live problem as *deliberate, policy-driven* demotion of stale items — i.e., a staleness/forgetting policy (Vector 4's cheap alternative), not per-signal conviction motion.
- Source: [Managed Forgetting (arXiv 1811.12155)](https://arxiv.org/pdf/1811.12155).

**4. LLM-as-judge confidence/coherence literature — the modern attempt — reports the core operation is unreliable and drift-prone.** Recent work on assigning confidence to knowledge-graph triples uses a separate JudgeLLM and explicitly flags that *diachronic coherence* (beliefs holding consistent relationships over time) is hard to maintain and that concept drift "is often more challenging to detect directly in LLMs." This is the contradiction-judgment in Vector 3, confirmed unreliable by the people building it.
- Sources: [TRAIL: Joint Inference and Refinement of KGs with LLMs (arXiv 2508.04474)](https://arxiv.org/pdf/2508.04474), [Standards for Belief Representations in LLMs (arXiv 2405.21030)](https://arxiv.org/pdf/2405.21030).

**Pattern across all four:** the *representation* of evolving belief is easy and keeps getting re-invented; the *automatic maintenance* of consistency is what kills the project — on cost (TMS), on performance/burden (NEPOMUK), or on reliability (LLM-judge). Live POVs is on the maintenance side of that line.

---

## Honest concessions — where the thesis is right

1. **The relocation is genuinely sharper.** "Liveness is a property of a stance, not a fragment" is correct and clarifying. Fragments-as-immutable-evidence + stance-as-the-thing-that-moves is the right decomposition. I'm attacking the *engine*, not this framing.
2. **One-source-of-truth at the facade is right and the repo lacks it.** Today a fragment filed into five wikis is re-classified and each wiki regens independently (`worker.ts:686` enqueues regen per edge). A POV evolving once and rendered five times is a real de-duplication win. If POVs ship, this is the reason.
3. **Detach ≠ delete is already how the schema thinks** (`edges.deletedAt`, soft-delete everywhere). The *representation* of churn is nearly free. My objection is to the *decision engine*, not the storage model.
4. **"Loose on evidence, tight on expression" is a good product instinct.** It's the right shape for a belief surface. It just doesn't require per-signal conviction motion to deliver — a periodically re-ranked working set with a single authored statement gets you there.

The strongest *pro* case is therefore narrow: ship the POV **as a render-time facade with one-source-of-truth de-dup and a staleness flag**, and explicitly *do not* build the per-signal conviction engine. That is a real, cheap, defensible feature. "Live" in the maximalist sense is the part to cut.

---

## Verdict block
**VERDICT:** Build the POV facade (one statement, one-source-of-truth, render-time, staleness-flagged) but do **not** build the per-signal "does this change me?" conviction engine — it re-adds the multiplicative, unbounded-judgment maintenance cost this codebase already deleted and that TMS/NEPOMUK abandoned.
**CONVICTION:** high — the cost shape is grounded in Robin's own pricing table and pipeline, the architecture-reversal is documented in the repo's own comments (`regen-worker.ts:26,141`), and three independent prior-art lines died on the identical maintenance problem.
**Strongest evidence:**
- Robin already removed time-based re-evaluation, made regen opt-in, debounced it, and capped it at 50/tick — the thesis proposes re-adding exactly that (`core/src/queue/regen-worker.ts:24,26,141–144`; `schema.ts:328`).
- Per-signal For/Against on a 9-fragment set is a Sonnet-tier reasoning call (~$0.012–0.018 each at the repo's `$3/$15` pricing, `usage-events.ts:43`); fan-out is over live POVs, losing today's constant-cost-per-fragment property.
- TMS belief-revision is Σ₂ᵖ-complete and was abandoned as "practically useless" ([KIE](https://blog.kie.org/2011/06/what-happened-to-truth-maintenance-systems.html), [Springer](https://link.springer.com/article/10.1007/BF01530952)); NEPOMUK's self-maintaining semantic layer was killed for "store everything twice" and replaced by the simpler Baloo index ([Wikipedia](https://en.wikipedia.org/wiki/NEPOMUK_(software))).
- Citation-impact gating collapses into "run a cheap relevance check to decide whether to run the expensive one" — which is the existing `dirtySince` + edge mechanism, proving the engine redundant.
**What would change my mind:**
- A concrete, *bounded* attach/detach spec with a numeric threshold (like the existing `WIKI_CLASSIFY_THRESHOLD`) and a proof the per-signal fan-out is O(retrieval top-k), not O(live POVs) — i.e., re-evaluation is gated by the same top-10 retrieval that bounds classification today.
- A measured cost ceiling: instrument a shadow run on real ingest volume using `usage_events` and show re-evaluation stays under (say) ingest cost itself, not 1–3× it.
- Evidence that the *moving conviction scalar* (not the working set, which a staleness flag covers) drives a user behavior that a periodic re-rank demonstrably does not.
