import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../middleware/session.js', () => ({
  sessionMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('userId', 'test-user-1')
    await next()
  }),
}))

vi.mock('../db/audit.js', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../bootstrap/seed-wiki-types.js', () => ({
  seedWikiTypes: vi
    .fn()
    .mockResolvedValue({ inserted: 0, refreshed: 0, preserved: 0, failed: 0 }),
}))

// Simple DB mock. Each test sets __currentRows on globalThis; select().from().where()
// returns that array. update().set().where() records into mockUpdateCalls.
// insert().values().returning() records into mockInsertCalls.
const mockUpdateCalls: Array<Record<string, unknown>> = []
const mockInsertCalls: Array<Record<string, unknown>> = []

vi.mock('../db/client.js', () => {
  // Drizzle queries are thenable. Both `select().from(t)` and
  // `select().from(t).where(x)` resolve to arrays. Return a thenable chain
  // from .from() that ALSO carries a .where() method for routes that filter.
  const makeRowsThenable = () => {
    const getRows = () => (globalThis as any).__currentRows ?? []
    return {
      where: async () => getRows(),
      // biome-ignore lint/suspicious/noThenProperty: Drizzle thenable mock
      then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(getRows()).then(onFulfilled),
    }
  }
  const fakeDb = {
    select: () => ({
      from: () => makeRowsThenable(),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          mockUpdateCalls.push(data)
        },
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          mockInsertCalls.push(data)
          return [data]
        },
      }),
    }),
  }
  return { db: fakeDb }
})

vi.mock('../db/schema.js', () => ({
  wikiTypes: {
    slug: 'slug',
    name: 'name',
    descriptor: 'descriptor',
    shortDescriptor: 'shortDescriptor',
    prompt: 'prompt',
    userModified: 'userModified',
    basedOnVersion: 'basedOnVersion',
    isDefault: 'isDefault',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}))

// ── Import under test (after mocks) ────────────────────────────────────────

const { wikiTypesRoutes } = await import('./wiki-types.js')

const app = new Hono()
app.route('/wiki-types', wikiTypesRoutes)

// ── Fixtures ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_YAML_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'prompts',
  'specs',
  'wiki-types',
  'log.yaml'
)
const LOG_YAML = readFileSync(LOG_YAML_PATH, 'utf-8')

// log.yaml declares `date` as required but the stock template never references
// {{date}} (unrelated pre-existing spec quirk). For the happy-path PUT test we
// flip that single field to required: false so the validation pipeline accepts
// the blob as-is. The raw LOG_YAML remains the GET-list hydration fixture.
const LOG_YAML_VALID = LOG_YAML.replace(
  / {2}- name: date\n {4}description: Current date\n {4}required: true/,
  '  - name: date\n    description: Current date\n    required: false'
)

function putJson(path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Resolve every on-disk wiki-type YAML for the preview happy-path loop.
const WIKI_TYPES_DIR = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'prompts',
  'specs',
  'wiki-types'
)

const ALL_SLUGS = [
  'agent',
  'belief',
  'research',
  'decision',
  'log',
  'objective',
  'principle',
  'project',
  'skill',
  'voice',
] as const

function readSlugYaml(slug: string): string {
  return readFileSync(resolve(WIKI_TYPES_DIR, `${slug}.yaml`), 'utf-8')
}

// All 10 wiki types share the same quirk: `date` is declared required but not
// referenced in any template. Flip it to required: false so the validation
// pipeline accepts the blob for the preview render.
function withDateOptional(y: string): string {
  return y.replace(
    / {2}- name: date\n {4}description: Current date\n {4}required: true/,
    '  - name: date\n    description: Current date\n    required: false'
  )
}

// Load the preview fixture at setup time to assert title appearance in renders.
const FIXTURE_YAML_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'prompts',
  'fixtures',
  'wiki-type-preview.yaml'
)
const FIXTURE_YAML = readFileSync(FIXTURE_YAML_PATH, 'utf-8')
const { load: loadYaml } = await import('js-yaml')
const FIXTURE = loadYaml(FIXTURE_YAML) as { title: string }

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /wiki-types', () => {
  beforeEach(() => {
    mockUpdateCalls.length = 0
    mockInsertCalls.length = 0
  })

  it('returns items sorted by displayLabel ascending and hydrates from disk YAML', async () => {
    ;(globalThis as any).__currentRows = [
      {
        slug: 'log',
        name: 'Log',
        descriptor: 'A chronological synthesis',
        shortDescriptor: 'Chronological record',
        prompt: LOG_YAML,
        userModified: false,
        basedOnVersion: 1,
      },
      {
        slug: 'voice',
        name: 'Voice',
        descriptor: 'Style guide',
        shortDescriptor: 'Style',
        prompt: LOG_YAML,
        userModified: false,
        basedOnVersion: 1,
      },
    ]
    const res = await app.request('/wiki-types')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json.wikiTypes)).toBe(true)
    // "Log" < "Voice" alphabetically
    expect(json.wikiTypes[0].slug).toBe('log')
    expect(json.wikiTypes[0]).toHaveProperty('defaultYaml')
    expect(json.wikiTypes[0]).toHaveProperty('inputVariables')
    expect(json.wikiTypes[0].inputVariables.length).toBeGreaterThan(0)
  })
})

describe('GET /wiki-types/:slug/default', () => {
  it('returns 200 with canonical YAML for a known slug', async () => {
    const res = await app.request('/wiki-types/log/default')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.slug).toBe('log')
    // from log.yaml's top-level `name:` key
    expect(json.yaml).toContain('name: QuillTheWriter')
  })

  it('returns 404 for an unknown slug', async () => {
    const res = await app.request('/wiki-types/nonexistent-slug-xyz/default')
    expect(res.status).toBe(404)
  })
})

describe('PUT /wiki-types/:slug', () => {
  beforeEach(() => {
    mockUpdateCalls.length = 0
    ;(globalThis as any).__currentRows = [
      {
        slug: 'log',
        name: 'Log',
        descriptor: 'existing',
        shortDescriptor: 'existing',
        prompt: LOG_YAML,
        userModified: false,
        basedOnVersion: 1,
      },
    ]
  })

  it('accepts a valid YAML and flips userModified=true', async () => {
    const res = await putJson('/wiki-types/log', { promptYaml: LOG_YAML_VALID })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(mockUpdateCalls).toHaveLength(1)
    expect(mockUpdateCalls[0].userModified).toBe(true)
    // log.yaml top-level `version: 2` (bumped in m-wiki-sidecar for
    // infobox + citation declarations output contract).
    expect(mockUpdateCalls[0].basedOnVersion).toBe(2)
    expect(mockUpdateCalls[0].prompt).toBe(LOG_YAML_VALID)
  })

  it('rejects malformed YAML with 400 + code YAML_PARSE_ERROR', async () => {
    const res = await putJson('/wiki-types/log', { promptYaml: 'name: [unclosed' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('YAML_PARSE_ERROR')
    expect(mockUpdateCalls).toHaveLength(0)
  })

  it('rejects YAML missing required PromptSpec fields with 400 + code YAML_SCHEMA_ERROR', async () => {
    const res = await putJson('/wiki-types/log', {
      promptYaml: 'name: X\nversion: 1\ncategory: generation',
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('YAML_SCHEMA_ERROR')
  })

  it('rejects YAML > 32KB with 400 + code YAML_TOO_LARGE (reaches validatePromptYaml, not zod)', async () => {
    const bigYaml = `${LOG_YAML}\n# pad\n${'x'.repeat(33 * 1024)}`
    const res = await putJson('/wiki-types/log', { promptYaml: bigYaml })
    expect(res.status).toBe(400)
    const json = await res.json()
    // With the zod body-schema .max(32768) removed, validatePromptYaml owns
    // this path exclusively. Assert the exact error code — no fallback branch.
    expect(json.code).toBe('YAML_TOO_LARGE')
    expect(mockUpdateCalls).toHaveLength(0)
  })

  it('rejects YAML with disallowed Handlebars helper {{#unless}} with 400 + code DISALLOWED_HELPER', async () => {
    // Replace the first {{#if timeline}} / {{/if}} pair with {{#unless ...}} / {{/unless}}.
    const bad = LOG_YAML.replace('{{#if timeline}}', '{{#unless timeline}}').replace(
      '{{/if}}',
      '{{/unless}}'
    )
    const res = await putJson('/wiki-types/log', { promptYaml: bad })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('DISALLOWED_HELPER')
  })

  it('rejects YAML using Handlebars block-params {{#each items as |it|}} with 400 + code UNSUPPORTED_BLOCK_PARAM', async () => {
    const blockParamYaml = `name: X
version: 1
category: generation
task: t
description: t
temperature: 0.3
system_message: hello
template: |
  {{#each items as |it|}}
  - {{it}}
  {{/each}}
input_variables:
  - name: items
    description: list
    required: true
`
    const res = await putJson('/wiki-types/log', { promptYaml: blockParamYaml })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('UNSUPPORTED_BLOCK_PARAM')
    expect(mockUpdateCalls).toHaveLength(0)
  })

  it('rejects YAML where a required input_variable is not referenced in template', async () => {
    const missing = `name: X
version: 1
category: generation
task: t
description: t
temperature: 0.3
system_message: hello
template: |
  no variables here
input_variables:
  - name: foo
    description: must be referenced
    required: true
`
    const res = await putJson('/wiki-types/log', { promptYaml: missing })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('MISSING_REQUIRED_VAR')
    expect(json.detail.missing).toContain('foo')
  })

  it('returns 200 with warnings[] when template references undeclared tokens', async () => {
    const withUnknown = `name: X
version: 1
category: generation
task: t
description: t
temperature: 0.3
system_message: hello
template: |
  {{declared}} and {{undeclared}}
input_variables:
  - name: declared
    description: yes
    required: true
`
    const res = await putJson('/wiki-types/log', { promptYaml: withUnknown })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.warnings).toBeDefined()
    expect(json.warnings.some((w: string) => w.includes('undeclared'))).toBe(true)
  })

  it('returns 404 when slug does not exist in DB', async () => {
    ;(globalThis as any).__currentRows = []
    const res = await putJson('/wiki-types/not-a-slug', { promptYaml: LOG_YAML })
    expect(res.status).toBe(404)
  })
})

describe('POST /wiki-types/:slug/reset', () => {
  beforeEach(() => {
    mockUpdateCalls.length = 0
    ;(globalThis as any).__currentRows = [
      {
        slug: 'log',
        name: 'Log',
        descriptor: 'x',
        shortDescriptor: 'x',
        prompt: 'user edited',
        userModified: true,
        basedOnVersion: 1,
      },
    ]
  })

  it('flips userModified=false and restores prompt from disk', async () => {
    const res = await app.request('/wiki-types/log/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.slug).toBe('log')
    expect(mockUpdateCalls).toHaveLength(1)
    expect(mockUpdateCalls[0].userModified).toBe(false)
    expect(mockUpdateCalls[0].prompt).toContain('name: QuillTheWriter')
    // log.yaml is now version 2 (m-wiki-sidecar rev introduces infobox +
    // citation declarations in the output contract).
    expect(mockUpdateCalls[0].basedOnVersion).toBe(2)
  })

  it('returns 404 when slug does not exist', async () => {
    ;(globalThis as any).__currentRows = []
    const res = await app.request('/wiki-types/nothing/reset', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /wiki-types/:slug/preview', () => {
  beforeEach(() => {
    mockUpdateCalls.length = 0
    mockInsertCalls.length = 0
    // Preview is stateless — DB rows intentionally empty by default to prove
    // the endpoint does not consult the DB. Individual tests may override.
    ;(globalThis as any).__currentRows = []
  })

  afterEach(() => {
    // Preview must not touch the DB. If a future refactor sneaks in a write,
    // this assertion freezes the stateless contract in place.
    expect(mockUpdateCalls).toHaveLength(0)
    expect(mockInsertCalls).toHaveLength(0)
  })

  it.each(ALL_SLUGS)(
    'happy path — slug %s renders with fixture title and no leftover mustaches',
    async (slug) => {
      const yaml = withDateOptional(readSlugYaml(slug))
      const res = await postJson(`/wiki-types/${slug}/preview`, { promptYaml: yaml })
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        renderedPrompt: string
        warnings: Array<{ code: string; message: string }>
      }
      expect(typeof json.renderedPrompt).toBe('string')
      expect(json.renderedPrompt.length).toBeGreaterThan(0)
      // Every mustache should have been resolved — no literal {{...}} remains.
      expect(json.renderedPrompt).not.toContain('{{')
      // Fixture's title MUST appear somewhere in the render — proves the
      // fixture was substituted, not a stale default.
      expect(json.renderedPrompt).toContain(FIXTURE.title)
      expect(Array.isArray(json.warnings)).toBe(true)
      for (const w of json.warnings) {
        expect(typeof w.code).toBe('string')
        expect(typeof w.message).toBe('string')
      }
    }
  )

  it('rejects malformed YAML with 400 + code YAML_PARSE_ERROR', async () => {
    const res = await postJson('/wiki-types/log/preview', {
      promptYaml: 'name: [unclosed',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('YAML_PARSE_ERROR')
  })

  it('rejects schema-invalid YAML with 400 + code YAML_SCHEMA_ERROR', async () => {
    const res = await postJson('/wiki-types/log/preview', {
      promptYaml: 'name: X\nversion: 1\ncategory: generation',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('YAML_SCHEMA_ERROR')
  })

  it('rejects YAML > 32KB with 400 + code YAML_TOO_LARGE', async () => {
    const bigYaml = `${LOG_YAML}\n# pad\n${'x'.repeat(33 * 1024)}`
    const res = await postJson('/wiki-types/log/preview', { promptYaml: bigYaml })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('YAML_TOO_LARGE')
  })

  it('rejects disallowed helper with 400 + code DISALLOWED_HELPER', async () => {
    const bad = LOG_YAML.replace('{{#if timeline}}', '{{#unless timeline}}').replace(
      '{{/if}}',
      '{{/unless}}'
    )
    const res = await postJson('/wiki-types/log/preview', { promptYaml: bad })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('DISALLOWED_HELPER')
  })

  it('rejects block-params with 400 + code UNSUPPORTED_BLOCK_PARAM', async () => {
    const blockParamYaml = `name: X
version: 1
category: generation
task: t
description: t
temperature: 0.3
system_message: hello
template: |
  {{#each items as |it|}}
  - {{it}}
  {{/each}}
input_variables:
  - name: items
    description: list
    required: true
`
    const res = await postJson('/wiki-types/log/preview', { promptYaml: blockParamYaml })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('UNSUPPORTED_BLOCK_PARAM')
  })

  it('rejects missing required var with 400 + code MISSING_REQUIRED_VAR', async () => {
    const missing = `name: X
version: 1
category: generation
task: t
description: t
temperature: 0.3
system_message: hello
template: |
  no variables here
input_variables:
  - name: foo
    description: must be referenced
    required: true
`
    const res = await postJson('/wiki-types/log/preview', { promptYaml: missing })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string; detail: { missing: string[] } }
    expect(json.code).toBe('MISSING_REQUIRED_VAR')
  })

  it('returns 200 with UNKNOWN_VARIABLE warning when template references undeclared vars', async () => {
    const withUnknown = `name: X
version: 1
category: generation
task: t
description: t
temperature: 0.3
system_message: hello
template: |
  {{declared}} and {{undeclared}}
input_variables:
  - name: declared
    description: yes
    required: true
`
    const res = await postJson('/wiki-types/log/preview', { promptYaml: withUnknown })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      renderedPrompt: string
      warnings: Array<{ code: string; message: string }>
    }
    expect(Array.isArray(json.warnings)).toBe(true)
    expect(
      json.warnings.some(
        (w) => w.code === 'UNKNOWN_VARIABLE' && w.message.includes('undeclared')
      )
    ).toBe(true)
    // Every warning entry must be a structured {code, message} pair — never a
    // bare string. This is the M-3 must-have made executable.
    for (const w of json.warnings) {
      expect(typeof w.code).toBe('string')
      expect(typeof w.message).toBe('string')
    }
  })

  it('rejects URL-encoded directory-traversal slug with 400 Invalid slug format', async () => {
    const res = await postJson('/wiki-types/..%2Fetc%2Fpasswd/preview', {
      promptYaml: LOG_YAML_VALID,
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Invalid slug format')
  })

  it('rejects disallowed-char slug with 400 Invalid slug format', async () => {
    const res = await postJson('/wiki-types/INVALID_SLUG/preview', {
      promptYaml: LOG_YAML_VALID,
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Invalid slug format')
  })

  it('succeeds with empty DB — preview is stateless and does not consult wiki_types rows', async () => {
    ;(globalThis as any).__currentRows = []
    const res = await postJson('/wiki-types/log/preview', { promptYaml: LOG_YAML_VALID })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { renderedPrompt: string }
    expect(json.renderedPrompt.length).toBeGreaterThan(0)
  })
})
