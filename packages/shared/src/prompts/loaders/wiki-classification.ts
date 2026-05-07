import { z } from 'zod'
import { loadSpec, renderTemplate } from '../loader.js'
import { wikiClassificationSchema } from '../specs/wiki-classification.schema.js'
import type { PromptResult } from '../types.js'

const inputSchema = z.object({
  content: z.string(),
  wikis: z.string(),
  // Optional at the loader boundary so callers that haven't been wired
  // through yet still compile. Falls back to a generic "the owner" label
  // for the [AUTHORSHIP] block — keeps the prompt grammatical even
  // before the owner-Person seed has run on a fresh DB.
  ownerName: z.string().optional(),
  fragmentContext: z.string().optional(),
})

export function loadWikiClassificationSpec(vars: {
  content: string
  wikis: string
  ownerName?: string
  fragmentContext?: string
}): PromptResult {
  const validated = inputSchema.parse(vars)
  const ownerName =
    validated.ownerName && validated.ownerName.trim().length > 0
      ? validated.ownerName
      : 'the owner'
  const spec = loadSpec('wiki-classification.yaml')
  // SEC-H5: every variable carries user-authored text — fragment content,
  // wiki list, owner name, and any inline fragment context.
  const user = renderTemplate(
    spec.template,
    { ...validated, ownerName },
    { userControlled: ['content', 'wikis', 'ownerName', 'fragmentContext'] }
  )
  return {
    system: spec.system_message,
    user,
    meta: {
      temperature: spec.temperature,
      outputSchema: wikiClassificationSchema,
    },
  }
}
