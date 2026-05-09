import { evalite } from 'evalite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'fixtures')

interface PeopleExtractionFixture {
  input: string
  knownPeople: Array<{ key: string; canonicalName: string; aliases: string[] }>
  expectedMatched: string[]
  expectedCandidates: string[]
  notes?: string
}

async function loadFixtures(): Promise<
  Array<{ name: string; input: PeopleExtractionFixture; expected: PeopleExtractionFixture }>
> {
  const entries = await readdir(fixturesDir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()

  const out = []
  for (const file of files) {
    const raw = await readFile(join(fixturesDir, file), 'utf8')
    const parsed = JSON.parse(raw) as PeopleExtractionFixture
    out.push({ name: file.replace(/\.json$/, ''), input: parsed, expected: parsed })
  }
  return out
}

/**
 * Stream P (#237 follow-up) — people-extraction eval. Verifies that the
 * extractor surfaces every person-like mention into matched (verified
 * known person) or candidates (unknown), instead of silently dropping
 * unfamiliar names. Run with:
 *
 *   pnpm -F @robin/core eval
 *
 * The default task is a deterministic stub that splits the input into
 * proper-noun-shaped tokens and routes each through the known-people
 * list. Replace with the real entityExtractor agent when wiring an
 * LLM-backed run, mirroring core/src/queue/worker.ts.
 */
evalite('people-extraction', {
  data: () => loadFixtures(),
  task: async (input: PeopleExtractionFixture) => {
    // Stub extractor: pick capitalised single-token names from the
    // input. Each token is matched against knownPeople (canonicalName
    // or alias) and routed to matched, otherwise candidates.
    const tokens = Array.from(
      new Set(
        input.input
          .split(/[^A-Za-z]+/)
          .filter((t) => /^[A-Z][a-z]+$/.test(t))
      )
    )
    const known = new Map<string, string>()
    for (const p of input.knownPeople) {
      known.set(p.canonicalName, p.key)
      for (const a of p.aliases) known.set(a, p.key)
    }
    const matched: Array<{ mention: string; matchedKey: string }> = []
    const candidates: Array<{ mention: string }> = []
    for (const t of tokens) {
      const key = known.get(t)
      if (key) matched.push({ mention: t, matchedKey: key })
      else candidates.push({ mention: t })
    }
    return { matched, candidates }
  },
  scorers: [
    {
      name: 'extractor-bucket-shape',
      scorer: ({ output, expected }) => {
        const matchedNames = output.matched.map((m: { mention: string }) => m.mention).sort()
        const candidateNames = output.candidates
          .map((c: { mention: string }) => c.mention)
          .sort()
        const expMatched = [...expected.expectedMatched].sort()
        const expCandidates = [...expected.expectedCandidates].sort()
        const matchedOk = JSON.stringify(matchedNames) === JSON.stringify(expMatched)
        const candidateOk =
          JSON.stringify(candidateNames) === JSON.stringify(expCandidates)
        return matchedOk && candidateOk ? 1 : 0
      },
    },
  ],
})
