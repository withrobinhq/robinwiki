---
name: robin-reference
description: Robin architectural reference and FAQ. Use when answering questions about how Robin works — entries, fragments, wikis, wiki types, descriptions, Wiki Format, Wiki Style, collections, people, the people-quarantine model, MCP tools — or behavioural questions like "why didn't my fragment land in wiki X?", "how long does Robin take to process an entry?", "where does my data live?", "what's the difference between log_entry and log_fragment?".
---

# Robin Reference

Architectural definitions, MCP tool reference, and answers to common questions about Robin. The companion skills (`robin-getting-started`, `log-to-robin`, and any future Robin skills) reference these definitions rather than encoding Robin's logic independently.

---

# Part 1: Architecture

## Entries

Raw inputs logged by the user or by automated systems. An entry is unstructured content — a transcript, an article, a thought, a pasted document. Robin's AI pipeline processes entries to extract fragments.

- Entries are the ingestion layer. Never the final form of knowledge.
- One entry can produce many fragments.
- Entries carry metadata: channel, uploaded by, attribution, context (see Metadata).
- Users should not worry about formatting their input — Robin handles processing.

## Fragments

The atomic units of knowledge extracted from entries. A fragment is a single idea, fact, observation, decision, quote, or insight — small enough to stand alone, specific enough to be useful.

- Robin extracts fragments from entries automatically.
- One fragment can belong to multiple wikis (many-to-many).
- Fragments carry their own attribution — "who said this" at the individual statement level.

**The 7 fragment types** (assigned automatically during extraction; the most specific that fits):

| Type | Use when… |
|---|---|
| **fact** | A concrete, verifiable statement about something that happened or is true. |
| **idea** | A thought, opinion, hypothesis, or suggestion — not yet acted on. |
| **question** | An explicit or clearly implied question. |
| **action** | A concrete task, commitment, or next step. |
| **quote** | Verbatim words attributed to a specific person. |
| **reference** | A pointer to an external resource — URL, book, paper, tool, repo. |
| **note** | A contextual or metacognitive remark that doesn't fit the others. |

## Wikis

Topics and themes that accumulate fragments over time. Each wiki has a body that synthesises its fragments into a coherent, evolving document — like a Wikipedia page that grows as you feed it.

- The organising layer of the knowledge base.
- Grow organically as entries are logged and fragments are routed.
- Can also be created deliberately before any content exists.
- Bodies are human-readable and should represent the user's best current understanding.
- Every wiki has a **type** (determines defaults), a **description** (routing), a **Wiki Format** (layout), and a **Wiki Style** (voice). All four are independent. See below.

### Description, Wiki Format, and Wiki Style

The three user-controllable levers on a wiki, each doing a different job:

- **Description.** Free-text statement of what this wiki is for. Robin matches incoming fragments against the description to decide whether they belong. Editable any time. Vague description → misrouted fragments. Specific description → accurate routing. Two non-obvious rules: (1) descriptions need to be **long enough for the AI classifier to work with** — a one-liner gives Robin almost nothing to match against; aim for 2–3 sentences that define the territory; (2) for **Belief wikis**, describe the *topic* not the *stance*, otherwise the classifier won't route counter-evidence into the wiki — e.g. a Belief titled "African talent will win Outsourcing 2.0" should describe African talent and the outsourcing market generally, not the reasons for the position, so disagreeing material also routes in.

- **Wiki Format.** A section template (markdown headings + prose prompts) Robin uses when synthesising the wiki body from accumulated fragments. Each wiki **type** ships with a default Wiki Format — the canonical layout for that knowledge (e.g. Belief: Core Claim / Supporting Points / Counterarguments / Key Quotes). On wiki creation, that default seeds the wiki. The user can edit it in the wiki's settings, or "Revert to default" to restore the type's default. On wiki-type change, a customised Wiki Format is preserved; an untouched default swaps to the new type's default. Persisted to `wikis.structure` in the database.

- **Wiki Style.** A voice/framing override that swaps Quill's `system_message` at regen time. Each wiki **type** ships with a default Wiki Style — the voice that fits that knowledge (a Belief reads like a held position with reasoning; a Voice wiki reads like a style guide; a Log reads like accumulating observations). The user can override it per-wiki, or "Revert to default" to restore the type's default. Persisted to `wikis.prompt` in the database.

**Critical: do not conflate the three.** Use the right vocabulary when answering questions:

- "Why isn't fragment X landing in wiki Y?" → description issue (routing).
- "Why is wiki Y's body laid out this way?" → Wiki Format (layout).
- "Why does wiki Y sound this way?" → Wiki Style (prose / framing).
- "I want different sections" → Wiki Format.
- "I want a different voice" → Wiki Style.
- "I want different kinds of fragments here" → description.

### The 10 default wiki types

Extensible via `Robin:create_wiki_type`. Each type ships with its own default Wiki Format and Wiki Style.

| Mode | Type | Purpose |
|---|---|---|
| Observe | **Log** | Capturing what happens. Doesn't close — accumulates. Templates within Log (Journal, Monitor, Playbook, Collection, Tracker) are formatting differences, not type differences. |
| Observe | **Research** | Accumulating signals around a subject with a question in mind. Pre-Belief stage — the bridge between Observe and Drive. |
| Drive | **Belief** | A position being formed or held; evolves as evidence accumulates. |
| Drive | **Decision** | A choice made or being evaluated, with reasoning. |
| Drive | **Objective** | Something being aimed for, connected to actions and projects. |
| Drive | **Project** | A bounded piece of work with scope, milestones, and status. |
| Govern | **Principle** | Non-negotiable rules and standards. |
| Govern | **Skill** | A repeatable capability — how to do something well. |
| Govern | **Agent** | Specification for an AI agent — role, tools, constraints. |
| Govern | **Voice** | How to communicate — tone, style, examples. |

## Collections

Optional user-curated buckets for grouping wikis. Hold wikis only (not fragments, people, or entries); a wiki can belong to multiple collections.

- User-created and managed. Robin does not auto-file.
- Optional — small knowledge bases don't need them.
- The Robin app sidebar groups wikis by collection; the Explorer page filters by collection.
- Manage via `Robin:list_groups`, `Robin:create_group`, and `Robin:add_wiki_to_group` (the API name "group" is the internal term for what the UI calls a Collection).

## People

A separate dimension that runs across all other objects. People can be the subject of wikis, the source of fragments, participants in entries, and connections across the knowledge base.

- Looked up via `Robin:find_person` (search by name/alias/key) and read in full via `Robin:brief_person`. Created or edited via `Robin:create_person` and `Robin:update_person`. Connected via `Robin:add_relationship`.
- Fragment-level attribution connects to the people layer.

### Quarantine model

Robin's people-extractor auto-proposes people from incoming fragments. Auto-proposed rows land with `status='pending'` and `created_via='extractor_pending'` so the operator can review before they show up across the knowledge base.

Three lifecycle states:

- **`verified`** — confirmed by the operator (or seeded manually, or created directly via `Robin:create_person`). Visible everywhere.
- **`pending`** — proposed by the extractor, awaiting operator approval. Hidden from default people views; surfaced for review.
- **`rejected`** — operator explicitly dismissed the candidate. Stays out.

Two MCP tools manage the queue: `Robin:list_pending_persons` (review the queue) and `Robin:set_auto_accept_persons` (an app setting — when true, the extractor flips new candidates straight to `verified` instead of routing through pending). Default is `false` so first-time users see what the extractor is doing.

---

# Part 2: The Three Modes

Robin organises knowledge around three modes:

- **Observe** — capture what's happening. Monitoring, logging, noting. The input layer.
- **Drive** — process observations into positions, decisions, plans. The thinking layer.
- **Govern** — encode judgment into rules and frameworks AI can act on. The governance layer.

A compounding loop: Observe → Drive → Govern → informs what you Observe next.

---

# Part 3: Metadata

Every piece of content entering Robin should carry three metadata dimensions. Until Robin's API supports dedicated fields, they're encoded as tags at the top of the content string.

### Channel

The pathway through which content entered Robin. Auto-populated.

Values: `Claude`, `Web`, `API`. (Map to the underlying `source` enum on `log_entry`: `mcp`, `web`, `api`. "Channel: Claude" is the human-readable label for `source=mcp`.)

### Uploaded by

Which human in the organisation sent this. Auto-populated by Claude from conversation context. Enables "show me everything Nadene has been logging".

### Attribution

The original authority behind the content — "who said it" / "who wrote it". This is the field that carries intellectual weight.

- **Entry level** — can include multiple sources (e.g. "Phyl Georgiou, Karen Kimami" for a meeting between them).
- **Fragment level** — per person ("Karen said X" / "Phyl said Y"). Robin handles this decomposition when fragmenting.
- **Articles** — `Author Name, Publication` (e.g. "Jane Smith, Financial Times").
- **User's own thinking** — attribute to the user.
- **User relaying someone else** ("Chris told me X") — attribute to Chris, not the user.
- **Unclear** — Claude should ask before logging.

### Content format template

```
[Channel: Claude]
[Uploaded by: {user's name}]
[Attribution: {who said/wrote it}]
[Context: {brief description of where this came from}]

{the actual content}
```

---

# Part 4: MCP Tool Reference

Robin currently exposes the tools below. Default to the **Capture** and **Read** tools for most conversations — the management tools are for power-user moments. (List drifts as features ship; if a user references a tool not in this table, check the live tool list before assuming it doesn't exist.)

### Capture — write knowledge into Robin

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:log_entry` | Logs raw text into Robin for AI processing | Default for most logging — meeting notes, observations, ideas, articles. Robin fragments and routes automatically. |
| `Robin:log_fragment` | Places a fragment directly into a specific wiki, bypassing the AI pipeline | When you know exactly which wiki the content belongs in (seeding a new wiki, or the user has explicitly directed content there). Get wiki slugs from `list_wikis` / `get_wiki` first. |
| `Robin:attach_fragments` | Files existing fragments under additional wikis without re-routing | When a fragment already in Robin should also live under another wiki — e.g. a multi-topic insight the classifier only filed in one home. |

### Read — pull knowledge out of Robin

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:search` | Hybrid search across fragments, wikis, and people | To find existing content, check what was created, explore connections, or compare new content against existing knowledge. |
| `Robin:list_wikis` | Lists all the user's wikis with metadata | To enumerate wikis, get a slug for another tool, or surface the shape of the knowledge base. |
| `Robin:get_wiki` | Reads a wiki's body and fragments | To review a wiki's state, pull its content into a conversation, or audit accumulation. |
| `Robin:get_fragment` | Reads a specific fragment | To examine or discuss a particular piece of knowledge. |
| `Robin:get_timeline` | Returns the audit trail / edit history for a wiki | When the user wants to see what's changed in a wiki, when, and why. |
| `Robin:find_person` | Looks up a person by name, alias, or key | When discussing people and relationships, or checking if someone is tracked. |
| `Robin:brief_person` | Returns the full structured summary of a tracked person | Once a person is identified, to pull what Robin knows about them — role, relationship, what they care about. |
| `Robin:list_skills` | Lists Skill-type wikis and skill-pack aliases | When the user wants to see what repeatable capabilities Robin has captured. |

### Manage wikis

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:create_wiki` | Creates a new wiki — title, description, type all required | When the user asks Claude to create a wiki. **Always follow the wiki-creation protocol in `robin-getting-started`** — never call without going through it. |
| `Robin:edit_wiki` | Updates a wiki's metadata or content (does not rename) | When the user has explicitly asked to revise an existing wiki's description, Wiki Format, Wiki Style, or body. Renames happen in the Robin app. |
| `Robin:publish_wiki` | Publishes a wiki to a stable public URL | When the user has explicitly asked to make a specific wiki readable by anyone with the link. Opt-in per wiki. |
| `Robin:unpublish_wiki` | Removes a wiki's public URL | When the user wants to retract a previously-published wiki. Wiki itself stays; only the public link is revoked. |
| `Robin:regen_now` | Triggers a fresh regeneration of a wiki's body from its current fragments | After editing Wiki Format or Wiki Style, after a batch of fragments lands, or after re-routing. |
| `Robin:regen_status` | Reads the regen state of a wiki | When the user wonders whether a wiki's body is up to date with its fragments. |

### Manage wiki types

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:get_wiki_types` | Lists available wiki types (slugs and descriptions) | Before creating a wiki to confirm valid type slugs, or to explain the type system to the user. |
| `Robin:create_wiki_type` | Defines a new wiki type | Rare — only when the user wants to extend Robin beyond the 10 defaults. |

### Manage people

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:create_person` | Creates a verified person row manually | When the user wants to seed a person Robin hasn't extracted yet (e.g. a client they're about to meet). Lands as `status='verified'`, bypassing quarantine. |
| `Robin:update_person` | Edits a tracked person's fields | When the user wants to refine a profile — corrected name, added aliases, updated role context. |
| `Robin:list_pending_persons` | Lists extractor-proposed people awaiting approval | When the user wants to review the quarantine queue. |
| `Robin:set_auto_accept_persons` | Toggles the `auto_accept_persons` app setting | When the user trusts the extractor and wants new candidates to flow straight to `verified`. Default is off. |
| `Robin:add_relationship` | Connects two people with a typed relationship | When Robin should know that A is the manager of B, or the co-founder of C. |

### Manage collections

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:list_groups` | Lists all collections with wiki counts | To show what collections exist or pick one for filing a wiki. |
| `Robin:create_group` | Creates a new collection | When the user wants a new bucket for grouping wikis. |
| `Robin:add_wiki_to_group` | Adds a wiki to a collection | After creating a wiki, when the user wants to file it. |

**Terminology note.** Robin renamed its API tools from "thread" to "wiki" — canonical names are `get_wiki`, `list_wikis`, `create_wiki`, etc. One legacy holdout: the parameter name on `log_fragment` is still `threadSlug` (not `wikiSlug`). Use `threadSlug` as written when calling that tool. In user-facing conversation, always say "wiki".

---

# Part 5: Available Robin skills

| Skill | Purpose | When it triggers |
|---|---|---|
| **robin-reference** (this skill) | Architectural definitions + FAQ | Questions about how Robin works, what a setting does, behavioural Qs ("why didn't my fragment…"). |
| **robin-getting-started** | Onboarding + wiki creation | New users, "I'm new to Robin", or any wiki-creation request. Loads before `Robin:create_wiki` to enforce the title/type/description quality gate. |
| **log-to-robin** | Content capture | "Log this to Robin" / "save this" / "send this", or proactive logging when Robin MCP tools are active. Internally decides Quick vs Mining mode and `log_entry` vs `log_fragment`. |

---

# Part 6: Common Questions

Prefer the canonical answer below when a question is in this set. Outside the set, fall back to Part 1's definitions — and admit uncertainty if the answer isn't documented.

## Why didn't my fragment land in the wiki I expected?

Almost always a **description** issue. Robin routes fragments by matching them against each wiki's description. If a wiki's description is vague — "Stuff about AI and jobs" — Robin guesses, and a fragment that should have landed there ends up somewhere else (or nowhere).

Fix: make the description more specific. Edit it in the wiki's settings — say what belongs and what doesn't. Future fragments route more accurately. Already-landed fragments stay where they are unless re-routed explicitly.

## Where does my data live? Who can see it?

Robin is single-tenant — each user has their own Robin instance with its own Postgres database. Wikis, fragments, entries, and people all live there.

By default, **wikis are private**. A wiki can be explicitly published from the Robin app (or via `Robin:publish_wiki`), which generates a stable URL anyone with the link can read — but this is opt-in per wiki, never automatic.

Robin does call out to LLM APIs (via OpenRouter) to fragment entries and synthesise wiki bodies — content is sent to those providers for processing. If the user is uncomfortable with any data leaving their machine, Robin is the wrong tool.

## Can I rename a wiki?

Yes — in the wiki's settings inside the Robin app. The user-facing name updates everywhere; the slug (used in URLs and backlinks like `[[wiki:my-slug]]`) stays stable so existing references don't break.

Renaming via MCP is not currently supported — `Robin:edit_wiki` updates the wiki's content body, description, Wiki Format, and Wiki Style, but not the name. Direct the user to the app for renames.

## Why is this wiki's body laid out a certain way?

A **Wiki Format** issue. Each wiki has a section template — its Wiki Format — that Robin follows when synthesising the body from fragments. The default comes from the wiki's type (Belief: Core Claim / Supporting Points / Counterarguments; Decision: per-Option subsections).

To change the layout, edit the Wiki Format in the wiki's settings. Write a new template or hit "Revert to default" to restore the type's default. The next regen matches the new Wiki Format.

The user can also edit the **type-level default Wiki Format** itself — useful when every new Belief wiki should follow a preferred layout. Changes the default for *future* wikis of that type; existing wikis keep their current Wiki Format.

## Why does this wiki sound the way it does — can I change the voice?

A **Wiki Style** issue. Wiki Style is the voice and framing Quill uses when generating the body — distinct from what sections appear (Wiki Format) and what content lands inside (Description). It's how the wiki *reads as prose*.

The default Wiki Style comes from the type. A Belief wiki's default voice frames things as a held position with reasoning; a Voice wiki's frames as style guidance; a Log wiki's as accumulating observations.

To change voice for one wiki: edit Wiki Style in its settings. Write the new voice instructions or hit "Revert to default". The next regen produces a body in the new voice. (Existing body text stays as-is until the next regen; trigger one via `Robin:regen_now` to apply immediately.)

The user can also edit the **type-level default Wiki Style** — every new Belief wiki then inherits the preferred voice. Changes the default for *future* wikis of that type; existing wikis keep their current Wiki Style.

**Quick heuristic.** Wrong material → Description. Wrong sections → Wiki Format. Wrong voice → Wiki Style.

## What's a Collection? Do I need them?

Optional buckets for grouping wikis. User-created and managed; Robin doesn't auto-file. The app sidebar groups wikis by collection.

Don't need them on day one. With 3–5 wikis the sidebar is small; collections add organisation without value. Useful around 15–20 wikis, when the list feels cluttered. Add when the user feels the need — not because the system expects them.

## How long does Robin take to process an entry?

Asynchronous — Robin queues the entry. For a short entry (a paragraph or two), expect a few seconds to a minute: fragment, embed, route, regen affected wiki bodies.

Longer entries (meeting transcript, long article) take longer — more to fragment, route, and regen. A few minutes is normal for dense content.

If after a few minutes no new fragments appear, two possibilities: (1) pipeline hit an issue — check the Robin app for errors; (2) Robin extracted nothing because the entry was too short, vague, or didn't contain substantive material.

## When should I add to an existing wiki vs create a new one?

Simplest rule: **log the entry first, see where Robin routes it.** Fragments landing in an existing wiki → that's the right home. Not landing anywhere → maybe a new wiki is needed.

Deliberate case:
- **Add to existing** when the new content reinforces, complicates, extends, or contradicts what's already there. A wiki is a *territory* — new fragments should fall within it.
- **Create new** when the topic is genuinely outside every existing description. Avoid wikis for one-off thoughts — those belong as fragments in an existing wiki, or in a Log wiki.

If unsure: "Could this be a chapter in any of your existing wikis?" If yes, add. If no, sit with it for a few days — new wikis without a clear reason often duplicate existing ones.

## What's the difference between log_entry and log_fragment?

Two MCP tools, two different jobs.

**`Robin:log_entry`** — the **default**. Pass raw text. Robin's pipeline extracts atomic fragments, embeds them, routes them across wikis based on each wiki's description. The user never has to think about which wiki gets what.

**`Robin:log_fragment`** — **manual placement**. Specify exactly which wiki a piece of content belongs in. Robin stores it there as a single fragment. No fragmentation, no routing. The AI pipeline is bypassed.

**When:**
- **`log_entry`** — normally. "Log this" → `log_entry`. Robin's job is to handle the messy work of breaking content into atomic fragments and routing them.
- **`log_fragment`** — when the user has explicitly directed content to a specific wiki ("save this to my Belief wiki on X"), or when seeding a new empty wiki. Requires the wiki slug — get from `list_wikis` first.

**Gotcha:** `log_fragment` doesn't fragment — whatever you send lands as one fragment. To manually place a multi-passage piece, break it into atomic fragments yourself first (one idea / one quote / one observation per fragment), then make a separate `log_fragment` call per piece.

## I have a long document — how should I log it?

Don't dump the whole thing into a single entry. Long documents (>~2,000 words) and messy multi-source content work much better mined first.

The **`log-to-robin`** skill handles this via its **Mining** mode. Mining is anchored on **comparison against Robin's existing knowledge** — Claude pulls the wikis the document touches (or runs broad searches), then surfaces fragments by what they *do to Robin*: novel relative to Robin's existing wikis, reinforcing something Robin already holds, or challenging a current position. The user curates which to keep.

Result: a curated set of fragments rather than 10,000 words of raw text for Robin to process — and the curation is grounded in the user's actual knowledge base, not Claude's priors about what reads as interesting.

For shorter content with clear attribution, the same `log-to-robin` skill uses its **Quick** mode — logs directly, less to filter.

## How does log-to-robin decide Quick vs Mining mode?

Two heuristics:

1. **Length.** Under ~2,000 words → Quick. Over → Mining.
2. **Attribution clarity.** Clean speaker labels → Quick can handle it. Messy ("Speaker 1, Speaker 2", anonymous, mixed-source) → Mining (which has a per-fragment attribution step Quick skips), regardless of length.

When both heuristics agree, the skill proceeds silently. **When they disagree, or when borderline, the skill asks the user directly** rather than guessing — an explicit "(a) Quick / (b) Mining" question. Attribution wins the default tie-break because fragment-level "who said what" is what Robin needs to get right.

Quick mode also includes a decision step before logging: `log_entry` vs `log_fragment`. Default is `log_entry`; switch to `log_fragment` only when the user has explicitly named a target wiki. Asks if unclear.

## What does Mining mode actually do — how does it decide what's "compelling"?

Anchored on **comparing the document against Robin's existing knowledge**. Without the comparison, Mining would just be Claude picking what looks interesting based on its own priors — no special connection to *this* user's knowledge base. With the comparison, Mining surfaces fragments whose value is grounded in what the user has actually been building.

**The comparison is the heart of the mode.** The first thing Mining does is ask the user *which part of Robin to compare against*: named wikis, broad search, or — explicit opt-out only — skip. The skill leans hard toward comparing; if the user opts out, Claude says once what's lost.

**Curation is Robin-grounded first.** Once the comparison is in hand, Claude evaluates fragments by:

- **Novel relative to Robin** — Robin's existing wikis don't already say this.
- **Challenging Robin** — contradicts or complicates a Belief, decision, principle, or position Robin already holds.
- **Reinforcing Robin** — adds evidence, depth, or a new angle to something Robin already holds.

Document-level criteria (well-articulated, good quote, actionable) are supplemental — or sole basis when the user opted out of comparison.

**The presentation makes the Robin connection visible.** Each surfaced fragment's primary rationale points to a specific wiki it reinforces or challenges, what gap it would fill. Not "this seems compelling", but: *"Reinforces your Belief wiki 'X' — currently argues from angle A; this adds angle B."* The user can approve, reject, or push back on Robin-grounded reasoning explicitly. This is what makes Mining different from a generic "find the highlights" tool: it's for tending the specific knowledge base the user is building.
