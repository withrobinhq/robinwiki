import { loadSpec, renderTemplate } from '../loader.js'
import { personSummaryInputSchema } from '../specs/person-summary/person-summary.schema.js'
import type { PromptResult } from '../types.js'

export function loadPersonSummarySpec(vars: {
  canonicalName: string
  aliases: string
  existingBody: string
  fragments: string
}): PromptResult {
  const validated = personSummaryInputSchema.parse(vars)
  const spec = loadSpec('person-summary.yaml', 'person-summary')
  // SEC-H5: every key originates from user-authored text (person names, body,
  // fragment block).
  const user = renderTemplate(spec.template, validated, {
    userControlled: ['canonicalName', 'aliases', 'existingBody', 'fragments'],
  })
  return {
    system: spec.system_message,
    user,
    meta: {
      temperature: spec.temperature,
      outputSchema: personSummaryInputSchema,
    },
  }
}
