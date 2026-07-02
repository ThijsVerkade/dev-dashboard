# Knowledge Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `npm run brain` — a generator that turns the repos under `./repos` plus configured Confluence ADR links into a linked-markdown Obsidian vault at `./brain/`.

**Architecture:** Small, independently-tested pure modules under `lib/brain/` (tier inference, project extraction, frontmatter, AUTO-block merge, HTML→markdown, Confluence fetch, page render), orchestrated by `lib/brain/vault.ts`, wired to a CLI in `scripts/build-brain.ts` that mirrors `scripts/setup-repos.ts`. Auto-extracted content lives in `<!-- AUTO -->` blocks; hand-authored prose and existing standards files are preserved on re-run.

**Tech Stack:** TypeScript (ESM), Node `fs/promises`, `tsx` runner, Vitest, `turndown` (HTML→markdown), Confluence Cloud REST v2, `@next/env` for env loading.

## Global Constraints

- **Vitest is the only gate.** `npm test` runs `lib/**/*.test.ts`. Do NOT rely on `tsc`/`lint`/`next build` to pass — they are pre-broken in this repo (Next 16 types issue).
- **No `server-only` in brain modules.** The generator runs in plain Node via `tsx`; `lib/env.ts` imports `server-only` which throws outside an RSC bundle. Brain modules read `process.env` directly and MUST NOT import `@/lib/env`.
- **Result type:** `import { type Result, ok, failure, unconfigured } from '@/lib/result'`. Shape: `{ ok: true; data: T } | { ok: false; reason: 'unconfigured' | 'error'; message: string }`.
- **Confluence auth:** Basic auth header `'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')` — token in the header, never the URL. Reuse `JIRA_EMAIL` / `JIRA_TOKEN`; host is `CONFLUENCE_HOST ?? JIRA_HOST`.
- **Scripts load env first:** `const { loadEnvConfig } = _nextEnv as typeof import('@next/env'); loadEnvConfig(process.cwd())` then dynamic-`import('@/lib/brain/...')` AFTER (see `scripts/setup-repos.ts`).
- **Imports inside `lib/brain/`:** use relative paths (`./tier`) for sibling brain modules; use `@/lib/result` for the shared Result.
- **Commit after every task.** End commit messages with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Vault output is gitignored** (`/brain`). Never commit generated vault content.

---

### Task 1: Shared types + tier inference

**Files:**
- Create: `lib/brain/types.ts`
- Create: `lib/brain/tier.ts`
- Test: `lib/brain/tier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Tier = 'api' | 'frontend' | 'bff' | 'unknown'`
  - `interface ProjectFacts { group: string; app: string; tier: Tier; repoPath: string; stack: string[]; scripts: string[]; readmeTitle?: string; readmeIntro?: string; hasAgentsDoc: boolean }`
  - `interface AdrPage { number: number; slug: string; title: string; markdown: string; sourceUrl: string }`
  - `interface VaultSummary { added: string[]; updated: string[]; skipped: string[]; warned: string[] }`
  - `function inferTier(app: string): Tier`

- [ ] **Step 1: Write the failing test**

`lib/brain/tier.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { inferTier } from './tier'

describe('inferTier', () => {
  it('maps api apps', () => {
    expect(inferTier('api')).toBe('api')
  })
  it('maps bff apps (bff wins over fe in "fe-bff")', () => {
    expect(inferTier('web-bff')).toBe('bff')
    expect(inferTier('bff-erp')).toBe('bff')
    expect(inferTier('fe-bff')).toBe('bff')
  })
  it('maps frontend apps', () => {
    expect(inferTier('fe')).toBe('frontend')
    expect(inferTier('fe-erp')).toBe('frontend')
    expect(inferTier('app-fe')).toBe('frontend')
  })
  it('falls back to unknown', () => {
    expect(inferTier('inventory-capture-ext')).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/brain/tier.test.ts`
Expected: FAIL — cannot find module `./tier`.

- [ ] **Step 3: Write the types and implementation**

`lib/brain/types.ts`:
```ts
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
```

`lib/brain/tier.ts`:
```ts
import type { Tier } from './types'

/**
 * Infer a repo's tier from its app name. Order matters: "bff" is checked before
 * "fe" because a frontend-BFF ("fe-bff") is a BFF, not a frontend.
 */
export function inferTier(app: string): Tier {
  const name = app.toLowerCase()
  if (name.includes('bff')) return 'bff'
  if (name === 'api' || name.includes('api')) return 'api'
  if (name.includes('fe')) return 'frontend'
  return 'unknown'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/brain/tier.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/brain/types.ts lib/brain/tier.ts lib/brain/tier.test.ts
git commit -m "feat(brain): shared types + tier inference

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extract project facts from a repo dir

**Files:**
- Create: `lib/brain/extract-project.ts`
- Create fixtures: `lib/brain/__fixtures__/nest-api/package.json`, `lib/brain/__fixtures__/nest-api/README.md`, `lib/brain/__fixtures__/next-fe/package.json`
- Test: `lib/brain/extract-project.test.ts`

**Interfaces:**
- Consumes: `ProjectFacts`, `Tier` (Task 1), `inferTier` (Task 1).
- Produces: `async function extractProject(group: string, app: string, repoPath: string): Promise<ProjectFacts>` — reads `<repoPath>/package.json`, `README.md`, and checks for `AGENTS.md`/`CLAUDE.md`. Never throws on missing files (returns best-effort facts).

- [ ] **Step 1: Write the fixtures**

`lib/brain/__fixtures__/nest-api/package.json`:
```json
{
  "name": "auction-api",
  "scripts": { "start:dev": "nest start --watch", "build": "nest build", "test": "vitest run" },
  "dependencies": { "@nestjs/core": "^10.0.0", "drizzle-orm": "^0.30.0", "pg": "^8.11.0" }
}
```

`lib/brain/__fixtures__/nest-api/README.md`:
```markdown
# Auction API

The auction service. Handles listings, bids, and settlement.

More detail here.
```

`lib/brain/__fixtures__/next-fe/package.json`:
```json
{
  "name": "auction-fe",
  "scripts": { "dev": "next dev", "build": "next build" },
  "dependencies": { "next": "16.0.0", "react": "19.0.0" }
}
```

- [ ] **Step 2: Write the failing test**

`lib/brain/extract-project.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { extractProject } from './extract-project'

const fixtures = fileURLToPath(new URL('./__fixtures__', import.meta.url))

describe('extractProject', () => {
  it('extracts stack, scripts, readme, and tier from a nest api', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/nest-api`)
    expect(f.tier).toBe('api')
    expect(f.stack).toEqual(expect.arrayContaining(['NestJS', 'Drizzle', 'Postgres']))
    expect(f.scripts).toEqual(expect.arrayContaining(['start:dev', 'build', 'test']))
    expect(f.readmeTitle).toBe('Auction API')
    expect(f.readmeIntro).toBe('The auction service. Handles listings, bids, and settlement.')
    expect(f.hasAgentsDoc).toBe(false)
  })

  it('detects Next.js frontend and tolerates a missing README', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    expect(f.tier).toBe('frontend')
    expect(f.stack).toEqual(expect.arrayContaining(['Next.js', 'React']))
    expect(f.readmeTitle).toBeUndefined()
  })

  it('returns best-effort facts for a directory with no package.json', async () => {
    const f = await extractProject('auction', 'mystery', `${fixtures}/does-not-exist`)
    expect(f.stack).toEqual([])
    expect(f.scripts).toEqual([])
    expect(f.tier).toBe('unknown')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/brain/extract-project.test.ts`
Expected: FAIL — cannot find module `./extract-project`.

- [ ] **Step 4: Write the implementation**

`lib/brain/extract-project.ts`:
```ts
import { readFile } from 'node:fs/promises'
import { inferTier } from './tier'
import type { ProjectFacts } from './types'

/** Known dependency → human stack label. First match per dep wins. */
const STACK_LABELS: Array<[RegExp, string]> = [
  [/^@nestjs\//, 'NestJS'],
  [/^next$/, 'Next.js'],
  [/^react$/, 'React'],
  [/^drizzle-orm$/, 'Drizzle'],
  [/^@prisma\/client$/, 'Prisma'],
  [/^(pg|postgres)$/, 'Postgres'],
  [/^express$/, 'Express'],
  [/^@apollo\/server$/, 'Apollo'],
]

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

function detectStack(deps: Record<string, unknown>): string[] {
  const labels = new Set<string>()
  for (const dep of Object.keys(deps)) {
    for (const [re, label] of STACK_LABELS) {
      if (re.test(dep)) labels.add(label)
    }
  }
  return [...labels]
}

/** First `# Heading` text and the first non-empty paragraph after it. */
function parseReadme(md: string): { title?: string; intro?: string } {
  const lines = md.split('\n')
  const titleLine = lines.find((l) => /^#\s+/.test(l))
  const title = titleLine?.replace(/^#\s+/, '').trim()
  const afterTitle = titleLine ? lines.slice(lines.indexOf(titleLine) + 1) : lines
  const intro = afterTitle.map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'))
  return { title, intro }
}

export async function extractProject(
  group: string,
  app: string,
  repoPath: string,
): Promise<ProjectFacts> {
  const pkg = await readJson(`${repoPath}/package.json`)
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
  }
  const scripts = Object.keys((pkg?.scripts as Record<string, unknown>) ?? {})

  let readmeTitle: string | undefined
  let readmeIntro: string | undefined
  try {
    const md = await readFile(`${repoPath}/README.md`, 'utf8')
    const parsed = parseReadme(md)
    readmeTitle = parsed.title
    readmeIntro = parsed.intro
  } catch {
    /* no README — best effort */
  }

  const hasAgentsDoc =
    (await fileExists(`${repoPath}/AGENTS.md`)) || (await fileExists(`${repoPath}/CLAUDE.md`))

  return {
    group,
    app,
    tier: inferTier(app),
    repoPath,
    stack: detectStack(deps),
    scripts,
    readmeTitle,
    readmeIntro,
    hasAgentsDoc,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/brain/extract-project.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/brain/extract-project.ts lib/brain/extract-project.test.ts lib/brain/__fixtures__
git commit -m "feat(brain): extract project facts from a repo dir

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontmatter build + split

**Files:**
- Create: `lib/brain/frontmatter.ts`
- Test: `lib/brain/frontmatter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function buildFrontmatter(data: Record<string, string | number | string[]>): string` — returns a `---\n…\n---\n` block. String arrays render as `[a, b]`. Keys emitted in insertion order.
  - `function splitFrontmatter(content: string): { frontmatter: string | null; body: string }` — separates a leading `---` block from the body; `frontmatter` is null when absent.

- [ ] **Step 1: Write the failing test**

`lib/brain/frontmatter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildFrontmatter, splitFrontmatter } from './frontmatter'

describe('buildFrontmatter', () => {
  it('serializes strings, numbers, and arrays in order', () => {
    const fm = buildFrontmatter({ type: 'project', 'adr-id': 6, stack: ['nestjs', 'drizzle'] })
    expect(fm).toBe('---\ntype: project\nadr-id: 6\nstack: [nestjs, drizzle]\n---\n')
  })
})

describe('splitFrontmatter', () => {
  it('splits a leading frontmatter block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\ntype: project\n---\nHello\n')
    expect(frontmatter).toBe('type: project')
    expect(body).toBe('Hello\n')
  })
  it('returns null frontmatter when absent', () => {
    const { frontmatter, body } = splitFrontmatter('Just body\n')
    expect(frontmatter).toBeNull()
    expect(body).toBe('Just body\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/brain/frontmatter.test.ts`
Expected: FAIL — cannot find module `./frontmatter`.

- [ ] **Step 3: Write the implementation**

`lib/brain/frontmatter.ts`:
```ts
type FrontmatterValue = string | number | string[]

export function buildFrontmatter(data: Record<string, FrontmatterValue>): string {
  const lines = Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(', ')}]`
    return `${key}: ${value}`
  })
  return `---\n${lines.join('\n')}\n---\n`
}

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  if (!content.startsWith('---\n')) return { frontmatter: null, body: content }
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return { frontmatter: null, body: content }
  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/brain/frontmatter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/brain/frontmatter.ts lib/brain/frontmatter.test.ts
git commit -m "feat(brain): frontmatter build + split helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: AUTO-block merge (preserve hand-authored prose)

**Files:**
- Create: `lib/brain/auto-block.ts`
- Test: `lib/brain/auto-block.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const AUTO_START: string`, `const AUTO_END: string`
  - `function mergeAutoBlock(existingBody: string | null, autoInner: string, stub: string): { body: string; warned: boolean }`
    - `existingBody === null` → `<AUTO block>\n\n<stub>`, warned false.
    - existing has both markers → replace between markers with the new block, keep everything outside; warned false.
    - existing present but markers missing → prepend the new AUTO block, keep existing prose below; warned true.

- [ ] **Step 1: Write the failing test**

`lib/brain/auto-block.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mergeAutoBlock, AUTO_START, AUTO_END } from './auto-block'

describe('mergeAutoBlock', () => {
  it('creates a new body with auto block + stub when none exists', () => {
    const { body, warned } = mergeAutoBlock(null, '## Stack\n- NestJS', '## What this does\nTODO')
    expect(body).toBe(`${AUTO_START}\n## Stack\n- NestJS\n${AUTO_END}\n\n## What this does\nTODO`)
    expect(warned).toBe(false)
  })

  it('replaces only the auto block, preserving prose above and below', () => {
    const existing = `intro\n${AUTO_START}\nOLD\n${AUTO_END}\n\n## What this does\nMy prose`
    const { body, warned } = mergeAutoBlock(existing, '## Stack\n- New', '## What this does\nTODO')
    expect(body).toBe(`intro\n${AUTO_START}\n## Stack\n- New\n${AUTO_END}\n\n## What this does\nMy prose`)
    expect(warned).toBe(false)
  })

  it('warns and prepends when markers are missing from an existing file', () => {
    const { body, warned } = mergeAutoBlock('hand written only', '## Stack\n- New', 'STUB')
    expect(warned).toBe(true)
    expect(body).toBe(`${AUTO_START}\n## Stack\n- New\n${AUTO_END}\n\nhand written only`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/brain/auto-block.test.ts`
Expected: FAIL — cannot find module `./auto-block`.

- [ ] **Step 3: Write the implementation**

`lib/brain/auto-block.ts`:
```ts
export const AUTO_START = '<!-- AUTO:start — regenerated each run, do not edit by hand -->'
export const AUTO_END = '<!-- AUTO:end -->'

function block(autoInner: string): string {
  return `${AUTO_START}\n${autoInner}\n${AUTO_END}`
}

export function mergeAutoBlock(
  existingBody: string | null,
  autoInner: string,
  stub: string,
): { body: string; warned: boolean } {
  if (existingBody === null) {
    return { body: `${block(autoInner)}\n\n${stub}`, warned: false }
  }

  const start = existingBody.indexOf(AUTO_START)
  const end = existingBody.indexOf(AUTO_END)
  if (start !== -1 && end !== -1 && end > start) {
    const before = existingBody.slice(0, start)
    const after = existingBody.slice(end + AUTO_END.length)
    return { body: `${before}${block(autoInner)}${after}`, warned: false }
  }

  // Existing content but no usable markers: don't guess — prepend, keep prose.
  return { body: `${block(autoInner)}\n\n${existingBody}`, warned: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/brain/auto-block.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/brain/auto-block.ts lib/brain/auto-block.test.ts
git commit -m "feat(brain): AUTO-block merge preserving hand-authored prose

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Confluence HTML → markdown

**Files:**
- Modify: `package.json` (add `turndown` + `@types/turndown`)
- Create: `lib/brain/html-to-md.ts`
- Test: `lib/brain/html-to-md.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function htmlToMarkdown(html: string): string` — strips Confluence-namespaced tags (`ac:*`, `ri:*`) to their inner text, then converts standard HTML to markdown.

- [ ] **Step 1: Install dependencies**

Run: `npm install turndown && npm install -D @types/turndown`
Expected: both added to `package.json`.

- [ ] **Step 2: Write the failing test**

`lib/brain/html-to-md.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from './html-to-md'

describe('htmlToMarkdown', () => {
  it('converts headings, emphasis, and lists', () => {
    const md = htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>a</li><li>b</li></ul>')
    expect(md).toContain('# Title')
    expect(md).toContain('Hello **world**')
    expect(md).toContain('a')
  })

  it('keeps inner text of Confluence-namespaced macros', () => {
    const md = htmlToMarkdown('<p>See <ac:link><ri:page ri:content-title="Foo" />the page</ac:link>.</p>')
    expect(md).toContain('the page')
    expect(md).not.toContain('ac:link')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/brain/html-to-md.test.ts`
Expected: FAIL — cannot find module `./html-to-md`.

- [ ] **Step 4: Write the implementation**

`lib/brain/html-to-md.ts`:
```ts
import TurndownService from 'turndown'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

/**
 * Remove Confluence storage-format namespaced tags (`<ac:...>`, `<ri:...>`, and their
 * self-closing forms) but keep any inner text, then convert the remaining standard
 * HTML to markdown.
 */
export function htmlToMarkdown(html: string): string {
  const cleaned = html
    .replace(/<\/?(?:ac|ri):[^>]*>/g, '') // opening/closing/self-closing namespaced tags
    .replace(/\s+\n/g, '\n')
  return turndown.turndown(cleaned).trim()
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/brain/html-to-md.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/brain/html-to-md.ts lib/brain/html-to-md.test.ts
git commit -m "feat(brain): Confluence HTML to markdown via turndown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Confluence fetch (creds + page id parsing + fetch)

**Files:**
- Create: `lib/brain/confluence.ts`
- Test: `lib/brain/confluence.test.ts`

**Interfaces:**
- Consumes: `Result`/`ok`/`failure` from `@/lib/result`.
- Produces:
  - `interface ConfluenceCreds { host: string; email: string; token: string }`
  - `function confluenceCreds(): ConfluenceCreds | null` — reads `process.env.CONFLUENCE_HOST ?? process.env.JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN`.
  - `function parsePageId(idOrUrl: string): string | null` — returns the numeric id from a bare id or a `.../pages/<id>/...` URL.
  - `type FetchLike = typeof fetch`
  - `async function fetchConfluencePage(creds: ConfluenceCreds, idOrUrl: string, fetchImpl?: FetchLike): Promise<Result<{ id: string; title: string; html: string; sourceUrl: string }>>`

- [ ] **Step 1: Write the failing test**

`lib/brain/confluence.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parsePageId, fetchConfluencePage, type ConfluenceCreds } from './confluence'

const creds: ConfluenceCreds = { host: 'https://acme.atlassian.net', email: 'a@b.co', token: 't' }

describe('parsePageId', () => {
  it('accepts a bare id', () => expect(parsePageId('123456')).toBe('123456'))
  it('extracts id from a url', () =>
    expect(parsePageId('https://acme.atlassian.net/wiki/spaces/ENG/pages/234567/ADR-6')).toBe('234567'))
  it('returns null for garbage', () => expect(parsePageId('nope')).toBeNull())
})

describe('fetchConfluencePage', () => {
  it('fetches and returns title + storage html + source url', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id: '234567',
          title: 'ADR-6 Merge commits',
          body: { storage: { value: '<p>Body</p>' } },
          _links: { webui: '/spaces/ENG/pages/234567/ADR-6' },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await fetchConfluencePage(creds, '234567', fakeFetch)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.title).toBe('ADR-6 Merge commits')
      expect(res.data.html).toBe('<p>Body</p>')
      expect(res.data.sourceUrl).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/234567/ADR-6')
    }
  })

  it('fails cleanly on HTTP 404', async () => {
    const fakeFetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const res = await fetchConfluencePage(creds, '999', fakeFetch)
    expect(res.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/brain/confluence.test.ts`
Expected: FAIL — cannot find module `./confluence`.

- [ ] **Step 3: Write the implementation**

`lib/brain/confluence.ts`:
```ts
import { type Result, ok, failure } from '@/lib/result'

export interface ConfluenceCreds {
  host: string
  email: string
  token: string
}

export type FetchLike = typeof fetch

export function confluenceCreds(): ConfluenceCreds | null {
  const host = process.env.CONFLUENCE_HOST ?? process.env.JIRA_HOST
  const email = process.env.JIRA_EMAIL
  const token = process.env.JIRA_TOKEN
  if (!host || !email || !token) return null
  return { host, email, token }
}

export function parsePageId(idOrUrl: string): string | null {
  const trimmed = idOrUrl.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  const m = trimmed.match(/\/pages\/(\d+)/)
  return m ? m[1] : null
}

export async function fetchConfluencePage(
  creds: ConfluenceCreds,
  idOrUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ id: string; title: string; html: string; sourceUrl: string }>> {
  const id = parsePageId(idOrUrl)
  if (!id) return failure(`Not a Confluence page id or URL: ${idOrUrl}`)
  const base = creds.host.replace(/\/+$/, '')
  const url = `${base}/wiki/api/v2/pages/${id}?body-format=storage`
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64'),
        Accept: 'application/json',
      },
    })
    if (!res.ok) return failure(`Confluence page ${id} fetch failed (HTTP ${res.status}).`)
    const json = (await res.json()) as {
      title?: string
      body?: { storage?: { value?: string } }
      _links?: { webui?: string }
    }
    return ok({
      id,
      title: json.title ?? `Page ${id}`,
      html: json.body?.storage?.value ?? '',
      sourceUrl: json._links?.webui ? `${base}/wiki${json._links.webui}` : url,
    })
  } catch (e) {
    return failure(e instanceof Error ? `Could not reach Confluence: ${e.message}` : 'Could not reach Confluence.')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/brain/confluence.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/brain/confluence.ts lib/brain/confluence.test.ts
git commit -m "feat(brain): Confluence page fetch (creds, id parse, REST v2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Render pages (project, ADR, standard stubs, index)

**Files:**
- Create: `lib/brain/render.ts`
- Test: `lib/brain/render.test.ts`

**Interfaces:**
- Consumes: `ProjectFacts`, `AdrPage`, `Tier` (Task 1); `buildFrontmatter` (Task 3); `mergeAutoBlock`, `AUTO_START` (Task 4).
- Produces:
  - `function renderProjectPage(facts: ProjectFacts, existing: string | null, syncedDate: string): { content: string; warned: boolean }`
  - `function renderAdr(page: { id: string; title: string; markdown: string; sourceUrl: string }, syncedDate: string): AdrPage` — parses an ADR number from the title (`/ADR[- ]?(\d+)/i`, else `0`), builds a slug `ADR-####-<slugified-title>`, returns the full page in `AdrPage.markdown`.
  - `type StandardKind = 'coding-standards' | 'api' | 'frontend' | 'bff' | 'deployment' | 'testing'`
  - `function renderStandardStub(kind: StandardKind): string` — `deployment` pre-filled from the facts below; others are stub templates.
  - `function renderIndex(title: string, links: Array<{ label: string; href: string }>): string`
  - `function slugify(s: string): string`

  **Deployment facts to embed verbatim in `renderStandardStub('deployment')`:** environments **dev / stg / prod** mapped to AWS named profiles via `CW_ENV_PROFILES`; services run on **AWS App Runner** with logs in **CloudWatch**; staging is played from the GitLab manual job `deploy:staging`; per-group staging URLs come from `STAGING_URLS`; Release Flow is **merge → deploy staging → tag for production**.

- [ ] **Step 1: Write the failing test**

`lib/brain/render.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { renderProjectPage, renderAdr, renderStandardStub, renderIndex, slugify } from './render'
import { AUTO_START } from './auto-block'
import type { ProjectFacts } from './types'

const facts: ProjectFacts = {
  group: 'auction', app: 'api', tier: 'api', repoPath: 'repos/basworld/auction/api',
  stack: ['NestJS', 'Drizzle'], scripts: ['start:dev', 'build'], readmeTitle: 'Auction API',
  readmeIntro: 'The auction service.', hasAgentsDoc: false,
}

describe('renderProjectPage', () => {
  it('includes frontmatter, auto block, tier links, and stub prose', () => {
    const { content } = renderProjectPage(facts, null, '2026-07-02')
    expect(content).toMatch(/^---\ntype: project\n/)
    expect(content).toContain('tier: api')
    expect(content).toContain(AUTO_START)
    expect(content).toContain('NestJS')
    expect(content).toContain('[[api]]')
    expect(content).toContain('[[deployment]]')
    expect(content).toContain('## What this does')
  })

  it('preserves hand-authored prose on re-render', () => {
    const first = renderProjectPage(facts, null, '2026-07-02').content
    const edited = first.replace('_Describe what this project does._', 'It runs auctions.')
    const { content } = renderProjectPage(facts, edited, '2026-07-03')
    expect(content).toContain('It runs auctions.')
  })
})

describe('renderAdr', () => {
  it('numbers, slugs, and stamps source', () => {
    const adr = renderAdr({ id: '234567', title: 'ADR-6 Merge commits', markdown: '# ADR-6\nUse BAS standard.', sourceUrl: 'https://x/wiki/y' }, '2026-07-02')
    expect(adr.number).toBe(6)
    expect(adr.slug).toBe('ADR-0006-adr-6-merge-commits')
    expect(adr.markdown).toContain('source-url: https://x/wiki/y')
    expect(adr.markdown).toContain('Use BAS standard.')
  })
})

describe('renderStandardStub', () => {
  it('pre-fills deployment with real facts', () => {
    const md = renderStandardStub('deployment')
    expect(md).toContain('deploy:staging')
    expect(md).toContain('App Runner')
    expect(md).toContain('dev / stg / prod')
  })
  it('stubs other standards', () => {
    expect(renderStandardStub('api')).toContain('type: standard')
  })
})

describe('renderIndex + slugify', () => {
  it('renders a link list', () => {
    expect(renderIndex('Projects', [{ label: 'API', href: 'auction/api' }])).toContain('- [[auction/api|API]]')
  })
  it('slugifies', () => expect(slugify('ADR-6 Merge commits')).toBe('adr-6-merge-commits'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/brain/render.test.ts`
Expected: FAIL — cannot find module `./render`.

- [ ] **Step 3: Write the implementation**

`lib/brain/render.ts`:
```ts
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
    .map((s) => `[[${s}]]`)
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

  const existingBody = existing === null ? null : stripFrontmatter(existing)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/brain/render.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/brain/render.ts lib/brain/render.test.ts
git commit -m "feat(brain): page renderers (project, ADR, standards, index)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Vault orchestration (idempotent writes, seeding, summary)

**Files:**
- Create: `lib/brain/vault.ts`
- Test: `lib/brain/vault.test.ts`

**Interfaces:**
- Consumes: `extractProject` (Task 2, as `typeof`); `renderAdr`/`renderIndex`/`renderProjectPage`/`renderStandardStub`/`StandardKind` (Task 7); `VaultSummary` (Task 1); `Result` (`@/lib/result`).
- Produces:
  - `interface BuildDeps { extract: typeof extractProject; fetchAdr: (idOrUrl: string) => Promise<Result<{ id: string; title: string; html: string; sourceUrl: string }>>; htmlToMd: (html: string) => string; syncedDate: string }`
  - `interface BuildOptions { brainDir: string; reposDir: string; adrPages: string[]; check: boolean; scope: 'all' | 'projects' | 'adrs' }`
  - `async function discoverRepos(reposDir: string): Promise<Array<{ group: string; app: string; repoPath: string }>>` — `<reposDir>/<owner>/<group>/<app>` flattened to `{group, app, repoPath}` (matches `repos/basworld/auction/api`).
  - `async function buildVault(opts: BuildOptions, deps: BuildDeps): Promise<VaultSummary>`

- [ ] **Step 1: Write the failing test**

`lib/brain/vault.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVault, discoverRepos } from './vault'
import { extractProject } from './extract-project'
import { ok } from '@/lib/result'

async function makeRepos(root: string) {
  const api = join(root, 'basworld', 'auction', 'api')
  await mkdir(api, { recursive: true })
  await writeFile(join(api, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '1' }, scripts: { build: 'x' } }))
}

const deps = {
  extract: extractProject,
  fetchAdr: async () => ok({ id: '1', title: 'ADR-6 X', html: '<p>Body</p>', sourceUrl: 'https://x/wiki/1' }),
  htmlToMd: (h: string) => h.replace(/<[^>]+>/g, ''),
  syncedDate: '2026-07-02',
}

describe('discoverRepos', () => {
  it('flattens owner/group/app into group/app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repos-'))
    await makeRepos(root)
    const repos = await discoverRepos(root)
    expect(repos).toEqual([{ group: 'auction', app: 'api', repoPath: join(root, 'basworld', 'auction', 'api') }])
    await rm(root, { recursive: true, force: true })
  })
})

describe('buildVault', () => {
  let brainDir: string
  let reposDir: string
  beforeEach(async () => {
    reposDir = await mkdtemp(join(tmpdir(), 'repos-'))
    brainDir = await mkdtemp(join(tmpdir(), 'brain-'))
    await makeRepos(reposDir)
  })

  it('creates standards, project pages, ADRs, and indexes', async () => {
    const summary = await buildVault({ brainDir, reposDir, adrPages: ['1'], check: false, scope: 'all' }, deps)
    expect(summary.added.some((p) => p.includes('standards/deployment.md'))).toBe(true)
    const project = await readFile(join(brainDir, 'projects', 'auction', 'api.md'), 'utf8')
    expect(project).toContain('NestJS')
    const adr = await readFile(join(brainDir, 'adrs', 'ADR-0006-adr-6-x.md'), 'utf8')
    expect(adr).toContain('Body')
  })

  it('preserves hand-authored prose and does not overwrite existing standards', async () => {
    await buildVault({ brainDir, reposDir, adrPages: [], check: false, scope: 'all' }, deps)
    const p = join(brainDir, 'projects', 'auction', 'api.md')
    const edited = (await readFile(p, 'utf8')).replace('_Describe what this project does._', 'Runs auctions.')
    await writeFile(p, edited)
    await writeFile(join(brainDir, 'standards', 'api.md'), '---\ntype: standard\n---\nMY API RULES\n')

    const summary = await buildVault({ brainDir, reposDir, adrPages: [], check: false, scope: 'all' }, deps)
    expect(await readFile(p, 'utf8')).toContain('Runs auctions.')
    expect(await readFile(join(brainDir, 'standards', 'api.md'), 'utf8')).toContain('MY API RULES')
    expect(summary.skipped.some((s) => s.includes('standards/api.md'))).toBe(true)
  })

  it('writes a placeholder and warns when an ADR fetch fails', async () => {
    const failing = { ...deps, fetchAdr: async () => ({ ok: false as const, reason: 'error' as const, message: 'boom' }) }
    const summary = await buildVault({ brainDir, reposDir, adrPages: ['999'], check: false, scope: 'all' }, failing)
    expect(summary.warned.length).toBeGreaterThan(0)
  })

  it('check mode reports counts but writes nothing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'brain-'))
    const summary = await buildVault({ brainDir: empty, reposDir, adrPages: [], check: true, scope: 'all' }, deps)
    expect(summary.added.length).toBeGreaterThan(0)
    await expect(readFile(join(empty, 'index.md'), 'utf8')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/brain/vault.test.ts`
Expected: FAIL — cannot find module `./vault`.

- [ ] **Step 3: Write the implementation**

`lib/brain/vault.ts`:
```ts
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { type Result } from '@/lib/result'
import type { extractProject } from './extract-project'
import { renderAdr, renderIndex, renderProjectPage, renderStandardStub, type StandardKind } from './render'
import type { VaultSummary } from './types'

export interface BuildDeps {
  extract: typeof extractProject
  fetchAdr: (idOrUrl: string) => Promise<Result<{ id: string; title: string; html: string; sourceUrl: string }>>
  htmlToMd: (html: string) => string
  syncedDate: string
}

export interface BuildOptions {
  brainDir: string
  reposDir: string
  adrPages: string[]
  check: boolean
  scope: 'all' | 'projects' | 'adrs'
}

const STANDARDS: StandardKind[] = ['coding-standards', 'api', 'frontend', 'bff', 'deployment', 'testing']

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** <reposDir>/<owner>/<group>/<app> → { group, app, repoPath }. */
export async function discoverRepos(
  reposDir: string,
): Promise<Array<{ group: string; app: string; repoPath: string }>> {
  const out: Array<{ group: string; app: string; repoPath: string }> = []
  for (const owner of await listDirs(reposDir)) {
    for (const group of await listDirs(join(reposDir, owner))) {
      for (const app of await listDirs(join(reposDir, owner, group))) {
        out.push({ group, app, repoPath: join(reposDir, owner, group, app) })
      }
    }
  }
  return out
}

export async function buildVault(opts: BuildOptions, deps: BuildDeps): Promise<VaultSummary> {
  const summary: VaultSummary = { added: [], updated: [], skipped: [], warned: [] }

  const write = async (rel: string, content: string, mode: 'refresh' | 'seed') => {
    const abs = join(opts.brainDir, rel)
    const had = await exists(abs)
    if (mode === 'seed' && had) {
      summary.skipped.push(rel)
      return
    }
    ;(had ? summary.updated : summary.added).push(rel)
    if (opts.check) return
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }

  const readExisting = async (rel: string): Promise<string | null> => {
    try {
      return await readFile(join(opts.brainDir, rel), 'utf8')
    } catch {
      return null
    }
  }

  // Standards (seed once).
  if (opts.scope !== 'adrs') {
    for (const kind of STANDARDS) {
      await write(`standards/${kind}.md`, renderStandardStub(kind), 'seed')
    }
    await write(
      'standards/index.md',
      renderIndex('Standards', STANDARDS.map((k) => ({ label: k, href: `standards/${k}` }))),
      'refresh',
    )
  }

  // Projects.
  if (opts.scope !== 'adrs') {
    const groups = new Map<string, string[]>()
    for (const { group, app, repoPath } of await discoverRepos(opts.reposDir)) {
      const facts = await deps.extract(group, app, repoPath)
      const rel = `projects/${group}/${app}.md`
      const { content, warned } = renderProjectPage(facts, await readExisting(rel), deps.syncedDate)
      await write(rel, content, 'refresh')
      if (warned) summary.warned.push(rel)
      groups.set(group, [...(groups.get(group) ?? []), app])
    }
    for (const [group, apps] of groups) {
      await write(
        `projects/${group}/index.md`,
        renderIndex(group, apps.map((a) => ({ label: a, href: `projects/${group}/${a}` }))),
        'refresh',
      )
    }
    await write(
      'projects/index.md',
      renderIndex('Projects', [...groups.keys()].map((g) => ({ label: g, href: `projects/${g}/index` }))),
      'refresh',
    )
  }

  // ADRs (full regenerate; placeholder + warn on failure).
  if (opts.scope !== 'projects') {
    const adrLinks: Array<{ label: string; href: string }> = []
    for (const idOrUrl of opts.adrPages) {
      const res = await deps.fetchAdr(idOrUrl)
      if (!res.ok) {
        const rel = `adrs/UNRESOLVED-${idOrUrl.replace(/[^\w]+/g, '-')}.md`
        await write(rel, `# Unresolved ADR\n\nCould not fetch \`${idOrUrl}\`: ${res.message}\n`, 'refresh')
        summary.warned.push(rel)
        continue
      }
      const adr = renderAdr({ ...res.data, markdown: deps.htmlToMd(res.data.html) }, deps.syncedDate)
      const rel = `adrs/${adr.slug}.md`
      await write(rel, adr.markdown, 'refresh')
      adrLinks.push({ label: adr.title, href: `adrs/${adr.slug}` })
    }
    await write('adrs/index.md', renderIndex('ADRs', adrLinks), 'refresh')
  }

  // Root MOC.
  await write(
    'index.md',
    renderIndex('Knowledge Brain', [
      { label: 'Standards', href: 'standards/index' },
      { label: 'Projects', href: 'projects/index' },
      { label: 'ADRs', href: 'adrs/index' },
    ]),
    'refresh',
  )

  return summary
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/brain/vault.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Run the full suite (regression gate)**

Run: `npm test`
Expected: all existing + new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/brain/vault.ts lib/brain/vault.test.ts
git commit -m "feat(brain): vault orchestration (discover, seed, render, summary)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: CLI wiring, config, gitignore, docs

**Files:**
- Create: `scripts/build-brain.ts`
- Modify: `package.json` (add `"brain"` script)
- Modify: `.gitignore` (add `/brain`)
- Modify: `.env.local.example` (document `BRAIN_DIR`, `ADR_PAGES`, `CONFLUENCE_HOST`)
- Modify: `README.md` (add a "Knowledge Brain" run note)

**Interfaces:**
- Consumes: `buildVault`, `BuildOptions`, `BuildDeps` (Task 8); `extractProject` (Task 2); `confluenceCreds`, `fetchConfluencePage` (Task 6); `htmlToMarkdown` (Task 5).
- Produces: `npm run brain` CLI. No exported API.

- [ ] **Step 1: Write the CLI**

`scripts/build-brain.ts`:
```ts
/**
 * Build/refresh the Knowledge Brain Obsidian vault from ./repos + Confluence ADRs.
 * Mirrors scripts/setup-repos.ts: load env via @next/env, then dynamic-import lib.
 *
 *   npm run brain                # build/refresh
 *   npm run brain -- --check     # report, write nothing
 *   npm run brain -- --projects-only | --adrs-only
 */
import _nextEnv from '@next/env'
const { loadEnvConfig } = _nextEnv as typeof import('@next/env')
loadEnvConfig(process.cwd())

const { buildVault } = await import('@/lib/brain/vault')
const { extractProject } = await import('@/lib/brain/extract-project')
const { confluenceCreds, fetchConfluencePage } = await import('@/lib/brain/confluence')
const { htmlToMarkdown } = await import('@/lib/brain/html-to-md')

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const scope: 'all' | 'projects' | 'adrs' = argv.includes('--projects-only')
  ? 'projects'
  : argv.includes('--adrs-only')
    ? 'adrs'
    : 'all'

const brainDir = process.env.BRAIN_DIR || 'brain'
const reposDir = process.env.WORKSPACE_DIR || 'repos'
const adrPages = (process.env.ADR_PAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const creds = confluenceCreds()
if (adrPages.length && !creds) {
  console.warn('⚠ ADR_PAGES set but no Confluence/Jira creds — ADRs will be written as placeholders.')
}

const fetchAdr = async (idOrUrl: string) =>
  creds
    ? fetchConfluencePage(creds, idOrUrl)
    : ({ ok: false as const, reason: 'unconfigured' as const, message: 'No Confluence credentials configured.' })

const summary = await buildVault(
  { brainDir, reposDir, adrPages, check, scope },
  { extract: extractProject, fetchAdr, htmlToMd: htmlToMarkdown, syncedDate: new Date().toISOString().slice(0, 10) },
)

const line = (label: string, items: string[]) =>
  console.log(`  ${label.padEnd(9)} ${items.length}${items.length ? ` — ${items.join(', ')}` : ''}`)

console.log(`\nKnowledge Brain (${check ? 'check' : 'build'}) → ${brainDir}`)
line('added', summary.added)
line('updated', summary.updated)
line('preserved', summary.skipped)
if (summary.warned.length) {
  console.warn('\n⚠ warnings:')
  line('warned', summary.warned)
}
console.log('')
```

- [ ] **Step 2: Add the npm script**

Edit `package.json` scripts, add after the `"setup"` line:
```json
"brain": "tsx scripts/build-brain.ts",
```

- [ ] **Step 3: Ignore the vault**

Append to `.gitignore`:
```
/brain
```

- [ ] **Step 4: Document config in `.env.local.example`**

Append:
```bash
# --- Knowledge Brain (npm run brain) ---
# Output vault dir (default: brain). Open this folder as an Obsidian vault.
# BRAIN_DIR=brain
# Confluence ADR pages to import — comma-separated page IDs or full page URLs.
# ADR_PAGES=123456,https://<site>.atlassian.net/wiki/spaces/ENG/pages/234567/ADR-6
# Confluence host (defaults to JIRA_HOST if the same Atlassian site).
# CONFLUENCE_HOST=https://<site>.atlassian.net
```

- [ ] **Step 5: Add a README run note**

Under the "Run" section of `README.md`, add:
```markdown
- `npm run brain` → build/refresh the Knowledge Brain vault in `./brain` (open in Obsidian).
  `--check` reports without writing; `--projects-only` / `--adrs-only` scope the run.
```

- [ ] **Step 6: Verify the CLI end-to-end**

Run: `npm run brain -- --check`
Expected: prints `Knowledge Brain (check) → brain` with non-zero `added` counts for `standards/*` (and `projects/*` if repos are present under `./repos`); exits 0; **no `brain/` dir created** (check mode).

Run: `npm run brain`
Expected: creates `./brain` with `index.md`, `standards/`, `projects/`, `adrs/`. Open the folder in Obsidian and confirm wiki-links resolve.

- [ ] **Step 7: Final regression gate**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/build-brain.ts package.json .gitignore .env.local.example README.md
git commit -m "feat(brain): CLI (npm run brain), config, gitignore, docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Vault structure (standards/adrs/projects/index) → Tasks 7–9.
- Standards split API/FE/BFF + deployment (pre-seeded) + coding + testing → Task 7 `renderStandardStub` + Task 8 seeding.
- Project pages auto-extract + tier auto-link + preserved prose → Tasks 2, 4, 7, 8.
- ADRs from Confluence via Atlassian token, HTML→md, source-url/last-synced, placeholder on failure → Tasks 5, 6, 7, 8.
- Frontmatter for LLM/Obsidian → Task 3, applied in Task 7.
- Idempotent, gitignored, `--check`, summary → Tasks 8, 9.
- Config `BRAIN_DIR`/`ADR_PAGES`/`CONFLUENCE_HOST`, no `server-only` → Task 9 + Global Constraints.
- Vitest fixtures for extract/render/auto-merge/html-to-md/confluence/vault → each task's test.

**Deviation from spec:** the `_templates/` folder is omitted for v1 (YAGNI — no generator logic needs it; Obsidian users can add templates later). Everything else in the spec is covered.

**Placeholder scan:** No plan-level placeholders. The `_TBD._` strings inside standard *stub content* are intentional deliverables — they are the seeded human-fill prompts, not gaps in the plan.

**Type consistency:** `ProjectFacts`, `AdrPage`, `VaultSummary`, `Tier` defined in Task 1, used unchanged in Tasks 2/7/8. `renderProjectPage(facts, existing, syncedDate)`, `fetchConfluencePage(creds, idOrUrl, fetchImpl?)`, `buildVault(opts, deps)` signatures match across definition and call sites. `BuildDeps.fetchAdr` returns the same `Result<{id,title,html,sourceUrl}>` that `fetchConfluencePage` produces. `renderAdr` slug (`ADR-0006-adr-6-merge-commits`) matches the `vault.test.ts` ADR filename assertion (`ADR-0006-adr-6-x.md` for title `ADR-6 X`).
