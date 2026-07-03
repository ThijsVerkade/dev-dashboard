export type Tier = 'api' | 'frontend' | 'bff' | 'unknown'

export interface ProjectFacts {
  group: string
  app: string
  tier: Tier
  repoPath: string
  /** Detected stack labels, e.g. "Laravel ^13.0"; version suffix present when known. */
  stack: string[]
  /** Script names from package.json and/or composer.json, merged. */
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

export interface VaultNode {
  /** Display label, from the note's leading `# ` heading (fallback: last slug segment). */
  title: string
  /** Vault-relative slug without extension, e.g. "standards/api"; "" for the root index. */
  slug: string
  /** In-app URL, e.g. "/brain" or "/brain/standards/api". */
  href: string
  /** Child nodes; empty for leaf notes. */
  children: VaultNode[]
}

export interface VaultTree {
  /** Top-level section nodes (standards, projects, adrs, …). */
  nodes: VaultNode[]
  /** Every note slug in the vault (e.g. "index", "standards/api", "adrs/ADR-0001-…"), for wiki-link resolution. */
  notePaths: string[]
}

export interface NoteView {
  title: string
  /** Flat key→value frontmatter (arrays kept as their raw `[a, b]` string). */
  frontmatter: Record<string, string>
  /** Markdown body with frontmatter stripped. */
  body: string
}
