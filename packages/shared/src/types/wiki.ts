export type WikiType =
  | 'log'
  | 'research'
  | 'belief'
  | 'decision'
  | 'project'
  | 'objective'
  | 'skill'
  | 'agent'
  | 'voice'
  | 'principle'

export interface DefaultWiki {
  name: string
  slug: string
  type: WikiType
}

export const DEFAULT_WIKIS: DefaultWiki[] = [
  { name: 'Daily Log', slug: 'daily-log', type: 'log' },
  { name: 'Bookmarks', slug: 'bookmarks', type: 'research' },
  { name: 'Beliefs', slug: 'beliefs', type: 'belief' },
  { name: 'Decisions', slug: 'decisions', type: 'decision' },
  { name: 'Projects', slug: 'projects', type: 'project' },
  { name: 'Objectives', slug: 'objectives', type: 'objective' },
  { name: 'Skills', slug: 'skills', type: 'skill' },
  { name: 'Agents', slug: 'agents', type: 'agent' },
  { name: 'Voice', slug: 'voice', type: 'voice' },
  { name: 'Principles', slug: 'principles', type: 'principle' },
]

export interface WikiTypeRecord {
  slug: string
  name: string
  shortDescriptor: string
  descriptor: string
  prompt: string
  isDefault: boolean
  userModified: boolean
  createdAt: Date
  updatedAt: Date
}
