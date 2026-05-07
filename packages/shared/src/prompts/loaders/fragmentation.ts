import { z } from 'zod'
import { loadSpec, renderTemplate } from '../loader.js'
import { fragmentationSchema } from '../specs/fragmentation.schema.js'
import type { PromptResult } from '../types.js'

const inputSchema = z.object({
  content: z.string(),
  context: z.string().optional(),
})

/**
 * Compute hard fragment ceiling from word count.
 *
 * v6 dropped the prompt-side `target` nudge — atomicity is now judged by
 * topic coherence, not by length. The ceiling is still useful as a code
 * safety net to prevent runaway over-splitting on very long entries, so
 * the function and `target` field are kept for backward compatibility
 * with `packages/agent/src/stages/fragment.ts`.
 *
 * @param wordCount - number of words in the entry content
 * @returns `{ target, ceiling }` — both are code-side caps; neither is
 *   injected into the prompt template.
 */
export function computeFragmentLimits(wordCount: number) {
  const target = Math.max(1, Math.min(30, Math.round(wordCount / 150)))
  const ceiling = target + 5
  return { target, ceiling }
}

export function loadFragmentationSpec(vars: {
  content: string
  context?: string
}): PromptResult {
  const validated = inputSchema.parse(vars)
  const spec = loadSpec('fragmentation.yaml')

  // SEC-H5: `content` and `context` are user-authored fragment text.
  const user = renderTemplate(spec.template, validated, {
    userControlled: ['content', 'context'],
  })
  return {
    system: spec.system_message,
    user,
    meta: {
      temperature: spec.temperature,
      outputSchema: fragmentationSchema,
    },
  }
}
