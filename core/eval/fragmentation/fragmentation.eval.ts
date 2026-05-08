import { evalite } from 'evalite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadFragmentationFixtures } from '../lib/fixture-loader.js'
import { fragmentationShapeScorer } from '../lib/scorers.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'fixtures')

/**
 * Component #7 — fragmentation eval. The corpus lives at
 * core/eval/fragmentation/fixtures/*.json and is hand-authored. Run with:
 *
 *   pnpm -F @robin/core eval
 *
 * The default task here is a deterministic stub that splits on double
 * newlines so the suite runs offline without OpenRouter. Replace with the
 * real fragmenter (createIngestAgents().fragmenter) when wiring an
 * LLM-backed run — see core/src/queue/worker.ts for the integration shape.
 */
evalite('fragmentation', {
  data: () => loadFragmentationFixtures(fixturesDir),
  task: async (input: string) => {
    // Stub fragmenter: split on blank lines, drop trivially short chunks.
    // Same shape the real fragmenter returns: { fragments: [{ content }] }.
    const fragments = input
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12)
      .map((content) => ({ content }))
    return { fragments }
  },
  scorers: [fragmentationShapeScorer],
})
