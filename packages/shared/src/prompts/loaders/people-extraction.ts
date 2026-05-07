import { z } from 'zod'
import { loadSpec, renderTemplate } from '../loader.js'
import { peopleExtractionSchema } from '../specs/people-extraction.schema.js'
import type { PromptResult } from '../types.js'

const inputSchema = z.object({
  content: z.string(),
  knownPeople: z.string().optional(),
})

export function loadPeopleExtractionSpec(vars: {
  content: string
  knownPeople?: string
}): PromptResult {
  const validated = inputSchema.parse(vars)
  const spec = loadSpec('people-extraction.yaml')
  // SEC-H5: `content` is user-authored; `knownPeople` carries user-authored names.
  const user = renderTemplate(spec.template, validated, {
    userControlled: ['content', 'knownPeople'],
  })
  return {
    system: spec.system_message,
    user,
    meta: {
      temperature: spec.temperature,
      outputSchema: peopleExtractionSchema,
    },
  }
}
