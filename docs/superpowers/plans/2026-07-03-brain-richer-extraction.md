# Richer Brain Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the Knowledge Brain extraction so PHP/Laravel repos and every project page carry real data, fill the standards with detected tooling + authored multi-level architecture notes, and ship git-activity awareness as a committed Claude skill.

**Architecture:** Extend the existing pure pipeline `extract-project.ts` (facts) → `render.ts` (markdown) → `vault.ts` (orchestration). New facts are added to `ProjectFacts` and rendered into the AUTO block, preserving `mergeAutoBlock` human-prose merging. Architecture notes are seeded-once static templates. Git activity is a Claude skill, not extracted data.

**Tech Stack:** TypeScript, Node fs/promises, Vitest.

## Global Constraints

- **Vitest is the only real gate.** Bare `tsc`/`lint`/`build` are pre-broken in this repo — run `npx vitest run <file>` to verify, never trust `tsc`/`build` output.
- **Secrets never emitted.** `.env.example` parsing reads variable NAMES only (text left of the first `=`); values are never read into memory or written to any note.
- **Do not edit `eslint.config.mjs`** — a hook blocks it. Fix source to satisfy the linter (e.g. destructure only used props, no unused vars).
- **Preserve human prose.** Project pages and seeded notes must round-trip hand edits (`mergeAutoBlock` / seed-once). Re-runs must not clobber edits.
- **Best-effort extraction.** Every new file read is wrapped so a missing/malformed file yields an empty array/undefined — never throws. The build never fails because a repo lacks a file.
- **Match existing style.** Follow the patterns already in `lib/brain/` (small pure functions, `readJson` try/catch, `satisfies` typing).

---

### Task 1: Composer / PHP stack + scripts + versioned labels

**Files:**
- Modify: `lib/brain/types.ts` (extend `ProjectFacts`)
- Modify: `lib/brain/extract-project.ts`
- Create: `lib/brain/__fixtures__/laravel-api/composer.json`
- Create: `lib/brain/__fixtures__/laravel-api/README.md`
- Test: `lib/brain/extract-project.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `extractProject(group, app, repoPath)` and `ProjectFacts`.
- Produces: `ProjectFacts.stack` entries may now carry a version suffix (e.g. `"Laravel ^13.0"`, `"PHP ^8.2"`); `scripts` includes composer script names when a `composer.json` exists. `extractProject` signature is unchanged.

**Detection rules:**
- If `composer.json` exists, merge its `require` + `require-dev` into a deps map and its `scripts` keys into the scripts list, in addition to any `package.json`.
- Composer stack labels (first match per dep wins, same as npm `STACK_LABELS`):
  - `php` → `PHP`
  - `laravel/framework` → `Laravel`
  - `pestphp/pest` → `Pest`
  - `larastan/larastan` → `Larastan`
  - `laravel/pint` → `Pint`
  - `symfony/` (prefix) → `Symfony`
- **Versioned labels:** when a label was matched from a single dep key, append that dep's version string: `Laravel ${deps['laravel/framework']}` → `"Laravel ^13.0"`. For prefix matches (`symfony/`), emit the bare label (`"Symfony"`, no version). Apply the same versioning to existing npm labels (`Next.js ${deps['next']}`, etc.).

- [ ] **Step 1: Write the fixture composer.json**

Create `lib/brain/__fixtures__/laravel-api/composer.json`:

```json
{
  "name": "laravel/laravel",
  "description": "Fixture Laravel API",
  "require": {
    "php": "^8.2",
    "laravel/framework": "^13.0",
    "symfony/intl": "^8.0"
  },
  "require-dev": {
    "pestphp/pest": "^4.1",
    "larastan/larastan": "^3.7",
    "laravel/pint": "^1.29"
  },
  "scripts": {
    "code-style": "pint --test",
    "unit-test": "pest --testsuite Unit"
  }
}
```

Create `lib/brain/__fixtures__/laravel-api/README.md`:

```markdown
# Fixture API

## Overview

A Laravel fixture used to test composer extraction.
```

- [ ] **Step 2: Write failing tests**

Add to `lib/brain/extract-project.test.ts`:

```typescript
  it('extracts composer stack with versions and composer scripts', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.tier).toBe('api')
    expect(f.stack).toEqual(
      expect.arrayContaining(['PHP ^8.2', 'Laravel ^13.0', 'Pest', 'Larastan', 'Pint', 'Symfony']),
    )
    expect(f.scripts).toEqual(expect.arrayContaining(['code-style', 'unit-test']))
  })

  it('versions npm stack labels from package.json', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    // next-fe fixture pins next + react; labels should carry their versions
    expect(f.stack.some((s) => s.startsWith('Next.js '))).toBe(true)
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/brain/extract-project.test.ts`
Expected: FAIL — composer not read, stack labels have no version.

- [ ] **Step 4: Implement**

In `lib/brain/extract-project.ts`, change stack detection to carry versions and add composer labels. Replace `STACK_LABELS` + `detectStack` with:

```typescript
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
  [/^php$/, 'PHP'],
  [/^laravel\/framework$/, 'Laravel'],
  [/^pestphp\/pest$/, 'Pest'],
  [/^larastan\/larastan$/, 'Larastan'],
  [/^laravel\/pint$/, 'Pint'],
  [/^symfony\//, 'Symfony'],
]

/** Labels whose regex matches a family (not one exact package) — no version suffix. */
const UNVERSIONED = new Set(['Symfony'])

function detectStack(deps: Record<string, unknown>): string[] {
  const labels = new Map<string, string>() // label -> version ('' if none)
  for (const [dep, version] of Object.entries(deps)) {
    for (const [re, label] of STACK_LABELS) {
      if (re.test(dep)) {
        if (!labels.has(label)) {
          const v = !UNVERSIONED.has(label) && typeof version === 'string' ? version : ''
          labels.set(label, v)
        }
        break
      }
    }
  }
  return [...labels].map(([label, v]) => (v ? `${label} ${v}` : label))
}
```

In `extractProject`, read composer.json alongside package.json and merge:

```typescript
  const pkg = await readJson(`${repoPath}/package.json`)
  const composer = await readJson(`${repoPath}/composer.json`)
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
    ...((composer?.require as Record<string, unknown>) ?? {}),
    ...((composer?.['require-dev'] as Record<string, unknown>) ?? {}),
  }
  const scripts = [
    ...Object.keys((pkg?.scripts as Record<string, unknown>) ?? {}),
    ...Object.keys((composer?.scripts as Record<string, unknown>) ?? {}),
  ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/brain/extract-project.test.ts`
Expected: PASS (all cases). The pre-existing nest-api case asserts `f.stack` contains `'NestJS'` and `'Drizzle'` exactly — versioning changes these to `'NestJS ^...'`. Update those pre-existing assertions in the same file to the versioned form (e.g. `expect(f.stack.some((s) => s.startsWith('NestJS'))).toBe(true)`), keeping them meaningful. Do NOT weaken with a substring hack.

- [ ] **Step 6: Commit**

```bash
git add lib/brain/types.ts lib/brain/extract-project.ts lib/brain/extract-project.test.ts lib/brain/__fixtures__/laravel-api
git commit -m "feat(brain): composer/PHP stack + scripts + versioned stack labels"
```

---

### Task 2: Env keys + layout + bounded contexts + fuller README

**Files:**
- Modify: `lib/brain/types.ts` (add `envKeys`, `layout`, `boundedContexts`)
- Modify: `lib/brain/extract-project.ts`
- Create: `lib/brain/__fixtures__/laravel-api/.env.example`
- Create fixture dirs (via `.gitkeep`): `lib/brain/__fixtures__/laravel-api/app/Auction/Domain/.gitkeep`, `.../app/Shared/Domain/.gitkeep`, `.../app/Http/.gitkeep` (Http has no Domain child → not a bounded context)
- Test: `lib/brain/extract-project.test.ts`

**Interfaces:**
- Consumes: `extractProject`, `ProjectFacts` (post-Task-1).
- Produces: `ProjectFacts` gains `envKeys: string[]`, `layout: string[]`, `boundedContexts: string[]`. README capture returns a fuller `readmeIntro`.

**Rules:**
- **envKeys:** read `.env.example`; for each line, trim; skip blank lines and lines starting with `#`; take text before the first `=`; keep names matching `/^[A-Za-z_][A-Za-z0-9_]*$/`. Never read the value side.
- **layout:** top-level directory names of the repo, excluding `node_modules`, `vendor`, `.git`, `.next`, `dist`, `build`, `coverage`, `storage`, `bootstrap`, `.idea`. Sorted.
- **boundedContexts:** only for `tier === 'api'`; names of directories directly under `app/` that themselves contain a `Domain/` subdirectory. Sorted. Empty for non-API or when `app/` absent.
- **readmeIntro (fuller):** all lines after the first `# Title` up to the second heading; strip heading lines; join non-empty lines with a space; collapse whitespace; cap at 600 chars, truncating on a word boundary and appending `…`. If no `##` heading exists, fall back to the old first-non-empty-paragraph behavior.

- [ ] **Step 1: Write fixtures**

`lib/brain/__fixtures__/laravel-api/.env.example`:

```
# App
APP_NAME=Fixture
APP_KEY=

AUCTION_API_URL=http://localhost:8000
DB_PASSWORD=secret-should-never-be-emitted
```

Create empty dirs via `.gitkeep` files:
- `lib/brain/__fixtures__/laravel-api/app/Auction/Domain/.gitkeep`
- `lib/brain/__fixtures__/laravel-api/app/Shared/Domain/.gitkeep`
- `lib/brain/__fixtures__/laravel-api/app/Http/.gitkeep`

Update the existing `laravel-api/README.md` to two sections so the section/cap logic is exercised:

```markdown
# Fixture API

## Overview

A Laravel fixture used to test composer extraction. It documents nothing real.

## Features

- Should not appear in the intro
```

- [ ] **Step 2: Write failing tests**

Add to `lib/brain/extract-project.test.ts`:

```typescript
  it('parses env keys only (never values) from .env.example', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.envKeys).toEqual(
      expect.arrayContaining(['APP_NAME', 'APP_KEY', 'AUCTION_API_URL', 'DB_PASSWORD']),
    )
    expect(JSON.stringify(f)).not.toContain('secret-should-never-be-emitted')
    expect(JSON.stringify(f)).not.toContain('localhost:8000')
  })

  it('detects bounded contexts (app/*/Domain) for api tier', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.boundedContexts).toEqual(['Auction', 'Shared'])
  })

  it('does not detect bounded contexts for a frontend', async () => {
    const f = await extractProject('auction', 'fe', `${fixtures}/next-fe`)
    expect(f.boundedContexts).toEqual([])
  })

  it('lists top-level layout dirs, excluding noise', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.layout).toContain('app')
  })

  it('captures the first README section, not just one line', async () => {
    const f = await extractProject('auction', 'api', `${fixtures}/laravel-api`)
    expect(f.readmeIntro).toContain('documents nothing real')
    expect(f.readmeIntro).not.toContain('Should not appear')
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/brain/extract-project.test.ts`
Expected: FAIL — `envKeys`/`layout`/`boundedContexts` undefined.

- [ ] **Step 4: Implement**

Add to `lib/brain/types.ts` `ProjectFacts`:

```typescript
  envKeys: string[]
  layout: string[]
  boundedContexts: string[]
```

In `extract-project.ts` add `readdir` to the `node:fs/promises` import, add helpers, and wire them in:

```typescript
async function parseEnvKeys(path: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const keys: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const name = line.split('=', 1)[0].trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.push(name)
  }
  return keys
}

const LAYOUT_EXCLUDE = new Set([
  'node_modules', 'vendor', '.git', '.next', 'dist', 'build', 'coverage',
  'storage', 'bootstrap', '.idea',
])

async function listTopDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !LAYOUT_EXCLUDE.has(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function detectBoundedContexts(repoPath: string, tier: Tier): Promise<string[]> {
  if (tier !== 'api') return []
  const appDir = `${repoPath}/app`
  const out: string[] = []
  let entries
  try {
    entries = await readdir(appDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      const sub = await readdir(`${appDir}/${e.name}`, { withFileTypes: true })
      if (sub.some((s) => s.isDirectory() && s.name === 'Domain')) out.push(e.name)
    } catch {
      /* skip */
    }
  }
  return out.sort()
}
```

Import `Tier` in extract-project.ts if not already imported (it imports `ProjectFacts` from `./types`; add `Tier`).

Replace `parseReadme` with a section-aware version:

```typescript
/** First `# Heading` text, and the prose of the first section (up to the 2nd heading), capped. */
function parseReadme(md: string): { title?: string; intro?: string } {
  const lines = md.split('\n')
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l))
  const title = titleIdx >= 0 ? lines[titleIdx].replace(/^#\s+/, '').trim() : undefined
  const after = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines

  const collected: string[] = []
  let headingsSeen = 0
  for (const l of after) {
    if (/^#{1,6}\s+/.test(l)) {
      headingsSeen++
      if (headingsSeen >= 2) break
      continue // skip the section heading itself (e.g. "## Overview")
    }
    if (l.trim()) collected.push(l.trim())
  }

  let intro = collected.join(' ').replace(/\s+/g, ' ').trim() || undefined
  if (!intro) {
    intro = after.map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  }
  if (intro && intro.length > 600) {
    intro = intro.slice(0, 600).replace(/\s+\S*$/, '') + '…'
  }
  return { title, intro }
}
```

Wire into the return of `extractProject` (note `tier` computed once):

```typescript
  const tier = inferTier(app)
  // ... existing readme parse producing readmeTitle/readmeIntro ...
  return {
    group,
    app,
    tier,
    repoPath,
    stack: detectStack(deps),
    scripts,
    readmeTitle,
    readmeIntro,
    hasAgentsDoc,
    envKeys: await parseEnvKeys(`${repoPath}/.env.example`),
    layout: await listTopDirs(repoPath),
    boundedContexts: await detectBoundedContexts(repoPath, tier),
  }
```

Update the existing "no package.json" test to also assert `envKeys`, `layout`, `boundedContexts` are `[]`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/brain/extract-project.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/brain/types.ts lib/brain/extract-project.ts lib/brain/extract-project.test.ts lib/brain/__fixtures__/laravel-api
git commit -m "feat(brain): extract env keys, layout, bounded contexts, fuller README"
```

---

### Task 3: Render new project-page AUTO sections

**Files:**
- Modify: `lib/brain/render.ts` (`renderProjectPage` auto block)
- Test: `lib/brain/render.test.ts`

**Interfaces:**
- Consumes: `ProjectFacts` with `envKeys`, `layout`, `boundedContexts` (post-Task-2). The `facts` const in `render.test.ts` must be updated to include these three fields.
- Produces: project markdown now contains `## Configuration`, `## Layout`, and (api tier only) `## Bounded contexts`, inside the AUTO block.

- [ ] **Step 1: Update the shared test fixture + write failing tests**

In `lib/brain/render.test.ts`, extend the top-level `facts` const with:

```typescript
  envKeys: ['APP_NAME', 'AUCTION_API_URL'],
  layout: ['app', 'routes', 'tests'],
  boundedContexts: ['Auction', 'Shared'],
```

Add tests:

```typescript
  it('renders configuration, layout, and bounded-contexts sections', () => {
    const { content } = renderProjectPage(facts, null, '2026-07-02')
    expect(content).toContain('## Configuration')
    expect(content).toContain('`AUCTION_API_URL`')
    expect(content).toContain('## Layout')
    expect(content).toContain('## Bounded contexts')
    expect(content).toContain('Auction')
  })

  it('omits bounded contexts for a non-api page', () => {
    const feFacts = { ...facts, tier: 'frontend' as const, boundedContexts: [] }
    const { content } = renderProjectPage(feFacts, null, '2026-07-02')
    expect(content).not.toContain('## Bounded contexts')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/brain/render.test.ts`
Expected: FAIL — sections absent (and TypeScript will flag the `facts` const until the three fields are added).

- [ ] **Step 3: Implement**

In `renderProjectPage`, build `autoInner` from a sections array. After the `## Scripts` block, append the new sections (Bounded contexts only when non-empty):

```typescript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/brain/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/brain/render.ts lib/brain/render.test.ts
git commit -m "feat(brain): render configuration, layout, bounded-contexts sections"
```

---

### Task 4: Standards tooling detection (testing + coding-standards)

**Files:**
- Modify: `lib/brain/render.ts` (add `renderToolingBlock` + `renderStandardWithTooling`)
- Modify: `lib/brain/vault.ts` (aggregate facts, seed with AUTO block, refresh block on re-run)
- Test: `lib/brain/render.test.ts`, `lib/brain/vault.test.ts`

**Interfaces:**
- Consumes: the array of `ProjectFacts` produced during the projects pass in `vault.ts`.
- Produces: `testing.md` and `coding-standards.md` contain an AUTO block listing detected tooling; the human stub prose below the block is preserved across runs (via `mergeAutoBlock` + `readExisting`).

**Detection (pure, in render.ts):** facts carry `stack` + `scripts` (not raw deps), so match on those. testing: `Pest` (stack `pest`), `Vitest` (script `vitest`), `Jest` (script `jest`), `Playwright` (script `playwright`), else `test script` if a `test` script exists. linters/formatters: `Pint` (stack `pint`), `ESLint` (script `lint`), `Prettier` (script `format`), `Biome` (script `biome`). Group by tier.

- [ ] **Step 1: Write failing render test**

Add to `lib/brain/render.test.ts`:

```typescript
import { renderToolingBlock } from './render'

describe('renderToolingBlock', () => {
  const toolFacts = [
    { tier: 'api', stack: ['PHP ^8.2', 'Pest', 'Pint'], scripts: ['unit-test', 'code-style'] },
    { tier: 'frontend', stack: ['Next.js ^16'], scripts: ['test', 'lint', 'format'] },
  ] as unknown as import('./types').ProjectFacts[]

  it('summarizes test frameworks grouped by tier', () => {
    const md = renderToolingBlock('testing', toolFacts)
    expect(md).toContain('Pest')
    expect(md).toMatch(/api/)
  })

  it('summarizes linters and formatters', () => {
    const md = renderToolingBlock('coding-standards', toolFacts)
    expect(md).toContain('Pint')
    expect(md).toContain('ESLint')
    expect(md).toContain('Prettier')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/brain/render.test.ts`
Expected: FAIL — `renderToolingBlock` not exported.

- [ ] **Step 3: Implement in render.ts**

```typescript
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
  const seed = renderStandardStub(kind) // frontmatter + '# Title' + stub prose
  const fmEnd = seed.indexOf('\n', seed.indexOf('---', 3) + 3)
  // Reuse the seed's frontmatter+title; put the AUTO block above the stub prose.
  const headerEnd = seed.indexOf('\n', seed.indexOf('# ')) + 1
  const header = seed.slice(0, headerEnd) // '---\n...\n---\n# Title\n'
  const stubProse = seed.slice(headerEnd)
  const autoInner = renderToolingBlock(kind, facts)
  const existingBody =
    existing === null ? null : existing.slice(existing.indexOf('# ') >= 0 ? existing.indexOf('\n', existing.indexOf('# ')) + 1 : 0)
  const merged = mergeAutoBlock(existingBody, autoInner, stubProse.trimStart())
  void fmEnd
  return `${header}\n${merged.body}\n`
}
```

Note: keep this simple and robust — the goal is `header` (frontmatter + `# Title`) unchanged, then an AUTO block, then the human stub prose. If the reviewer finds the slicing fragile, prefer having `renderStandardStub` expose its parts; adjust as needed but keep frontmatter identical to the other standards.

- [ ] **Step 4: Run render test to verify pass**

Run: `npx vitest run lib/brain/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing vault test**

In `lib/brain/vault.test.ts`, extend the existing build test (which already stubs `extract`/`fetchAdr` and writes to a temp dir) to assert:

```typescript
    expect(read('standards/testing.md')).toContain('<!-- AUTO:start')
```

Add a second assertion that a hand edit below the AUTO block survives a rebuild: after the first build, append a marker line to `standards/testing.md`, rebuild, and assert the marker is still present. Reuse the test's existing temp-dir + fake-extract helpers; ensure the fake facts include the new `envKeys`/`layout`/`boundedContexts` fields so the stub compiles.

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run lib/brain/vault.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement in vault.ts**

Collect facts during the projects loop: `const allFacts: ProjectFacts[] = []` and push each `facts`. Move the `testing`/`coding-standards` writes to AFTER the projects loop (so facts exist), writing them with `renderStandardWithTooling(kind, allFacts, await readExisting(rel))` in mode `'refresh'`. The other four standards (`api`, `frontend`, `bff`, `deployment`) keep their current seed-once `renderStandardStub` write, and `standards/index.md` stays as-is. Import `renderStandardWithTooling` and the `ProjectFacts` type.

- [ ] **Step 8: Run both test files to verify pass**

Run: `npx vitest run lib/brain/render.test.ts lib/brain/vault.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/brain/render.ts lib/brain/vault.ts lib/brain/render.test.ts lib/brain/vault.test.ts
git commit -m "feat(brain): auto-fill testing + coding-standards from detected tooling"
```

---

### Task 5: Architecture multi-level notes

**Files:**
- Modify: `lib/brain/render.ts` (add `ARCHITECTURE_NOTES` map + `renderArchitectureNote`)
- Modify: `lib/brain/vault.ts` (seed the architecture notes + add to root MOC)
- Test: `lib/brain/vault.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (static templates).
- Produces: `architecture/{index,system-flow,domain-layer,application-layer,infrastructure-layer}.md`, seed-once. Root `index.md` MOC gains an `Architecture` link.

**Content — transcribe verbatim into `ARCHITECTURE_NOTES` values (keys are the slugs).** Frontmatter on each: `type: architecture`, `status: authored`.

`index`:

```markdown
---
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
```

`system-flow`:

```markdown
---
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
   an `*_API_URL` env var (e.g. `AUCTION_API_URL`).
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
```

`domain-layer`:

```markdown
---
type: architecture
status: authored
---
# Domain layer

The core of the API. Pure business model with no framework or I/O concerns.

## What lives here

- **Entities** — objects with identity and a lifecycle (e.g. an Auction, a Lot).
- **Value objects** — immutable values compared by content (e.g. Money, a bid
  amount).
- **Domain events** — facts that happened in the domain (e.g. `BidPlaced`).
- **Domain services** — business logic that doesn't belong to a single entity.

## Bounded contexts

Each context is a self-contained slice of the domain under `app/<Context>/`,
split into `Application` / `Domain` / `Infrastructure`. In `auction/api` these
include **Auction**, **Inventory**, **Notification**, **Publishing**, **Hexon**,
and a **Shared** kernel. A context owns its own models and never reaches into
another context's internals.

## Rules

- No Laravel, Eloquent, HTTP, or database code here. Those are
  [[architecture/infrastructure-layer|infrastructure]] details.
- The Domain does not depend on the Application or Infrastructure layers —
  dependencies point inward.
```

`application-layer`:

```markdown
---
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
```

`infrastructure-layer`:

```markdown
---
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
  messaging), HTTP entry points (`Http/` controllers, requests, resources),
  and framework wiring (Laravel providers).
- **Persistence mapping** — turning domain objects into rows and back.

## Rules

- Depends inward on the Application and Domain layers; they never depend on it
  (ports & adapters / hexagonal).
- Laravel and Eloquent are infrastructure details — swapping the framework
  should not touch the [[architecture/domain-layer|domain]].
- HTTP controllers are thin: validate input, call an application use case,
  return a resource. No business logic.
```

- [ ] **Step 1: Write failing vault test**

Add to the existing build test in `lib/brain/vault.test.ts`:

```typescript
    expect(read('architecture/index.md')).toContain('# Architecture')
    expect(read('architecture/domain-layer.md')).toContain('Bounded contexts')
    expect(read('architecture/system-flow.md')).toContain('FE → BFF → API')
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/brain/vault.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `render.ts`, add `const ARCHITECTURE_NOTES: Record<string, string> = { … }` with the five contents above and export `renderArchitectureNote(slug: string): string { return ARCHITECTURE_NOTES[slug] }`.

In `vault.ts`, inside the `scope !== 'adrs'` block, seed each note (mode `'seed'`):

```typescript
    for (const slug of ['index', 'system-flow', 'domain-layer', 'application-layer', 'infrastructure-layer']) {
      await write(`architecture/${slug}.md`, renderArchitectureNote(slug), 'seed')
    }
```

Add an `Architecture` link to the root `index.md` MOC (href `architecture/index`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/brain/vault.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/brain/render.ts lib/brain/vault.ts lib/brain/vault.test.ts
git commit -m "feat(brain): seed multi-level architecture notes (system-flow + DDD layers)"
```

---

### Task 6: Git-activity Claude skill + onboarding

**Files:**
- Create: `.claude/skills/brain-git-activity/SKILL.md`
- Modify: `ONBOARDING.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write the skill**

Create `.claude/skills/brain-git-activity/SKILL.md`:

```markdown
---
name: brain-git-activity
description: Use when the user asks about recent git activity, active branches, who last changed an app, or "what's been happening" in the BAS repos or the Knowledge Brain vault. Surface it live from git — never from a note.
---

# Brain git activity

The Knowledge Brain notes under `brain/` describe each app's **stable** facts
(stack, scripts, config, architecture). They deliberately do NOT record git
activity, which goes stale the moment it is written. Pull activity **live**
from the cloned repos instead.

## Where the repos are

`repos/<owner>/<group>/<app>` (e.g. `repos/basworld/auction/api`). A brain note
at `brain/projects/<group>/<app>.md` carries the repo path in its `repo:`
frontmatter.

## How to answer common questions

- **Recent commits for an app:**
  `git -C repos/basworld/<group>/<app> log --oneline -20`
- **Who last touched it / when:**
  `git -C repos/basworld/<group>/<app> log -1 --format='%an, %ar — %s'`
- **Active branches:**
  `git -C repos/basworld/<group>/<app> branch -a --sort=-committerdate`
- **What changed across all apps this week:** loop over the app dirs and run
  `git -C <dir> log --since='1 week ago' --oneline`.
- **Uncommitted work:** `git -C <dir> status --short`.

## Rules

- Always run against the actual repo path; never quote activity from a note.
- Read-only: never commit, push, or mutate a repo when answering an activity
  question unless the user explicitly asks.
- If a repo dir is missing, tell the user to run `npm run setup` to clone it.
```

- [ ] **Step 2: Reference it in ONBOARDING.md**

Under the "Notes" section of `ONBOARDING.md`, add:

```markdown
- **Git activity is live, not stored.** The `brain-git-activity` Claude skill
  (in `.claude/skills/`, travels with the repo) teaches Claude to pull recent
  commits, branches, and authorship straight from `repos/` on demand — the
  notes only hold stable facts.
```

- [ ] **Step 3: Verify the skill file is well-formed**

Run: `head -5 .claude/skills/brain-git-activity/SKILL.md`
Expected: shows YAML frontmatter with `name:` and `description:`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/brain-git-activity/SKILL.md ONBOARDING.md
git commit -m "feat(brain): ship git-activity Claude skill + onboarding note"
```

---

## Post-implementation

- [ ] Run the full suite: `npx vitest run`
- [ ] Rebuild the vault to see real output: `npm run brain`, then spot-check `brain/projects/auction/api.md` (PHP/Laravel stack + versions, composer scripts, Configuration, Layout, Bounded contexts) and `brain/architecture/`.
- [ ] Final whole-branch review (subagent-driven-development final step), then finish the branch.
