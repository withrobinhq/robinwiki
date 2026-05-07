import { z } from 'zod'
import { loadSpec, renderTemplate } from '../loader.js'
import { fragmentRelevanceSchema } from '../specs/fragment-relevance.schema.js'
import type { PromptResult } from '../types.js'

const inputSchema = z.object({
  sourceContent: z.string(),
  candidateContent: z.string(),
})

export function loadFragmentRelevanceSpec(vars: {
  sourceContent: string
  candidateContent: string
}): PromptResult {
  const validated = inputSchema.parse(vars)
  const spec = loadSpec('fragment-relevance.yaml')
  // SEC-H5: both keys are user-authored fragment content.
  const user = renderTemplate(spec.template, validated, {
    userControlled: ['sourceContent', 'candidateContent'],
  })
  return {
    system: spec.system_message,
    user,
    meta: {
      temperature: spec.temperature,
      outputSchema: fragmentRelevanceSchema,
    },
  }
}
