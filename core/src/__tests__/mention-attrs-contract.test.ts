import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * H2 (#329) contract guards on FRAGMENT_MENTIONS_PERSON edge attrs.
 *
 * Every code path that writes a FRAGMENT_MENTIONS_PERSON edge MUST
 * stamp the `attrs` jsonb with the literal mention surface form, the
 * source span the LLM saw, and the extractor confidence. Without
 * those fields, /people surfaces and matcher audits cannot
 * reconstruct what the LLM actually saw at extract time.
 *
 * The two production write sites are:
 *   1. packages/agent/src/stages/persist.ts (worker pipeline)
 *   2. core/src/mcp/handlers.ts            (MCP log_fragment fast path)
 *
 * Tombstones live in core/src/lib/seedFixture.ts (UAT seed) and
 * core/src/routes/people.ts (merge-people repointer); those paths
 * are dev-only or carry attrs through a different mechanism, so
 * they are explicitly skipped.
 *
 * Behavioural assertions on the actual attrs jsonb live in:
 *   - packages/agent/src/__tests__/persist-people.test.ts
 *   - core/src/__tests__/mcp-log-fragment.test.ts
 *
 * This file is a static guard that catches a regression at the
 * source level before the DB ever sees it.
 */

const REPO_ROOT = resolve(__dirname, '../../..')

const PERSIST_PATH = resolve(REPO_ROOT, 'packages/agent/src/stages/persist.ts')
const HANDLERS_PATH = resolve(REPO_ROOT, 'core/src/mcp/handlers.ts')

describe('FRAGMENT_MENTIONS_PERSON attrs contract (H2 #329)', () => {
  it('worker persist stage writes attrs on FRAGMENT_MENTIONS_PERSON', () => {
    const src = readFileSync(PERSIST_PATH, 'utf8')
    // Locate the FRAGMENT_MENTIONS_PERSON insert block. We look for a
    // window that spans from the edge type back ~30 lines so we can
    // confirm `attrs:` appears next to it.
    const idx = src.indexOf("edgeType: 'FRAGMENT_MENTIONS_PERSON'")
    expect(idx).toBeGreaterThan(-1)
    const window = src.slice(Math.max(0, idx - 600), idx + 200)
    expect(window).toMatch(/attrs:\s*payload\.attrs/)
  })

  it('MCP log_fragment handler writes attrs on FRAGMENT_MENTIONS_PERSON', () => {
    const src = readFileSync(HANDLERS_PATH, 'utf8')
    const idx = src.indexOf("edgeType: 'FRAGMENT_MENTIONS_PERSON'")
    expect(idx).toBeGreaterThan(-1)
    const window = src.slice(Math.max(0, idx - 600), idx + 200)
    expect(window).toMatch(/attrs[,:]/)
  })

  it('MentionEdgeAttrs type carries mention, sourceSpan, confidence', () => {
    const src = readFileSync(PERSIST_PATH, 'utf8')
    expect(src).toMatch(/interface MentionEdgeAttrs[\s\S]{0,400}mention:\s*string/)
    expect(src).toMatch(/interface MentionEdgeAttrs[\s\S]{0,400}sourceSpan:\s*string/)
    expect(src).toMatch(/interface MentionEdgeAttrs[\s\S]{0,400}confidence:\s*number/)
  })
})
