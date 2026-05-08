import { evalite } from 'evalite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadClassificationFixtures } from '../lib/fixture-loader.js'
import { classificationLandingScorer } from '../lib/scorers.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'fixtures')

/**
 * Component #8 — classification eval. Each fixture is a fragment text +
 * expected wiki keys (the slugs the fragment SHOULD land in). Run with:
 *
 *   pnpm -F @robin/core eval
 *
 * The stub task here picks every wiki whose slug appears as a substring of
 * the fragment text — a deliberately weak baseline so the suite passes
 * `scoreThreshold=50` on canary fixtures and gets stronger as Marcel's
 * prompt improves. Replace with the real classifier (Marcel / wikiClassifier)
 * when wiring an LLM-backed run.
 */
const KNOWN_WIKIS = [
  'retail-operations',
  'policy-decisions',
  'customer-segments',
  'engineering-decisions',
  'product-roadmap',
  'health',
  'reading-list',
  'travel',
  'culinary',
  'finance',
]

evalite('classification', {
  data: () => loadClassificationFixtures(fixturesDir),
  task: async (input: string) => {
    const lower = input.toLowerCase()
    const wikis = KNOWN_WIKIS.filter((slug) =>
      slug
        .split('-')
        .some((tok) => lower.includes(tok)),
    )
    return { wikis }
  },
  scorers: [classificationLandingScorer],
})
