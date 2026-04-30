import type { WikiType } from './wiki.js'

// ─── Wiki Type Prompt Keys ───
//
// These keys address per-wiki-type prompt templates stored in the `configs`
// table under kind='wiki_type_prompt'. Previously these were seeded into the
// `config_notes` table; that feature was removed in M1.

export type WikiGuideKey =
  | 'wiki-guide-log'
  | 'wiki-guide-research'
  | 'wiki-guide-belief'
  | 'wiki-guide-decision'
  | 'wiki-guide-project'
  | 'wiki-guide-objective'
  | 'wiki-guide-skill'
  | 'wiki-guide-agent'
  | 'wiki-guide-voice'
  | 'wiki-guide-principle'

export const WIKI_TYPE_TO_GUIDE_KEY: Record<WikiType, WikiGuideKey> = {
  log: 'wiki-guide-log',
  research: 'wiki-guide-research',
  belief: 'wiki-guide-belief',
  decision: 'wiki-guide-decision',
  project: 'wiki-guide-project',
  objective: 'wiki-guide-objective',
  skill: 'wiki-guide-skill',
  agent: 'wiki-guide-agent',
  voice: 'wiki-guide-voice',
  principle: 'wiki-guide-principle',
}
