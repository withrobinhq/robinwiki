import { z } from 'zod'

const InputVariableSchema = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean().default(true),
})

const OutputSchema = z.object({
  strict: z.boolean().optional(),
  loose: z.boolean().optional(),
  format: z.string().optional(),
  parse_strategy: z.string().optional(),
})

const FewShotSchema = z.object({
  input: z.string(),
  output: z.string(),
})

export const PromptSpecSchema = z.object({
  name: z.string(),
  version: z.number(),
  category: z.enum(['classification', 'extraction', 'generation', 'scoring']),
  task: z.string(),
  description: z.string(),
  temperature: z.number().min(0).max(2),
  system_message: z.string(),
  template: z.string(),
  // First-class document-structure field (#244). Wiki-type YAMLs declare the
  // canonical layout here; the template body references it as `{{structure}}`.
  // Optional because non–wiki-type specs (fragmenter, classifier, etc.) don't
  // use it. A per-wiki override is stored separately in `wikis.structure`.
  default_structure: z.string().optional(),
  input_variables: z.array(InputVariableSchema),
  output: OutputSchema.optional(),
  few_shot_examples: z.array(FewShotSchema).optional(),
  system_only: z.boolean().optional().default(false),
  display_label: z.string().optional(),
  display_description: z.string().optional(),
  display_short_descriptor: z.string().optional(),
  display_order: z.number().int().optional(),
})

export type PromptSpec = z.infer<typeof PromptSpecSchema>
