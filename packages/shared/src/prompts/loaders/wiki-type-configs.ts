import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpecFromBlob } from '../loader.js'
import type { WikiType } from '../../types/wiki.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WIKI_TYPES_DIR = resolve(__dirname, '..', 'specs', 'wiki-types')

export interface WikiTypeConfig {
  slug: WikiType
  displayLabel: string
  displayDescription: string
  displayShortDescriptor: string
  displayOrder: number
  version: number
  rawYaml: string
  /**
   * Wave G — type-aware HyDE authoring instruction. Empty string when the
   * spec does not define `internal_framing`; the seeder writes NULL into
   * wiki_types.internal_framing in that case so the column genuinely
   * reflects "no framing on disk".
   */
  internalFraming: string
}

/**
 * Read every wiki-type YAML spec from disk, validate via PromptSpecSchema,
 * and return a sorted array of configs. Each config carries the full raw
 * YAML blob so the core seed can store it verbatim in wiki_types.prompt.
 *
 * Specs flagged `system_only: true` are skipped defensively — wiki-type
 * YAMLs should never be system_only, but guard against future mistakes.
 *
 * Throws on parse errors (YAMLException) or schema errors (ZodError). The
 * seed caller is responsible for per-file error recovery; test code should
 * fail hard on malformed YAML.
 */
export function loadWikiTypeConfigs(): WikiTypeConfig[] {
  const files = readdirSync(WIKI_TYPES_DIR).filter((f) => f.endsWith('.yaml'))
  const configs: WikiTypeConfig[] = []
  for (const filename of files) {
    const filePath = resolve(WIKI_TYPES_DIR, filename)
    const rawYaml = readFileSync(filePath, 'utf-8')
    const spec = parseSpecFromBlob(rawYaml)
    if (spec.system_only) continue
    const slug = filename.replace(/\.yaml$/, '') as WikiType
    configs.push({
      slug,
      displayLabel: spec.display_label ?? slug,
      displayDescription: spec.display_description ?? '',
      displayShortDescriptor: spec.display_short_descriptor ?? '',
      displayOrder: spec.display_order ?? 999,
      version: spec.version,
      rawYaml,
      internalFraming: spec.internal_framing ?? '',
    })
  }
  return configs.sort((a, b) => a.displayOrder - b.displayOrder)
}
