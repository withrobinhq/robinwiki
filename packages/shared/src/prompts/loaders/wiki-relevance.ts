import { z } from 'zod'
import { loadSpec, renderTemplate } from '../loader.js'
import { wikiRelevanceSchema } from '../specs/wiki-relevance.schema.js'
import type { PromptResult } from '../types.js'

const inputSchema = z.object({
  wikiName: z.string(),
  threadType: z.string(),
  threadDescription: z.string(),
  threadSummary: z.string().optional(),
  fragmentContent: z.string(),
})

export function loadWikiRelevanceSpec(vars: {
  wikiName: string
  threadType: string
  threadDescription: string
  threadSummary?: string
  fragmentContent: string
}): PromptResult {
  const validated = inputSchema.parse(vars)
  const spec = loadSpec('wiki-relevance.yaml')
  // SEC-H5: every key carries user-authored text (wiki name, thread metadata,
  // fragment body).
  const user = renderTemplate(spec.template, validated, {
    userControlled: [
      'wikiName',
      'threadType',
      'threadDescription',
      'threadSummary',
      'fragmentContent',
    ],
  })
  return {
    system: spec.system_message,
    user,
    meta: {
      temperature: spec.temperature,
      outputSchema: wikiRelevanceSchema,
    },
  }
}
