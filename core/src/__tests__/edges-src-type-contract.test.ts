import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Static contract guards on the edges.src_type / dst_type vocabulary.
 *
 * Migration 0016 canonicalised src_type to one of
 * {raw_source, fragment, wiki, person} and added a CHECK constraint
 * pinning the vocabulary at the schema level. These tests guard the
 * SQL artefact and the source-tree writers so a regression to the
 * legacy 'entry' string (or any other off-vocabulary value) trips a
 * unit-test failure before it can reach a database.
 *
 * A runtime check against a live Postgres instance lives in the
 * UAT plan (`.uat/plans/74-edges-src-type-canonicalize.md`); it
 * cannot run here because vitest does not boot Postgres.
 */

const REPO_ROOT = resolve(__dirname, '../../..')
const MIGRATION_PATH = resolve(
  REPO_ROOT,
  'core/drizzle/migrations/0016_edges_src_type_canonicalize.sql'
)

const CANONICAL_VOCAB = ['raw_source', 'fragment', 'wiki', 'person'] as const

describe('edges src_type contract', () => {
  it('migration 0016 backfills entry to raw_source', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/UPDATE\s+edges\s+SET\s+src_type\s*=\s*'raw_source'\s+WHERE\s+src_type\s*=\s*'entry'/i)
  })

  it('migration 0016 adds CHECK constraints on src_type and dst_type', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    expect(sql).toMatch(/ALTER\s+TABLE\s+edges\s+ADD\s+CONSTRAINT\s+edges_src_type_check/i)
    expect(sql).toMatch(/ALTER\s+TABLE\s+edges\s+ADD\s+CONSTRAINT\s+edges_dst_type_check/i)
  })

  it('migration 0016 CHECK constraints permit only canonical vocabulary', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    for (const value of CANONICAL_VOCAB) {
      expect(sql).toContain(`'${value}'`)
    }
    // Reject the legacy spelling. The UPDATE line above mentions 'entry'
    // inside a WHERE clause; we only want to flag a NEW IN-list inclusion.
    const checkBody = sql.match(/CHECK\s*\(\s*src_type\s+IN\s*\([^)]*\)\s*\)/i)?.[0] ?? ''
    expect(checkBody).not.toContain("'entry'")
  })

  it('no source file under core/src or packages/agent/src writes srcType="entry"', async () => {
    // The migration .sql file references 'entry' as the legacy value to
    // backfill; that file is intentionally excluded here. Only TypeScript
    // sources and tests get the strict treatment.
    const { execSync } = await import('node:child_process')
    const result = execSync(
      `grep -rn "srcType: *'entry'" ${REPO_ROOT}/core/src ${REPO_ROOT}/packages/agent/src --include="*.ts" || true`,
      { encoding: 'utf8' }
    )
    // Test fixtures in schema.test.ts intentionally still exercise the
    // legacy spelling against the test DB to validate the CHECK
    // constraint rejects it. Filter those out.
    const productionMatches = result
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => !line.includes('__tests__/'))
    expect(productionMatches).toEqual([])
  })
})
