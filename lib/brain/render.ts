import { buildFrontmatter } from './frontmatter'
import { mergeAutoBlock } from './auto-block'
import type { AdrPage, ProjectFacts, Tier } from './types'

export type StandardKind =
  | 'coding-standards'
  | 'api'
  | 'frontend'
  | 'bff'
  | 'deployment'
  | 'testing'

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const TIER_STD: Record<Tier, string | null> = {
  api: 'api',
  frontend: 'frontend',
  bff: 'bff',
  unknown: null,
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  return end === -1 ? content : content.slice(end + 5)
}

function stripLeadingTitle(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, '')
}

export function renderProjectPage(
  facts: ProjectFacts,
  existing: string | null,
  syncedDate: string,
): { content: string; warned: boolean } {
  const fm = buildFrontmatter({
    type: 'project',
    group: facts.group,
    app: facts.app,
    tier: facts.tier,
    repo: facts.repoPath,
    stack: facts.stack,
    status: 'active',
    'last-synced': syncedDate,
  })

  const follows = [TIER_STD[facts.tier], 'deployment', 'coding-standards']
    .filter((s): s is string => !!s)
    .map((s) => `[[standards/${s}|${s}]]`)
    .join(' · ')

  const autoInner = [
    facts.readmeIntro ? `> ${facts.readmeIntro}` : '> _No README summary found._',
    '',
    `**Follows:** ${follows}`,
    '',
    '## Stack',
    facts.stack.length ? facts.stack.map((s) => `- ${s}`).join('\n') : '- _none detected_',
    '',
    '## Scripts',
    facts.scripts.length ? facts.scripts.map((s) => `- \`${s}\``).join('\n') : '- _none_',
  ].join('\n')

  const stub = ['## What this does', '', '_Describe what this project does._'].join('\n')

  const existingBody = existing === null ? null : stripLeadingTitle(stripFrontmatter(existing))
  const merged = mergeAutoBlock(existingBody, autoInner, stub)
  const title = `# ${facts.group}/${facts.app}\n\n`
  return { content: `${fm}\n${title}${merged.body}\n`, warned: merged.warned }
}

export function renderAdr(
  page: { id: string; title: string; markdown: string; sourceUrl: string },
  syncedDate: string,
): AdrPage {
  const num = Number(page.title.match(/ADR[- ]?(\d+)/i)?.[1] ?? 0)
  const slug = `ADR-${String(num).padStart(4, '0')}-${slugify(page.title)}`
  const fm = buildFrontmatter({
    type: 'adr',
    'adr-id': num,
    title: page.title,
    'source-url': page.sourceUrl,
    status: 'accepted',
    'last-synced': syncedDate,
  })
  return {
    number: num,
    slug,
    title: page.title,
    sourceUrl: page.sourceUrl,
    markdown: `${fm}\n${page.markdown}\n\n---\n[View in Confluence](${page.sourceUrl})\n`,
  }
}

const DEPLOYMENT_BODY = `## Environments
We run **dev / stg / prod**, each mapped to an AWS named profile (\`CW_ENV_PROFILES\`).

## Where we deploy
Services run on **AWS App Runner**. Application logs go to **CloudWatch** and are read
per-environment by the dev-dashboard Logs panel.

## Release Flow
**merge → deploy staging → tag for production.** Staging is played from the GitLab
manual job \`deploy:staging\`. Per-group staging URLs come from \`STAGING_URLS\`.

## Notes
_Add rollback, migration, and secrets-handling notes here._`

const STUB_BODY: Record<Exclude<StandardKind, 'deployment'>, string> = {
  'coding-standards':
    '## Naming & structure\n\n_TBD._\n\n## Git & merge\nFollow the BAS merge-commit standard (ADR-6). See [[adrs/index|ADRs]].',
  api: '## Endpoints\n\n_TBD._\n\n## Validation & errors\n\n_TBD._\n\n## Auth\n\n_TBD._',
  frontend: '## Structure\n\n_TBD._\n\n## State\n\n_TBD._\n\n## Components & a11y\n\n_TBD._',
  bff: '## Responsibilities\n\n_TBD._\n\n## Contracts to FE\n\n_TBD._\n\n## Auth passthrough\n\n_TBD._',
  testing: '## Expectations per tier\n\n_TBD._',
}

const STD_TITLE: Record<StandardKind, string> = {
  'coding-standards': 'Coding standards',
  api: 'API standards',
  frontend: 'Frontend standards',
  bff: 'BFF standards',
  deployment: 'Deployment',
  testing: 'Testing',
}

export function renderStandardStub(kind: StandardKind): string {
  const tier = kind === 'coding-standards' ? 'cross-cutting' : kind
  const fm = buildFrontmatter({ type: 'standard', tier, status: 'authored' })
  const body = kind === 'deployment' ? DEPLOYMENT_BODY : STUB_BODY[kind]
  return `${fm}\n# ${STD_TITLE[kind]}\n\n${body}\n`
}

export function renderIndex(title: string, links: Array<{ label: string; href: string }>): string {
  const list = links.map((l) => `- [[${l.href}|${l.label}]]`).join('\n')
  return `# ${title}\n\n${list}\n`
}
