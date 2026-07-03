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

  const sections: string[] = [
    facts.readmeIntro ? `> ${facts.readmeIntro}` : '> _No README summary found._',
    '',
    `**Follows:** ${follows}`,
    '',
    '## Stack',
    facts.stack.length ? facts.stack.map((s) => `- ${s}`).join('\n') : '- _none detected_',
    '',
    '## Scripts',
    facts.scripts.length ? facts.scripts.map((s) => `- \`${s}\``).join('\n') : '- _none_',
    '',
    '## Configuration',
    facts.envKeys.length ? facts.envKeys.map((k) => `- \`${k}\``).join('\n') : '- _no .env.example_',
    '',
    '## Layout',
    facts.layout.length ? facts.layout.map((d) => `- \`${d}/\``).join('\n') : '- _none_',
  ]
  if (facts.boundedContexts.length) {
    sections.push('', '## Bounded contexts', facts.boundedContexts.map((c) => `- ${c}`).join('\n'))
  }
  const autoInner = sections.join('\n')

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

/** Frontmatter, title, and stub prose for a standards page, kept separate so callers can
 *  splice content (e.g. an AUTO block) between the title and the prose without re-parsing. */
function standardParts(kind: StandardKind): { frontmatter: string; title: string; prose: string } {
  const tier = kind === 'coding-standards' ? 'cross-cutting' : kind
  const frontmatter = buildFrontmatter({ type: 'standard', tier, status: 'authored' })
  const title = `# ${STD_TITLE[kind]}`
  const prose = kind === 'deployment' ? DEPLOYMENT_BODY : STUB_BODY[kind]
  return { frontmatter, title, prose }
}

export function renderStandardStub(kind: StandardKind): string {
  const { frontmatter, title, prose } = standardParts(kind)
  return `${frontmatter}\n${title}\n\n${prose}\n`
}

type ToolFacts = Pick<ProjectFacts, 'tier' | 'stack' | 'scripts'>

function hasTool(hay: string[], needle: string): boolean {
  return hay.some((s) => s.toLowerCase().includes(needle))
}

/** AUTO-block inner markdown summarizing detected tooling for a standards page. */
export function renderToolingBlock(
  kind: 'testing' | 'coding-standards',
  facts: ToolFacts[],
): string {
  const detect = (f: ToolFacts): string[] => {
    if (kind === 'testing') {
      const t: string[] = []
      if (hasTool(f.stack, 'pest')) t.push('Pest')
      if (hasTool(f.scripts, 'vitest')) t.push('Vitest')
      if (hasTool(f.scripts, 'jest')) t.push('Jest')
      if (hasTool(f.scripts, 'playwright')) t.push('Playwright')
      if (!t.length && hasTool(f.scripts, 'test')) t.push('test script')
      return t
    }
    const t: string[] = []
    if (hasTool(f.stack, 'pint')) t.push('Pint')
    if (hasTool(f.scripts, 'lint')) t.push('ESLint')
    if (hasTool(f.scripts, 'format')) t.push('Prettier')
    if (hasTool(f.scripts, 'biome')) t.push('Biome')
    return t
  }

  const byTier = new Map<string, Set<string>>()
  for (const f of facts) {
    for (const tool of detect(f)) {
      const set = byTier.get(f.tier) ?? new Set<string>()
      set.add(tool)
      byTier.set(f.tier, set)
    }
  }
  const lines =
    byTier.size === 0
      ? ['- _no tooling detected_']
      : [...byTier].map(([tier, tools]) => `- **${tier}**: ${[...tools].sort().join(', ')}`)
  return lines.join('\n')
}

/** Full standards file content with a regenerated tooling AUTO block + preserved prose. */
export function renderStandardWithTooling(
  kind: 'testing' | 'coding-standards',
  facts: ToolFacts[],
  existing: string | null,
): string {
  const { frontmatter, title, prose } = standardParts(kind)
  const autoInner = renderToolingBlock(kind, facts)
  const existingBody = existing === null ? null : stripLeadingTitle(stripFrontmatter(existing))
  const merged = mergeAutoBlock(existingBody, autoInner, prose)
  return `${frontmatter}\n${title}\n\n${merged.body}\n`
}

export function renderIndex(title: string, links: Array<{ label: string; href: string }>): string {
  const list = links.map((l) => `- [[${l.href}|${l.label}]]`).join('\n')
  return `# ${title}\n\n${list}\n`
}

const ARCHITECTURE_NOTES: Record<string, string> = {
  index: `---
type: architecture
status: authored
---
# Architecture

How the BAS platform is layered, written so an AI agent can navigate from the
whole-system view down to a single layer.

- [[architecture/system-flow|System flow: FE → BFF → API]]
- [[architecture/domain-layer|Domain layer]]
- [[architecture/application-layer|Application layer]]
- [[architecture/infrastructure-layer|Infrastructure layer]]

The API follows Domain-Driven Design with a hexagonal (ports & adapters)
arrangement: each bounded context is split into **Application**, **Domain**,
and **Infrastructure**. Read the layer notes in that order — Domain is the
core, Application orchestrates it, Infrastructure adapts it to the outside
world.
`,
  'system-flow': `---
type: architecture
status: authored
---
# System flow: FE → BFF → API

Requests flow in one direction across three tiers. Each tier has one job and
never reaches past its neighbour.

## The chain

1. **Frontend (FE)** — Next.js/React. Renders UI and calls **only** its BFF.
   It never calls the API directly and holds no domain logic.
2. **Backend-for-Frontend (BFF)** — a thin Node service per frontend. It
   aggregates and shapes data for that specific UI, and passes authentication
   through to the API. It owns no business rules. Its upstream API is wired via
   an \`*_API_URL\` env var (e.g. \`AUCTION_API_URL\`).
3. **API** — Laravel. Owns the domain: business rules, persistence, events.
   It is the single source of truth and is shared across BFFs.

## Rules

- FE → BFF → API only. No tier skips its neighbour.
- Domain rules live in the API, never in a BFF or FE.
- The BFF adapts shape and auth for one frontend; if two frontends need
  different shapes, they get different BFFs.

See [[architecture/domain-layer|Domain]],
[[architecture/application-layer|Application]], and
[[architecture/infrastructure-layer|Infrastructure]] for how the API itself is
layered.
`,
  'domain-layer': `---
type: architecture
status: authored
---
# Domain layer

The core of the API. Pure business model with no framework or I/O concerns.

## What lives here

- **Entities** — objects with identity and a lifecycle (e.g. an Auction, a Lot).
- **Value objects** — immutable values compared by content (e.g. Money, a bid
  amount).
- **Domain events** — facts that happened in the domain (e.g. \`BidPlaced\`).
- **Domain services** — business logic that doesn't belong to a single entity.

## Bounded contexts

Each context is a self-contained slice of the domain under \`app/<Context>/\`,
split into \`Application\` / \`Domain\` / \`Infrastructure\`. In \`auction/api\` these
include **Auction**, **Inventory**, **Notification**, **Publishing**, **Hexon**,
and a **Shared** kernel. A context owns its own models and never reaches into
another context's internals.

## Rules

- No Laravel, Eloquent, HTTP, or database code here. Those are
  [[architecture/infrastructure-layer|infrastructure]] details.
- The Domain does not depend on the Application or Infrastructure layers —
  dependencies point inward.
`,
  'application-layer': `---
type: architecture
status: authored
---
# Application layer

Orchestrates the domain to fulfil a use case. The "verbs" of the system.

## What lives here

- **Use cases / application services** — one class per action (e.g. "place a
  bid"): load domain objects, invoke domain behaviour, persist via a port,
  dispatch events.
- **Commands / queries** — the input shapes a use case accepts.
- **Ports (interfaces)** — what the use case needs from the outside world
  (repositories, gateways), defined here and implemented in
  [[architecture/infrastructure-layer|infrastructure]].

## Rules

- Contains orchestration, not business rules — those belong in the
  [[architecture/domain-layer|domain]].
- No HTTP, framework, or persistence code. It depends on the Domain and on
  ports it defines, never on concrete infrastructure.
- Entry points (HTTP controllers, console commands, listeners) call the
  Application layer — they are adapters, not part of it.
`,
  'infrastructure-layer': `---
type: architecture
status: authored
---
# Infrastructure layer

Adapts the domain and application to the outside world. The replaceable edge.

## What lives here

- **Repository implementations** — the concrete side of the ports the
  [[architecture/application-layer|application layer]] defines, backed by
  Eloquent/the database.
- **External adapters** — clients for other systems (S3, Firebase, Hexon,
  messaging), HTTP entry points (\`Http/\` controllers, requests, resources),
  and framework wiring (Laravel providers).
- **Persistence mapping** — turning domain objects into rows and back.

## Rules

- Depends inward on the Application and Domain layers; they never depend on it
  (ports & adapters / hexagonal).
- Laravel and Eloquent are infrastructure details — swapping the framework
  should not touch the [[architecture/domain-layer|domain]].
- HTTP controllers are thin: validate input, call an application use case,
  return a resource. No business logic.
`,
}

export function renderArchitectureNote(slug: string): string {
  return ARCHITECTURE_NOTES[slug]
}
