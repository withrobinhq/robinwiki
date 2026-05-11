import { z } from 'zod'

/**
 * Marcel-emitted citation span. Character offsets are zero-based and
 * half-open against the fragment text the classifier was shown:
 * `text === fragmentText.slice(start, end)`. The agent stage and the
 * persist path validate this invariant before storing the spans on the
 * FRAGMENT_IN_WIKI edge `attrs`. Bad spans are dropped, not coerced.
 */
/**
 * Base shape for a citation span (no cross-field refinements). Used inside
 * wikiClassificationSchema so the LLM-facing structured-output schema stays
 * serializable and a single malformed span cannot reject the full parse.
 */
const citationSpanBaseSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
  text: z.string(),
})

/**
 * Full citation span schema with cross-field validation. Use this for
 * standalone validation (e.g. safeParse on individual spans) outside the
 * LLM structured-output path. The refine rejects spans where end < start.
 */
export const citationSpanSchema = citationSpanBaseSchema.refine(
  (span) => span.end >= span.start,
  { message: 'citationSpan.end must be >= start' }
)
export type CitationSpan = z.infer<typeof citationSpanSchema>

export const wikiClassificationSchema = z.object({
  assignments: z.array(
    z.object({
      wikiKey: z.string(),
      wikiName: z.string(),
      confidence: z.number(),
      reasoning: z.string(),
      // Optional for backward compatibility with v3 callers and to keep
      // the schema permissive when the LLM omits the field on a
      // borderline assignment. Consumers should treat empty/missing as
      // "fall back to post-hoc reconstruction" (see Step 3).
      //
      // Uses the base shape (without cross-field refine) so a single bad
      // span cannot reject the entire classification parse. The classify
      // stage's validateSpans() filters end < start post-parse.
      citationSpans: z.array(citationSpanBaseSchema).optional(),
    })
  ),
  noMatchReason: z.string().optional(),
})

export type WikiClassificationOutput = z.infer<typeof wikiClassificationSchema>
