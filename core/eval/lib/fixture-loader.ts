import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Generic JSON-fixture loader. Each `*.json` under `dir` is parsed and
 * returned as `{ name, input, expected }` matching the shape evalite's
 * `data()` callback wants. The `name` is the file basename minus extension.
 *
 * Loaders are async because evalite invokes `data()` once per suite at
 * collection time. Synchronous file reads here would hide IO latency in
 * the eval timing.
 */
export interface FragmentationFixture {
  /** Raw entry text the fragmenter is asked to split. */
  input: string
  /** Expected fragment count window (inclusive). */
  expectedCount: { min: number; max: number }
  /** Claims that MUST appear as fragments (substring match). */
  mustContain: string[]
  /** Phrases that MUST NOT become fragments (matcher fluff). */
  mustNotContain?: string[]
  /** Free-text golden criteria — surfaced in eval reports. */
  notes?: string
}

export interface ClassificationFixture {
  /** Fragment text the classifier is asked to route. */
  input: string
  /** Wiki keys (slugs) the fragment SHOULD land in. */
  expected: string[]
  /** Wiki keys the fragment MUST NOT land in (precision). */
  forbidden?: string[]
  notes?: string
}

export type Loaded<TFixture> = Array<{
  name: string
  input: TFixture['input']
  expected: TFixture
}>

export async function loadFragmentationFixtures(
  dir: string,
): Promise<Loaded<FragmentationFixture>> {
  return loadFixtures<FragmentationFixture>(dir)
}

export async function loadClassificationFixtures(
  dir: string,
): Promise<Loaded<ClassificationFixture>> {
  return loadFixtures<ClassificationFixture>(dir)
}

async function loadFixtures<TFixture extends { input: unknown }>(
  dir: string,
): Promise<Loaded<TFixture>> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()

  const out: Loaded<TFixture> = []
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8')
    const parsed = JSON.parse(raw) as TFixture
    out.push({
      name: file.replace(/\.json$/, ''),
      input: parsed.input,
      expected: parsed,
    })
  }
  return out
}
