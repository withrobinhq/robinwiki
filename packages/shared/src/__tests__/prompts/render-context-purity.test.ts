import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as loader from '../../prompts/loader'
import { loadFragmentRelevanceSpec } from '../../prompts/loaders/fragment-relevance'
import { loadFragmentationSpec } from '../../prompts/loaders/fragmentation'
import { loadPeopleExtractionSpec } from '../../prompts/loaders/people-extraction'
import { loadPersonSummarySpec } from '../../prompts/loaders/person-summary'
import { loadWikiClassificationSpec } from '../../prompts/loaders/wiki-classification'
import { loadWikiGenerationSpec } from '../../prompts/loaders/wiki-generation'
import { loadWikiRelevanceSpec } from '../../prompts/loaders/wiki-relevance'

/**
 * Render-context purity: every renderTemplate call site is enumerated and
 * its variables map snapshot-asserted to be free of named secrets. The
 * compiled template can be partially user-controlled (via wiki-type YAML
 * overrides), so any value that lands here is effectively user-readable.
 */

const FORBIDDEN_KEYS = [
  'process',
  'env',
  'MASTER_KEY',
  'OPENROUTER_API_KEY',
  'BETTER_AUTH_SECRET',
  'RECOVERY_SECRET',
  'JOB_SIGNING_SECRET',
  'KEY_ENCRYPTION_SECRET',
] as const

interface CapturedCall {
  template: string
  variables: Record<string, unknown>
}

let captured: CapturedCall[]

beforeEach(() => {
  captured = []
  vi.spyOn(loader, 'renderTemplate').mockImplementation((template, variables, opts) => {
    captured.push({ template, variables: { ...variables } })
    // Delegate to a fresh compile so the loader's downstream return value is
    // realistic. Using the real (non-spied) implementation here would create
    // a recursion loop, so do the compile inline.
    const Handlebars = require('handlebars') as {
      compile: (t: string, opts: { noEscape: boolean }) => (vars: unknown) => string
    }
    const compiled = Handlebars.compile(template, { noEscape: true })
    let effective = variables
    if (opts?.userControlled && opts.userControlled.length > 0) {
      effective = { ...variables }
      for (const key of opts.userControlled) {
        const v = effective[key]
        if (typeof v === 'string') effective[key] = v
      }
    }
    return compiled(effective)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function assertSnapshotIsClean(label: string, calls: CapturedCall[]) {
  expect(calls.length, `${label}: expected at least one renderTemplate call`).toBeGreaterThan(0)
  for (const call of calls) {
    const keys = Object.keys(call.variables)
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(
        keys,
        `${label}: top-level key "${forbidden}" leaked into render context`
      ).not.toContain(forbidden)
    }
    const json = JSON.stringify(call.variables)
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(
        json.includes(forbidden),
        `${label}: forbidden token "${forbidden}" appears anywhere in render context`
      ).toBe(false)
    }
  }
}

describe('render-context purity — no secrets in any renderTemplate call', () => {
  it('fragmentation loader', () => {
    loadFragmentationSpec({ content: 'hello world', context: 'some context' })
    assertSnapshotIsClean('fragmentation', captured)
  })

  it('wiki-classification loader', () => {
    loadWikiClassificationSpec({
      content: 'fragment content',
      wikis: '- wiki one\n- wiki two',
      ownerName: 'Alice',
      fragmentContext: 'some context',
    })
    assertSnapshotIsClean('wiki-classification', captured)
  })

  it('people-extraction loader', () => {
    loadPeopleExtractionSpec({
      content: 'I met Alice and Bob today.',
      knownPeople: '- Alice\n- Bob',
    })
    assertSnapshotIsClean('people-extraction', captured)
  })

  it('wiki-relevance loader', () => {
    loadWikiRelevanceSpec({
      wikiName: 'Health Tracking',
      threadType: 'log',
      threadDescription: 'a daily log',
      threadSummary: 'recent entries',
      fragmentContent: 'I went for a 5k run this morning',
    })
    assertSnapshotIsClean('wiki-relevance', captured)
  })

  it('fragment-relevance loader', () => {
    loadFragmentRelevanceSpec({
      sourceContent: 'source',
      candidateContent: 'candidate',
    })
    assertSnapshotIsClean('fragment-relevance', captured)
  })

  it('person-summary loader', () => {
    loadPersonSummarySpec({
      canonicalName: 'Alice',
      aliases: 'Al, Allie',
      existingBody: 'Existing person body.',
      fragments: 'Some fragments.',
    })
    assertSnapshotIsClean('person-summary', captured)
  })

  it('wiki-generation loader', () => {
    loadWikiGenerationSpec('log', {
      fragments: 'no fragments',
      title: 'Test Wiki',
      date: '2026-04-20',
      count: 0,
    })
    assertSnapshotIsClean('wiki-generation', captured)
  })
})

describe('render-context purity — static analysis', () => {
  it('no source file pipes process.env into renderTemplate', () => {
    // Walk packages/ and assert no .ts file contains a renderTemplate(...)
    // call that references process.env on the same line. Mirrors the
    // documented `rg "renderTemplate.*process\\.env" packages/` invariant.
    const packagesRoot = resolve(__dirname, '../../../..')
    const matches: string[] = []
    const RE = /renderTemplate.*process\.env/

    function walk(dir: string): void {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
        const full = resolve(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) {
          walk(full)
          continue
        }
        if (!full.endsWith('.ts') && !full.endsWith('.mts')) continue
        const content = readFileSync(full, 'utf-8')
        for (const line of content.split('\n')) {
          if (RE.test(line)) matches.push(`${full}: ${line}`)
        }
      }
    }

    walk(packagesRoot)
    expect(matches).toEqual([])
  })
})
