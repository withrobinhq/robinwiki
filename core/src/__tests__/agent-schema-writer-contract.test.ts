import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'
import { execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Static contract guard for the wiki_agent_schema writer registry.
 *
 * Stream S routed every wiki_agent_schema write through `ensureAgentSchema`
 * in `core/src/lib/wiki-agent-schema.ts`. This test enforces the registry
 * boundary at build time: only the helper module may issue a Drizzle
 * INSERT into the wikiAgentSchema table. Any new caller must add itself
 * as a mode in the helper rather than reaching past it.
 *
 * The check is grep-shaped, not type-shaped: it parses the source files
 * for the substring `db.insert(wikiAgentSchema)` (and the `database.insert`
 * variant used inside the helper) and asserts that the only file containing
 * the pattern is `core/src/lib/wiki-agent-schema.ts`. This catches a future
 * contributor copy-pasting an INSERT into a route or worker.
 *
 * Comment-only mentions are excluded: the regex is anchored to actual
 * call expressions.
 *
 * See docs/architecture/wiki-agent-schema.md `Writer registry` section
 * for the canonical caller list and how to register a new write path.
 */

const REPO_ROOT = resolve(__dirname, '../../..')
const HELPER_FILE = resolve(REPO_ROOT, 'core/src/lib/wiki-agent-schema.ts')

// Pattern: `.insert(wikiAgentSchema)`. Drizzle insert chains often span
// multiple lines (`database\n  .insert(wikiAgentSchema)`), so we anchor
// on the call expression itself rather than the receiver. Comment-only
// mentions are ruled out by requiring no `//` or `*` glyph immediately
// before `.insert` on the line.
const INSERT_PATTERN = /^[^/*\n]*\.insert\(wikiAgentSchema\b/m

function listTsSourceFiles(): string[] {
  // git ls-files keeps the test deterministic against the working tree
  // and skips node_modules / build artefacts without bespoke filtering.
  const out = execSync(
    `git ls-files -- 'core/src/**/*.ts' 'core/scripts/**/*.ts' 'packages/**/*.ts'`,
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  return out
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => resolve(REPO_ROOT, p))
}

describe('wiki_agent_schema writer registry contract', () => {
  it('exposes ensureAgentSchema as the registered helper entry point', () => {
    const helperSrc = readFileSync(HELPER_FILE, 'utf8')
    expect(helperSrc).toMatch(/export async function ensureAgentSchema\b/)
  })

  it('only core/src/lib/wiki-agent-schema.ts contains a direct INSERT into wikiAgentSchema', () => {
    const offenders: string[] = []
    for (const file of listTsSourceFiles()) {
      const src = readFileSync(file, 'utf8')
      if (!INSERT_PATTERN.test(src)) continue
      if (resolve(file) === HELPER_FILE) continue
      offenders.push(relative(REPO_ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it('helper file actually issues the gated INSERTs (sanity check on the regex)', () => {
    const helperSrc = readFileSync(HELPER_FILE, 'utf8')
    // Description and hyde rows are both written from the helper. Both
    // upserts use the same pattern, so detecting one occurrence is
    // sufficient to confirm the regex is targeted correctly.
    expect(INSERT_PATTERN.test(helperSrc)).toBe(true)
  })
})
