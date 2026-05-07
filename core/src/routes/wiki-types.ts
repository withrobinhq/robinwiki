import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { parseSpecFromBlob, loadWikiTypePreviewFixture, renderPromptSpec } from '@robin/shared/prompts'
import { sessionMiddleware } from '../middleware/session.js'
import { db } from '../db/client.js'
import { wikiTypes } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { validationHook } from '../lib/validation.js'
import { validatePromptYaml } from '../lib/prompt-validation.js'
import { seedWikiTypes } from '../bootstrap/seed-wiki-types.js'
import {
  wikiTypeResponseSchema,
  wikiTypesListResponseSchema,
  createWikiTypeBodySchema,
  putWikiTypePromptBodySchema,
  previewWikiTypePromptBodySchema,
  defaultYamlResponseSchema,
} from '../schemas/wiki-types.schema.js'
import { emitAuditEvent } from '../db/audit.js'

const log = logger.child({ component: 'wiki-types' })

const wikiTypesRouter = new Hono()
wikiTypesRouter.use('*', sessionMiddleware)

// Resolve the wiki-types YAML directory via @robin/shared's dist output.
// tsdown copies YAML specs to packages/shared/dist/prompts/specs/wiki-types/
// so this path works in both dev and production (no src/ dependency).
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPECS_WIKI_TYPES_DIR = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'dist',
  'prompts',
  'specs',
  'wiki-types'
)

// T-04-06 mitigation: slug regex before any readFileSync so a crafted slug like
// "../../../../etc/passwd" can never escape the specs directory.
const SLUG_REGEX = /^[a-z0-9-]+$/

function readDefaultYaml(slug: string): string | null {
  if (!SLUG_REGEX.test(slug)) return null
  const filePath = resolve(SPECS_WIKI_TYPES_DIR, `${slug}.yaml`)
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

type WikiTypeListItem = {
  slug: string
  displayLabel: string
  displayDescription: string
  displayShortDescriptor: string
  displayOrder: number
  promptYaml: string
  defaultYaml: string
  userModified: boolean
  basedOnVersion: number
  inputVariables: Array<{ name: string; description: string; required: boolean }>
}

// POST /wiki-types/setup -- seed defaults from YAML configs (idempotent)
wikiTypesRouter.post('/setup', async (c) => {
  try {
    const result = await seedWikiTypes()

    await emitAuditEvent(db, {
      entityType: 'wiki_type',
      entityId: 'system',
      eventType: 'seeded',
      source: 'system',
      summary: 'Wiki types seeded',
      detail: { result },
    })

    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, 'wiki-types setup failed')
    return c.json({ error: message }, 500)
  }
})

// GET /wiki-types -- enriched list. Sorted by displayLabel ascending; excludes
// any disk YAML with system_only: true (defensive — should never be present in
// the wiki-types/ directory, but we filter anyway).
wikiTypesRouter.get('/', async (c) => {
  const rows = await db.select().from(wikiTypes)
  const items: WikiTypeListItem[] = []

  for (const row of rows) {
    const defaultYaml = readDefaultYaml(row.slug)

    if (defaultYaml === null) {
      // Row with no corresponding disk YAML (e.g. user-created via POST /).
      // Include as-is so the frontend can still list it.
      items.push({
        slug: row.slug,
        displayLabel: row.name,
        displayDescription: row.descriptor,
        displayShortDescriptor: row.shortDescriptor,
        displayOrder: 999,
        promptYaml: row.prompt,
        defaultYaml: '',
        userModified: row.userModified,
        basedOnVersion: row.basedOnVersion,
        inputVariables: [],
      })
      continue
    }

    try {
      const spec = parseSpecFromBlob(defaultYaml)
      if (spec.system_only) continue
      items.push({
        slug: row.slug,
        displayLabel: spec.display_label ?? row.name,
        displayDescription: spec.display_description ?? row.descriptor,
        displayShortDescriptor: spec.display_short_descriptor ?? row.shortDescriptor,
        displayOrder: spec.display_order ?? 999,
        promptYaml: row.prompt,
        defaultYaml,
        userModified: row.userModified,
        basedOnVersion: row.basedOnVersion,
        inputVariables: spec.input_variables.map((v) => ({
          name: v.name,
          description: v.description,
          required: v.required,
        })),
      })
    } catch (err) {
      log.warn(
        { err, slug: row.slug },
        'disk YAML failed to parse in GET /wiki-types — falling back to DB-only fields'
      )
      items.push({
        slug: row.slug,
        displayLabel: row.name,
        displayDescription: row.descriptor,
        displayShortDescriptor: row.shortDescriptor,
        displayOrder: 999,
        promptYaml: row.prompt,
        defaultYaml,
        userModified: row.userModified,
        basedOnVersion: row.basedOnVersion,
        inputVariables: [],
      })
    }
  }

  items.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel))

  return c.json(wikiTypesListResponseSchema.parse({ wikiTypes: items }))
})

// GET /wiki-types/:slug -- legacy single-row (preserved for frontend compat)
wikiTypesRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const [row] = await db.select().from(wikiTypes).where(eq(wikiTypes.slug, slug))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(wikiTypeResponseSchema.parse(row))
})

// GET /wiki-types/:slug/default -- canonical YAML from disk
wikiTypesRouter.get('/:slug/default', async (c) => {
  const slug = c.req.param('slug')
  const yaml = readDefaultYaml(slug)
  if (yaml === null) return c.json({ error: 'Not found' }, 404)
  return c.json(defaultYamlResponseSchema.parse({ slug, yaml }))
})

// PUT /wiki-types/:slug -- full validation pipeline
wikiTypesRouter.put(
  '/:slug',
  zValidator('json', putWikiTypePromptBodySchema, validationHook),
  async (c) => {
    const slug = c.req.param('slug')
    const body = c.req.valid('json')

    const [existing] = await db.select().from(wikiTypes).where(eq(wikiTypes.slug, slug))
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const result = validatePromptYaml(body.promptYaml)
    if (result.ok !== true) {
      // Explicit cast because core's tsconfig has strict: false which weakens
      // discriminated-union narrowing on the negative branch.
      const failure = result as Extract<typeof result, { ok: false }>
      return c.json(failure.body, failure.status as 400)
    }

    await db
      .update(wikiTypes)
      .set({
        prompt: body.promptYaml,
        userModified: true,
        basedOnVersion: result.spec.version,
        name: result.spec.display_label ?? existing.name,
        descriptor: result.spec.display_description ?? existing.descriptor,
        shortDescriptor: result.spec.display_short_descriptor ?? existing.shortDescriptor,
        updatedAt: new Date(),
      })
      .where(eq(wikiTypes.slug, slug))

    await emitAuditEvent(db, {
      entityType: 'wiki_type',
      entityId: slug,
      eventType: 'edited',
      source: 'api',
      summary: `Wiki type prompt updated: ${slug}`,
      detail: {
        slug,
        basedOnVersion: result.spec.version,
        warnings: result.warnings,
      },
    })

    return c.json({
      ok: true,
      slug,
      basedOnVersion: result.spec.version,
      warnings: result.warnings,
    })
  }
)

// POST /wiki-types/:slug/reset -- restore from disk, flip userModified=false
wikiTypesRouter.post('/:slug/reset', async (c) => {
  const slug = c.req.param('slug')

  const [existing] = await db.select().from(wikiTypes).where(eq(wikiTypes.slug, slug))
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const defaultYaml = readDefaultYaml(slug)
  if (defaultYaml === null) {
    return c.json(
      { error: 'No canonical YAML on disk for this slug — reset not possible' },
      400
    )
  }

  let canonicalVersion: number
  try {
    const spec = parseSpecFromBlob(defaultYaml)
    canonicalVersion = spec.version
  } catch (err) {
    log.error({ err, slug }, 'canonical YAML failed to parse during reset — refusing')
    return c.json({ error: 'Canonical YAML on disk is invalid — contact operator' }, 500)
  }

  await db
    .update(wikiTypes)
    .set({
      prompt: defaultYaml,
      userModified: false,
      basedOnVersion: canonicalVersion,
      updatedAt: new Date(),
    })
    .where(eq(wikiTypes.slug, slug))

  await emitAuditEvent(db, {
    entityType: 'wiki_type',
    entityId: slug,
    eventType: 'reset',
    source: 'api',
    summary: `Wiki type reset to default: ${slug}`,
    detail: { slug, basedOnVersion: canonicalVersion },
  })

  return c.json({ ok: true, slug, basedOnVersion: canonicalVersion })
})

// POST /wiki-types/:slug/preview -- deterministic Handlebars render (NO LLM).
// Returns the exact prompt that would be sent at generation time, given a
// shared fixture for input variables. Stateless — no DB work, no audit event.
wikiTypesRouter.post(
  '/:slug/preview',
  zValidator('json', previewWikiTypePromptBodySchema, validationHook),
  async (c) => {
    const slug = c.req.param('slug')
    if (!SLUG_REGEX.test(slug)) {
      return c.json({ error: 'Invalid slug format' }, 400)
    }

    const body = c.req.valid('json')
    const result = validatePromptYaml(body.promptYaml)
    if (result.ok !== true) {
      // Strict: false in core's tsconfig weakens discriminated-union narrowing
      // on the negative branch; cast for clarity (mirrors PUT handler pattern).
      const failure = result as Extract<typeof result, { ok: false }>
      return c.json(failure.body, failure.status as 400)
    }

    const fixtureVars = loadWikiTypePreviewFixture(slug)
    const { rendered, warnings: renderWarnings } = renderPromptSpec(
      result.spec,
      fixtureVars as unknown as Record<string, unknown>
    )

    // Lift Phase 1's string-warnings to structured shape AT the preview boundary.
    // Phase 1's validator emits warnings only for the "referenced but not
    // declared" case — so UNKNOWN_VARIABLE is the correct code. Renderer
    // warnings are already structured. Left un-deduped for v1 (see Plan 03 Task
    // 2 note): a user-facing duplicate is strictly-less-broken than a missing
    // warning, and callers can dedupe on `${code}|${message}` if needed.
    const structuredWarnings: Array<{ code: string; message: string }> = [
      ...result.warnings.map((message) => ({
        code: 'UNKNOWN_VARIABLE' as const,
        message,
      })),
      ...renderWarnings.map((w) => ({ code: w.code, message: w.message })),
    ]

    return c.json({
      renderedPrompt: rendered,
      warnings: structuredWarnings,
    })
  }
)

// POST /wiki-types -- create a new user-defined wiki type (unchanged)
wikiTypesRouter.post(
  '/',
  zValidator('json', createWikiTypeBodySchema, validationHook),
  async (c) => {
    const body = c.req.valid('json')

    const [existing] = await db.select().from(wikiTypes).where(eq(wikiTypes.slug, body.slug))
    if (existing) {
      return c.json({ error: `Wiki type "${body.slug}" already exists` }, 409)
    }

    const [created] = await db
      .insert(wikiTypes)
      .values({
        slug: body.slug,
        name: body.name,
        shortDescriptor: body.shortDescriptor,
        descriptor: body.descriptor,
        prompt: body.prompt,
        isDefault: false,
        userModified: true,
      })
      .returning()

    await emitAuditEvent(db, {
      entityType: 'wiki_type',
      entityId: body.slug,
      eventType: 'created',
      source: 'api',
      summary: `Wiki type created: ${body.name}`,
      detail: { slug: body.slug, name: body.name },
    })

    return c.json(wikiTypeResponseSchema.parse(created), 201)
  }
)

export { wikiTypesRouter as wikiTypesRoutes }
