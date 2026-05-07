---
name: log-to-robin-guide
description: Onboarding + reference + wiki-creation quality gate for Robin. Triggers on setting up Robin, starting a knowledge base, "I'm new to Robin", and questions about entries, fragments, wikis, types, structures, or descriptions. Also triggers on any wiki-creation request — "create a wiki", "make a new wiki", "add a Belief/Project/Decision/Log/Research/Skill/Voice/Principle/Agent/Objective wiki". This skill defines the title/type/description quality bar Claude must apply before calling `Robin:create_wiki`; loading it is mandatory before any wiki-creation tool call. Other Robin skills (log-to-robin-short, log-to-robin-long) reference Part 2 of this skill for architectural definitions. First skill a new Robin user should encounter.
---

# Robin Knowledge System Guide

This skill has two parts:

**Part 1: Onboarding** — walks a new user through setup, step by step. Use this when someone is new to Robin or setting up their knowledge base for the first time.

**Part 2: Robin Reference** — defines Robin's architecture, metadata, and conventions. This is the reference layer that every other Robin skill leans on. Use this when you need to understand how Robin works in order to do your job (logging, comparing, extracting).

---

# PART 1: ONBOARDING

## Step 0: The Welcome

When this skill triggers for a new user, open with the welcome message below. Deliver it conversationally — not as a wall of text. Match the user's energy, but keep the substance.

---

Welcome to the Robin Knowledge System.

Robin is a second brain. Not the kind that sits there collecting dust while AI does vague things with your notes. The kind that gets sharper the more you use it — because you are the one sharpening it.

Here's the deal. Robin automates the parts of knowledge management that shouldn't require your brain: ingesting raw material, breaking it into pieces, routing those pieces to the right places, and synthesising what's accumulating. That's the machine's job. It's good at it.

But Robin deliberately stops where your thinking should start.

You decide what topics matter. You name the wikis. You review what the system extracted and tell it when it's wrong. You write the rules that govern how your knowledge behaves. Robin is the orchestra. You are the conductor. Take away the conductor and you don't get silence — you get noise.

This is not a knowledge system for people who want to dump information in and ask questions later. If that's what you want, there are plenty of RAG tools that will happily let you do that — and you'll get exactly the shallow, context-free answers you'd expect.

Robin is for people who want to engage with their knowledge. Who believe that the act of organising thought is itself a form of thinking. Who want a system that compounds over time because a human is actively steering it.

**What this onboarding will do:**

We're going to walk through setting up your knowledge base together. Step by step. At each stage, I'll explain what Robin does automatically and what it expects from you. By the end, you'll have:

- A working knowledge base with your first wikis
- An understanding of how entries become fragments become wikis
- Your first logged knowledge — real material, not demo data
- A feel for the rhythm of working with Robin day to day
- A plan for how your meetings and conversations flow into Robin

Ready? Let's go.

---

## Step 1: Why Are We Doing This in Claude?

You're probably wondering: if I'm setting up Robin, why am I talking to Claude? Shouldn't I be in Robin?

Robin is an app. You'll log into it. You'll use it to organise your folder structure, edit your wikis, review what's accumulated, and manage the shape of your knowledge base. That's Robin's home turf.

But Robin was built around a core design principle: **it is a knowledge system, not an everything-app.** Robin does one thing well — it manages your knowledge. It stores it, structures it, connects it, and synthesises it. What it deliberately does *not* try to do is be the place where all the thinking, analysing, and capturing happens.

That's where **MCP — Model Context Protocol** — comes in. Think of MCP as a universal connector. It lets any AI tool talk to your Robin knowledge base. Claude speaks MCP. So do workflow automation tools, custom agents, and other AI systems. They can all read from and write to Robin.

This means the heavy lifting of knowledge capture — mining a meeting transcript, extracting insights from a long document, spotting a belief worth preserving mid-conversation — happens through tools like Claude that are good at that kind of work. Robin receives the knowledge, processes it, fragments it, routes it, and keeps it structured. Each system does what it's best at.

**What this means in practice:**
- You log knowledge to Robin from wherever you are — a Claude conversation, a workflow, the Robin app, an API call
- Robin processes it, extracts the important fragments, routes them to the right wikis
- Any tool connected via MCP can then access that knowledge
- You manage the structure and shape of your knowledge base in Robin's own interface
- Your knowledge base is yours. It doesn't live inside Claude or inside any single tool. It lives in Robin.

So when we set up your knowledge base in this conversation, we're not replacing Robin. We're using Claude to do the parts Claude is good at — conversation, analysis, and capture — while Robin does what Robin is good at: being your knowledge system.

---

## Step 2: Understand the Architecture

Before we create anything, you need to understand what Robin is actually doing under the hood. Not because you need to be technical — but because this system only works if you understand the logic behind it.

### The Three Layers

**Entries** are raw inputs. A meeting transcript. A voice note. A pasted article. An observation you type in at 11pm. You don't need to format them. You don't need to tag them. You just log them. This is the part Robin automates — it takes your messy, unstructured input and processes it.

**Fragments** are the atomic units of knowledge that Robin extracts from your entries. One entry might produce five fragments. A fragment is a single idea, fact, observation, decision, or insight — small enough to stand alone, specific enough to be useful. Robin does the extraction. But you should review the results, because the system learns what matters from how you engage with it.

**Wikis** are the topics and themes that accumulate fragments over time. Think of them like wiki pages that grow. A wiki called "AI and African Talent" might collect fragments from a podcast you listened to, a meeting note, a LinkedIn post you drafted, and a research paper — all converging into one place. Wikis have bodies that synthesise their fragments into a coherent, evolving document.

**The key insight:** this is a many-to-many architecture. One entry produces many fragments. One fragment can belong to multiple wikis. A client insight from a single meeting can touch your strategy wiki, your relationship wiki, and your product wiki simultaneously. This convergence is where compounding knowledge happens.

### Prompt the user

Ask:
> What kind of knowledge do you work with day to day? Meeting notes? Research? Client work? Strategy? Personal development? Don't overthink it — just tell me what flows through your head and inbox most often.

Use their answer to guide wiki creation in Step 4.

---

## Step 3: Understand the Three Modes

Robin organises knowledge capture around three modes. These aren't features — they're a philosophy about how knowledge actually works.

**Observe** — Watch reality unfold and capture what matters. This is the input layer. Monitoring news, logging meeting notes, capturing what you read, noting what surprised you. Most people's "knowledge management" stops here. Robin doesn't.

**Drive** — Move from one state to a better one by thinking, deciding, doing, and aiming. This is where you process what you've observed into positions, decisions, plans, and hypotheses. It's the thinking layer. Robin supports this by surfacing fragments that relate to what you're working on, but the thinking is yours.

**Govern** — Encode your judgment so AI can act on your behalf. This is the most powerful mode. Once you've thought enough about a topic, you can write rules, criteria, and frameworks that tell Robin (and any AI working with your knowledge) how to behave. Your curated, structured, human-governed knowledge becomes what makes AI actually useful.

Together they form a compounding loop. Observation shapes thinking. Thinking defines governance. Governance informs what you observe next. The system does not reset — it accumulates.

### Prompt the user

Ask:
> Which of these three modes resonates most with where you are right now?
> - **Observe:** "I have a lot of information coming at me and I need to capture it better"
> - **Drive:** "I have information but I need to turn it into decisions and direction"
> - **Govern:** "I have strong views and I want to encode them so AI can work from my playbook"

Most people start with Observe. That's fine. The system will pull you into the other modes naturally.

Use their answer to set the tone for what kinds of entries we log first.

---

## Step 4: Create Your First Wikis

Now we build. Wikis are the backbone of your knowledge base. They're the topics that matter to you — the things you want to get smarter about over time.

But before creating any, you need to know that not all wikis are the same. Robin ships with **10 default wiki types**, organised across the three modes. Each type is designed for a different kind of knowledge, with its own default structure and purpose. (The type list is extensible via `Robin:create_wiki_type`, but the 10 defaults cover almost everything most users need — start there.)

### The 10 Wiki Types

**Observe — watch reality unfold and capture what matters:**
- **Log** — capturing what happens, in words or data. Doesn't close — it accumulates. The value is in faithful capture, whether chronological or curated. Templates within Log include Journal, Monitor, Playbook, Collection, Tracker — these are formatting differences, not knowledge-type differences.
- **Research** — accumulating signals around a specific subject to make sense of an unfolding pattern. You're watching with a question. It's the pre-Belief stage — exploratory, question-driven, not yet committed to a position. May eventually trigger a Belief when enough signal has accumulated. Research is the bridge between Observe and Drive.

**Drive — move from one state to a better one by thinking, deciding, doing, and aiming:**
- **Belief** — a position you hold or are forming about how something works. Beliefs evolve — they start as hunches and mature as evidence accumulates.
- **Decision** — a choice you've made or are evaluating, with the reasoning behind it. What was decided, what was considered, what was rejected.
- **Objective** — something you're aiming for. Clear enough to know when you've hit it, connected to the actions and projects that serve it.
- **Project** — a bounded piece of work. Scope, milestones, team, constraints, and status. Projects serve objectives and generate entries constantly.

**Govern — encode your judgment so AI can act on your behalf:**
- **Principle** — your non-negotiables. The rules and standards that don't bend regardless of context. The foundation Govern mode is built on.
- **Skill** — a repeatable capability. How to do something well, step by step, with the knowledge needed to execute it.
- **Agent** — the specification for an AI agent. Its role, tools, constraints, and the knowledge it has access to.
- **Voice** — how you or your organisation communicates. Tone, style rules, what to avoid, and examples of the voice in practice.

When you create a wiki, you choose its type. That type determines the wiki's structure — what sections it has, what kind of fragments are most relevant, and how the wiki body gets synthesised. A Belief wiki works differently from a Log wiki, which works differently from a Voice wiki.

You don't need one of each type on day one. Start with whatever types match how you actually think and work. The types are here to help you be intentional about what kind of knowledge you're building.

### Guidelines for good wikis

- **Name them like you'd name a belief or a territory, not a filing cabinet.** "How AI is reshaping professional services" is better than "AI Notes". "The case for African tech talent" is better than "Africa Research".
- **Start with 3-5 wikis.** You can always add more.
- **Mix types based on what you actually need.** If you're in Observe mode, start with a Log and a Research wiki. If you're in Drive mode, maybe a Belief and a Project. If you already have strong views, a Principle wiki might be where you start.
- **Don't worry about overlap.** Fragments can belong to multiple wikis. That's the whole point.
- **Ignore Collections for now.** You'll see a Collections section in the Robin app sidebar — these are optional buckets for grouping wikis once your knowledge base grows. With 3-5 wikis you don't need them. Revisit when your sidebar starts feeling cluttered.

### Two controls, two jobs — Description vs Structure

Each wiki has **two distinct levers**, and they do completely different things. New users confuse them constantly. Get this right and the rest of the system makes sense.

**Description = "what fragments belong in this wiki?"**
Robin uses the description to decide whether an incoming fragment routes into this wiki. It's the **router**. A vague description means Robin guesses; fragments end up in the wrong place. A specific description means accurate routing.

A good description answers: what is this wiki about, what kind of knowledge belongs here, and what doesn't. It doesn't need to be long — it needs to be clear.

Example of a weak description: "Stuff about AI and jobs."

Example of a strong description: "How AI is changing the division of labour between humans and machines, with a focus on which tasks are being automated, which are being augmented, and what new roles are emerging. Particularly interested in the African context and the outsourcing industry."

**Structure = "how does this wiki read once it has fragments?"**
Each wiki also has a structure — a section template that Robin uses when synthesizing the wiki body. It's the **layout**. The default comes from the wiki's type (a Belief wiki has different sections than a Decision wiki). You can customize it in the wiki's settings, or hit "Revert to default" to restore the type's default.

The structure controls **what the wiki looks like when you read it** — not what gets routed into it.

**The key distinction:**
- Description = the door. Who gets in?
- Structure = the room. How is it laid out?

**On day one:** focus your energy on **descriptions**. Leave structures as the type's default — they're already designed for the kind of knowledge that type holds. Once a wiki has accumulated fragments and you have a feel for how you want to read it, revisit the structure. Both are editable any time.

### Create your wikis in Robin

This is the step where you leave this conversation and go to the Robin app. Wiki creation happens in Robin — that's where you set the name, choose the type, write the description, and (optionally) review the default structure.

### Prompt the user

Based on what they told you in Step 2, and which mode resonated in Step 3, suggest 3-5 wikis. For each one, propose a name, a type, and a draft description. Explain why you chose that type. Ask them to react — edit, add, remove, change types.

Once the user is happy with the list, tell them:

> Now go to the Robin app and create these wikis. For each one, set the name, choose the type, and paste in the description. Once they're created, come back here and we'll start logging your first entries.

**During onboarding, send the user to the app.** This isn't because Claude can't create wikis — `Robin:create_wiki` works fine. It's because new users need to get comfortable with the app and take ownership of their structure from the start. The first few wikis should be created by the user's own hands.

**Once the user is established, Claude may create wikis via `Robin:create_wiki`** — but only when the user has provided a clear name, a clear type, and a real description. A bad wiki corrupts Robin's routing forever; the wrong type means the wiki has the wrong structure; a vague description means fragments land in the wrong place. The MCP tool enforces all three at the schema level (any caller hits a hard wall without them) — your job is to make sure the three are *good*, not just present. See "Creating Wikis Well" in Part 2 for the quality bar.

---

## Step 5: Set Up Your Meeting Notes Pipeline

Meetings are one of the richest sources of knowledge. But they only become knowledge if they flow into Robin. Instead of just talking about this — let's do it. We're going to take a real meeting and walk it through the full process.

### 5a: Check their transcription setup

Ask:
> How do your meetings get recorded? Do you use a transcription tool like Fellow, Otter, Fireflies, or similar? If so, is it connected to Claude via MCP?

If they don't have transcription set up, discuss options and move to Step 6 — they can come back to this step later.

If they do have a transcription tool with MCP access, proceed.

### 5b: Pick a recent meeting

Ask:
> Let's test this with a real meeting. Pick a recent one — ideally one that had some substance, not just a quick check-in. Which meeting should we use?

Use the transcription tool's MCP to find and pull the meeting. If the tool supports search (e.g., Fellow's `search_meetings`), help the user find the right one.

### 5c: Pull the transcript and check attribution

Pull the transcript for the chosen meeting. Before doing anything else, check the speaker labels:

- **Names present and clear** (e.g., `[00:02:14] Karen Kimami: We've been using Meltwater...`) — great. Tell the user: "Your transcription tool labels speakers by name, which means your meetings will flow into Robin cleanly. When you say 'log this meeting,' I can trust who said what."

- **Names missing or generic** (e.g., "Speaker 1", "Unknown") — flag it. Tell the user: "Your transcription tool isn't labelling speakers by name. That means when we log meetings, I'll need to extract the key fragments and ask you to tell me who said each one. It adds a step, but it's important — Robin needs to know who said what at the fragment level."

### 5d: Log the meeting to Robin

Now actually do it. Walk the user through their first meeting log:

1. Show the user what you're about to send — the transcript with metadata tags (Channel, Uploaded by, Attribution, Context).
2. Check for any sensitive content and flag if present.
3. Confirm with the user: "Ready to log this to Robin?"
4. Call `Robin:log_entry` with the structured content.
5. Confirm what was logged.

This is the user's first real entry — make it count. Explain what happens next: Robin will process the transcript, extract fragments, and route them to relevant wikis. The user can go to the Robin app to see what was created.

### 5e: Document the pipeline

Note for future reference which path this user's meetings will take:
- **Clean attribution** → meetings can be logged via the short-form capture skill (`log-to-robin-short`)
- **Messy attribution** → meetings route through the long-form capture skill (`log-to-robin-long`) with manual attribution

---

## Step 6: Log More Entries

You've already logged your first entry — a meeting transcript. Now let's build the habit with a different kind of input. Entries are how knowledge gets into Robin. The key thing to understand: you don't need to be precious about entries. They're raw material. Robin's job is to process them. Your job is to be honest and abundant.

### Ways to log entries

- **Via MCP (right here):** Use `Robin:log_entry` to log text directly from this conversation. Great for observations, ideas, or things you're thinking about right now.
- **Via the Robin web app:** For longer material, articles, or when you're not in a Claude conversation.

### What makes a good entry

- **Be specific.** "Had a good meeting with Sarah" is almost useless. "Sarah pushed back on the pricing model — she thinks per-seat doesn't work for NGOs with rotating staff. She suggested a project-based model instead. I think she's right." That's an entry Robin can work with.
- **Include context.** Who said it? When? Why does it matter? The more context in the entry, the better the fragments Robin extracts.
- **Don't self-edit.** If you're thinking it, log it. Not every entry produces gold. But the ones that do are worth the noise.

### Prompt the user

Ask:
> You've already logged a meeting. Now try something different — an article that stuck with you recently, an idea you've been mulling over, or a decision you've been wrestling with. Just talk naturally. I'll log it to Robin.

Use `Robin:log_entry` with their content. Then explain what happens next: Robin will process the entry, extract fragments, and route them to relevant wikis.

---

## Step 7: Using Robin — The Two-Way Loop

So far we've focused on getting knowledge *into* Robin. But Robin isn't a one-way dump. The whole point of building a knowledge base is to use it. Knowledge flows in, and it flows back out — into your work, your writing, your decisions, your tools.

Here's what that looks like in practice:

**Pull beliefs into your writing.** You have two Belief wikis about AI and the future of work. You're drafting a LinkedIn post. Instead of starting from scratch, you ask Claude to read those wikis from Robin and use them as the foundation. Your post is grounded in thinking you've already done — not improvised in the moment.

**Update your tools from Robin.** You've built a Skill in Claude that helps you run a specific workflow. Over the past month, new fragments have accumulated in Robin that refine how that skill should work. You pull the latest from Robin, review what's changed, and update the Claude skill to reflect your current thinking.

**Prepare for a meeting using your wikis.** You're about to meet a client. You ask Claude to pull everything Robin knows about that person and that relationship — fragments from past meetings, decisions you've made, beliefs you hold about their industry. You walk in prepared, with your own accumulated knowledge at your fingertips.

**Let your Govern wikis direct AI behaviour.** Your Principle wiki defines non-negotiables for how your organisation communicates. Your Voice wiki encodes tone and style. When Claude or any other tool generates content, it can read those wikis and operate within your rules — not its defaults.

The key insight: **Robin gets more valuable the more you use it in both directions.** Logging builds the knowledge base. Using it proves the knowledge base works. And the act of using it reveals gaps — things you thought you knew but hadn't captured, wikis that need updating, beliefs that have shifted.

### Prompt the user

Ask:
> Now that you've logged a couple of entries, let's try using Robin. Is there something you're working on right now — a piece of writing, a decision, a meeting coming up — where we could pull from your knowledge base? Let's see Robin work in the other direction.

If they have something, use `Robin:search` or `Robin:get_wiki` to pull relevant knowledge and show them how it feeds into their current work.

---

## Step 8: Establish Your Rhythm

The last step isn't a task — it's a habit. Robin compounds. But only if you use it consistently.

### The daily rhythm

- **Morning:** Scan your wikis. Has anything accumulated overnight (from automated feeds, team inputs)? What's growing? What's stale?
- **During the day:** Log entries as you go. After a meeting, capture the key takeaway. After reading something, log the one thing that stuck with you. After making a decision, log why.
- **Weekly:** Review your wikis. Read the wiki bodies. Are they reflecting your current thinking? Edit them if not. The wiki is your curated position — it should always represent your best current understanding.

### The compounding effect

In week one, Robin feels like a note-taking tool. By month two, your wikis have depth. By month six, you have a genuine knowledge base — an externalised, structured version of your expertise that AI can actually work with. That's when Govern mode comes alive. That's when you stop just capturing knowledge and start deploying it.

### Close the onboarding

> Your knowledge base is set up. You've got wikis, your first entries are logged, and you've seen knowledge flow both ways.
>
> From here, the system gets out of your way. Log entries. Use your wikis. Tend your knowledge. Let it compound.
>
> And remember: Robin is automatic where it makes sense. But it expects you to think where it matters. The more you engage, the more valuable this becomes. Not because the AI gets smarter — but because your knowledge base does. And that's yours.

---

## When You Don't Know the Answer

Claude does not know everything about Robin. Robin is an evolving product with features, settings, and capabilities that may go beyond what's documented in this skill.

If a user asks a question about Robin that you can't confidently answer — how a specific feature works, what a setting does, what's possible in the Robin app — **say so.** Don't guess or improvise.

Tell the user: "I'm not sure about that — you'd want to check in the Robin app directly, or ask the Robin team."

This applies during onboarding and in any future conversation involving Robin. It's always better to be honest about the limits of what you know than to give wrong information about how someone's knowledge system works.

---

## Handling Different Starting Points

Not every user arrives blank. Adapt:

- **User has existing notes/documents they want to import:** Guide them to log entries from their existing material. Start with the 3-5 most important pieces, not everything at once.
- **User is setting up Robin for a team/organisation:** Focus on shared wikis first. Establish naming conventions early. Discuss who governs which wikis.
- **User has been using Robin but wants to reorganise:** Use `Robin:search` to audit what exists. Identify wiki gaps, fragment routing issues, and stale content before restructuring.
- **User is a media monitoring client:** This onboarding still applies, but emphasise briefs, topics, and keywords over personal knowledge tasks. Lean on Research and Log wiki types as the backbone.

---

# PART 2: ROBIN REFERENCE

This section defines Robin's architecture and conventions. The logging skills (`log-to-robin-short`, `log-to-robin-long`) and any future Robin skills should reference these definitions rather than encoding Robin's logic independently.

---

## Core Architecture

### Entries

Raw inputs logged by the user or by automated systems. An entry is unstructured content — a transcript, an article, a thought, a pasted document. Robin's AI pipeline processes entries to extract fragments.

**Key properties:**
- Entries are the ingestion layer. They are never the final form of knowledge.
- One entry can produce many fragments.
- Entries carry metadata: channel, uploaded by, attribution, context (see Metadata section below).
- Users should not worry about formatting or structure — Robin handles processing.

### Fragments

The atomic units of knowledge extracted from entries. A fragment is a single idea, fact, observation, decision, quote, or insight. Fragments are small enough to stand alone and specific enough to be useful.

**Key properties:**
- Robin extracts fragments from entries automatically.
- One fragment can belong to multiple wikis (many-to-many).
- Fragments carry their own attribution — "who said this" at the individual statement level.

**The 7 fragment types** (assigned automatically during extraction; use the most specific that fits):

| Type | Use when… |
|---|---|
| **fact** | A concrete, verifiable statement about something that happened or is true. |
| **idea** | A thought, opinion, hypothesis, or suggestion — not yet acted on. |
| **question** | An explicit or clearly implied question. |
| **action** | A concrete task, commitment, or next step. |
| **quote** | Verbatim words attributed to a specific person. |
| **reference** | A pointer to an external resource — URL, book, paper, tool, repo. |
| **note** | A contextual or metacognitive remark that doesn't fit the others. |

### Wikis

Topics and themes that accumulate fragments over time. Each wiki has a body that synthesises its fragments into a coherent, evolving document — like a Wikipedia page that grows as you feed it.

**Key properties:**
- Wikis are the organising layer of the knowledge base.
- They grow organically as entries are logged and fragments are routed.
- They can also be created deliberately before any content exists.
- Wiki bodies are human-readable and should represent the user's best current understanding of the topic.
- Every wiki has a **type** that determines its default structure and synthesis behaviour.
- Every wiki has a **description** (what fragments belong here — the routing lever) and a **structure** (the section template — the synthesis lever). These are independent controls. See "Description vs Structure" below.

#### Description vs Structure

The two user-controllable levers on a wiki:

- **Description.** Free-text statement of what this wiki is for. Robin matches incoming fragments against the description to decide whether they belong. Editable any time. Vague description → misrouted fragments. Specific description → accurate routing.

- **Structure.** A section template (markdown headings + prose prompts) Robin uses when synthesizing the wiki body from accumulated fragments. Each wiki **type** ships with a `default_structure` — the canonical layout for that kind of knowledge (e.g. Belief: Core Claim / Supporting Points / Counterarguments / Key Quotes). When a wiki is created, that default seeds the wiki's structure. The user can edit the structure in the wiki's settings, or hit "Revert to default" to restore the type's default. On wiki type change, a customized structure is preserved; an untouched default swaps to the new type's default.

**Critical: do not conflate them.** The skill's job when answering user questions is to use the right vocabulary:
- "Why isn't fragment X landing in wiki Y?" → description issue (routing).
- "Why is wiki Y's body laid out this way?" → structure issue (synthesis).
- "I want this wiki to read differently" → structure.
- "I want different kinds of fragments in this wiki" → description.

**The 10 default wiki types** (extensible via `Robin:create_wiki_type`):

| Mode | Type | Purpose |
|---|---|---|
| Observe | **Log** | Capturing what happens, in words or data. Doesn't close — it accumulates. Templates within Log (Journal, Monitor, Playbook, Collection, Tracker) are formatting differences, not type differences. |
| Observe | **Research** | Accumulating signals around a specific subject to make sense of an unfolding pattern. Watching with a question. The pre-Belief stage — the bridge between Observe and Drive. |
| Drive | **Belief** | A position being formed or held, evolving as evidence accumulates |
| Drive | **Decision** | A choice made or being evaluated, with reasoning |
| Drive | **Objective** | Something being aimed for, connected to actions and projects |
| Drive | **Project** | A bounded piece of work with scope, milestones, and status |
| Govern | **Principle** | Non-negotiable rules and standards |
| Govern | **Skill** | A repeatable capability — how to do something well |
| Govern | **Agent** | Specification for an AI agent — role, tools, constraints |
| Govern | **Voice** | How to communicate — tone, style, examples |

### Collections

Optional, user-curated buckets for grouping wikis. Collections only hold wikis (not fragments, people, or entries) and a wiki can belong to multiple collections at once.

**Key properties:**
- User-created and user-managed. Robin does not auto-file wikis into collections.
- Optional — a user with a small number of wikis doesn't need them.
- A wiki can belong to zero, one, or several collections.
- The Robin app sidebar groups wikis by collection; the Explorer page lets users filter by collection.
- Manage via `Robin:list_groups`, `Robin:create_group`, and `Robin:add_wiki_to_group` (the API name "group" is the internal term for what the UI calls a Collection).

### People

A separate dimension that runs across all other objects. People can be the subject of wikis, the source of fragments, participants in entries, and connections across the knowledge base.

**Key properties:**
- People are tracked via `Robin:get_person`.
- Attribution at the fragment level connects to the people layer.
- People can appear throughout the knowledge base — a person might be quoted in one wiki, be the subject of another, and be a participant in entries across many topics.

---

## The Three Modes

Robin organises knowledge around three modes:

**Observe** — capture what's happening. Monitoring, logging, noting. The input layer.

**Drive** — process observations into positions, decisions, plans. The thinking layer.

**Govern** — encode judgment into rules and frameworks that AI can act on. The governance layer.

These form a compounding loop: Observe → Drive → Govern → (informs what you) Observe next.

---

## Metadata

Every piece of content entering Robin should carry three metadata dimensions. Until Robin's API supports dedicated fields for these, they are encoded as tags at the top of the content string.

### Channel

The technical pathway through which content entered Robin. Auto-populated — neither the user nor Claude needs to think about this.

Values: `Claude`, `Web`, `API`. (These map to the underlying `source` enum on `log_entry`: `mcp`, `web`, `api`. The skill convention "Channel: Claude" is the human-readable label for `source=mcp`.)

### Uploaded by

Which human in the organisation sent this content. Auto-populated by Claude from conversation context.

This is about accountability and organisational awareness. "Show me everything Nadene has been logging" is a valid query this enables.

### Attribution

The original authority behind the content. This is "who said it" or "who wrote it." This is the field that carries intellectual weight.

**Rules:**
- At the **entry level**, attribution can include multiple sources (e.g., "Phyl Georgiou, Karen Kimami" for a meeting between them). This acknowledges everyone involved.
- At the **fragment level**, attribution should be per person — "Karen said X" or "Phyl said Y." Robin handles this decomposition when it fragments entries.
- For **articles**: attribution is `Author Name, Publication` (e.g., "Jane Smith, Financial Times").
- For the **user's own thinking**: attribution is the user themselves.
- When a user **relays someone else's idea** ("Chris told me he thinks X"): attribute to Chris, not the user.
- If attribution is **unclear**, Claude should ask before logging.

### Temporary content format

Until the API supports dedicated metadata fields, encode as:

```
[Channel: Claude]
[Uploaded by: {user's name}]
[Attribution: {who said/wrote it}]
[Context: {brief description of where this came from}]

{the actual content}
```

---

## Creating Wikis Well

The MCP `create_wiki` tool requires three fields — `title`, `description`, and `type` — at the schema level. Calling without all three returns a protocol error. But "present" is not the same as "good." A bad wiki — generic name, wrong type, vague description — corrupts Robin's routing the moment it accumulates fragments, and the damage is hard to undo. Claude's job is to protect the user from creating one.

### The protocol

When the user asks you to create a wiki via MCP, follow this every time. **Do NOT infer fields from the title** — even if the title seems self-explanatory.

1. **Ask the user, in their own words, what this wiki is for.** The description is what Robin uses to route future fragments — it must come from the user, not from your own paraphrase. A title like "Parambi Family Travel Planning" is not enough; you need the user's articulation of what kinds of fragments belong here and what doesn't.
2. **Call `Robin:get_wiki_types` and present the type options to the user.** Ask which type fits. Do not infer the type from the title or the description.
3. **Confirm name + type + description back to the user**, then call `Robin:create_wiki` with all three exactly as the user said them.

If the user provides only a title, do NOT call `create_wiki` yet — ask the description and type questions first. Skipping these steps corrupts routing for every future fragment that lands in this wiki.

### The quality bar

Each of the three fields has a threshold beyond just being non-empty:

**Name is territorial, not generic.**
- Bad: "AI Notes", "Africa Research", "Strategy"
- Good: "How AI is reshaping professional services", "The case for African tech talent", "Why we're picking project-based pricing"
- The name should sound like a position, a territory, or a question — not a folder.

**Type is explicitly chosen.**
- If the user is unsure which type fits, walk them through the options `get_wiki_types` returns. Explain the choice: "Sounds like a Belief — a position you're forming. Or is this more Research — still gathering signal?"
- Don't accept "whichever" — make them pick.

**Description defines what belongs and what doesn't.**
- Bad: "Stuff about AI and jobs."
- Good: "How AI is changing the division of labour between humans and machines, with a focus on which tasks are being automated, which are being augmented, and what new roles are emerging. Particularly interested in the African context and the outsourcing industry."
- Vague description = misrouted fragments forever.

If any of the three are weak, refuse to call the tool. Tell the user what's missing — show them the bad/good examples — and help them strengthen it. This friction is the feature.

---

## MCP Tool Reference

Robin exposes 16 MCP tools, grouped here by purpose. Default to the **Capture** and **Read** tools for most conversations — the management tools are for power-user moments.

### Capture — write knowledge into Robin

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:log_entry` | Logs raw text into Robin for AI processing | Default for most logging — meeting notes, observations, ideas, articles. Robin will fragment and route automatically. |
| `Robin:log_fragment` | Places a fragment directly into a specific wiki, bypassing the AI pipeline | When you know exactly which wiki the content belongs to (e.g., seeding a new wiki, or the user has explicitly directed content to a specific wiki). Get wiki slugs from `list_wikis` or `get_wiki` first. |

### Read — pull knowledge out of Robin

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:search` | Hybrid search across fragments, wikis, and people | To find existing content, check what was created, explore connections, or compare new content against existing knowledge |
| `Robin:list_wikis` | Lists all the user's wikis with metadata | To enumerate what wikis exist, get a slug for another tool, or surface the shape of the knowledge base |
| `Robin:get_wiki` | Reads a wiki's body and fragments | To review a wiki's current state, pull its content into a Claude conversation, or audit its accumulation |
| `Robin:get_fragment` | Reads a specific fragment | To examine or discuss a particular piece of knowledge |
| `Robin:find_person` | Looks up a person by name, alias, or key | When discussing people and relationships, or checking if someone is already tracked |
| `Robin:brief_person` | Returns the full structured summary of a tracked person | Once a person is identified, to pull what Robin knows about them — their role, how the user knows them, what they care about |
| `Robin:list_skills` | Lists the skills available in the Robin knowledge base (skills stored as wiki rows under the `skill` wiki type) | To enumerate which skill wikis exist for the user; useful when picking a skill to read or extend. Metadata only; fetch full body via `get_wiki`. |

### Manage wikis

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:create_wiki` | Creates a new wiki — title, description, and type are ALL required | When the user asks Claude to create a wiki. **Always follow the protocol in "Creating Wikis Well" above** — never call without going through it. |
| `Robin:edit_wiki` | Updates a wiki's metadata or content | When the user has explicitly asked to revise an existing wiki's name, description, structure, or body |
| `Robin:get_timeline` | Returns the audit trail / edit history for a wiki | When the user wants to see what's changed in a wiki, when, and why |

### Manage wiki types

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:get_wiki_types` | Lists the available wiki types (slugs and descriptions) | Before creating a wiki to confirm valid type slugs, or to explain the type system to the user |
| `Robin:create_wiki_type` | Defines a new wiki type | Rare — only when the user wants to extend Robin beyond the 10 default types |

### Manage collections (groups of wikis)

| Tool | What it does | When to use it |
|---|---|---|
| `Robin:list_groups` | Lists all collections with wiki counts | To show what collections exist or pick one for filing a wiki |
| `Robin:create_group` | Creates a new collection | When the user wants a new bucket for grouping wikis (e.g., "Personal", "Work") |
| `Robin:add_wiki_to_group` | Adds a wiki to a collection | After creating a wiki, when the user wants to file it into an existing collection |

**Note on terminology:** Robin renamed its API tools from "thread" to "wiki" — so the canonical names are `get_wiki`, `list_wikis`, `create_wiki`, etc. One legacy holdout: the parameter name on `log_fragment` is still `threadSlug` (not `wikiSlug`). Use `threadSlug` as written when calling that tool, even though everywhere else "wiki" is the term. In user-facing conversation, always say "wiki."

---

## Available Robin Skills

These skills work together to support Robin's knowledge system. Each one leans on Part 2 of this guide for architectural definitions.

| Skill | Purpose | When it triggers |
|---|---|---|
| **Robin Knowledge System Guide** (this skill) | Onboarding + reference layer | New user setup, or when other skills need architectural context |
| **Log to Robin (Short)** | Capture short-form content — chat insights, meeting notes, articles under ~2,000 words with clear attribution | User says "log this to Robin" and content is short with clear speakers |
| **Log to Robin (Long)** | Mine long documents and attribution-unclear content for the best fragments. Pre-chunks long input into atomic `log_entry` calls before sending; the server stays naive on entry size by design. | Content over ~2,000 words, or attribution is unclear regardless of length |

---

# PART 3: Common Questions

When the user asks something Claude could plausibly answer from this skill, prefer the canonical answer below. If the question is outside this set, fall back to first principles from Part 2 — and admit uncertainty if the answer isn't in either place.

## Why didn't my fragment land in the wiki I expected?

Almost always a **description** issue (see Description vs Structure). Robin routes fragments by matching them against each wiki's description. If a wiki's description is vague — "Stuff about AI and jobs" — Robin guesses, and a fragment that should have landed there ends up somewhere else (or nowhere).

The fix is to make the description more specific. Edit it in the wiki's settings — say what belongs in this wiki, and what doesn't. Future fragments will route more accurately. Already-landed fragments stay where they are unless the user explicitly re-routes them.

## Where does my data live? Who can see it?

Robin is single-tenant — each user has their own Robin instance with its own Postgres database. Wikis, fragments, entries, and people all live there.

By default, **wikis are private**. A wiki can be explicitly published from the Robin app, which generates a stable URL anyone with the link can read — but this is opt-in per wiki, never automatic.

Robin does call out to LLM APIs (via OpenRouter) to fragment entries and synthesize wiki bodies — content is sent to those providers for processing. If the user is uncomfortable with any data leaving their machine, Robin is the wrong tool.

## Can I rename a wiki?

Yes — in the wiki's settings inside the Robin app. The user-facing name updates everywhere; the slug (used in URLs and backlinks like `[[wiki:my-slug]]`) stays stable so existing references don't break.

Renaming via Claude/MCP is not currently supported — `Robin:edit_wiki` updates the wiki's content body, not its name. Direct the user to the app for renames.

## Why is this wiki's body laid out a certain way?

A **structure** issue (see Description vs Structure). Each wiki has a section template — its structure — that Robin follows when synthesizing the wiki body from fragments. The default comes from the wiki's type (a Belief wiki has Core Claim / Supporting Points / Counterarguments; a Decision wiki has per-Option subsections).

If the user wants the wiki to read differently, they edit the structure in the wiki's settings. They can write their own template, or hit "Revert to default" to restore the type's default. The next time the wiki regenerates, the body will match the new structure.

The user can also edit the **type-level default structure** itself in settings — useful when they want every new Belief wiki (for example) to follow their preferred layout. That changes the default seeded into *future* wikis of that type; existing wikis keep their current structures.

## What's a Collection? Do I need to use them?

Collections are optional buckets for grouping wikis (see Collections in Part 2). The user creates them and files wikis into them; Robin doesn't auto-file. The Robin app sidebar groups wikis by collection.

The user doesn't need them on day one. With 3-5 wikis the sidebar is small; collections add organisation without adding value. They become useful around 15-20 wikis, when the list starts feeling cluttered. Tell the user to add collections when *they* feel the need — not because the system expects them.

## How long does Robin take to process an entry?

Asynchronous — Robin queues the entry, so it doesn't block the user. For a typical short entry (a paragraph or two), expect a few seconds to a minute end-to-end: Robin fragments the entry, embeds the fragments, routes them to wikis, and regenerates affected wiki bodies.

Longer entries (a meeting transcript, a long article) take longer — more to fragment, more to route, more to regenerate. A few minutes is normal for a dense entry.

If after a few minutes the user doesn't see new fragments in their wikis, two possibilities: (1) the pipeline hit an issue — check the Robin app for errors; (2) Robin extracted nothing, because the entry was too short, too vague, or didn't contain anything substantive worth keeping.

## When should I add to an existing wiki vs create a new one?

Simplest rule: **log the entry first, see where Robin routes it.** If fragments land in an existing wiki, that wiki is the right home. If they don't land anywhere, that's a signal a new wiki may be needed.

For the deliberate case:
- **Add to existing** when the new content reinforces, complicates, extends, or contradicts what's already there. A wiki is a *territory* — new fragments should fall within it.
- **Create a new wiki** when the topic is genuinely outside every existing description. Avoid wikis for one-off thoughts — those belong as fragments in an existing wiki, or in a Log wiki.

If the user is unsure: "Could this be a chapter in any of your existing wikis?" If yes, add. If no, sit with it for a few days first — new wikis without a clear reason often duplicate existing ones.

## I have a long document or report — how should I log it?

Don't dump the whole thing into a single entry. Long documents (>~2,000 words) and messy multi-source content (transcripts with unclear speakers, decks covering many topics) work much better when *mined* first.

Use the **`log-to-robin-long`** skill — it reads the document, surfaces the most compelling fragments (novel claims, well-articulated ideas, things that complicate or reinforce what Robin already knows), and asks the user which to keep before logging. The result is a curated set of fragments rather than 10,000 words of raw text for Robin to process. The skill also pre-chunks the approved fragments into one atomic `log_entry` call each; the server is deliberately naive on entry size, so chunking happens client-side in the skill.

This matters because Robin's pipeline is sized for atomic ideas, not full documents. Logging a raw 50-page deck means Robin spends compute fragmenting things the user wouldn't have kept anyway, and the wiki bodies that get synthesized include noise. Mining-first means quality fragments land cleanly and the wikis stay sharp.

For shorter content (~2,000 words or less, with clear attribution — chat insights, meeting transcripts with named speakers, single-author articles), the **`log-to-robin-short`** skill is the right tool. It logs more directly because there's less to filter.

## When should I use Log Short vs Log Long?

Two heuristics, in order:

1. **Length.** Under ~2,000 words → Short. Over → Long. A few hundred words is clearly Short. A 50-page deck is clearly Long.

2. **Attribution clarity.** If speaker labels are clean ("Karen Kimami: …", named author, the user's own words) → Short can handle it. If attribution is messy (transcript with "Speaker 1, Speaker 2", anonymous report, mixed-source doc) → Long, even if the word count would otherwise fit Short. Long has a per-fragment attribution-resolution step that Short skips.

When both heuristics agree, use that skill. When they disagree, attribution wins — Robin's value depends on knowing who said what at the fragment level, and Long is built to get that right.

Edge cases:
- A 2,500-word piece with one through-line and a clear author → Short is fine.
- A 1,500-word piece covering five topics with no attribution → Long.
- A user asking "log this whole conversation" mid-chat → Short (conversational, attribution is clear from context).
- A pasted research report → Long, regardless of size, because the user doesn't want everything kept.

The skills themselves enforce this — if Log Short detects content that exceeds its bar, it reroutes to Log Long automatically.

## What's the difference between log_entry and log_fragment?

Two MCP tools, two different jobs.

**`Robin:log_entry`** is the **default**. The user gives Claude raw text — a meeting transcript, an observation, an article — and Claude calls `log_entry`. Robin's pipeline takes over: extracts atomic fragments, embeds them, routes them to the relevant wikis based on each wiki's description. The user never has to think about which wiki gets what.

**`Robin:log_fragment`** is **manual placement**. The user (or Claude) specifies exactly which wiki a piece of content belongs in, and Robin stores it there as a single fragment. No fragmentation. No routing. The AI pipeline is bypassed.

When to use each:
- **`log_entry`** — normally. If the user said "log this", that's `log_entry`. Robin's job is to handle the messy work of breaking content into atomic fragments and routing them.
- **`log_fragment`** — when the user explicitly directs content to a specific wiki ("save this to my Belief wiki on X"), or when seeding a new empty wiki with a starter idea. Requires the wiki slug — get it from `list_wikis` first.

**The subtle gotcha:** `log_fragment` doesn't fragment the content — whatever you send lands as a single fragment. So if the user wants to manually place a multi-passage piece, don't pass the whole thing as one call. Break it into atomic fragments yourself first (one idea, one quote, or one observation per fragment), then make a separate `log_fragment` call for each. That way each idea lands cleanly and can be related to other fragments.
