---
name: log-to-robin-long
description: Mine long documents, reports, decks, and complex content for knowledge worth capturing in Robin. Use this skill whenever a user wants to log content to Robin that exceeds ~2,000 words OR when speaker attribution is unclear regardless of length. Also trigger when a user uploads a large document and wants to extract the most valuable parts for Robin, or when the log-to-robin-short skill reroutes here due to length or attribution issues. This skill reads the full content, compares it against existing Robin knowledge, surfaces the most compelling fragments for user curation, resolves attribution, and logs approved content. Pre-chunks long content into atomic log_entry calls before sending to Robin (the server stays naive on entry size by design).
---

# Log to Robin (Long)

The miner. Takes a large or complex piece of content — a research report, a 50-page deck, a dense strategy document, a messy transcript with unclear attribution — and extracts what's worth keeping in Robin.

The core difference from Log Short: **the user doesn't want everything logged.** The value is in selection. Claude reads the whole thing, compares it against what Robin already knows, and surfaces the specific pieces worth capturing. The user curates. Then Claude logs what's approved.

This skill also handles content rerouted from Log Short due to unclear speaker attribution. The workflow is the same — narrow down to the compelling fragments first, then resolve who said what.

## Pre-chunking: the contract with Robin's server

Robin's server is **deliberately naive on entry size**. It does not split a giant entry into many. The chunking responsibility lives **in this skill, on the client side**.

What that means in practice:

- A 10,000-word document MUST NOT be sent as a single `log_entry` call. The fragmenter is sized for atomic ideas; handing it 10,000 words wastes compute, produces sloppy fragments, and pushes the cost line.
- This skill's job is to convert "one big document" into "N atomic `log_entry` calls", one per compelling fragment the user approves.
- Each call carries one self-contained idea, quote, observation, decision, or claim — small enough that Robin's downstream fragmenter sees a single unit and produces a single fragment from it.

The cap to keep in mind: roughly **~2,000 words per `log_entry` call**, and ideally far less. If an approved fragment is longer than that, split it further along the natural seam — paragraph break, topic shift, speaker change.

## When this skill activates

**Triggered directly when:**
- User says "log this to Robin" and the content exceeds ~2,000 words
- User uploads a long document (PDF, deck, report) and asks to extract knowledge for Robin
- User references a large piece of content and wants Robin to learn from it

**Rerouted from Log Short when:**
- Content exceeds ~2,000 words
- Speaker attribution is unclear or missing regardless of length
- Content is dense and multi-topic even at shorter lengths

These are heuristics. A 2,500-word piece with one clear through-line might stay with Log Short. A 1,500-word piece covering five topics with no names attached should come here.

## Step 1: Assess what you're working with

Before diving in, get oriented.

**Can Claude read the whole thing in one pass?**
- If yes, proceed to Step 2.
- If the document is too long to process at once, ask the user for guidance: "This is a large document. Want me to work through the whole thing section by section, or should I focus on specific parts? If so, which sections matter most to you?"

**Is this a reroute from Log Short due to attribution issues?**
- If yes, note that attribution resolution will happen in Step 5 after fragments are selected. The first job is still to identify what's compelling.

## Step 2: Ask the user to scope the comparison

Claude needs to know what existing Robin knowledge to compare against. Don't assume — ask.

"Which areas of your knowledge should I compare this against? I can search broadly across Robin, or you can point me to specific wikis."

Three scenarios:
- **User names specific wikis** — Claude pulls those via `Robin:get_wiki` and uses them as the comparison baseline.
- **User says "search broadly"** — Claude runs multiple `Robin:search` queries based on the document's key themes to build a picture of what Robin already knows.
- **User says "just find what's interesting, don't worry about comparison"** — Claude skips the comparison step and extracts based on the content alone.

The comparison isn't mandatory — it makes extraction smarter, but some users just want Claude to pull out the good stuff.

## Step 3: Read and extract

Read the full document (or the scoped sections if the user narrowed it). Identify the fragments worth surfacing.

**What counts as "compelling":**
- **Novel** — Robin doesn't know this yet. New information, new perspectives, new data.
- **Challenging** — contradicts or complicates an existing Belief, assumption, or wiki in Robin.
- **Reinforcing** — adds evidence or depth to something Robin already holds. Strengthens an existing position.
- **Actionable** — implies a decision, a next step, or a change in approach.
- **Clearly articulated** — well-expressed ideas, clean formulations that are worth preserving in their original language.
- **Good quotes** — specific statements from specific people that carry weight, show a perspective, or capture something precisely.

**How many fragments to extract:**
- If the user has specified a number ("give me the top 5"), respect that.
- Otherwise, use judgement. Surface everything genuinely worth keeping — don't artificially cap at 5 if there are 12 good things, and don't pad to 10 if there are only 3.
- If the document is exceptionally rich and you're finding 20+ compelling fragments, flag it: "There's a lot worth capturing here. Want me to show you everything, or should I prioritise the top [number]?"

## Step 4: Present fragments for curation

Show the user what you found. For each fragment:

1. **The content itself** — preserved in its original language. Do not polish or rephrase.
2. **Why it matters** — one or two sentences on why this is worth capturing. Is it novel? Does it challenge something? Is it a particularly good articulation?
3. **Where it connects** — if you did the comparison step, note which Robin wiki this relates to. "This directly feeds your wiki on [X]" or "This contradicts what you currently hold about [Y]" or "This has no home in Robin yet — it's new territory."

Present as a numbered list so the user can easily approve, reject, or discuss individual items.

Example format:
```
**1.** "The real bottleneck isn't model quality — it's that organisations don't know what they believe, so they can't tell the model what to care about."
→ Novel articulation of a core problem. Connects to your Belief wiki on knowledge systems preceding communications systems.

**2.** Karen noted that Meltwater produced 865+ articles of noise despite months of keyword refinement.
→ Concrete evidence for the case against keyword-based monitoring. Reinforces your wiki on Robin's differentiation from traditional tools.
```

After presenting, ask: "Which of these should I log to Robin? All of them, a selection, or want to discuss any first?"

## Step 5: Resolve attribution

Once the user has approved which fragments to keep, resolve attribution for each one.

**If attribution is already clear** (single-author report, named speakers in a transcript), confirm it briefly: "I'll attribute all of these to [Author/Publication] — correct?"

**If attribution is unclear** (the reason this got rerouted from Log Short, or a multi-author document where it's not obvious who said what), go fragment by fragment on the ones that need it:

"For fragment 3 — 'the real bottleneck is organisational belief systems' — who should I attribute this to?"

Don't ask about every fragment if most have obvious attribution. Only flag the ambiguous ones.

**Attribution format:**
- Single person: "Karen Kimami"
- Person + context: "Karen Kimami, Head of Fund Engagement at Gatsby Africa"
- Publication: "Author Name, Publication" (e.g., "Jane Smith, Financial Times")
- Multiple speakers at entry level: "Phyl Georgiou, Karen Kimami" — Robin handles per-fragment attribution downstream.
- User relaying someone else: attribute to the original source, not the user.

## Step 6: Structure and log — one atomic call per approved fragment

This is where the pre-chunking contract lands.

**Default: one `log_entry` call per approved fragment.**

For each fragment the user approved in Step 4 (with attribution resolved in Step 5), make a separate `Robin:log_entry` call. Each call is one self-contained idea Robin can fragment cleanly. Do NOT bundle ten fragments into one call to "save round-trips" — that defeats the whole point of mining.

Per-call content format:

```
[Channel: Claude]
[Uploaded by: {user's name}]
[Attribution: {who said/wrote this specific fragment}]
[Context: {what document this came from, which section, the surrounding situation}]

{the fragment, preserved in its original form}
```

If a single approved fragment is itself longer than ~2,000 words (rare — usually means Step 3 didn't narrow enough), split it along the natural seam (paragraph, topic shift, speaker change) and make multiple calls, each with the same context tag so Robin can reconnect them.

**Alternative: log fragment by fragment to specific wikis.**
If during curation the user said "that one goes in my monitoring differentiation wiki, that one goes in the Gatsby wiki", use `Robin:log_fragment` with the appropriate `threadSlug` for those, and `Robin:log_entry` for any fragment that needs Robin to route. Same one-call-per-fragment rule applies.

**Why not bundle?** Robin's server stays naive on size by design. The fragmenter is built for atomic input. One big bundled call would force the fragmenter to reason over 10,000+ words in a single pass, which produces sloppy fragments and burns compute. The chunking lives here, in the client, on purpose.

**Rules for each call's content body:**
- **Preserve raw language.** Do not polish, summarise, or rephrase. Log exactly what the document says.
- **Convert double quotes to single quotes when transcribing.** Robin's downstream wiki-writing pipeline has a known issue where literal double-quote characters (`"`) in source content can cause truncated wiki output mid-sentence. Whenever you would write a quoted phrase, name, or direct quotation, use single quotes (`'…'`) instead. Apply this as you transcribe — preserve the wording inside the quotes verbatim, only swap the punctuation. Example: source says *Tom said "we should ship by Friday"* → log as *Tom said 'we should ship by Friday'*.
- **Include conversational context** in each call's `[Context:]` tag. Each fragment should carry enough context to be meaningful on its own. Don't just log 'the bottleneck is belief systems' — wrap it: 'In a discussion of why AI-powered communications tools underperform, the author argues that the bottleneck isn't model quality but that organisations don't know what they believe.'
- **Content in languages other than English** — log as-is. Robin handles multilingual content. Do not translate.

## Step 7: Confirm what was logged

After all calls complete, confirm to the user what was sent:

"Logged to Robin: [number] fragments from [document name/description], attributed to [attribution]. [Brief summary of what was captured.]"

This matters because there is no edit or delete via the API. Once logged, it's logged.

## Sensitivity check

Before logging, scan the approved fragments for sensitive material: salary figures, personal health information, internal politics, confidential client data, personal contact details.

If sensitive content is present, flag it: "Some of the approved fragments include sensitive information [specify what]. Still want me to log all of them?"

Do not gatekeep — the user decides. But make sure it's a conscious decision.

## Proactive logging

Same rules as Log Short. Claude may suggest using this skill when **all** of these are true:
- Robin MCP tools are already active in the conversation
- The user has shared or is discussing a substantial document
- The document clearly contains knowledge worth extracting

In this case, Claude suggests: "There's a lot in this document that could be valuable in Robin. Want me to mine it for the best fragments?"

**If Robin hasn't been invoked in the conversation, Claude does not introduce Robin.**

## Handling URLs

If a user shares a URL and says "log this" and the fetched content exceeds ~2,000 words:
1. Fetch the content using `web_fetch`
2. Inform the user this is a longer piece and you'll use the mining approach
3. Attribution is `Author + Publication` (extract from the article)
4. Proceed with the normal Long flow from Step 2

## Edge cases

**Document is long but has one clear through-line.** If a 3,000-word article makes one argument and the whole thing is worth keeping, don't force the mining workflow. Ask: "This is a longer piece but it's focused on one core idea. Want me to log the whole thing as a single entry, or extract the key points?" If the user picks "whole thing", split the article along its own paragraph/section breaks into ~2,000-word atomic calls — never one giant call.

**User says "log this" but there's nothing compelling in the document.** Be honest: "I've read through this and I'm not finding much that's new relative to what Robin already holds. Want me to look again with different criteria, or skip this one?"

**User wants to update something already in Robin.** There are no update or delete tools in the current API. Offer to help: "I can log a new entry clarifying this." Robin will process the new entry and reconcile it with existing knowledge.

**The document references people Robin tracks.** If you encounter names that might exist in Robin's person system, you can use `Robin:find_person` to check and note the connection — but don't let this slow down the extraction workflow.
