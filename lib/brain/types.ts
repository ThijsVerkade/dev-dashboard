export type Tier = 'api' | 'frontend' | 'bff' | 'unknown'

export interface ProjectFacts {
  group: string
  app: string
  tier: Tier
  repoPath: string
  stack: string[]
  scripts: string[]
  readmeTitle?: string
  readmeIntro?: string
  hasAgentsDoc: boolean
}

export interface AdrPage {
  number: number
  slug: string
  title: string
  markdown: string
  sourceUrl: string
}

export interface VaultSummary {
  added: string[]
  updated: string[]
  skipped: string[]
  warned: string[]
}
