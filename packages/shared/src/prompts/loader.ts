import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Handlebars from 'handlebars'
import { load as loadYaml } from 'js-yaml'
import { z } from 'zod'
import { PromptSpecSchema } from './schema.js'
import type { PromptSpec } from './schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = resolve(__dirname, 'specs')

const specCache = new Map<string, PromptSpec>()

/**
 * Load and validate a YAML prompt spec file.
 * Results are cached by key (filename + optional subdir).
 */
export function loadSpec(filename: string, subdir?: string): PromptSpec {
  const key = subdir ? `${subdir}/${filename}` : filename
  const cached = specCache.get(key)
  if (cached) return cached

  const dir = subdir ? resolve(SPECS_DIR, subdir) : SPECS_DIR
  const filePath = resolve(dir, filename)
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = loadYaml(raw)
  const spec = PromptSpecSchema.parse(parsed)

  specCache.set(key, spec)
  return spec
}

/**
 * Render-context invariant: variables passed to renderTemplate must be
 * limited to the typed input_variables declared by each prompt spec.
 * NEVER pass process.env, master keys, OpenRouter config, password hashes,
 * encrypted DEKs, or any secret-bearing field through this function. The
 * compiled template can be partially user-controlled (via wiki-type YAML
 * overrides), so any value reachable here is effectively user-readable.
 *
 * `render-context-purity.test.ts` enumerates every loader call site and
 * asserts the variable map is free of named secrets. Keep that contract
 * intact when adding new loaders.
 */

/**
 * Insert a zero-width space between consecutive Handlebars delimiters so a
 * user-controlled value containing literal `{{...}}` cannot be re-evaluated
 * as a sub-template. The ZWSP is invisible to the LLM (humans / models see
 * the literal `{{evil}}` glyphs), but Handlebars no longer parses the pair
 * as an opening / closing delimiter.
 *
 * Verified to survive multi-pass rendering — see template-injection.test.ts
 * for the round-trip lock.
 */
const ZERO_WIDTH_SPACE = '\u200B'
export function escapeHandlebarsDelimiters(s: string): string {
  return s.replace(/\{\{/g, `{${ZERO_WIDTH_SPACE}{`).replace(/\}\}/g, `}${ZERO_WIDTH_SPACE}}`)
}

/**
 * Options for renderTemplate. The `userControlled` array names variable keys
 * whose string values are sourced from user content (fragment text, wiki
 * names, etc.) — those values are passed through escapeHandlebarsDelimiters
 * before substitution. Keys not listed are treated as server-controlled and
 * pass through verbatim. Missing entry list means RAW substitution — callers
 * must explicitly opt in to escaping.
 */
export interface RenderTemplateOptions {
  userControlled?: readonly string[]
}

const MAX_ESCAPE_RECURSION_DEPTH = 4

function escapeUserControlledValue(value: unknown, depth: number): unknown {
  if (depth > MAX_ESCAPE_RECURSION_DEPTH) return value
  if (typeof value === 'string') return escapeHandlebarsDelimiters(value)
  if (Array.isArray(value)) {
    return value.map((item) => escapeUserControlledValue(item, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = escapeUserControlledValue(v, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Render a Handlebars template with the given variables.
 * Uses noEscape to avoid HTML entity escaping (these are LLM prompts, not HTML).
 *
 * When `opts.userControlled` is supplied, string values for the listed keys
 * (and string leaves of arrays / nested objects up to depth 4) are passed
 * through escapeHandlebarsDelimiters. This blocks attempts to smuggle a
 * `{{...}}` sub-template through a user-controlled fragment. Server-derived
 * values (counts, dates, etc.) are not escaped.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
  opts?: RenderTemplateOptions
): string {
  let effectiveVars = variables
  const userControlled = opts?.userControlled
  if (userControlled && userControlled.length > 0) {
    effectiveVars = { ...variables }
    for (const key of userControlled) {
      if (!Object.hasOwn(effectiveVars, key)) continue
      effectiveVars[key] = escapeUserControlledValue(effectiveVars[key], 0)
    }
  }
  const compiled = Handlebars.compile(template, { noEscape: true })
  return compiled(effectiveVars)
}

/**
 * Parse and validate a YAML blob (arbitrary string) through PromptSpecSchema.
 * Unlike loadSpec, this does NOT read from disk and does NOT cache results.
 * Throws YAMLException on syntax errors; throws ZodError on schema errors.
 *
 * Used for TRUSTED disk-load callers only (e.g. reading default YAML from
 * the shipped specs directory). For UNTRUSTED user-supplied YAML, prefer
 * `parseUserSpecFromBlobStrict` (HTTP boundary) or
 * `parseUserSpecFromBlobLenient` (runtime loader) — both enforce the
 * forbidden-field whitelist that protects spec.system_message from override.
 */
export function parseSpecFromBlob(yaml: string): PromptSpec {
  const parsed = loadYaml(yaml)
  return PromptSpecSchema.parse(parsed)
}

/**
 * Fields that user-supplied YAML overrides may NOT carry. The runtime
 * always sources spec.system_message from the canonical disk YAML; the
 * `system_only` flag is similarly admin-only (would let a user mark their
 * override as system-tier).
 */
export const USER_OVERRIDE_FORBIDDEN_FIELDS = ['system_message', 'system_only'] as const

function ensurePlainObject(parsed: unknown): asserts parsed is Record<string, unknown> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Match the YAMLException-shaped error so existing classifier code in
    // core/src/lib/prompt-validation.ts (.name === 'YAMLException') keeps
    // routing this through the YAML_PARSE_ERROR branch.
    const err = new Error('YAML root must be a mapping') as Error & { name: string }
    err.name = 'YAMLException'
    throw err
  }
}

function buildForbiddenFieldZodError(fields: string[]): z.ZodError {
  return new z.ZodError(
    fields.map((field) => ({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `Field "${field}" is not allowed in user-supplied wiki-type prompt overrides`,
    }))
  )
}

/**
 * Placeholder substituted when a user blob omits the required
 * system_message field. The caller (wiki-generation loader) overwrites
 * spec.system_message with the disk default before render — this string
 * must NEVER reach the LLM. Internal contract; not exported.
 */
const STRIPPED_SYSTEM_MESSAGE_PLACEHOLDER = '__stripped_system_message_placeholder__'

/**
 * Parse a user-supplied YAML blob STRICTLY: throw on any forbidden field.
 *
 * Use this at the HTTP boundary (PUT/POST /wiki-types/:slug) so attempts
 * to override spec.system_message return a 400 to the client. The thrown
 * error is a `ZodError` so the existing validatePromptYaml flatten() path
 * keeps working — see USER_OVERRIDE_FORBIDDEN_FIELDS for the field list.
 *
 * Note: `system_message` is required by PromptSpecSchema but absent from
 * user-supplied overrides (the runtime sources it from disk). We backfill
 * a placeholder before schema parse so the user blob does not need to
 * carry it. The placeholder must be overwritten by the disk spec at the
 * caller boundary; it must NEVER reach the LLM.
 */
export function parseUserSpecFromBlobStrict(yaml: string): PromptSpec {
  const parsed = loadYaml(yaml)
  ensurePlainObject(parsed)

  const offending = USER_OVERRIDE_FORBIDDEN_FIELDS.filter((field) => Object.hasOwn(parsed, field))
  if (offending.length > 0) {
    throw buildForbiddenFieldZodError([...offending])
  }

  const parsedWithDefaults = parsed as Record<string, unknown>
  if (!Object.hasOwn(parsedWithDefaults, 'system_message')) {
    parsedWithDefaults.system_message = STRIPPED_SYSTEM_MESSAGE_PLACEHOLDER
  }

  return PromptSpecSchema.parse(parsedWithDefaults)
}

/**
 * Parse a user-supplied YAML blob LENIENTLY: silently strip forbidden
 * fields and return them in `stripped` so the caller can audit. Never
 * throws on forbidden fields — only on YAML parse errors or downstream
 * PromptSpec schema violations.
 *
 * Use this at the runtime loader boundary (regen / preview) so a stored
 * wikiTypes.prompt row written before the strict gate landed cannot crash
 * the worker — the forbidden field is dropped and an audit row is emitted
 * by the caller.
 *
 * Note: the spec returned from this function MUST have its `system_message`
 * overwritten by the disk-spec value at the caller boundary. We backfill a
 * placeholder so PromptSpecSchema.parse (which marks system_message as
 * required) does not reject the user blob just because we stripped a
 * forbidden override. The caller is contractually obliged to merge with the
 * disk spec; this placeholder must NEVER reach the LLM.
 */
export function parseUserSpecFromBlobLenient(yaml: string): {
  spec: PromptSpec
  stripped: string[]
} {
  const parsed = loadYaml(yaml)
  ensurePlainObject(parsed)

  const stripped: string[] = []
  for (const field of USER_OVERRIDE_FORBIDDEN_FIELDS) {
    if (Object.hasOwn(parsed, field)) {
      stripped.push(field)
      delete (parsed as Record<string, unknown>)[field]
    }
  }

  // Backfill a placeholder for required fields the user blob no longer
  // carries — the caller (wiki-generation loader) overwrites both with the
  // disk spec values, so the placeholder is never observed by the LLM.
  const parsedWithDefaults = parsed as Record<string, unknown>
  if (!Object.hasOwn(parsedWithDefaults, 'system_message')) {
    parsedWithDefaults.system_message = STRIPPED_SYSTEM_MESSAGE_PLACEHOLDER
  }

  const spec = PromptSpecSchema.parse(parsedWithDefaults)
  return { spec, stripped }
}

// Minimal Handlebars AST typings — duplicated narrowly from
// core/src/lib/prompt-validation.ts because @robin/shared cannot depend on
// @robin/core. Private to this module; not re-exported. See RESEARCH.md §Risks
// #6 for the rationale against extracting a shared walker.
interface HbsPathExpression {
  type: 'PathExpression'
  original: string
}

interface HbsStatement {
  type: string
}

interface HbsMustacheStatement extends HbsStatement {
  type: 'MustacheStatement'
  path: HbsPathExpression
}

interface HbsProgram {
  body: HbsStatement[]
  blockParams?: string[]
}

interface HbsBlockStatement extends HbsStatement {
  type: 'BlockStatement'
  path: HbsPathExpression
  params: Array<HbsPathExpression | { type: string }>
  program: HbsProgram
  inverse?: HbsProgram
}

/**
 * Structured render-time warning. Kept open-typed in `code` so future phases
 * can add codes (e.g. `EMPTY_CONDITIONAL_BRANCH`) without churn across callers.
 */
export interface RenderWarning {
  code: 'UNKNOWN_VARIABLE'
  message: string
  detail?: { name?: string }
}

export interface RenderResult {
  rendered: string
  warnings: RenderWarning[]
}

/**
 * Render a PromptSpec's template against a variable map, returning the
 * rendered string and any structured warnings collected during a narrow AST
 * walk. Warnings currently cover only `UNKNOWN_VARIABLE` — a template
 * reference to a name that is not declared in `spec.input_variables`.
 *
 * Does NOT re-validate the template — the pre-save `validatePromptYaml`
 * pipeline in @robin/core owns helper-whitelist + block-param rejection.
 * Safe to call on any spec that has survived that validator; tolerates
 * malformed templates by silently returning zero warnings.
 */
export function renderPromptSpec(
  spec: PromptSpec,
  vars: Record<string, unknown>,
  opts?: RenderTemplateOptions
): RenderResult {
  const rendered = renderTemplate(spec.template, vars, opts)

  // Narrow reference-collection walk. Duplicates the subset of
  // validatePromptYaml's walk that gathers variable names — see RESEARCH.md
  // §Risks #6 for the intentional duplication.
  const referenced = new Set<string>()
  try {
    const ast = Handlebars.parse(spec.template) as unknown as HbsProgram
    collectReferences(ast.body, referenced)
  } catch {
    // Malformed templates should have been rejected upstream. Returning zero
    // warnings here is safe — the render output will contain literal mustaches
    // the consumer can see.
  }

  const declared = new Set(spec.input_variables.map((v) => v.name))
  const warnings: RenderWarning[] = []
  for (const ref of referenced) {
    if (!declared.has(ref)) {
      warnings.push({
        code: 'UNKNOWN_VARIABLE',
        message: `Template references {{${ref}}} but it is not declared in input_variables.`,
        detail: { name: ref },
      })
    }
  }

  return { rendered, warnings }
}

function collectReferences(body: HbsStatement[], out: Set<string>): void {
  for (const node of body) {
    if (node.type === 'MustacheStatement') {
      out.add((node as HbsMustacheStatement).path.original)
      continue
    }
    if (node.type === 'BlockStatement') {
      const block = node as HbsBlockStatement
      for (const param of block.params) {
        if (param.type === 'PathExpression') {
          out.add((param as HbsPathExpression).original)
        }
      }
      if (block.program) collectReferences(block.program.body, out)
      if (block.inverse) collectReferences(block.inverse.body, out)
    }
    // PartialStatement, CommentStatement, ContentStatement: skip (no refs).
  }
}
