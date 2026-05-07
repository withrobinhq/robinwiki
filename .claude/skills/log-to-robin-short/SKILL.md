---
name: log-to-robin-short
description: Capture knowledge from conversations, meeting transcripts, articles, and short-form content into Robin's knowledge system. Use this skill whenever a user says "log this to Robin", "save this to Robin", "send this to Robin", or when Claude recognises something worth preserving during a conversation where Robin MCP tools are already active. Also trigger when processing meeting transcripts for Robin, or when a user shares an article or short piece of content they want captured. This skill handles content under ~2,000 words with clear speaker attribution. If content exceeds ~2,000 words or speaker attribution is unclear/missing, route to the log-to-robin-long skill instead.
---

# Log to Robin (Short)

The translator between conversation and Robin's knowledge system. Claude's job is to take something worth keeping — a chat insight, meeting transcript, article, comment — and package it so Robin can receive, classify, fragment, and route it correctly.

Claude does not classify knowledge types, assign to threads, or fragment content. Robin handles all of that. Claude's job is to make the content string as clean and well-attributed as possible so Robin's pipeline can do its work.

## When this skill activates

The trigger is the word "log" (or similar: "save", "send", "capture") directed at Robin. Claude decides whether to use this skill or the long-form skill based on two factors:

**Use this skill (Short) when:**
- Content is under ~2,000 words AND speaker attribution is clear
- Meeting transcript with named speakers (e.g., `[timestamp] Full Name: content`)
- Single-author article or report
- User's own thinking or insight from a chat
- A clearly-scoped piece of content with obvious authorship

**Route to Log Long instead when:**
- Content exceeds ~2,000 words (research reports, 50-page decks, long strategy docs)
- Speaker attribution is unclear or missing regardless of length (e.g. meeting notes labelled "Speaker 1, Speaker 2")
- Content is dense and multi-topic even at shorter lengths

These are heuristics, not hard rules. A 2,500-word piece with one clear through-line can stay Short. A 1,500-word piece covering five topics with no attribution should go Long.

## Step 1: Figure out what "this" means

"Log this to Robin" is ambiguous. Claude must determine scope before logging anything.

**Take a first guess based on context, then confirm.** Never guess silently, never ask an open-ended "what do you mean?"

Decision logic:
- User just made a single statement and immediately says "log this" → probably means that statement. Confirm: "I'll log your point about [X] — that right?"
- User says "log this" after a long back-and-forth → ambiguous. Propose what you think is the substance: "I think the key insight here was [X]. Want me to log just that, or the broader discussion?"
- User says "log this meeting" or "log this article" → referent is clear, scope may not be. Clarify if needed.
- User says "log this chat" or "log this conversation" → whole-chat intent. Log as a single entry and let Robin fragment it.
- User references something from earlier in the chat → identify the specific moment and confirm.

The goal is a single confident proposal the user can approve or redirect.

## Step 2: Attribution pre-flight

Before logging, scan the content for speaker attribution. This determines whether to proceed or reroute.

**Three scenarios:**

1. **Names present and clear** — transcripts with speaker labels like `[timestamp] Full Name: content`, single-author articles, user's own words. Proceed to Step 3.

2. **Names missing or generic** — "Speaker 1", "Unknown", no labels at all. If the content is short enough to parse, ask the user: "I'm seeing Speaker 1 and Speaker 2 but no names — who was in this meeting?" Once clarified, proceed. If it's too tangled to untangle who said what, reroute to Log Long — it will extract the most compelling fragments and ask the user to attribute each one.

3. **Single source, obvious attribution** — an article by a named author, the user's own insight, a quote from a specific person. Attribution is clear. Proceed.

## Step 3: Sensitivity check

Before logging, briefly scan the content for sensitive material: salary figures, personal health information, internal politics, confidential client data, personal contact details.

If sensitive content is present, flag it: "This includes some sensitive information [specify what]. Still want me to log all of it to Robin?"

Do not gatekeep — the user decides. But make sure it's a conscious decision.

## Step 4: Structure the content for Robin

Robin's `log_entry` API currently accepts two fields: `content` (string) and `source` (mcp/api/web).

Until the API supports dedicated metadata fields, encode metadata as clear tags at the top of the content string, then include the actual content below.

### Content format

```
[Channel: Claude]
[Uploaded by: {user's name}]
[Attribution: {who said/wrote it}]
[Context: {brief description of where this came from}]

{the actual content, preserved in its original form}
```

**Rules for the content body:**
- **Preserve raw language.** Do not polish, summarise, or rephrase. Robin's pipeline will handle processing. If someone said 'it took a lot of human effort to sift through,' log exactly that — not 'the process required significant manual filtering.'
- **Convert double quotes to single quotes when transcribing.** Robin's downstream wiki-writing pipeline has a known issue where literal double-quote characters (`"`) in source content can cause truncated wiki output mid-sentence. Whenever you would write a quoted phrase, name, or direct quotation, use single quotes (`'…'`) instead. Apply this as you transcribe — preserve the wording inside the quotes verbatim, only swap the punctuation. Example: source says *6 September is "Cousins Olympics" day* → log as *6 September is 'Cousins Olympics' day*.
- **Preserve speaker attribution inline.** If the source is a transcript, keep the speaker labels: "Karen: We've been using Meltwater which was giving us a lot of noise." (NB: even speaker-labelled transcripts should follow the single-quote rule for any phrase the speaker quoted within their own utterance.)
- **Include conversational context.** Don't log a bare insight stripped of its origin. Instead of just 'attribution should be per-fragment not per-entry,' log: 'During a discussion about Robin's knowledge capture architecture, Phyl identified that attribution should work differently at entry vs fragment level — entries can carry multiple sources but fragments should carry single-person attribution.'
- **For meeting transcripts, use the full transcript** as the content, not any AI-generated summary. Summaries flatten attribution. The transcript preserves who said what. Include the full transcript and let Robin fragment it.

### Metadata guidance

**Channel:** Always `Claude` when logging from a Claude conversation.

**Uploaded by:** The user Claude is talking to. Infer from conversation context.

**Attribution:** The original authority behind the content. This is "who said it" or "who wrote it."
- User's own thinking → attribute to the user
- Meeting transcript → attribute to all participants at the entry level (e.g., "Phyl Georgiou, Karen Kimami"). Robin will handle per-fragment attribution downstream.
- Article → attribute as `Author Name, Publication` (e.g., "Jane Smith, Financial Times")
- User relaying someone else's idea ("Chris told me he thinks X") → attribute to Chris, not the user
- If attribution is unclear, ask.

**Context:** A one-line description of the origin. Examples:
- "From a conversation between Phyl and Claude about Robin's skill architecture"
- "Meeting transcript: Karen Kimami and Phyl Georgiou, April 9 2026"
- "Article shared by user"

## Step 5: Log to Robin

Call `Robin:log_entry` with the structured content string and `source: "mcp"`.

**When to use `log_fragment` instead:**
Only if the user has explicitly directed content to a specific wiki, or the conversation is already operating within a specific wiki context (e.g., Claude has already been reading from or writing to a particular wiki via `Robin:get_wiki`). In that case, use `Robin:log_fragment` with the appropriate `threadSlug` (legacy parameter name — Robin renamed thread→wiki everywhere except this single argument on `log_fragment`).

Default to `log_entry`. Let Robin route.

## Step 6: Confirm what was logged

After a successful log, confirm to the user what was sent. Keep it brief:

"Logged to Robin: [one-line summary of what was captured, attributed to whom, from what context]."

This matters because there is no edit or delete via the API. Once logged, it's logged. The confirmation gives the user a last-check moment.

## Proactive logging

Claude may suggest logging when **all** of these are true:
- Robin MCP tools are already active in the conversation (calls to `search`, `get_wiki`, `list_wikis`, `log_entry`, `log_fragment`, `find_person`, or `brief_person` have been made)
- Something worth preserving surfaces — a decision, a belief, a realization, a key piece of information
- The user hasn't explicitly asked to log

In this case, Claude suggests: "That point about [X] sounds worth logging to Robin — want me to capture it?"

**If Robin hasn't been invoked in the conversation, Claude does not introduce Robin.** No unsolicited "would you like to save this to Robin?" in conversations that aren't about Robin.

## Handling URLs and articles

If a user shares a URL and says "log this":
1. Fetch the content using `web_fetch`
2. Assess length — if over ~2,000 words, reroute to Log Long
3. If under ~2,000 words, discuss with the user: "I've pulled the article. Want me to log the whole thing, or should I focus on the key points?"
4. Attribution is `Author + Publication` (extract from the article)
5. Proceed with the normal flow

## Edge cases

**User says "log this" but there's nothing obviously worth logging.** Ask: "What specifically would you like me to capture? I want to make sure I get the right thing."

**Multiple insights from one conversation.** Log as a single entry. Robin handles fragmentation — it will break the entry into separate fragments and route them appropriately.

**Content in a language other than English.** Log as-is. Robin handles multilingual content. Do not translate.

**User wants to update something already in Robin.** There are no update or delete tools in the current API. Offer to help: "I can log a new entry clarifying this." Robin will process the new entry and reconcile it with existing knowledge.
