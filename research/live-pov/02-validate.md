# 02 — Validate: The case FOR building Live POVs

**Agent role:** Sub-agent B ("Validate"). I am not neutral. My job is to build the strongest defensible
case that Live POVs is the right path for Robin, grounded in formal theory, prior art that shipped, and
Robin's actual codebase — not vibes.

**Citations convention.** `[research]` = external claim with URL. `[robin]` = inference from reading this
repo (file:line where load-bearing). I keep them separate on purpose.

---

## 1. Framing

The thesis says four things that, taken together, are not a novelty — they are a re-derivation of a 40-year-old
sound pattern, dressed for a second-brain product:

1. **Beliefs are revisable, and revision is minimal** (you change as little as possible when new evidence lands).
2. **Evidence is bipolar** (For/Against — support and attack are independent relations, not one signed scalar).
3. **A claim's truth is a function of its current justifications**, recomputed when the justification set churns.
4. **The unit that "is alive" is a stance/claim, not a raw datum.** Data is immutable; the stance over it moves.

Every one of those four maps cleanly onto an established formal system (§2). The product insight — that the
*facade* (one stance, churning working-set of fragments) is the right object to hang liveness on — is the genuinely
new contribution, and §4 argues it is the *correct* engineering choice, not just a defensible one.

And critically (§6): Robin's codebase already implements ~70% of the machinery this requires, for a different
purpose (wiki regen). Live POVs is not a green-field build. It is a **re-aiming of an engine that already exists,
already batches, already debounces, already tracks cost per stage, and already does attach/detach-not-delete.**

---

## 2. Formal grounding — the thesis is a known-sound pattern

### 2.1 AGM belief revision → "superseded-not-deleted" and "minimal motion"

The AGM paradigm (Alchourrón, Gärdenfors, Makinson, 1985) defines the rational operations on a belief set:
*expansion* (add without consistency check), *revision* (add while restoring consistency), and *contraction*
(remove a belief). Its defining objective is to make belief change **minimal** — "simultaneously minimizing the
set of new beliefs that have to be adopted, and the set of old beliefs that have to be discarded or reformulated"
[research].

This is *exactly* the thesis's "conviction moves (strengthen/weaken/step aside); text immutable; genuine content
change spins a successor with lineage." A new signal triggers a **revision**, not a wholesale rewrite. The
LOCKED decision "superseded-not-deleted" is AGM **contraction done honestly**: AGM removes a belief from the
deductive closure but the product keeps the superseded fragment row for lineage/audit. Robin's instinct to never
hard-delete is the operationally-correct version of AGM contraction — you retract the *stance's reliance* on a
fragment without destroying the evidence.

- Primary: *Belief Revision I: The AGM Theory*, Franz Huber — https://philsci-archive.pitt.edu/10838/1/Belief_Revision_I.pdf [research]
- Overview: https://en.wikipedia.org/wiki/Belief_revision [research]

**Why this helps the case:** the single most-questioned design choice ("why keep dead fragments?") is not a
Robin quirk. It is the operational form of a theorem-backed rationality postulate. Minimal-change revision is
*why* a Live POV should do small conviction nudges most of the time and only occasionally spin a successor — and
superforecasting data (§3.2) shows this is also what empirically-best human updaters do.

### 2.2 Truth-Maintenance Systems → the POV facade *is* a JTMS node; many POVs over shared fragments *is* an ATMS

This is the strongest single mapping, and it is almost uncanny.

- **JTMS (Doyle, 1979):** maintains a *justification* per belief — "a reason or explanation for why a particular
  belief is held" — and recomputes a belief's IN/OUT status when its justifications change [research]. A **Live
  POV is a JTMS node.** Its working-set of ~3–9 fragments *is* its justification set. "Liveness = working-set
  churn" is *literally* the JTMS belief-status recomputation triggered by justification change. Robin even has the
  trigger column already: `wikis.dirty_since` is stamped on edge attach/detach and cleared on recompute
  [robin: core/src/db/schema.ts:335, core/src/routes/wikis.ts:~975].

- **ATMS (de Kleer, 1986):** the key generalization is *multiple simultaneous contexts of belief* over a shared
  set of assumptions, with labels tracking which environments support which nodes [research]. This is the thesis's
  **"a POV in five wikis evolves once at the facade; a wiki renders POVs, never owns conviction."** The fragments
  are the shared assumption base; each wiki is a *context* that the same POVs project into. One-source-of-truth
  across wikis is not a nice-to-have the product bolted on — it is the defining architectural property of an ATMS,
  and ATMS exists *precisely because* maintaining one consistent context (JTMS-style) across many viewpoints
  doesn't scale. The thesis independently rediscovered the JTMS→ATMS evolution.

- Primary overview: *Belief Revision and Truth Maintenance Systems: An Overview and a Proposal*, Shapiro et al. —
  https://cse.buffalo.edu/~shapiro/Papers/br-overview.pdf [research]
- Tutorial: *Using Truth Maintenance Systems: A Tutorial*, IEEE Expert — https://dl.acm.org/doi/10.1109/64.363270 [research]

**Why this helps the case:** TMS is not theory-only — it shipped inside production expert systems and constraint
solvers for decades. The pattern "store justifications, recompute status on justification churn, keep retracted
items for context" is battle-tested infrastructure. Robin would be implementing a *narrow, single-context-per-POV*
TMS, which is the easy end of the design space.

### 2.3 Bipolar argumentation (Dung + support/attack) → "For/Against propositions"

Dung's abstract argumentation framework is the canonical formalism for "which conclusions survive a web of
attacks." A **Bipolar Argumentation Framework (BAF)** extends it with an explicit *support* relation alongside
*attack* — formally a triple ⟨arguments, attack, support⟩ [research]. The motivation in the literature is the
exact one the thesis asserts: "arguments in favour of a conclusion can be considered as positive while arguments
against the conclusion as negative ones," and a standalone support relation is needed because chained attacks
(Dung's only notion of defense) are *insufficient* to express real reasoning [research].

The thesis's LOCKED "For/Against propositions" is a BAF. The working-set fragments that "push/pull" are the
support and attack arcs into the POV's central claim.

- *On the Acceptability of Arguments in Bipolar Argumentation Frameworks* (Cayrol & Lagasquie-Schiex) — https://www.researchgate.net/publication/220907701 [research]
- Applied to live online debate: Cabrio & Villata, *A natural language bipolar argumentation approach to support
  users in online debate interactions* — https://journals.sagepub.com/doi/10.1080/19462166.2013.862303 [research]

### 2.4 Defeasible reasoning (Pollock) → conviction "weaken / step aside" has a precise vocabulary

Pollock's two defeater types are the missing precision the thesis's "Against" needs:
- **Rebutting defeater:** a prima facie reason for the *opposite* conclusion.
- **Undercutting defeater:** a reason to doubt that the support *still supports*, without arguing the opposite [research].

This distinction is product-critical and the thesis under-specifies it. "Step aside" (the POV withdraws, doesn't
flip) is an **undercut**: the evidence base eroded, so the warrant is gone, but nothing argues the negation.
"Weaken/strengthen" toward the opposite is a **rebut**. Pollock's "a conclusion is warranted iff supported by an
ultimately undefeated argument" gives Robin a crisp, implementable definition of when a POV is *live-and-held* vs.
*live-but-stepped-aside* — instead of a hand-wavy conviction float.

- *Defeasible Reasoning*, Stanford Encyclopedia of Philosophy — https://plato.stanford.edu/entries/reasoning-defeasible/ [research]
- Prakken & Horty, *An appreciation of John Pollock's work on the computational study of argument* — https://content.iospress.com/articles/argument-and-computation/663409 [research]

### 2.5 Bayesian / superforecasting → the *cadence* of conviction motion

How much should a POV move per signal? The Good Judgment Project answers empirically: the best forecasters
"do many small updates, with occasional big updates, just as Bayesianism would predict," and treat "beliefs not
as sacrosanct truths, but as hypotheses to be tested" [research]. The single strongest predictor of becoming a
superforecaster was "perpetual beta… the degree to which one is committed to belief updating," ~3× more powerful
than intelligence [research].

This is direct evidence that the thesis's core loop — a POV that "keeps asking does this change me," nudging
conviction in small increments and rarely spinning a successor — is *the* behavior that correlates with being
right over time. It also bounds the design: most signals should produce a *tiny* conviction delta (cheap to
compute, see §5), and the expensive "spin a successor with lineage" path is rare by construction.

- *Superforecasters' Toolbox: Beliefs as Hypotheses* — https://goodjudgment.com/superforecasters-toolbox-beliefs/ [research]
- *Evidence on good forecasting practices from the Good Judgment Project* — https://aiimpacts.org/evidence-on-good-forecasting-practices-from-the-good-judgment-project/ [research]

**Net of §2:** the thesis is the intersection of AGM (minimal revision, retract-don't-destroy), TMS (justification
churn recompute; multi-context = facade-across-wikis), BAF (For/Against), Pollock (weaken=rebut vs. step-aside=undercut),
and GJP (small-updates cadence). Four of those five are LOCKED decisions already. **The thesis is not speculative;
it is a synthesis of sound, separately-validated components.**

---

## 3. Prior art that *worked* (not just theory)

### 3.1 Argument mapping delivered measurable value

Computer-aided argument mapping is the closest shipped analog to "render a claim with its For/Against structure,"
and the effect sizes are large and replicated. A meta-analysis found high-intensity argument-mapping courses
improve critical-thinking scores by ~0.8 SD — "more than twice the typical effect size for standard critical
thinking courses"; a 2026 meta-analysis of argument-visualization tools reports a bias-adjusted g = 0.87 [research].
The mechanism that produces the gain is *exactly* what a POV surface does: it forces the implicit web of support
and rebuttal into explicit, inspectable structure.

- *Using Argument Mapping to Improve Critical Thinking Skills* (van Gelder) — https://thinkeranalytix.org/wp-content/uploads/2018/09/TvG-Using-argument-mapping-to-improve-critical-thinking-skills-2015.pdf [research]
- *Meta-Analysis of Argument Visualization Tools in Higher Education* (2026), Springer — https://link.springer.com/article/10.1007/s10758-026-09981-8 [research]

### 3.2 Calibrated, self-updating belief systems beat static expertise

GJP superforecasters were "30% better than intelligence officers with access to actual classified information,
and 60% better than the average" [research]. The differentiator was *process* — continual evidence-driven
updating — not access to more data. This is the product thesis in one sentence: **the value isn't in capturing
more; it's in a structure that keeps re-weighing what's captured.** A pile of static notes is the "intelligence
officer with classified access"; a Live POV is the superforecaster's process applied to your own second brain.

- *Superforecasters: A Decade of Stochastic Dominance* — https://goodjudgment.com/wp-content/uploads/2021/10/Superforecasters-A-Decade-of-Stochastic-Dominance.pdf [research]

### 3.3 RAG-freshness work proves the *problem* is real *and* the *mitigation* is known

The RAG community has converged on "knowledge decay" as a first-class production problem: "if the knowledge base
is not updated, the RAG system can become stale," embedding models "show limited ability in distinguishing
temporal validity," and naive systems "surface stale context or fail to distinguish novel updates from redundant
information" [research]. Crucially, the *mitigation* the field landed on is the same shape as the thesis's
liveness engine: "a reranking step between the retriever and the LLM — one that hard-removes expired facts, boosts
active time-bounded signals, and uses exponential decay to prefer newer documents," plus "automated refresh
pipelines" and "metadata-driven freshness signals" [research].

That matters two ways. (a) It independently confirms KB-rot is the real enemy (§5/§4). (b) It validates the
*cost-control architecture*: the production answer is **not** "re-embed everything synchronously on every change"
— it's pre-filter + decay + batched refresh. Robin already has exactly this skeleton (§6).

- *The Knowledge Decay Problem: How to Build RAG Systems That Stay Fresh at Scale* — https://ragaboutit.com/the-knowledge-decay-problem-how-to-build-rag-systems-that-stay-fresh-at-scale/ [research]
- *HoH: A Dynamic Benchmark for Evaluating the Impact of Outdated Information on RAG* — https://arxiv.org/pdf/2503.04800 [research]
- *Solving Freshness in RAG: A Simple Recency Prior and the Limits* — https://arxiv.org/pdf/2509.19376 [research]

### 3.4 KB-rot is the actual killer of second-brain tools — and it's a maintenance problem, not a capture problem

The PKM literature is blunt: systems "fall apart under their own weight"; "if your system requires a dedicated
maintenance session just to keep it functional, it is overengineered"; intermittent maintenance "leads to
fragmentation, resulting in an incomplete system that reduces its value" [research]. The arXiv field study of
industry researchers using Obsidian reinforces that the *upkeep*, not the capture, is where second brains die.

This is the commercial thesis. Every second-brain tool competes on *capture* and loses on *maintenance*. Live
POVs reframes the product around the thing that actually kills retention: **the system maintains its own
convictions, so the user doesn't run "maintenance sessions."** Liveness is not a feature; it is the antidote to
the documented cause of abandonment.

- *How People Manage Knowledge in their "Second Brains" — A Case Study with Industry Researchers Using Obsidian* — https://arxiv.org/pdf/2509.20187 [research]
- *One Too Many: When Chasing the 'Perfect' Second Brain Tool Goes Wrong* — https://medium.com/@theo-james/one-too-many-when-chasing-the-perfect-second-brain-tool-goes-wrong-e1ff65c51af7 [research]

---

## 4. Why the facade model is *sound* (not just convenient)

The thesis's central engineering bet is: **liveness is a property of a facade wrapping ONE stance, backed by a
churning working-set of fragments — loose on evidence, tight on expression.** Three arguments that this is the
*correct* abstraction:

**(a) It separates the two things that change at different rates and for different reasons.** Evidence (fragments)
is append-mostly, immutable, high-volume, cheap. Expression (the stance text, ≤2 paragraphs) is low-volume,
expensive (LLM), and the thing the user reads. Coupling them — the way a plain wiki does, where the document *is*
both the evidence ledger and the prose — forces a rewrite every time a datum lands. That is precisely the QA
incident the repo already documents: 89 entries → 534 fragments → **27 back-to-back regens**, "most runs
superseded by the next batch before the output mattered" [robin: core/src/queue/regen-debounce.ts:5-16]. The
facade is the fix: fragment churn updates *membership and conviction* (cheap, structured), and only crosses into
*re-expression* (expensive, LLM) on a debounced/triggered cadence. **The facade is the join point where you put
the cost throttle.**

**(b) One-source-of-truth across wikis is the ATMS property, and it's load-bearing.** The thesis's "a POV in five
wikis evolves once at the facade" is the single most important correctness property. Without it, the same belief
drifts into five inconsistent versions — which is the *fragmentation* the PKM research names as the abandonment
cause (§3.4). The facade makes inconsistency structurally impossible: the wikis hold *references/projections*, not
copies. This is the same reason ATMS beat per-context JTMS (§2.2). Robin's `edges` table already models
membership as references (`FRAGMENT_IN_WIKI` is an edge, not a copy) [robin: core/src/db/schema.ts:487-505], and
the global instruction "One Source of Truth: never fix a display problem by duplicating data" is satisfied *by
construction* under the facade.

**(c) Lineage trustworthiness.** "Text immutable; genuine change spins a successor with lineage" plus
"detach ≠ delete" gives every conviction an auditable provenance: *which* fragments were For/Against *when* the
stance was last re-expressed, and *why* it superseded its predecessor. That is the JTMS justification record (§2.2)
and the AGM contraction-with-retention (§2.1) combined. For a second brain whose whole pitch is "trust the
structure you didn't build by hand," provenance is the trust substrate. Robin already has the substrate: `edits`
carries `contentBefore`/`contentAfter` [robin: core/src/db/schema.ts:444-465], `edges` soft-delete is the
detach-not-delete primitive, and `audit_log` records every attach/unattach [robin: core/src/routes/wikis.ts:~985].

---

## 5. A bounded, buildable design that defuses the cost objection

The cost objection is the only serious one: "a Live POV that re-evaluates on every signal is an unbounded LLM
bill." Here is a concrete design that bounds it, and it leans almost entirely on machinery Robin **already ships**.

### 5.1 Five gates before any LLM token is spent

A signal arrives → before it can move a POV's conviction, it passes cheap pre-filters, in order, cheapest first:

1. **Vector pre-filter (no LLM).** Only POVs whose centroid is within cosine threshold of the new fragment are
   candidates. Robin already does top-k vector candidate selection before LLM scoring in both `wikiClassify`
   (top-10) and `fragRelate` (top-5) [robin: packages/agent/src/stages/wiki-classify.ts:44,
   packages/agent/src/stages/frag-relate.ts:23]. The Live-POV engine reuses this verbatim.
2. **Citation-impact gating (the thesis's own idea, sharpened).** Only POVs that are *earned-live* participate.
   A POV becomes live by accumulating citation impact — i.e., its stance is actually surfaced/cited in rendered
   wikis. Dormant claims never enter the loop. This is opt-in/earned exactly as the thesis proposes, and it caps
   the live set to a small, high-value subset regardless of total KB size.
3. **Debounce / quiet-window (no LLM).** During active capture bursts, defer re-evaluation until the POV has been
   quiet for N minutes. Robin already implements this for wikis: `filterDebouncedWikiKeys` against `dirty_since`,
   default 5-minute window, env-tunable, hard-ceilinged [robin: core/src/queue/regen-debounce.ts:45-111]. This is
   the exact fix for the "27 back-to-back regens" incident, and it transfers to POVs unchanged.
4. **Conviction-delta pre-estimate (cheap or no LLM).** Most signals should move conviction negligibly (§2.5,
   GJP "many small updates"). A cheap scorer (reuse the existing `fragment-relevance` prompt's score, or an even
   cheaper embedding-similarity proxy) decides whether the delta is large enough to be worth a re-expression. Sub-
   threshold ⇒ update the *structured* working-set/conviction state only (DB write, no generation). Re-expression
   (the ≤2-paragraph LLM rewrite) fires only on threshold-crossing motion.
5. **Batched, triggered re-expression — never per-signal-synchronous.** When a POV does cross threshold, enqueue
   it; a batch worker drains up to `BATCH_LIMIT` per tick. Robin's regen batch worker is this exact pattern:
   `BATCH_LIMIT = 50`, fires on a cadence, separates *ingest-driven debounced* triggers from *recovery/explicit*
   bypass triggers, caps per-tick cost, emits per-item audit on failure [robin: core/src/queue/regen-worker.ts:24,137-302].

The decisive point: **gates 1, 3, and 5 already exist in production code for wiki regen.** Gates 2 and 4 are the
new logic, and both are *cheaper* than what already runs (gate 2 is a counter/threshold; gate 4 reuses an existing
prompt or an embedding compare). The Live-POV engine is a re-parameterization of the regen pipeline with two added
pre-filters — not a new subsystem.

### 5.2 Where it plugs in (Robin-specific)

- **State store:** a POV is a row analogous to a `wiki`, with `dirty_since` (churn signal), `state`
  (PENDING/LINKING/RESOLVED already models "needs recompute / recomputing / settled")
  [robin: core/src/db/schema.ts:208,335], plus conviction columns (a signed scalar + a `held|stepped_aside`
  status from §2.4). Working-set membership is `edges` rows (`FRAGMENT_SUPPORTS_POV` / `FRAGMENT_ATTACKS_POV` —
  the bipolar pair from §2.3), attached/soft-deleted exactly like `FRAGMENT_IN_WIKI` today.
- **Trigger:** the same edge-insert hook that stamps `wikis.dirty_since` stamps the POV's `dirty_since`.
- **Worker:** a sibling of `processRegenBatchJob`, sharing `enqueueWikiRegen`'s debounce/producer plumbing.
- **Cost accounting:** `usage_events` already keys every LLM call by stage and `cost_usd_micros`, and
  `app_settings` already stores budget caps (`limit_usd_micros`) [robin: core/src/db/schema.ts:554-593]. Add a
  `stage='pov_reeval'` and the spend is observable and *cappable from day one* — the cost objection becomes a
  dashboard line and a budget knob, not an open-ended risk.
- **Lineage:** successor-spin writes an `edits` row (`contentBefore`/`contentAfter`) and a `POV_SUPERSEDES_POV`
  edge; the predecessor is retained (AGM-honest contraction).

### 5.3 The cost math, bounded

Live set is capped by citation-impact gating (gate 2) to the user's actually-cited stances — call it tens, not
thousands. Re-expression fires only on threshold-crossing motion (gate 4), debounced (gate 3), batched at ≤50/tick
(gate 5). A re-expression is one ≤2-paragraph generation — *smaller* than today's full-wiki regen (70–180s of LLM
work per the QA note). So per-POV liveness is **strictly cheaper than the wiki regen Robin already pays for**, and
the count of live POVs is bounded by design. Worst case is throttled by the existing `app_settings` budget cap.
**There is no unbounded-cost path that the existing throttles don't already close.**

---

## 6. Why Robin *specifically* makes this feasible (the un-fair-advantage)

Most teams proposing "self-updating beliefs" would start from zero. Robin starts from ~70% built, because the wiki
regen subsystem is a liveness engine wearing a different hat:

| Live-POV need | Already in Robin | Evidence |
|---|---|---|
| Churn signal on the live object | `wikis.dirty_since`, stamped on attach/detach, cleared on recompute | schema.ts:335; wikis.ts:~975 |
| Attach / detach-not-delete | `FRAGMENT_IN_WIKI` edge insert + soft-delete; "fragment lives on as an unattached atom" | wikis.ts:~922-965 |
| Bipolar membership model | typed `edges` (`edge_type` + `attrs` jsonb) — add SUPPORTS/ATTACKS types | schema.ts:487-505 |
| Vector pre-filter before LLM | top-k candidate select in classify (10) and frag-relate (5) | wiki-classify.ts:44; frag-relate.ts:23 |
| Debounce / quiet-window | `filterDebouncedWikiKeys`, 5-min default, env-tunable, ceilinged | regen-debounce.ts:45-111 |
| Batched, capped re-eval | `processRegenBatchJob`, BATCH_LIMIT=50, trigger taxonomy, per-item audit | regen-worker.ts:24,137-302 |
| Per-stage cost tracking | `usage_events.cost_usd_micros` keyed by `stage`/`job_id` | schema.ts:554-581 |
| Budget caps | `app_settings` `{limit_usd_micros}` | schema.ts:589-593 |
| Lineage / provenance | `edits.contentBefore/After`; `audit_log` per state change | schema.ts:444-465 |
| State machine for recompute | `object_state` PENDING/LINKING/RESOLVED + CasLock | schema.ts:208; locks.ts |

The thesis's "liveness = working-set churn, debounced, batched, citation-gated, cost-capped" is a near-isomorphic
re-aiming of this table. **That is the single strongest pro-build argument: the expensive, risky infrastructure is
already written, tested, and in production for regen. Live POVs reuses it.**

---

## 7. Honest concessions (where it's genuinely risky)

I'm defending the build, not pretending it's free.

1. **Fragment immutability is asserted, not enforced.** The repo currently lets you `PUT /fragments/:id` and mutate
   `content` in place, writing a before/after audit row [robin: core/src/routes/fragments.ts:329-376]. The LOCKED
   "immutable, superseded-not-deleted" decision is *aspirational* in code today. Live POVs would need to *tighten*
   this into true append-only successor-spin. That's a real migration and a behavior change — defensible, but not
   already done.
2. **Conviction is a hard product surface, not just a number.** Showing a user "this belief weakened" without it
   feeling like the app is gaslighting them is a UX problem the formalisms don't solve. The "Socrates"/narration
   surface is genuinely unsolved and could sink adoption even if the engine is perfect.
3. **Cardinality/coherence of a stance is under-specified.** "One stance per POV, ≤2 paragraphs" is clean in theory;
   real thoughts are multi-claim. Splitting a muddy thought into clean single-stance POVs is itself an LLM judgment
   call that can go wrong, and the thesis lists this as open for good reason.
4. **Attach/detach rules are the actual hard AI problem.** Gate-4 ("is this delta worth re-expressing?") and the
   For/Against classification are where quality lives or dies. The existing relevance prompts are a starting point,
   but bipolar (support vs. attack vs. undercut) is strictly harder than the current binary relevance scoring, and
   will need its own eval set. This is the part I'd de-risk with a spike before committing.
5. **It only pays off if users have enough captured signal to *create churn*.** A cold KB has nothing to re-weigh;
   liveness is a late-game value prop. Early users may not see the differentiator until the KB is dense.

None of these is fatal. (1) and (4) are scoped engineering; (2) and (3) are design risks to spike, not unknowns
that invalidate the thesis. The formal grounding and the existing infrastructure mean the *core* is low-risk; the
*surface* is where the work is.

---

## Verdict block
**VERDICT:** Build it — Live POVs is a sound re-derivation of AGM + TMS + bipolar argumentation that targets the documented killer of second brains (maintenance-driven KB-rot), and Robin already ships ~70% of the bounded, cost-throttled engine it needs.
**CONVICTION:** high — the four core mechanics are each independently validated formalisms (4 of 5 already LOCKED), the cost objection is closed by gates that already run in production for wiki regen, and KB-rot-as-abandonment-cause is well-documented. Held high, not absolute: the AI-quality of bipolar attach/detach (gate 4) is unproven in this repo and is the one thing I'd spike before full commit.
**Strongest evidence:**
- A Live POV *is* a JTMS node (justification = working-set) and many-POVs-over-shared-fragments *is* an ATMS (multi-context over shared assumptions) — Doyle 1979 / de Kleer 1986; the facade independently rediscovers the JTMS→ATMS evolution. https://cse.buffalo.edu/~shapiro/Papers/br-overview.pdf
- The cost objection is already closed in Robin's own code: vector pre-filter + 5-min debounce + batched ≤50/tick + per-stage `cost_usd_micros` + `app_settings` budget cap — Live POVs re-aims this, it doesn't build it [robin: regen-debounce.ts:45-111, regen-worker.ts:24-302, schema.ts:554-593].
- KB-rot/maintenance burden is the documented cause of second-brain abandonment, and self-updating belief processes empirically out-perform static expertise (GJP: +30% vs. classified-access analysts). https://arxiv.org/pdf/2509.20187 · https://goodjudgment.com/wp-content/uploads/2021/10/Superforecasters-A-Decade-of-Stochastic-Dominance.pdf
**What would change my mind:**
- A spike showing the bipolar attach/detach + "is-this-delta-worth-re-expressing" classification (gate 4) can't hit acceptable precision with Robin's prompt/model stack — that's the load-bearing AI risk.
- Evidence that the live set can't be kept small by citation-impact gating (i.e., users cite broadly, so tens-of-POVs becomes thousands) — which would reopen the cost objection the §5 design relies on closing.
- User research showing conviction-motion narration reads as the app being unreliable rather than thoughtful, with no UX framing that fixes it.
