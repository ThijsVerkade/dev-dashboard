# Self-Service Repo Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard clone its configured `AGENT_REPOS` into `<dashboard>/repos` itself — via a `npm run setup` CLI and an in-app Setup panel — so anyone can go from a fresh checkout to an agent-ready dashboard without manual `git clone`.

**Architecture:** One shared, server-safe core module (`lib/setup/repos.ts`) owns all logic — listing configured repos, classifying present/missing, and cloning missing ones over HTTPS with token safety. Three thin surfaces consume it: a `tsx` CLI script, two API routes, and a React panel + banner. The existing agent runner is refactored to resolve its workspace through the same `installRoot()` so clones land exactly where it later looks.

**Tech Stack:** Next.js (App Router, this repo's fork), TypeScript, React client components, `vitest`, `tsx` (new devDependency) for the CLI, `@next/env` (already present) to load `.env.local` in the CLI, `git` on PATH.

## Global Constraints

- This is a **modified Next.js** — before writing any code that touches a Next API, read the relevant guide under `node_modules/next/dist/docs/` (per `AGENTS.md`).
- Import Node builtins with the `node:` prefix (repo convention, e.g. `node:child_process`).
- **Server-only boundary:** `lib/setup/repos.ts` MUST NOT import any `'server-only'` module (`lib/env.ts`, `lib/agent/runner.ts`) — the `tsx` CLI imports it in plain Node, where `'server-only'` throws. It reads GitLab creds from `process.env` directly. Client components import **only types** from it (`import type { … }`).
- Use the `Result<T>` pattern from `@/lib/result` (`ok` / `unconfigured` / `failure`) for anything fallible surfaced to a caller.
- **The `GITLAB_TOKEN` must never be persisted to disk or logged.** Embed it only in the transient clone URL, reset `origin` to a token-less URL immediately after, and `redactToken(...)` every message returned to CLI/API/UI.
- Default install root is `<cwd>/repos`; `WORKSPACE_DIR` env still overrides it.
- TDD, DRY, YAGNI, frequent commits.

---

### Task 1: Shared core — types + pure helpers

**Files:**
- Create: `lib/setup/repos.ts`
- Test: `lib/setup/repos.test.ts`

**Interfaces:**
- Consumes: `parseRepoSpec` from `@/lib/agent/prompt` (`(value: string) => { repo: string; baseBranch: string }`); `dashboardConfig.agentRepos: Record<string,string>` from `@/dashboard.config`.
- Produces (relied on by every later task):
  - types `RepoState = 'present' | 'present-not-git' | 'missing'`, `RepoEntry`, `RepoStatus`, `SetupStatus`
  - `bareHost(host: string): string`
  - `buildCloneUrl(host: string, token: string, repoName: string): string`
  - `cleanRemoteUrl(host: string, repoName: string): string`
  - `redactToken(text: string, token: string): string`
  - `classifyState(dirExists: boolean, gitExists: boolean): RepoState`
  - `parseAgentRepos(map?: Record<string,string>): RepoEntry[]`

- [ ] **Step 1: Write the failing test**

`lib/setup/repos.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  bareHost, buildCloneUrl, cleanRemoteUrl, redactToken, classifyState, parseAgentRepos,
} from '@/lib/setup/repos'

describe('bareHost', () => {
  it('strips scheme and trailing slash', () => {
    expect(bareHost('https://gitlab.example.com/')).toBe('gitlab.example.com')
    expect(bareHost('http://gl.local')).toBe('gl.local')
  })
})

describe('buildCloneUrl / cleanRemoteUrl', () => {
  it('embeds the token, then produces a clean url', () => {
    expect(buildCloneUrl('https://gitlab.example.com', 'glpat-x', 'auction/api'))
      .toBe('https://oauth2:glpat-x@gitlab.example.com/auction/api.git')
    expect(cleanRemoteUrl('https://gitlab.example.com', 'auction/api'))
      .toBe('https://gitlab.example.com/auction/api.git')
  })
})

describe('redactToken', () => {
  it('replaces every occurrence of the token', () => {
    expect(redactToken('clone https://oauth2:glpat-x@h/r.git glpat-x', 'glpat-x'))
      .toBe('clone https://oauth2:***@h/r.git ***')
  })
  it('is a no-op for an empty token', () => {
    expect(redactToken('nothing', '')).toBe('nothing')
  })
})

describe('classifyState', () => {
  it('maps existence checks to a state', () => {
    expect(classifyState(false, false)).toBe('missing')
    expect(classifyState(true, false)).toBe('present-not-git')
    expect(classifyState(true, true)).toBe('present')
  })
})

describe('parseAgentRepos', () => {
  it('parses group/app + branch, sorted by repoName', () => {
    const map = { 'lease/api': 'lease/api@develop', 'auction/api': 'auction/api@main' }
    expect(parseAgentRepos(map)).toEqual([
      { group: 'auction', app: 'api', repoName: 'auction/api', baseBranch: 'main' },
      { group: 'lease', app: 'api', repoName: 'lease/api', baseBranch: 'develop' },
    ])
  })
  it('defaults the branch to main', () => {
    expect(parseAgentRepos({ 'auction/api': 'auction/api' })[0].baseBranch).toBe('main')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- repos.test`
Expected: FAIL — cannot resolve `@/lib/setup/repos` / functions not exported.

- [ ] **Step 3: Write the module (pure parts only)**

`lib/setup/repos.ts`:

```ts
import { dashboardConfig } from '@/dashboard.config'
import { parseRepoSpec } from '@/lib/agent/prompt'

export type RepoState = 'present' | 'present-not-git' | 'missing'

export type RepoEntry = {
  group: string
  app: string
  /** Path segment under the install root, e.g. 'auction/api'. */
  repoName: string
  baseBranch: string
}

export type RepoStatus = RepoEntry & { state: RepoState; path: string }

export type SetupStatus = {
  /** GITLAB_HOST + GITLAB_TOKEN both present (cloning is impossible otherwise). */
  configured: boolean
  /** Absolute install root. */
  root: string
  repos: RepoStatus[]
}

/** 'https://gitlab.example.com/' -> 'gitlab.example.com'. */
export function bareHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** Authenticated clone URL. The token is embedded only for the clone, never persisted. */
export function buildCloneUrl(host: string, token: string, repoName: string): string {
  return `https://oauth2:${token}@${bareHost(host)}/${repoName}.git`
}

/** Token-less remote URL, set on origin right after cloning. */
export function cleanRemoteUrl(host: string, repoName: string): string {
  return `https://${bareHost(host)}/${repoName}.git`
}

/** Replace every occurrence of the token with '***' (no-op for an empty token). */
export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('***') : text
}

/** Pure state classifier from two existence checks. */
export function classifyState(dirExists: boolean, gitExists: boolean): RepoState {
  if (!dirExists) return 'missing'
  return gitExists ? 'present' : 'present-not-git'
}

/** Parse AGENT_REPOS into typed entries (key 'auction/api', value 'auction/api@main'). */
export function parseAgentRepos(
  map: Record<string, string> = dashboardConfig.agentRepos,
): RepoEntry[] {
  return Object.entries(map)
    .map(([key, spec]) => {
      const slash = key.indexOf('/')
      const group = slash === -1 ? key : key.slice(0, slash)
      const app = slash === -1 ? '' : key.slice(slash + 1)
      const { repo: repoName, baseBranch } = parseRepoSpec(spec)
      return { group, app, repoName, baseBranch }
    })
    .filter((e) => e.repoName)
    .sort((a, b) => a.repoName.localeCompare(b.repoName))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- repos.test`
Expected: PASS (all cases in `lib/setup/repos.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add lib/setup/repos.ts lib/setup/repos.test.ts
git commit -m "feat: repo-installer core types and pure helpers"
```

---

### Task 2: Shared core — status, target selection, cloning

**Files:**
- Modify: `lib/setup/repos.ts` (append IO functions)
- Test: `lib/setup/repos.io.test.ts`

**Interfaces:**
- Consumes: `node:fs` (`existsSync`, `mkdirSync`), `node:child_process` (`execFileSync`), `node:path` (`join`, `dirname`); `dashboardConfig.workspaceDir`; `Result`/`ok`/`unconfigured`/`failure` from `@/lib/result`; helpers from Task 1.
- Produces (relied on by Tasks 3, 4, 5):
  - `resolveGitlab(): { host: string; token: string } | null`
  - `installRoot(): string`
  - `getStatus(): SetupStatus`
  - `selectCloneTargets(status: SetupStatus, repoName?: string): RepoStatus[]`
  - `cloneRepo(entry: RepoEntry): Result<{ repoName: string }>`

- [ ] **Step 1: Write the failing test**

`lib/setup/repos.io.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/dashboard.config', () => ({
  dashboardConfig: {
    agentRepos: { 'auction/api': 'auction/api@main', 'lease/api': 'lease/api@main' },
    workspaceDir: '/tmp/root',
  },
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn(), mkdirSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { getStatus, selectCloneTargets, cloneRepo, installRoot } from '@/lib/setup/repos'

const existsMock = vi.mocked(existsSync)
const execMock = vi.mocked(execFileSync)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
})

describe('installRoot', () => {
  it('uses the workspaceDir override', () => {
    expect(installRoot()).toBe('/tmp/root')
  })
})

describe('getStatus', () => {
  it('classifies each configured repo; configured=false without creds', () => {
    existsMock.mockImplementation((p) => String(p).startsWith('/tmp/root/auction/api'))
    const s = getStatus()
    expect(s.configured).toBe(false)
    expect(s.repos.find((r) => r.repoName === 'auction/api')?.state).toBe('present')
    expect(s.repos.find((r) => r.repoName === 'lease/api')?.state).toBe('missing')
  })
  it('configured=true when host and token are set', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 't'
    existsMock.mockReturnValue(false)
    expect(getStatus().configured).toBe(true)
  })
})

describe('selectCloneTargets', () => {
  it('returns all missing when no name is given', () => {
    existsMock.mockReturnValue(false)
    expect(selectCloneTargets(getStatus()).map((r) => r.repoName)).toEqual(['auction/api', 'lease/api'])
  })
  it('returns only the named repo', () => {
    existsMock.mockReturnValue(false)
    expect(selectCloneTargets(getStatus(), 'lease/api').map((r) => r.repoName)).toEqual(['lease/api'])
  })
})

describe('cloneRepo', () => {
  const entry = { group: 'auction', app: 'api', repoName: 'auction/api', baseBranch: 'main' }
  it('is unconfigured without creds', () => {
    const res = cloneRepo(entry)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toBe('unconfigured')
  })
  it('clones with the token URL, then strips the token from origin', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(false)
    const res = cloneRepo(entry)
    expect(res.ok).toBe(true)
    const argLists = execMock.mock.calls.map((c) => c[1] as string[])
    expect(argLists[0]).toEqual(['clone', 'https://oauth2:secret@gl.x/auction/api.git', '/tmp/root/auction/api'])
    const setUrl = argLists.find((a) => a.includes('set-url'))
    expect(setUrl).toContain('https://gl.x/auction/api.git')
    expect(JSON.stringify(setUrl)).not.toContain('secret')
  })
  it('redacts the token from clone errors', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(false)
    execMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: git clone https://oauth2:secret@gl.x/auction/api.git'), {
        stderr: 'auth for secret failed',
      })
    })
    const res = cloneRepo(entry)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('secret')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- repos.io.test`
Expected: FAIL — `getStatus` / `cloneRepo` / etc. not exported.

- [ ] **Step 3: Append the IO functions to `lib/setup/repos.ts`**

Add these imports at the top of the file (alongside the existing ones):

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { type Result, ok, unconfigured, failure } from '@/lib/result'
```

Append these functions to the end of the file:

```ts
/** GitLab creds from env, or null when unset. Mirrors env.gitlab() without the 'server-only' import. */
export function resolveGitlab(): { host: string; token: string } | null {
  const host = process.env.GITLAB_HOST
  const token = process.env.GITLAB_TOKEN
  return host && token ? { host, token } : null
}

/** Absolute install root: WORKSPACE_DIR override, else <cwd>/repos. */
export function installRoot(): string {
  return dashboardConfig.workspaceDir || join(process.cwd(), 'repos')
}

function classify(path: string): RepoState {
  return classifyState(existsSync(path), existsSync(join(path, '.git')))
}

/** Present/missing status for every configured repo. */
export function getStatus(): SetupStatus {
  const root = installRoot()
  const repos = parseAgentRepos().map((e) => {
    const path = join(root, e.repoName)
    return { ...e, path, state: classify(path) }
  })
  return { configured: !!resolveGitlab(), root, repos }
}

/** Which repos a clone request targets: one named repo, or all currently missing. */
export function selectCloneTargets(status: SetupStatus, repoName?: string): RepoStatus[] {
  return repoName
    ? status.repos.filter((r) => r.repoName === repoName)
    : status.repos.filter((r) => r.state === 'missing')
}

/** Clone one repo over HTTPS, then strip the token from origin. Never overwrites an existing dir. */
export function cloneRepo(entry: RepoEntry): Result<{ repoName: string }> {
  const gl = resolveGitlab()
  if (!gl) return unconfigured('set GITLAB_HOST and GITLAB_TOKEN to clone')
  const dest = join(installRoot(), entry.repoName)
  if (existsSync(dest)) return failure(`${dest} already exists`)
  try {
    mkdirSync(dirname(dest), { recursive: true })
    execFileSync('git', ['clone', buildCloneUrl(gl.host, gl.token, entry.repoName), dest], {
      stdio: 'pipe',
      timeout: 300_000,
    })
    // Best-effort: check out the configured base branch (no-op if it's already the default).
    try {
      execFileSync('git', ['-C', dest, 'checkout', entry.baseBranch], { stdio: 'ignore' })
    } catch {
      // base branch may equal the default or not exist remotely — leave the default checkout
    }
    execFileSync('git', ['-C', dest, 'remote', 'set-url', 'origin', cleanRemoteUrl(gl.host, entry.repoName)], {
      stdio: 'ignore',
    })
    return ok({ repoName: entry.repoName })
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer | string }
    const raw = [err.message, err.stderr?.toString()].filter(Boolean).join('\n') || 'git clone failed'
    return failure(redactToken(raw, gl.token))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- repos`
Expected: PASS (both `repos.test.ts` and `repos.io.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add lib/setup/repos.ts lib/setup/repos.io.test.ts
git commit -m "feat: repo-installer status + clone with token redaction"
```

---

### Task 3: API routes (status + clone)

**Files:**
- Create: `app/api/setup/repos/route.ts`
- Create: `app/api/setup/repos/clone/route.ts`

**Interfaces:**
- Consumes: `getStatus`, `selectCloneTargets`, `cloneRepo` from `@/lib/setup/repos`; `ok`/`unconfigured` from `@/lib/result`; `NextRequest`/`NextResponse` from `next/server`.
- Produces: `GET /api/setup/repos` → `Result<SetupStatus>`; `POST /api/setup/repos/clone` (body `{ repoName?: string }`) → `Result<Array<{ repoName: string; result: Result<{ repoName: string }> }>>`.

> These are thin glue over the Task 2 core (whose logic is already unit-tested). No new unit test; verified by build + curl.

- [ ] **Step 1: Read the route-handler guide**

Read `node_modules/next/dist/docs/` for the route-handler / `NextResponse` guide in this fork. Confirm the `export const dynamic = 'force-dynamic'` + `NextResponse.json(...)` shape matches `app/api/agent/apps/route.ts`.

- [ ] **Step 2: Create the status route**

`app/api/setup/repos/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { ok } from '@/lib/result'
import { getStatus } from '@/lib/setup/repos'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(ok(getStatus()))
}
```

- [ ] **Step 3: Create the clone route**

`app/api/setup/repos/clone/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { ok, unconfigured } from '@/lib/result'
import { getStatus, selectCloneTargets, cloneRepo } from '@/lib/setup/repos'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const repoName = typeof body?.repoName === 'string' ? body.repoName : undefined
  const status = getStatus()
  if (!status.configured) {
    return NextResponse.json(unconfigured('set GITLAB_HOST and GITLAB_TOKEN to clone'))
  }
  const results = selectCloneTargets(status, repoName).map((t) => ({
    repoName: t.repoName,
    result: cloneRepo(t),
  }))
  return NextResponse.json(ok(results))
}
```

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: build succeeds; both routes compile.

Then start `npm run dev` and:

Run: `curl -s localhost:3000/api/setup/repos | head -c 400`
Expected: JSON `{"ok":true,"data":{"configured":...,"root":"...","repos":[...]}}`.

- [ ] **Step 5: Commit**

```bash
git add app/api/setup
git commit -m "feat: setup repos status + clone API routes"
```

---

### Task 4: CLI (`npm run setup`) + predev warning

**Files:**
- Create: `scripts/setup-repos.ts`
- Modify: `package.json` (add `tsx` devDependency + `setup` script; extend `predev` / `predev:lan`)

**Interfaces:**
- Consumes: `loadEnvConfig` from `@next/env`; `getStatus`, `cloneRepo`, `selectCloneTargets` from `@/lib/setup/repos` (imported **dynamically**, after env is loaded).
- Produces: `npm run setup` (clone missing) and `tsx scripts/setup-repos.ts --check` (report-only, always exits 0).

- [ ] **Step 1: Add the `tsx` devDependency**

Run: `npm install -D tsx`
Expected: `tsx` added under `devDependencies`; `node_modules/.bin/tsx` exists.

- [ ] **Step 2: Write the CLI script**

`scripts/setup-repos.ts`:

```ts
/**
 * Clone the AGENT_REPOS this dashboard is configured for into <dashboard>/repos
 * (or WORKSPACE_DIR). Idempotent: clones only what's missing, never touches existing
 * clones. `--check` reports status and warns without cloning (used by predev).
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

// Import AFTER env is loaded — dashboard.config reads process.env at module-eval time.
const { getStatus, cloneRepo, selectCloneTargets } = await import('@/lib/setup/repos')

const checkOnly = process.argv.includes('--check')
const status = getStatus()

const LABEL: Record<string, string> = {
  present: '✓ present',
  'present-not-git': '! not a git repo',
  missing: '✗ missing',
}

console.log(`\nConfigured repos (install root: ${status.root}):`)
for (const r of status.repos) {
  console.log(`  ${LABEL[r.state].padEnd(18)} ${r.repoName}@${r.baseBranch}`)
}
if (status.repos.length === 0) {
  console.log('  (none — set AGENT_REPOS in .env.local)')
}

const missing = status.repos.filter((r) => r.state === 'missing')

if (checkOnly) {
  if (missing.length > 0) {
    console.warn(
      `\n⚠ ${missing.length} configured repo(s) not installed — run \`npm run setup\` or use the dashboard Setup panel.\n`,
    )
  }
  process.exit(0)
}

if (!status.configured) {
  console.error(
    '\nCannot clone: set GITLAB_HOST and GITLAB_TOKEN in .env.local (token needs the read_repository scope).\n',
  )
  process.exit(1)
}

if (missing.length === 0) {
  console.log('\nAll configured repos are already installed.\n')
  process.exit(0)
}

let failed = 0
for (const entry of selectCloneTargets(status)) {
  process.stdout.write(`\nCloning ${entry.repoName}@${entry.baseBranch} … `)
  const res = cloneRepo(entry)
  if (res.ok) {
    console.log('done')
  } else {
    failed++
    console.log('FAILED')
    console.error(`  ${res.message}`)
  }
}

console.log(
  `\nSummary: cloned ${missing.length - failed}, failed ${failed}, present ${status.repos.length - missing.length}.\n`,
)
process.exit(failed > 0 ? 1 : 0)
```

- [ ] **Step 3: Wire up package.json scripts**

In `package.json`, add a `setup` script and extend the two `predev` hooks (they currently run only `bash scripts/ensure-sso.sh`). The `--check` run always exits 0, so it warns without blocking startup:

```json
    "setup": "tsx scripts/setup-repos.ts",
    "predev": "bash scripts/ensure-sso.sh && tsx scripts/setup-repos.ts --check",
    "predev:lan": "bash scripts/ensure-sso.sh && tsx scripts/setup-repos.ts --check",
```

- [ ] **Step 4: Verify the report path (no cloning)**

Run: `npx tsx scripts/setup-repos.ts --check`
Expected: prints the "Configured repos (install root: …/repos)" table; if any are missing, prints the `⚠ N configured repo(s) not installed` warning; exits 0 (`echo $?` → `0`). No clone attempted.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-repos.ts package.json package-lock.json
git commit -m "feat: npm run setup CLI + non-blocking predev repo check"
```

---

### Task 5: Point the agent runner at `installRoot()`

**Files:**
- Modify: `lib/agent/runner.ts` (replace the local `workspaceDir()` with the shared `installRoot()`)

**Interfaces:**
- Consumes: `installRoot` from `@/lib/setup/repos`.
- Produces: no new exports; `repoPath` now resolves under the same root the installer clones into.

> Single source of truth: the runner and the installer must agree on where repos live. Existing agent tests must still pass.

- [ ] **Step 1: Add the import**

In `lib/agent/runner.ts`, add to the imports:

```ts
import { installRoot } from '@/lib/setup/repos'
```

- [ ] **Step 2: Remove the local `workspaceDir` and its now-unused `homedir` import**

Delete this line (currently ~line 55):

```ts
const workspaceDir = () => dashboardConfig.workspaceDir || join(homedir(), 'workspace')
```

And remove the now-unused import:

```ts
import { homedir } from 'node:os'
```

(Verify `homedir` is not referenced elsewhere first: `grep -n homedir lib/agent/runner.ts` should show only the import line before this edit.)

- [ ] **Step 3: Replace the two call sites**

Both occurrences of `join(workspaceDir(), repoName)` (currently ~lines 167 and 294) become:

```ts
const repoPath = join(installRoot(), repoName)
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS — full suite green (agent tests unaffected).

Run: `npm run build`
Expected: build succeeds (no unused-import / type errors).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/runner.ts
git commit -m "refactor: runner resolves repos via shared installRoot()"
```

---

### Task 6: Setup panel, page, nav entry, and missing-repos banner

**Files:**
- Create: `components/repos-panel.tsx`
- Create: `components/repos-banner.tsx`
- Create: `app/(dashboard)/setup/page.tsx`
- Modify: `components/nav-items.tsx` (add the Setup destination)
- Modify: `app/(dashboard)/layout.tsx` (mount the banner)

**Interfaces:**
- Consumes: `usePoll` from `@/lib/use-poll`; `PanelShell` from `@/components/panel-shell`; `Button`, `Badge` from `@/components/ui/*`; `cn` from `@/lib/utils`; **types only** `SetupStatus`, `RepoState` from `@/lib/setup/repos`; the routes from Task 3.
- Produces: `ReposPanel`, `ReposBanner` components; `/setup` route; a `navItems` entry.

> Client components import **only types** from `@/lib/setup/repos` (`import type`) — it pulls in `node:*` and must never enter the client bundle.

- [ ] **Step 1: Read the guide for any Next API used**

If unsure about `next/link` usage in this fork, check `node_modules/next/dist/docs/`. `Link` is used the same way as elsewhere in the repo.

- [ ] **Step 2: Create the panel**

`components/repos-panel.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PanelShell } from '@/components/panel-shell'
import { cn } from '@/lib/utils'
import type { SetupStatus, RepoState } from '@/lib/setup/repos'

const STATE_CLASS: Record<RepoState, string> = {
  present: 'text-primary border-primary/40',
  'present-not-git': 'text-amber-500 border-amber-500/40',
  missing: 'text-destructive border-destructive/40',
}
const STATE_LABEL: Record<RepoState, string> = {
  present: '● present',
  'present-not-git': '● not a git repo',
  missing: '● missing',
}

async function clone(repoName?: string) {
  const res = await fetch('/api/setup/repos/clone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(repoName ? { repoName } : {}),
  })
  return res.json()
}

export function ReposPanel() {
  const { data, loading } = usePoll<SetupStatus>('/api/setup/repos', 15000)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(repoName?: string) {
    setBusy(repoName ?? '*')
    try {
      await clone(repoName)
    } finally {
      setBusy(null)
    }
  }

  return (
    <PanelShell<SetupStatus> title="repos" result={data} loading={loading}>
      {(status) => {
        const missing = status.repos.filter((r) => r.state === 'missing')
        return (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs text-muted-foreground">root: {status.root}</p>
              {status.configured && missing.length > 0 && (
                <Button size="sm" disabled={busy !== null} onClick={() => run()}>
                  {busy === '*' ? 'Cloning…' : `Clone all missing (${missing.length})`}
                </Button>
              )}
            </div>
            {!status.configured && (
              <p className="font-mono text-sm text-amber-500">
                [ ---- ] set GITLAB_HOST and GITLAB_TOKEN (token scope: read_repository) to clone
              </p>
            )}
            <ul className="space-y-1">
              {status.repos.map((r) => (
                <li key={r.repoName} className="flex items-center justify-between gap-3 font-mono text-sm">
                  <span className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn('rounded-none bg-transparent px-1.5 text-[11px]', STATE_CLASS[r.state])}
                    >
                      {STATE_LABEL[r.state]}
                    </Badge>
                    <span>
                      {r.repoName}@{r.baseBranch}
                    </span>
                  </span>
                  {status.configured && r.state === 'missing' && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(r.repoName)}>
                      {busy === r.repoName ? 'Cloning…' : 'Clone'}
                    </Button>
                  )}
                </li>
              ))}
              {status.repos.length === 0 && (
                <li className="font-mono text-sm text-muted-foreground">no repos configured — set AGENT_REPOS</li>
              )}
            </ul>
          </div>
        )
      }}
    </PanelShell>
  )
}
```

- [ ] **Step 3: Create the banner**

`components/repos-banner.tsx`:

```tsx
'use client'
import Link from 'next/link'
import { usePoll } from '@/lib/use-poll'
import type { SetupStatus } from '@/lib/setup/repos'

export function ReposBanner() {
  const { data } = usePoll<SetupStatus>('/api/setup/repos', 30000)
  if (!data || !data.ok) return null
  const missing = data.data.repos.filter((r) => r.state === 'missing').length
  if (missing === 0) return null
  return (
    <Link
      href="/setup"
      className="block border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-center font-mono text-xs text-amber-500 hover:bg-amber-500/20"
    >
      ⚠ {missing} configured repo{missing > 1 ? 's' : ''} not installed — click to install
    </Link>
  )
}
```

- [ ] **Step 4: Create the page**

`app/(dashboard)/setup/page.tsx`:

```tsx
import { ReposPanel } from '@/components/repos-panel'

export default function SetupPage() {
  return (
    <div className="space-y-4">
      <ReposPanel />
    </div>
  )
}
```

- [ ] **Step 5: Add the nav entry**

In `components/nav-items.tsx`, add `FolderGit2` to the `lucide-react` import and append the destination:

```tsx
import { FolderGit2, GitBranch, LayoutDashboard, Rocket, SquareKanban, Workflow } from "lucide-react"
```

```tsx
  { href: "/agents", title: "Agents", icon: Workflow },
  { href: "/jira", title: "Jira", icon: SquareKanban },
  { href: "/setup", title: "Setup", icon: FolderGit2 },
]
```

- [ ] **Step 6: Mount the banner in the layout**

In `app/(dashboard)/layout.tsx`, import the banner:

```tsx
import { ReposBanner } from "@/components/repos-banner";
```

Then render it directly above `<main>` (inside `<SidebarInset>`, after the closing `</header>`):

```tsx
                </header>
                <ReposBanner />
                <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
                  {children}
                </main>
```

- [ ] **Step 7: Verify**

Run: `npm run build`
Expected: build succeeds; `/setup` route present; no "server-only imported from client" errors (types are erased).

Then `npm run dev` → open `http://localhost:3000/setup`: the panel lists each configured repo with present/missing badges and Clone buttons; when repos are missing, the amber banner shows at the top of every dashboard page and links to `/setup`.

- [ ] **Step 8: Commit**

```bash
git add components/repos-panel.tsx components/repos-banner.tsx "app/(dashboard)/setup/page.tsx" components/nav-items.tsx "app/(dashboard)/layout.tsx"
git commit -m "feat: Setup repos panel, page, nav entry, and missing-repos banner"
```

---

### Task 7: Docs + gitignore

**Files:**
- Modify: `.gitignore` (ignore `/repos`)
- Modify: `.env.local.example` (document `WORKSPACE_DIR` + `read_repository` scope)
- Modify: `README.md` (add the install step + explain the default location)

- [ ] **Step 1: Ignore the clone location**

In `.gitignore`, add near the top (beside `/.agent-jobs`):

```
# cloned application repos (installed by `npm run setup`)
/repos
```

- [ ] **Step 2: Document env in `.env.local.example`**

Change the existing GitLab token line comment to mention `read_repository`, and add a `WORKSPACE_DIR` note below the Agent dispatch block:

```
# WORKSPACE_DIR — where configured repos are cloned/looked up.
# Defaults to <dashboard>/repos (installed by `npm run setup`). Point it at your own
# checkout dir (e.g. ~/workspace) to reuse existing clones instead.
# WORKSPACE_DIR=

# NOTE: cloning over HTTPS needs GITLAB_TOKEN to include the `read_repository` scope
# (the `api` scope already includes it; `read_api` alone cannot clone).
```

- [ ] **Step 3: Add the install step to `README.md`**

In the `## Setup` section, add a step after the `.env.local` step (and renumber the ones after it):

```markdown
4. **Install the application repos:** `npm run setup` clones every repo listed in
   `AGENT_REPOS` into `./repos` (or `WORKSPACE_DIR`), skipping any already present.
   You can also do this from the dashboard's **Setup** page, which shows which repos
   are installed and offers per-repo / clone-all buttons. `npm run dev` prints a
   reminder if any configured repo is still missing (it never blocks startup).
   The token needs the **`read_repository`** scope to clone (a `read_api`-only token
   can't). Set `WORKSPACE_DIR=~/workspace` to reuse existing clones instead of `./repos`.
```

- [ ] **Step 4: Verify**

Run: `git check-ignore repos && echo IGNORED`
Expected: prints `repos` then `IGNORED`.

Read through the README setup section — steps are correctly numbered and consistent.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .env.local.example README.md
git commit -m "docs: document repo installer setup, WORKSPACE_DIR, and token scope"
```

---

## Notes / Known Considerations

- **Next dev file-watching:** repos cloned into `<dashboard>/repos` sit inside the project root, so the dev watcher walks them. They are never imported by the app, so edits there won't trigger app recompiles, but a very large monorepo adds watch overhead. Escape hatch: set `WORKSPACE_DIR=~/workspace` (documented) to clone outside the project.
- **Clone endpoint auth:** `POST /api/setup/repos/clone` is unauthenticated, matching the read routes. It can only clone repos already listed in `AGENT_REPOS` into `installRoot()` (low blast radius). If the dashboard is exposed on the LAN (`dev:lan`), consider gating it behind the existing agent-token mechanism in a follow-up.
- **Default location change:** the agent runner's workspace default moves from `~/workspace` to `<dashboard>/repos` (Task 5). Users who relied on the old default set `WORKSPACE_DIR=~/workspace`; the Setup panel/banner will otherwise flag their repos as "missing" and offer to clone.

## Self-Review

- **Spec coverage:** shared core (Task 1–2) ✓; CLI `npm run setup` (Task 4) ✓; API routes (Task 3) ✓; UI panel + banner (Task 6) ✓; install-inside-dashboard via `installRoot` default + `/repos` gitignore (Task 2, 5, 7) ✓; AGENT_REPOS as source of truth (Task 1) ✓; HTTPS + token auth with redaction + token-less origin (Task 2) ✓; leave existing clones untouched / clone-only-missing (Task 2 `selectCloneTargets`, `cloneRepo` refuses existing dir) ✓; warn-don't-block gate (Task 4 `--check`, Task 6 banner) ✓; error handling — unconfigured / clone failure / present-not-git (Task 2) ✓; tests (Task 1–2) ✓; read_repository scope doc (Task 7) ✓.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
- **Type consistency:** `SetupStatus`, `RepoStatus`, `RepoState`, `RepoEntry`, `installRoot`, `getStatus`, `selectCloneTargets`, `cloneRepo`, `buildCloneUrl`, `cleanRemoteUrl`, `redactToken`, `classifyState`, `parseAgentRepos`, `resolveGitlab` — names/signatures identical across the module, tests, routes, CLI, and components.
