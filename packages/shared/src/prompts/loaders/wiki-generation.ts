import { z } from 'zod'
import { loadSpec, parseUserSpecFromBlobLenient, renderTemplate } from '../loader.js'
import type { PromptResult } from '../types.js'
import type { PromptSpec } from '../schema.js'
import type { WikiType } from '../../types/wiki.js'
import { logWikiSchema } from '../specs/wiki-types/log.schema.js'
import { researchWikiSchema } from '../specs/wiki-types/research.schema.js'
import { beliefWikiSchema } from '../specs/wiki-types/belief.schema.js'
import { decisionWikiSchema } from '../specs/wiki-types/decision.schema.js'
import { projectWikiSchema } from '../specs/wiki-types/project.schema.js'
import { objectiveWikiSchema } from '../specs/wiki-types/objective.schema.js'
import { skillWikiSchema } from '../specs/wiki-types/skill.schema.js'
import { agentWikiSchema } from '../specs/wiki-types/agent.schema.js'
import { voiceWikiSchema } from '../specs/wiki-types/voice.schema.js'
import { principleWikiSchema } from '../specs/wiki-types/principle.schema.js'

/** Base YAML used as scaffold for user-created types that have no shipped YAML. */
const BASE_SPEC_FILENAME = 'belief.yaml'
const BASE_SPEC_SUBDIR = 'wiki-types'

/**
 * Shape a fragment row into the [FRAGMENTS] inline-slug format consumed by
 * the LLM. The header line carries the grounded identifiers the model needs
 * to emit [[fragment:slug]] tokens and per-section citation declarations.
 *
 * Example emitted form:
 *   - id: frag-abc123  slug: my-fragment  captured: 2026-04-12
 *     ### Morning run
 *     Ran 5k in the park.
 */
export interface WikiFragmentInput {
  id: string
  slug: string
  title?: string | null
  content: string
  createdAt?: string | Date | null
}

const toIsoDate = (input: unknown): string | null => {
  if (!input) return null
  if (input instanceof Date) {
    const iso = input.toISOString()
    return iso.slice(0, 10)
  }
  if (typeof input === 'string') {
    // Accept ISO strings and date-only strings alike; keep YYYY-MM-DD
    const d = new Date(input)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
  }
  return null
}

export function renderFragmentsBlock(frags: WikiFragmentInput[]): string {
  return frags
    .map((f) => {
      const captured = toIsoDate(f.createdAt)
      const header =
        `- id: ${f.id}  slug: ${f.slug}${captured ? `  captured: ${captured}` : ''}`
      const titleLine = f.title ? `  ### ${f.title}` : ''
      const contentLines = f.content
        .split('\n')
        .map((line) => (line.length > 0 ? `  ${line}` : ''))
        .join('\n')
      return [header, titleLine, contentLines].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

/**
 * Shape a person row into the [PEOPLE] inline-slug format. Slug and name
 * are mandatory; relationship is only emitted when non-empty so the LLM
 * does not see stub text like "relationship: ".
 */
export interface WikiPersonInput {
  slug: string
  name: string
  relationship?: string | null
}

export function renderPeopleBlock(people: WikiPersonInput[]): string {
  return people
    .map((p) => {
      const rel = p.relationship && p.relationship.trim().length > 0
        ? `  relationship: ${p.relationship.trim()}`
        : ''
      return `- slug: ${p.slug}  name: ${p.name}${rel}`
    })
    .join('\n')
}

const inputSchema = z.object({
  fragments: z.string(),
  title: z.string(),
  date: z.string(),
  // SEC-L3: callers may stringify `count` if it survives a FAILSAFE_SCHEMA
  // YAML round-trip; coerce so the input contract stays numeric.
  count: z.coerce.number(),
  timeline: z.string().optional(),
  people: z.string().optional(),
  existingWiki: z.string().optional(),
  edits: z.string().optional(),
  relatedWikis: z.string().optional(),
  // #244 — per-wiki structure override (wikis.structure). When present this
  // wins over the type's default_structure. Resolved before render.
  structure: z.string().optional(),
})

const schemaMap: Record<WikiType, z.ZodType> = {
  log: logWikiSchema,
  research: researchWikiSchema,
  belief: beliefWikiSchema,
  decision: decisionWikiSchema,
  project: projectWikiSchema,
  objective: objectiveWikiSchema,
  skill: skillWikiSchema,
  agent: agentWikiSchema,
  voice: voiceWikiSchema,
  principle: principleWikiSchema,
}

/** Resolve output schema for a wiki type. Falls back to belief schema for user-created types. */
function resolveOutputSchema(type: string): z.ZodType {
  return schemaMap[type as WikiType] ?? beliefWikiSchema
}

/**
 * Load the disk spec for a wiki type. For shipped types this reads the YAML file
 * directly. For user-created types (no YAML on disk) it falls back to the base
 * template so the full prompt scaffolding (rules, citations, infobox, guardrails)
 * is always present.
 */
function loadDiskSpecWithFallback(type: string): { spec: PromptSpec; isBase: boolean } {
  try {
    return { spec: loadSpec(`${type}.yaml`, 'wiki-types'), isBase: false }
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isNotFound) throw err
    return { spec: loadSpec(BASE_SPEC_FILENAME, BASE_SPEC_SUBDIR), isBase: true }
  }
}

/**
 * Override shape for loadWikiGenerationSpec.
 *
 * - `yaml`: full YAML blob (from wikiTypes.prompt). Parsed via parseSpecFromBlob;
 *   spec.system_message, spec.template, spec.temperature all come from the blob.
 * - `systemMessage`: plain text (from wikis.prompt). Disk spec is loaded; the
 *   text is APPENDED to spec.system_message (separated by a blank line) —
 *   template/temperature/input_variables stay. Append (not replace) lets users
 *   add per-wiki guidance on top of the canonical type prompt without losing
 *   its rules or tone.
 *
 * In both cases, outputSchema is always code-sourced from schemaMap[type] —
 * user YAML can never change the LLM output contract.
 */
export type WikiGenerationOverride =
  | { kind: 'yaml'; blob: string }
  | { kind: 'systemMessage'; text: string }

export function loadWikiGenerationSpec(
  type: string,
  vars: {
    fragments: string
    title: string
    date: string
    count: number
    timeline?: string
    people?: string
    existingWiki?: string
    edits?: string
    relatedWikis?: string
    /**
     * #244 — per-wiki structure override (from `wikis.structure`). When
     * non-empty, replaces the type's `default_structure` before render.
     */
    structure?: string
  },
  override?: WikiGenerationOverride,
): PromptResult {
  const validated = inputSchema.parse(vars)
  const { spec: diskSpec } = loadDiskSpecWithFallback(type)

  // Resolve effective spec based on override shape. parseUserSpecFromBlobLenient
  // strips the locked forbidden fields (system_message, system_only) from
  // user-supplied YAML so a stored blob written before the strict gate landed
  // cannot crash the worker. It throws on yaml-parse / schema failures only —
  // the caller (regen.ts) catches and falls back to disk.
  let effective: PromptSpec = diskSpec
  let strippedFields: string[] = []
  if (override) {
    if (override.kind === 'yaml') {
      const { spec: userSpec, stripped } = parseUserSpecFromBlobLenient(override.blob)
      strippedFields = stripped
      // User blob fields win for display/structure/framing/temperature only.
      // system_message, system_only, and template are LOCKED to the disk spec
      // so user overrides cannot strip prompt scaffolding (rules, citations,
      // infobox, guardrails). The UI form exposes default_structure and
      // internal_framing as separate textareas; template is not user-editable.
      effective = {
        ...diskSpec,
        // Safe override fields — user can customize these
        ...(userSpec.default_structure != null && { default_structure: userSpec.default_structure }),
        ...(userSpec.internal_framing != null && { internal_framing: userSpec.internal_framing }),
        ...(userSpec.display_label != null && { display_label: userSpec.display_label }),
        ...(userSpec.display_description != null && { display_description: userSpec.display_description }),
        ...(userSpec.display_short_descriptor != null && { display_short_descriptor: userSpec.display_short_descriptor }),
        ...(userSpec.temperature != null && { temperature: userSpec.temperature }),
        // Locked fields — always from disk
        system_message: diskSpec.system_message,
        system_only: diskSpec.system_only,
        template: diskSpec.template,
      }
    } else {
      // Append (not replace): user text extends the canonical type system_message.
      // trimEnd on both sides keeps the blank-line separator clean.
      const extra = override.text.trim()
      effective = extra
        ? {
            ...diskSpec,
            system_message: `${diskSpec.system_message.trimEnd()}\n\n${extra}`,
          }
        : diskSpec
    }
  }

  // Resolve {{structure}} — per-wiki override beats the type's
  // default_structure. Render the resolved structure block through
  // Handlebars first so it can interpolate `{{title}}` etc. (the
  // structure block is still a sub-template, not opaque text). Empty-
  // string fallback keeps the outer render safe if a malformed yaml
  // omits both.
  const overrideStructure = validated.structure?.trim()
  const rawStructure =
    overrideStructure && overrideStructure.length > 0
      ? overrideStructure
      : (effective.default_structure ?? '')
  // SEC-H5: every variable from `validated` that carries user content gets
  // its delimiters escaped before substitution. `count` and `date` are
  // server-derived (Number / ISO date) — pass through verbatim.
  const userControlledVars = [
    'fragments',
    'title',
    'people',
    'existingWiki',
    'edits',
    'relatedWikis',
    'structure',
    'timeline',
  ] as const
  const resolvedStructure = renderTemplate(rawStructure, validated, {
    userControlled: userControlledVars,
  })

  const renderVars = { ...validated, structure: resolvedStructure }
  // The compiled template here can be partially user-controlled (the
  // user_message_template field of a wiki-type override). Handlebars does not
  // re-evaluate variable values, so the per-key escape is the load-bearing
  // mitigation — see template-injection.test.ts.
  const user = renderTemplate(effective.template, renderVars, {
    userControlled: userControlledVars,
  })
  return {
    system: effective.system_message,
    user,
    meta: {
      temperature: effective.temperature,
      outputSchema: resolveOutputSchema(type),
    },
    // Names of forbidden user-override fields that the lenient parser dropped.
    // Empty for disk-default + systemMessage-append paths. Callers with a DB
    // connection should emit an audit row when non-empty.
    strippedFields,
  }
}
