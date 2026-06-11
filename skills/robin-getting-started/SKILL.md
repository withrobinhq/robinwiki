---
name: robin-getting-started
description: Robin onboarding and wiki-creation flow. Use when a user is new to Robin, setting up their knowledge base, says "I'm new to Robin", asks how to start — or makes any wiki-creation request ("create a wiki", "make a new wiki", "add a Belief/Project/Decision/Log/Research/Skill/Voice/Principle/Agent/Objective wiki"). Walks new users through their first wikis and first entries. Loading is mandatory before calling `Robin:create_wiki`.
---

# Robin: Getting Started + Wiki Creation

Two flows, same skill:

- **Onboarding** — for a new user setting up Robin for the first time. Step 0 through Step 8.
- **Wiki creation** — for any later request to create a wiki. The "Create your first wikis" section's quality protocol applies every time, not just on day one.

Both rely on the architectural definitions in the companion `robin-reference` skill. Load that when you need full reference on entries, fragments, wikis, types, Description / Wiki Format / Wiki Style, MCP tools, or FAQ-style questions.

---

## Step 0: Welcome (onboarding only)

Open conversationally — not a wall of text. Match the user's energy.

> Welcome to the Robin Knowledge System.
>
> Robin is a second brain — the kind that gets sharper the more you use it, because you're the one sharpening it. Robin automates the parts of knowledge management that shouldn't require your brain (ingesting, fragmenting, routing, synthesising) and deliberately stops where your thinking should start. You decide what topics matter, you name the wikis, you review what the system extracted, you write the rules that govern your knowledge.
>
> This is not for people who want to dump information in and ask questions later — that's RAG, and there are plenty of tools for it. Robin is for people who want to engage with their knowledge; who believe organising thought is itself a form of thinking; who want a system that compounds because a human is actively steering it.
>
> We'll walk through setup step by step. By the end you'll have a working knowledge base with your first wikis, your first logged entries, and a feel for the day-to-day rhythm.

---

## Step 1: Why this is in Claude, not the Robin app

Brief explanation only if the user asks or seems confused.

Robin is the knowledge system; it stores, structures, connects, and synthesises. It deliberately does not try to be the place where all thinking, analysing, and capturing happens. **MCP (Model Context Protocol)** is the universal connector — Claude speaks MCP, so do workflow tools and custom agents. They all read from and write to Robin.

So heavy lifting (mining a transcript, extracting from a long document, spotting a belief mid-conversation, creating wikis from a discussion) happens through tools like Claude that are good at it. Robin receives the knowledge, processes it, keeps it structured. The user manages the shape of the knowledge base in Robin's own interface.

---

## Step 2: Architecture (brief)

The user needs the logic; full definitions are in `robin-reference`.

- **Entries** — raw inputs (transcripts, articles, observations). Unstructured. The user just logs them; Robin handles processing.
- **Fragments** — atomic units of knowledge Robin extracts from entries. One entry → many fragments. A fragment is a single idea, fact, observation, decision, or quote.
- **Wikis** — topics and themes that accumulate fragments. Wiki bodies synthesise their fragments into a coherent, evolving document.
- **Many-to-many.** One fragment can belong to multiple wikis. A client insight from one meeting can touch your strategy wiki, your relationship wiki, and your product wiki simultaneously. This convergence is where compounding happens.

**Ask the user:**

> What kind of knowledge do you work with day to day? Meeting notes, research, client work, strategy, personal development? Don't overthink — just tell me what flows through your head and inbox most often.

Use the answer to guide wiki creation in Step 4.

---

## Step 3: The three modes (brief)

- **Observe** — capture what's happening. Monitoring, logging, noting. Input layer.
- **Drive** — process observations into positions, decisions, plans. Thinking layer.
- **Govern** — encode judgment into rules and frameworks AI can act on. Governance layer.

Compounding loop: Observe → Drive → Govern → informs what you Observe next.

**Ask the user:**

> Which mode resonates most right now?
> - **Observe:** "I have a lot coming at me and need to capture it better"
> - **Drive:** "I have information but need to turn it into decisions and direction"
> - **Govern:** "I have strong views and want to encode them for AI to work from"

Most people start with Observe — that's fine.

---

## Step 4: Create your first wikis (the heart of the skill)

Wikis are the backbone. They're the topics that matter — the things the user wants to get smarter about over time.

### The 10 wiki types

Robin ships with 10 default types, organised across the three modes. (Extensible via `Robin:create_wiki_type`, but the defaults cover almost everything.)

**Observe:**
- **Log** — capturing what happens. Accumulates, doesn't close. (Templates within Log — Journal, Monitor, Playbook, Collection, Tracker — are formatting variants, not separate types.)
- **Research** — accumulating signals around a subject with a question in mind. The pre-Belief stage.

**Drive:**
- **Belief** — a position being formed or held; evolves as evidence accumulates.
- **Decision** — a choice made or being evaluated, with reasoning.
- **Objective** — something being aimed for; connected to actions and projects.
- **Project** — bounded work with scope, milestones, and status.

**Govern:**
- **Principle** — non-negotiable rules and standards.
- **Skill** — a repeatable capability, step-by-step.
- **Agent** — specification for an AI agent (role, tools, constraints).
- **Voice** — how to communicate (tone, style, examples).

Each type has its own default Wiki Format and Wiki Style. A Belief reads differently from a Log differently from a Voice. (Full definitions of Wiki Format and Wiki Style live in `robin-reference`.)

### Guidelines for good wikis

- **Name them like a position or a territory, not a folder.** "How AI is reshaping professional services" beats "AI Notes". "The case for African tech talent" beats "Africa Research".
- **Start with 3–5.** Add more later.
- **Mix types based on actual need.** Observe-mode users start with Log and Research. Drive-mode users start with Belief and Project. If the user already has strong views, Principle might be the starter.
- **Overlap is fine** — fragments can belong to multiple wikis. That's the point.
- **Ignore Collections on day one** — optional groupings, useful around 15–20 wikis when the sidebar feels cluttered.

### Three controls per wiki — Description, Wiki Format, Wiki Style

Each wiki has three independent levers. New users confuse them constantly.

- **Description** = "what fragments belong here?" The router. Vague → misrouted fragments. Specific → accurate routing. *Bad:* "Stuff about AI and jobs." *Good:* "How AI is changing the division of labour between humans and machines — which tasks are being automated, which augmented, what new roles emerge. Particularly the African context and the outsourcing industry."
- **Wiki Format** = "how is this laid out when I read it?" The section template Quill follows when synthesising. Type-default unless the user overrides in the wiki's settings.
- **Wiki Style** = "how does this sound when Quill writes it?" The voice override that swaps Quill's instructions at regen time. Type-default unless overridden.

Door / room / voice. **Day one focus is descriptions.** Leave Wiki Format and Wiki Style at type defaults — they're already designed for the kind of knowledge each type holds. All three are editable any time. Full definitions in `robin-reference`.

### Creating wikis via Claude — the quality protocol

Claude can create wikis directly via `Robin:create_wiki`. The MCP tool requires three fields — `title`, `description`, `type` — at the schema level (calling without all three returns a protocol error). But "present" is not enough. A bad wiki — generic name, wrong type, vague description — corrupts Robin's routing the moment it accumulates fragments, and the damage is hard to undo. Claude's job is to protect the user from creating one.

**Every wiki-creation request follows this protocol. Do NOT infer fields from the title — even if the title seems self-explanatory.**

1. **Ask the user, in their own words, what this wiki is for.** The description is what Robin uses to route future fragments — it must come from the user, not from a paraphrase. A title like "Parambi Family Travel Planning" is not enough; ask what kinds of fragments belong here and what doesn't.
2. **Call `Robin:get_wiki_types` and present the options.** Ask which type fits. Do not infer the type from the title or description.
3. **Confirm name + type + description back to the user,** then call `Robin:create_wiki` with all three exactly as the user articulated them.

If the user supplied only a title, do NOT call `create_wiki` yet — ask the description and type questions first.

**The quality bar each field must clear:**

- **Name — territorial, not generic.** Bad: "AI Notes", "Africa Research", "Strategy". Good: "How AI is reshaping professional services", "The case for African tech talent", "Why we're picking project-based pricing". The name should sound like a position, a territory, or a question.
- **Type — explicitly chosen.** If the user is unsure, walk through `get_wiki_types` and explain the fit: "Sounds like a Belief — a position you're forming. Or is this Research — still gathering signal?" Don't accept "whichever".
- **Description — defines what belongs and what doesn't.** Bad: "Stuff about AI and jobs." Good: see the worked example above. Specific guidance the user often needs:
  - **Long enough for the AI classifier to work with.** A one-line description gives Robin almost nothing to match fragments against. Aim for at least 2–3 sentences that define the territory.
  - **Broad enough to catch what's relevant, narrow enough not to catch everything.** "Stuff about AI" catches too much. "GPT-4 vs Claude pricing in March 2026" catches too little. The right band is the topical area whose fragments should converge into one wiki body.
  - **For Belief wikis: describe the *topic*, not the *stance*.** A Belief wiki holds a position, but the description should describe the whole topic area — not just the position the user currently holds. Otherwise the classifier won't route counter-evidence into the wiki, and the user won't see disagreeing material that should challenge or refine the belief. Example: a Belief titled "African talent will win Outsourcing 2.0" should have a description about *African talent and the global outsourcing market* — not about *why Africa will win* — so fragments arguing the opposite also route in.
  - **Descriptions are editable any time.** Reassure the user — first version doesn't need to be perfect. Refine when fragments start routing weirdly.

If any of the three are weak, refuse to call the tool. Tell the user what's missing, show them bad/good examples, help strengthen it. **This friction is the feature.**

### Onboarding flow: suggest, then create

Before proposing wikis, draw on everything you know about this user:

- **The user's Step 2 and Step 3 answers** — primary signal.
- **Claude's memory of past conversations with this user** (if any) — recurring topics, decisions they've described, people they've mentioned, beliefs they've articulated. Surface those as candidate wikis: *"I've noticed across our previous chats that you've been thinking a lot about [X] — want that as a Belief wiki?"*
- **Files or content shared earlier in this conversation** — uploaded docs, pasted material, anything substantive Claude has already seen.

If memory and prior chats give a strong picture, lean on them — these are the most grounded basis for proposals because they reflect what the user *actually* spends time on. Frame the suggestions as "based on what I know from our previous conversations and what you've told me today, here are 5 wikis I'd suggest..." so the user sees the reasoning.

If memory and prior chats give little or nothing (new Claude user, or memory is sparse), say so honestly and fall back on Step 2 / Step 3.

For each proposed wiki: name, type, draft description. Explain why you chose the type. Ask the user to react — edit, add, remove, change types.

Once the user has approved a list, walk through each wiki using the quality protocol above (confirm name + type + description for each, then call `Robin:create_wiki`). The user sees the wikis appear in their Robin app as they're created — encourage them to open the app in another tab so they can watch the knowledge base take shape.

---

## Step 5: Set up the meeting notes pipeline

Meetings are one of the richest sources of knowledge. Let's pipe a real one through.

### 5a — Check transcription setup

> How do your meetings get recorded? Do you use Fellow, Otter, Fireflies, or similar? Is it connected to Claude via MCP?

If no transcription set up, discuss options and move to Step 6 — they can come back later. If yes, proceed.

### 5b — Pick a recent meeting

> Let's test with a real one. Pick a recent meeting with some substance — not just a quick check-in. Which should we use?

Use the transcription tool's MCP to find and pull it.

### 5c — Check attribution on the transcript

- **Names present and clear** (e.g. `[00:02:14] Karen Kimami: …`) — great. Tell the user their meetings will flow into Robin cleanly.
- **Names missing or generic** ("Speaker 1", "Unknown") — flag it. Their meetings will need per-fragment attribution at log time. The `log-to-robin` skill handles that in its Mining mode.

### 5d — Log the meeting

1. Show the user what you're about to send (transcript with metadata tags: Channel, Uploaded by, Attribution, Context).
2. Flag any sensitive content.
3. Confirm: "Ready to log this to Robin?"
4. Call `Robin:log_entry`.
5. Confirm what landed.

Explain what happens next: Robin processes the transcript, extracts fragments, routes them. The user can open the Robin app to see what was created.

### 5e — Document the pipeline (mental note)

- **Clean attribution** → `log-to-robin` skill's Quick mode. Log directly.
- **Messy attribution** → `log-to-robin` skill's Mining mode. Surface compelling fragments, ask the user to attribute the ambiguous ones individually.

---

## Step 6: Log more entries

The user has their first entry. Now build the habit with a different kind of input.

**Ways to log:**
- Via MCP (right here) — `Robin:log_entry`. Best for observations, ideas, in-the-moment thinking.
- Via the Robin web app — for longer material or when not in a Claude conversation.

**What makes a good entry:**
- **Be specific.** "Had a good meeting with Sarah" is almost useless. "Sarah pushed back on per-seat pricing — she thinks it doesn't work for NGOs with rotating staff; she suggested project-based instead. I think she's right." That's an entry Robin can work with.
- **Include context.** Who said it, when, why it matters. More context → better fragments.
- **Don't self-edit.** If you're thinking it, log it. Not every entry produces gold; the ones that do are worth the noise.

**Prompt:**

> Try something different now — an article that stuck with you, an idea you've been mulling, a decision you've been wrestling with. Talk naturally; I'll log it to Robin.

Call `Robin:log_entry`. Explain Robin will fragment and route.

---

## Step 7: Using Robin — the two-way loop

Robin isn't a one-way dump. The point is using it back.

- **Pull beliefs into your writing.** Drafting a LinkedIn post? Ask Claude to read your Belief wikis from Robin and use them as the foundation. Post is grounded in thinking you've already done.
- **Update your tools from Robin.** New fragments accumulate in Robin that refine how a Claude skill should work. Pull the latest, update the skill.
- **Prepare for a meeting using your wikis.** About to meet a client? Ask Claude to pull what Robin knows about that person and relationship — past meetings, decisions, beliefs about their industry. Walk in prepared.
- **Let Govern wikis direct AI.** Your Principle and Voice wikis define non-negotiables. Claude and any other MCP-connected tool can read them and operate within your rules.

**Robin gets more valuable the more you use it in both directions.** Logging builds the base; using it proves it works; using it reveals gaps.

**Prompt:**

> Now that you've logged a couple of entries, try using Robin. Anything you're working on right now — writing, a decision, an upcoming meeting — where we could pull from your knowledge base?

Use `Robin:search` or `Robin:get_wiki` to feed their current work.

---

## Step 8: Establish the rhythm

The last step isn't a task — it's a habit. Robin compounds, but only with consistent use.

- **Morning:** scan wikis. Anything accumulated overnight? What's growing? What's stale?
- **During the day:** log as you go. After a meeting, capture the takeaway. After reading, log the one thing that stuck. After deciding, log why.
- **Weekly:** review wiki bodies. Are they reflecting current thinking? Edit if not. The wiki is the user's curated position — it should always represent their best current understanding.

**The compounding effect.** Week one feels like a note-taking tool. By month two wikis have depth. By month six it's a genuine externalised knowledge base AI can work with — which is when Govern mode comes alive.

**Close the onboarding:**

> Your knowledge base is set up. Wikis, first entries logged, knowledge flowing both ways.
>
> From here the system gets out of your way. Log, use, tend, let it compound. Robin is automatic where it makes sense and expects you to think where it matters. The more you engage, the more valuable this becomes — not because the AI gets smarter, but because your knowledge base does. And that's yours.

---

## When you don't know the answer

Claude does not know everything about Robin. Robin is an evolving product with features and settings that may go beyond this skill.

If a user asks something you can't confidently answer — how a specific feature works, what a setting does, what's possible in the app — **say so.** Don't guess.

> I'm not sure about that — check in the Robin app directly, or ask the Robin team.

Better to be honest than to give wrong information about someone's knowledge system.

---

## Handling different starting points

Not every user arrives blank.

- **Existing notes/documents to import:** log entries from the existing material. Start with 3–5 most important pieces, not everything.
- **Team/organisation setup:** focus on shared wikis first. Establish naming conventions early. Discuss who governs which wikis.
- **Reorganising an existing Robin:** use `Robin:search` to audit. Identify wiki gaps, routing issues, stale content before restructuring.
- **Media monitoring client:** onboarding still applies, but emphasise briefs, topics, keywords. Lean on Research and Log wiki types.
