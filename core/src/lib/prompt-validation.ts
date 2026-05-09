import { parseUserSpecFromBlobLenient } from '@robin/shared'
import type { PromptSpec } from '@robin/shared'
import Handlebars from 'handlebars'

const MAX_YAML_BYTES = 32 * 1024
const ALLOWED_HELPERS = new Set(['if', 'each'])

export interface ValidationSuccess {
  ok: true
  spec: PromptSpec
  warnings: string[]
}

export interface ValidationFailure {
  ok: false
  status: number
  body: { code: string; error: string; detail?: unknown }
}

export type ValidationResult = ValidationSuccess | ValidationFailure

// Minimal structural typings for the Handlebars AST nodes we touch. Handlebars
// ships its own type bundle under the `hbs` namespace, but we avoid leaning on
// the namespace so the module remains portable across handlebars minor-version
// bumps. These shapes match the nodes emitted by `Handlebars.parse` in 4.7.x.
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
 * Validate a user-submitted YAML prompt spec against all Phase 1 rules.
 * Pipeline order (fail fast):
 *   1. byte length ≤ 32KB
 *   2. js-yaml parse
 *   3. PromptSpecSchema (via parseSpecFromBlob)
 *   4. Handlebars.parse template (syntax)
 *   5. Handlebars AST walk:
 *        - REJECT block-params ({{#each x as |y|}}) — UNSUPPORTED_BLOCK_PARAM
 *        - helper whitelist: if, each only — DISALLOWED_HELPER
 *   6. required input_variables all referenced in template
 * Returns { ok: true, spec, warnings } on success (warnings = tokens referenced
 * but not declared in input_variables — soft issue).
 */
export function validatePromptYaml(yaml: string): ValidationResult {
  // 1. Size cap. Checked here (not in the zod body schema) so we can return
  // a stable { code: 'YAML_TOO_LARGE' } instead of the generic zod 400 shape.
  const byteLength = Buffer.byteLength(yaml, 'utf-8')
  if (byteLength > MAX_YAML_BYTES) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'YAML_TOO_LARGE',
        error: `YAML exceeds 32KB cap (got ${byteLength} bytes)`,
      },
    }
  }

  // 2 + 3. Parse YAML + validate schema via the LENIENT user-blob parser. It
  // first asserts the root is a plain mapping (YAMLException-shaped error on
  // arrays / scalars), silently strips USER_OVERRIDE_FORBIDDEN_FIELDS so a
  // round-tripped disk YAML (which always carries system_message) survives
  // validation, then runs PromptSpecSchema. Stripped fields are surfaced as
  // soft warnings, never as a hard error. Defense-in-depth lives at the
  // runtime loader (wiki-generation.ts), which always overwrites
  // system_message and system_only with the canonical disk values before
  // render so a stripped-but-stored override cannot reach the LLM.
  let spec: PromptSpec
  let stripped: string[] = []
  try {
    const result = parseUserSpecFromBlobLenient(yaml)
    spec = result.spec
    stripped = result.stripped
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'YAMLException' || name === 'YAMLError') {
      return {
        ok: false,
        status: 400,
        body: {
          code: 'YAML_PARSE_ERROR',
          error: 'YAML parse error',
          detail: (err as Error).message,
        },
      }
    }

    const flatten = (err as { flatten?: () => unknown }).flatten
    return {
      ok: false,
      status: 400,
      body: {
        code: 'YAML_SCHEMA_ERROR',
        error: 'YAML schema validation failed',
        detail: typeof flatten === 'function' ? flatten.call(err) : (err as Error).message,
      },
    }
  }

  // 4. Handlebars syntax check.
  let ast: HbsProgram
  try {
    ast = Handlebars.parse(spec.template) as unknown as HbsProgram
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'TEMPLATE_SYNTAX_ERROR',
        error: 'Handlebars template syntax error',
        detail: (err as Error).message,
      },
    }
  }

  // 5 + 6. AST walk collecting helpers + referenced variables.
  const referenced = new Set<string>()
  const walkErrors: { code: string; helper: string }[] = []
  let blockParamHit: string | null = null

  function walk(body: HbsStatement[]): void {
    for (const node of body) {
      if (node.type === 'MustacheStatement') {
        const m = node as HbsMustacheStatement
        referenced.add(m.path.original)
        continue
      }
      if (node.type === 'BlockStatement') {
        const block = node as HbsBlockStatement
        const helper = block.path.original

        // REJECT block-params: {{#each items as |it|}} — unsupported by our
        // renderer. Handlebars exposes them on block.program.blockParams as a
        // non-empty string[]. We capture only the first offending helper so
        // the error message stays deterministic.
        const blockParams = block.program?.blockParams
        if (blockParams && blockParams.length > 0) {
          if (blockParamHit === null) blockParamHit = helper
          continue
        }

        if (!ALLOWED_HELPERS.has(helper)) {
          walkErrors.push({ code: 'DISALLOWED_HELPER', helper })
          continue
        }
        // Block-helper first-param is the variable being gated (e.g. {{#if x}}).
        for (const param of block.params) {
          if (param.type === 'PathExpression') {
            referenced.add((param as HbsPathExpression).original)
          }
        }
        if (block.program) walk(block.program.body)
        if (block.inverse) walk(block.inverse.body)
      }
      // PartialStatement, CommentStatement, ContentStatement: ignore.
    }
  }

  walk(ast.body)

  // Fail-fast on block-params BEFORE other helper errors so the user sees the
  // clearer, more actionable message.
  if (blockParamHit !== null) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'UNSUPPORTED_BLOCK_PARAM',
        error:
          'Handlebars block parameters (as |x|) are not supported. Use the raw variable name instead.',
        detail: { helper: blockParamHit },
      },
    }
  }

  if (walkErrors.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'DISALLOWED_HELPER',
        error: `Disallowed Handlebars helpers: ${walkErrors
          .map((e) => e.helper)
          .join(', ')}. Only 'if' and 'each' are permitted.`,
        detail: walkErrors,
      },
    }
  }

  // Required-var check.
  const declaredRequired = new Set(
    spec.input_variables.filter((v) => v.required).map((v) => v.name)
  )
  const missingRequired = [...declaredRequired].filter((v) => !referenced.has(v))
  if (missingRequired.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        code: 'MISSING_REQUIRED_VAR',
        error: 'Required input_variables not referenced in template',
        detail: { missing: missingRequired },
      },
    }
  }

  // Unknown-var warning (soft).
  const declaredAll = new Set(spec.input_variables.map((v) => v.name))
  const warnings: string[] = []
  for (const ref of referenced) {
    if (!declaredAll.has(ref)) {
      warnings.push(
        `Template references {{${ref}}} but it is not declared in input_variables.`
      )
    }
  }

  // Surface forbidden-field stripping as a soft warning so the caller can
  // audit and the frontend can show "your override of X was ignored". The
  // runtime loader strips again before render (defense-in-depth) so a stored
  // override cannot reach the LLM.
  for (const field of stripped) {
    warnings.push(
      `Field "${field}" is reserved for the canonical disk spec and was ignored. The stored value will not affect generation.`
    )
  }

  return { ok: true, spec, warnings }
}
