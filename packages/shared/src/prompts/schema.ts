import { z } from 'zod'

// SEC-L3: yaml is loaded with FAILSAFE_SCHEMA so unquoted scalars arrive as
// strings. `z.coerce.number()` is safe (NaN trips downstream `.int()` /
// `.min()`) but `z.coerce.boolean()` would convert "false" to true — use a
// preprocess that explicitly maps "true"/"false" before booleaning.
const yamlBoolean = (schema: z.ZodTypeAny) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v
    if (v === 'true') return true
    if (v === 'false') return false
    return v
  }, schema)

const InputVariableSchema = z.object({
  name: z.string(),
  description: z.string(),
  required: yamlBoolean(z.boolean().default(true)),
})

const OutputSchema = z.object({
  strict: yamlBoolean(z.boolean().optional()),
  loose: yamlBoolean(z.boolean().optional()),
  format: z.string().optional(),
  parse_strategy: z.string().optional(),
})

const FewShotSchema = z.object({
  input: z.string(),
  output: z.string(),
})

export const PromptSpecSchema = z.object({
  name: z.string(),
  version: z.coerce.number(),
  category: z.enum(['classification', 'extraction', 'generation', 'scoring']),
  task: z.string(),
  description: z.string(),
  temperature: z.coerce.number().min(0).max(2),
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
  system_only: yamlBoolean(z.boolean().optional().default(false)),
  display_label: z.string().optional(),
  display_description: z.string().optional(),
  display_short_descriptor: z.string().optional(),
  display_order: z.coerce.number().int().optional(),
  // Wave G — type-aware HyDE authoring instruction. Loaded into
  // wiki_types.internal_framing on bootstrap. Optional because non
  // wiki-type specs (fragmenter, classifier, etc.) do not need framing.
  internal_framing: z.string().optional(),
})

export type PromptSpec = z.infer<typeof PromptSpecSchema>
