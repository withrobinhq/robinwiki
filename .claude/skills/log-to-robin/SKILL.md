---
name: log-to-robin
description: Captures content into Robin's knowledge base via MCP. Use when the user says "log this to Robin", "save this to Robin", or "send this to Robin" — or when Robin MCP tools are active and Claude spots something worth preserving (a decision, belief, key insight, or substantial document). Handles short content with clear attribution (chat insights, single-author articles, attributed transcripts under ~2,000 words) and long or complex content needing curation (research reports, long decks, dense multi-topic content, transcripts with unclear attribution).
---

# Log to Robin

The bridge between conversation and Robin's knowledge system. Claude takes something worth keeping — a chat insight, meeting transcript, article, research report — and packages it so Robin can classify, fragment, and route it. Claude does not classify knowledge types or fragment content; Robin handles that. Claude's job is clean, well-attributed input.

Two modes:
- **Quick** — short content with clear attribution. Log as-is.
- **Mining** — long or complex content. Read it, surface compelling fragments, let the user curate, log what's approved.

**The first thing this skill does is decide which mode.** When it's not obvious, ask the user before anything else.

## Step 1: Decide quick or mining mode

**Heuristic:**

| Signal | Quick | Mining |
|---|---|---|
| Length | Under ~2,000 words | Over ~2,000 words |
| Attribution | Clear speaker(s) named | Missing, unclear, or "Speaker 1 / Speaker 2" |
| Density | One main idea, or a clean transcript | Multi-topic, dense, or mixed sources |
| User intent | "log this" — capture it wholesale | "extract the best bits", "find what's worth keeping" |

### When the choice is clear, proceed

E.g. a 500-word chat insight → **Quick**. A 12,000-word strategy deck → **Mining**.

### When it's not clear, ask the user

Don't guess. Cases that warrant asking:

- Borderline length (~1,500–3,000 words).
- Long but one clear through-line, or short but covers many topics with no single attribution.
- Mixed attribution (named speakers in some sections, missing in others).
- The user said "log this" with no signal about whether they want everything captured or curated.

**Ready-to-use question:**

> "Two ways I can handle this: (a) **Quick** — log the whole thing in one go with the attribution you give me, or (b) **Mining** — I read through it, surface the most compelling bits, and you decide which to keep. Which fits what you want?"

Once mode is decided, follow the matching path below, then converge on the shared **Format and log** section.

---

# Quick mode

## Quick · Step A: Figure out what "this" means

"Log this to Robin" is ambiguous. **Take a first guess based on context, then confirm.** Never guess silently, never ask open-ended "what do you mean?"

Decision logic:
- User just made a statement, then "log this" → that statement. Confirm: "I'll log your point about [X] — that right?"
- "Log this" after a long back-and-forth → propose the substance: "I think the key insight was [X]. Want just that, or the broader discussion?"
- "Log this meeting / article" → referent is clear, scope may not be. Clarify if needed.
- "Log this chat / conversation" → whole-chat intent. Log as a single entry; Robin fragments it.

## Quick · Step B: Attribution pre-flight

Scan for speaker attribution.

- **Clear** (named speakers, single-author article, user's own words) — proceed to Step C.
- **Missing or generic** ("Speaker 1", "Unknown", no labels) — if the content is short enough to parse, ask: "I'm seeing Speaker 1 and Speaker 2 but no names — who was in this meeting?" If it's too tangled, switch to Mining mode — it has a per-fragment attribution step for exactly this.

Once settled, proceed to **Step C**.

## Quick · Step C: Decide `log_entry` vs `log_fragment`

Two calls, two different jobs. Pick deliberately.

| | `Robin:log_entry` (default) | `Robin:log_fragment` |
|---|---|---|
| **What Robin does with it** | Robin's pipeline fragments the entry, classifies each fragment, and routes it across wikis. The content can land in multiple wikis at once. | The content is filed directly as a fragment in one specific wiki. No fragmentation by Robin, no cross-wiki routing. |
| **Use when** | Default. The user wants Robin to figure out where this belongs. | The user has explicitly named a wiki, or the conversation is already operating within one specific wiki context. |
| **Parameter** | None — Robin handles routing | `threadSlug` (legacy parameter name — Robin renamed thread→wiki everywhere except this one argument on `log_fragment`) |

**Default to `log_entry`.** Routing across wikis is what Robin is *for*. Let it do its job unless the user has overridden.

Switch to `log_fragment` only when:
- The user has explicitly directed the content to a named wiki: "Log this in my [X] wiki", "save this directly under [Y]".
- The conversation context makes the target wiki unambiguous (Claude has just been reading or writing it via `Robin:get_wiki`, the user has been editing it, the discussion has been scoped to that single wiki).

**If it's not obvious which call to use, ask.** Ready-to-use:

> "Want this routed by Robin across wikis (it'll fragment and allocate automatically), or filed directly into a specific wiki? If the latter — which one?"

Once decided, jump to **Format and log** below.

---

# Mining mode

**The user doesn't want everything logged — the value is in selection.** Claude reads the document, compares it against what Robin already knows, surfaces the specific pieces worth capturing, the user curates, Claude logs what's approved.

Also handles content bounced from Quick for unclear attribution — workflow is the same; resolve attribution after curation.

## Mining · Step A: Assess what you're working with

**Can Claude read the whole thing in one pass?**
- If yes, proceed to Step B.
- If the document is too long to process at once, ask the user: "This is a large document. Want me to work through the whole thing section by section, or should I focus on specific parts? If so, which sections matter most to you?"

## Mining · Step B: Compare against Robin's existing knowledge

**This is the heart of Mining mode.** Without the comparison, Claude is curating against its own priors — and "novel", "challenging", "reinforcing" only mean anything *relative to Robin*. Skip this and those judgments collapse into Claude's subjective read.

**Default: compare.** Ask the user where to anchor:

> "I want to compare this against what's already in Robin so I can flag which parts are genuinely new, which reinforce what you hold, and which complicate it. Should I search broadly across your knowledge base, or focus on specific wikis you have in mind?"

Three options, descending preference:

- **User names specific wikis** — pull via `Robin:get_wiki`; use them as the baseline.
- **User says "search broadly"** — run multiple `Robin:search` queries against the document's key themes.
- **User explicitly says "skip comparison"** — only then proceed without it. Say once what's lost: "Without comparing against Robin, I'll pick what looks compelling from the document itself, not what's specifically new or reinforcing relative to your knowledge base. Still want me to proceed?"

Don't volunteer the skip option. It's there for when the user actively wants it.

## Mining · Step C: Read and extract

Read the document (or the scoped sections). Identify fragments worth surfacing.

**Criteria — Robin-grounded first.** These three are statements about how the document relates to Robin's *actual* knowledge state, not Claude's opinions about what feels interesting. Lead curation with them.

- **Novel relative to Robin** — Robin's existing wikis don't already say this. (Note "relative to Robin", not "feels new to Claude".)
- **Challenging Robin** — contradicts or complicates a Belief, decision, principle, or claim already in the knowledge base. Forces a defend-or-update moment.
- **Reinforcing Robin** — adds evidence, depth, or a new angle to something Robin already holds. Strengthens a position with citable material.

These three are document-level judgments — supplemental signal once the Robin-grounded ones have been applied, or the sole criteria when Step B was skipped.

- **Actionable** — implies a decision, next step, or change in approach.
- **Clearly articulated** — well-expressed ideas worth preserving in their original language.
- **Good quotes** — specific statements that carry weight or capture something precisely.

**How many:**
- User specified a number? Respect it.
- Otherwise, use judgement — don't cap at 5 if there are 12 good ones, don't pad to 10 if there are only 3.
- 20+? Flag it: "There's a lot worth capturing. Want me to show everything, or prioritise the top [number]?"

## Mining · Step D: Present fragments for curation

**Lead each fragment's rationale with its relationship to Robin's knowledge base** — that's the basis curation came from, so it should be the basis the user sees.

For each fragment:

1. **The content itself** — preserved in its original language. Do not polish or rephrase.
2. **How it relates to Robin** — the Robin-grounded judgment that earned its place. Be specific about which wiki, position, or gap:
   - **Novel**: "Robin has no current coverage of [X]; this would create new territory." Or: "Your wiki on [Y] doesn't address this angle; this would extend it."
   - **Challenging**: "Your wiki on [X] holds [position]; this complicates it by [way]."
   - **Reinforcing**: "Your wiki on [X] argues [position]; this adds [evidence/angle/depth]."
3. **Why it carries weight on its own** (optional, only when it adds something) — clear articulation, particularly good quote, etc.

If Step B was skipped, the rationale falls back to (3) only — make that visible. Don't pretend a Robin-grounded judgment was made when it wasn't.

Present as a numbered list so the user can approve, reject, or discuss individual items.

Example format (with comparison done — the default path):
```
**1.** "The real bottleneck isn't model quality — it's that organisations don't know what they believe, so they can't tell the model what to care about."
→ **Reinforces** your Belief wiki "Knowledge systems must precede communications systems": the article makes the same claim from the model-deployment angle, where your wiki currently argues from the organisational-clarity angle.

**2.** Karen noted that Meltwater produced 865+ articles of noise despite months of keyword refinement.
→ **Reinforces** your wiki on Robin's differentiation from traditional monitoring tools with a concrete number. Your wiki currently states the case in general terms; this gives you a specific figure you can cite.

**3.** "AI agents will exhibit personality drift over long conversations — they start coherent and end somewhere else."
→ **Novel** relative to Robin: no current wiki on personality drift; your AI-alignment / agent-behaviour wikis don't touch this. New territory.
```

Example format (with comparison skipped — Step B's explicit opt-out path):
```
**1.** "The real bottleneck isn't model quality — it's that organisations don't know what they believe..."
→ Clearly articulated; carries the argument well. (No Robin comparison was done — worth checking whether you already hold this position before logging.)
```

After presenting, ask: "Which of these should I log to Robin? All of them, a selection, or want to discuss any first?"

## Mining · Step E: Resolve attribution

Once approved, resolve attribution for each fragment.

- **Clear** (single-author report, named speakers) — confirm once: "I'll attribute all of these to [Author/Publication] — correct?"
- **Unclear** (Quick → Mining bounce, or multi-author with ambiguous voice) — go fragment by fragment on the unclear ones: "For fragment 3 — '[content]' — who should I attribute this to?"

Don't ask about every fragment. Only flag the ambiguous ones. Then proceed to **Format and log**.

---

# Format and log

Both modes converge here. Everything below applies the same way, except the content-format template (single piece for Quick, multiple curated fragments for Mining).

## Content format

Robin's `log_entry` API currently accepts two fields: `content` (string) and `source` (mcp/api/web). Until the API supports dedicated metadata fields, encode metadata as clear tags at the top of the content string, then include the actual content below.

**Quick mode — single piece of content:**

```
[Channel: Claude]
[Uploaded by: {user's name}]
[Attribution: {who said/wrote it}]
[Context: {brief description of where this came from}]

{the actual content, preserved in its original form}
```

**Mining mode — multiple curated fragments bundled as one entry:**

```
[Channel: Claude]
[Uploaded by: {user's name}]
[Attribution: {primary attribution for the document}]
[Context: {what this document is and where it came from}]

--- Fragment 1 ---
[Attribution: {if different from primary}]
{content}

--- Fragment 2 ---
[Attribution: {if different from primary}]
{content}

...
```

## Rules for the content body

- **Preserve raw language.** Do not polish, summarise, or rephrase. If someone said *"it took a lot of human effort to sift through,"* log exactly that — not *"the process required significant manual filtering."*
- **Convert double quotes to single quotes when transcribing.** Known issue: literal `"` characters in source content can truncate wiki output mid-sentence. Use single quotes (`'…'`) for any quoted phrase, name, or direct quotation. Preserve the wording verbatim; only swap the punctuation. Example: *6 September is "Cousins Olympics" day* → log as *6 September is 'Cousins Olympics' day*.
- **Preserve speaker attribution inline.** Keep transcript labels: "Karen: We've been using Meltwater..." (Speaker-labelled transcripts still follow the single-quote rule for any nested quotes.)
- **Include conversational context.** Don't log a bare insight stripped of its origin. Instead of *'attribution should be per-fragment not per-entry,'* log: *'During a discussion of Robin's knowledge capture, Phyl argued attribution should work differently at entry vs fragment level — entries can carry multiple sources, fragments should carry single-person attribution.'*
- **Meeting transcripts: use the full transcript,** not an AI-generated summary. Summaries flatten attribution; the transcript preserves who said what. Let Robin fragment it.
- **Languages other than English: log as-is.** Robin handles multilingual. Do not translate.

## Attribution guidance

- **Channel:** Always `Claude` when logging from a Claude conversation.
- **Uploaded by:** The user Claude is talking to. Infer from context.
- **Attribution:** The original authority behind the content. "Who said it" / "who wrote it":
  - User's own thinking → attribute to the user.
  - Meeting transcript → attribute to all participants at the entry level (e.g., "Phyl Georgiou, Karen Kimami"). Robin handles per-fragment attribution downstream.
  - Article → `Author Name, Publication` (e.g., "Jane Smith, Financial Times").
  - User relaying someone else's idea ("Chris told me he thinks X") → attribute to Chris, not the user.
  - Person + role context if helpful: "Karen Kimami, Head of Fund Engagement at Gatsby Africa".
  - If unclear, ask.
- **Context:** A one-line description of the origin. Examples:
  - "From a conversation between Phyl and Claude about Robin's skill architecture"
  - "Meeting transcript: Karen Kimami and Phyl Georgiou, April 9 2026"
  - "Article shared by user"

## Sensitivity check

Before logging, scan the content (Quick mode) or the approved fragments (Mining mode) for sensitive material: salary figures, personal health information, internal politics, confidential client data, personal contact details.

If sensitive content is present, flag it: "This includes some sensitive information [specify what]. Still want me to log all of it to Robin?"

Do not gatekeep — the user decides. But make sure it's a conscious decision.

## Call Robin

Call whichever you chose during the mode-specific path:

- **`Robin:log_entry`** — pass `content`, `source: "mcp"`, and structured metadata:
  - `type` — infer from content: `article` for written pieces with a byline, `transcript` for multi-speaker conversations, `email` for messages with a From header, `document` for uploaded files, `thought` for personal reflections (default).
  - `authors` — extract from attribution: pass as an array of names (e.g. `["Sarah Mwangi", "Barzan Mozafari"]`). Do NOT put attribution only in the content text — pass it as this parameter so Robin can create structured authorship edges.
  - Robin handles fragmentation and cross-wiki routing.
- **`Robin:log_fragment`** — pass the content, the target wiki's `threadSlug`, and optionally `authors`. Lands directly in that wiki, no routing.

The decision was made in **Quick · Step C** or implicitly during Mining curation. If you got here without making it, go back and make it — don't pick by default mid-call.

Mining default: bundle all approved fragments into one `log_entry` so Robin routes each across wikis. Switch to fragment-by-fragment `log_fragment` only if the user has already specified which wiki each fragment belongs to. Don't push that direction unless they're already thinking in those terms.

## Confirm what was logged

After a successful log, confirm to the user what was sent.

- Quick: "Logged to Robin: [one-line summary of what was captured, attributed to whom, from what context]."
- Mining: "Logged to Robin: [number] fragments from [document name/description], attributed to [attribution]. [Brief summary.]"

No edit or delete via the API — once logged, it's logged. The confirmation is the user's last-check moment.

---

## Proactive logging

Claude may suggest logging when **all** of these are true:

- Robin MCP tools are already active in the conversation (calls to `search`, `get_wiki`, `list_wikis`, `log_entry`, `log_fragment`, `find_person`, or `brief_person` have been made).
- Something worth preserving surfaces — a decision, a belief, a realization, a key piece of information, or a substantial document.
- The user hasn't explicitly asked to log.

For a short item: "That point about [X] sounds worth logging to Robin — want me to capture it?"

For a substantial document: "There's a lot in this document that could be valuable in Robin. Want me to mine it for the best fragments?"

**If Robin hasn't been invoked in the conversation, Claude does not introduce Robin.** No unsolicited "would you like to save this to Robin?" in conversations that aren't about Robin.

## Handling URLs and articles

If a user shares a URL and says "log this":

1. Fetch the content using `web_fetch`.
2. Assess length and attribution, then re-run **Step 1** with the fetched content to decide Quick vs Mining (so the same mode decision happens whether content was pasted directly or fetched from a URL).
3. Attribution is `Author + Publication` (extract from the article).
4. Proceed via the chosen mode.

## Edge cases

- **"Log this" but nothing obviously worth logging.** Ask: "What specifically would you like me to capture? I want to make sure I get the right thing."
- **Multiple insights from one conversation (Quick mode).** Log as a single entry. Robin handles fragmentation — it will split the entry into separate fragments and route them.
- **Document is long but has one clear through-line.** This is exactly the kind of borderline case Step 1 is designed for — ask the user: "This is longer but focused on one core idea. Want me to log the whole thing as a single entry (Quick), or extract the key points (Mining)?"
- **User wants to update something already in Robin.** There are no update or delete tools in the current API. Offer to help: "I can log a new entry clarifying this." Robin will process the new entry and reconcile it with existing knowledge.
- **Document references people Robin tracks.** In Mining mode, you can use `Robin:find_person` to check and note the connection — but don't let this slow down the extraction workflow.
- **"Log this" on a long document but nothing compelling inside.** Be honest: "I've read through this and I'm not finding much that's new relative to what Robin already holds. Want me to look again with different criteria, or skip this one?"
