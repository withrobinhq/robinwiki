import type { WikiType } from '@robin/shared'

/**
 * Static descriptor map for wiki type inference.
 * Sourced from the YAML-backed wiki-type-configs — kept inline so
 * inference works without loading YAML specs at runtime.
 */
const WIKI_TYPE_DESCRIPTORS: Record<WikiType, string> = {
  log:       'a chronological synthesis of events and observations',
  research:  'a curated library of references and findings on a topic',
  belief:    'a synthesis of a held position or mental model',
  decision:  'a record of a discrete choice and its reasoning',
  project:   'a living document of an active initiative',
  objective: 'a high-level objective with measurable direction',
  skill:     'a knowledge base for a capability being built',
  agent:     'documentation for a configured AI assistant',
  voice:     'a style guide for communication',
  principle: 'a document of an operating rule or commitment',
}

/**
 * Infer the best-matching WikiType from a user-provided description.
 *
 * Scores each type by counting how many tokens in the descriptor appear
 * in the lowercased description. Returns the highest-scoring type.
 * Defaults to 'log' on tie or empty input.
 */
export function inferWikiType(description: string): WikiType {
  if (!description.trim()) return 'log'

  const lower = description.toLowerCase()
  const inputTokens = new Set(lower.split(/\s+/).filter(Boolean))

  let bestType: WikiType = 'log'
  let bestScore = 0

  for (const [type, descriptor] of Object.entries(WIKI_TYPE_DESCRIPTORS) as [WikiType, string][]) {
    const descriptorTokens = descriptor.toLowerCase().split(/\s+/)
    let score = 0
    for (const token of descriptorTokens) {
      if (inputTokens.has(token)) score++
      // Also check substring match for partial overlaps
      if (token.length > 3 && lower.includes(token)) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestType = type
    }
  }

  return bestType
}
