import { z } from 'zod'

/**
 * Marcel-emitted citation span. Character offsets are zero-based and
 * half-open against the fragment text the classifier was shown:
 * `text === fragmentText.slice(start, end)`. The agent stage and the
 * persist path validate this invariant before storing the spans on the
 * FRAGMENT_IN_WIKI edge `attrs`. Bad spans are dropped, not coerced.
 */
export const citationSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: z.string().min(1),
})
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
      citationSpans: z.array(citationSpanSchema).optional(),
    })
  ),
  noMatchReason: z.string().optional(),
})

export type WikiClassificationOutput = z.infer<typeof wikiClassificationSchema>
