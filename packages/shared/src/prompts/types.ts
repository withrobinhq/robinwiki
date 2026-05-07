import type { z } from 'zod'

/** Return type for all prompt spec loader functions */
export interface PromptResult {
  system: string
  user: string
  meta: {
    temperature: number
    outputSchema: z.ZodType
  }
  /**
   * Names of forbidden user-override fields that the runtime loader silently
   * stripped from a user-supplied YAML blob. Empty (or absent) for the disk-
   * default and the per-wiki systemMessage-append paths. Callers that have a
   * database connection should emit an audit row when this is non-empty.
   */
  strippedFields?: string[]
}
