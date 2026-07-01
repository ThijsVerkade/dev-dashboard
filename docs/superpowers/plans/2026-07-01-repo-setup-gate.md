# Repo-Setup Gate + Robust Cloning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repo setup a mandatory, no-bypass gate (like the AWS login gate) with in-UI GitLab token entry, and make cloning reliable and transparent (visible per-repo results, recoverable broken dirs, no silent wrong-branch).

**Architecture:** Extend the existing `lib/setup/repos.ts` clone logic (branch warning + force re-clone), add a client-safe helper module and a token-persistence module, expose them through two API routes, and add a `<ReposSetupGate>` client component nested inside `<AwsLoginGate>` in the dashboard layout. A single shared `<ReposSetup>` component (per-repo clone UI + token form) is reused by both the gate and the `/setup` page.

**Tech Stack:** Next.js (App Router), React client components, TypeScript, Vitest (node env), git CLI via `node:child_process`.

## Global Constraints

- **Hard gate, no bypass.** The dashboard must be unreachable until every configured repo is `present`. No "continue anyway" escape hatch.
- **Loopback-only for secret/side-effecting routes.** The token route must 403 unless the request host is loopback, reusing `isLoopbackHost` from `lib/sso-login.ts`.
- **Never leak the token.** Embed token only in the clone/ls-remote URL; strip from origin after clone; remove partial clones on failure; redact the token from every returned message via `redactToken`.
- **Never delete a healthy repo.** Force re-clone may remove a `present-not-git` directory only, never a valid git repo (`present`).
- **Persist creds to `.env.local`** (gitignored) and also set `process.env` in-memory so changes apply without a server restart.
- **Default GitLab host:** `https://gitlab.bastrucks.com` (overridable by `GITLAB_HOST`).
- **Result type:** `Result<T>` from `@/lib/result` — `{ ok: true; data: T } | { ok: false; reason: 'unconfigured' | 'error'; message: string }`. Use `ok()`, `unconfigured()`, `failure()`.
- **Tests** live in `lib/**/*.test.ts` (Vitest include glob); node environment, no DOM. Do not add component tests. Run with `npx vitest run <file>`.

---

### Task 1: Add default GitLab host to config and `host` to `SetupStatus`

**Files:**
- Modify: `dashboard.config.ts:82-107` (add `gitlabHost`)
- Modify: `lib/setup/repos.ts:20-26` (add `host` to `SetupStatus`), `lib/setup/repos.ts:87-94` (`getStatus`)
- Test: `lib/setup/repos.io.test.ts:3-8` (config mock) and a new assertion

**Interfaces:**
- Produces: `dashboardConfig.gitlabHost: string`; `SetupStatus` gains `host: string`.

- [ ] **Step 1: Update the `getStatus` I/O test's config mock and add a host assertion**

In `lib/setup/repos.io.test.ts`, extend the mock (lines 3-8) to include `gitlabHost`:

```ts
vi.mock('@/dashboard.config', () => ({
  dashboardConfig: {
    agentRepos: { 'auction/api': 'auction/api@main', 'lease/api': 'lease/api@main' },
    workspaceDir: '/tmp/root',
    gitlabHost: 'https://gitlab.example.com',
  },
}))
```

Add this assertion inside the existing `describe('getStatus', ...)` block:

```ts
it('includes the configured gitlab host', () => {
  existsMock.mockReturnValue(false)
  expect(getStatus().host).toBe('https://gitlab.example.com')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/setup/repos.io.test.ts -t "includes the configured gitlab host"`
Expected: FAIL — `getStatus().host` is `undefined`.

- [ ] **Step 3: Add `gitlabHost` to the config**

In `dashboard.config.ts`, inside the `dashboardConfig` object (after the `stagingJobName` line, around line 88), add:

```ts
  // Base GitLab host for the setup token form + create-token link. Overridable by GITLAB_HOST.
  gitlabHost: process.env.GITLAB_HOST ?? 'https://gitlab.bastrucks.com',
```

- [ ] **Step 4: Add `host` to `SetupStatus` and populate it in `getStatus`**

In `lib/setup/repos.ts`, `import { dashboardConfig } from '@/dashboard.config'` is already present. Extend the `SetupStatus` type (lines 20-26):

```ts
export type SetupStatus = {
  /** GITLAB_HOST + GITLAB_TOKEN both present (cloning is impossible otherwise). */
  configured: boolean
  /** Absolute install root. */
  root: string
  /** GitLab host for the token form / create-token link. */
  host: string
  repos: RepoStatus[]
}
```

Update `getStatus` (lines 87-94) to return `host`:

```ts
export function getStatus(): SetupStatus {
  const root = installRoot()
  const repos = parseAgentRepos().map((e) => {
    const path = join(root, e.repoName)
    return { ...e, path, state: classify(path) }
  })
  return { configured: !!resolveGitlab(), root, host: dashboardConfig.gitlabHost, repos }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/setup/repos.io.test.ts`
Expected: PASS (all cases, including the new host assertion).

- [ ] **Step 6: Commit**

```bash
git add dashboard.config.ts lib/setup/repos.ts lib/setup/repos.io.test.ts
git commit -m "feat: expose gitlabHost default in setup status"
```

---

### Task 2: Branch-aware clone with wrong-branch warning

**Files:**
- Modify: `lib/setup/repos.ts:103-132` (`cloneRepo`)
- Test: `lib/setup/repos.io.test.ts` (existing `cloneRepo` cases + a new warning case)

**Interfaces:**
- Consumes: `resolveGitlab`, `buildCloneUrl`, `cleanRemoteUrl`, `redactToken`, `installRoot` (existing in `repos.ts`).
- Produces: `cloneRepo(entry: RepoEntry, opts?: { force?: boolean }): Result<{ repoName: string; branch: string; warning?: string }>`. (This task adds `branch`/`warning`; the `opts.force` behavior is implemented in Task 3 — declare the optional param now, unused.)

- [ ] **Step 1: Add a failing test for the wrong-branch warning**

In `lib/setup/repos.io.test.ts`, inside `describe('cloneRepo', ...)`, add:

```ts
it('warns when the requested base branch is not the checked-out branch', () => {
  process.env.GITLAB_HOST = 'https://gl.x'
  process.env.GITLAB_TOKEN = 'secret'
  existsMock.mockReturnValue(false)
  execMock.mockImplementation((_bin, args) => {
    const a = args as string[]
    if (a.includes('rev-parse')) return 'master\n' as never // HEAD ended up on master
    return '' as never
  })
  const res = cloneRepo(entry) // entry.baseBranch === 'main'
  expect(res.ok).toBe(true)
  expect(res.ok === true && res.data.branch).toBe('master')
  expect(res.ok === true && res.data.warning).toContain('main')
})
```

Also update the existing `'clones with the token URL...'` test to assert the new success shape — add after its `expect(res.ok).toBe(true)`:

```ts
  expect(res.ok === true && typeof res.data.branch).toBe('string')
```

Note: in that test `execMock` returns `undefined` for all calls, so `rev-parse` yields `''` → `branch` is `''` and (since `'' !== 'main'`) a warning is set; that is fine for the shape assertion.

- [ ] **Step 2: Run to verify the new test fails**

Run: `npx vitest run lib/setup/repos.io.test.ts -t "warns when the requested base branch"`
Expected: FAIL — `res.data.branch` is `undefined` (current return is `{ repoName }`).

- [ ] **Step 3: Rewrite `cloneRepo` to check out the branch, read HEAD back, and warn on mismatch**

Replace `cloneRepo` (lines 103-132) with:

```ts
/** Clone one repo over HTTPS, then strip the token from origin. Never overwrites an existing dir. */
export function cloneRepo(
  entry: RepoEntry,
  _opts: { force?: boolean } = {},
): Result<{ repoName: string; branch: string; warning?: string }> {
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
      execFileSync('git', ['-C', dest, 'checkout', entry.baseBranch], { stdio: 'pipe' })
    } catch {
      // base branch may equal the default or not exist remotely — leave the default checkout
    }
    execFileSync('git', ['-C', dest, 'remote', 'set-url', 'origin', cleanRemoteUrl(gl.host, entry.repoName)], {
      stdio: 'ignore',
    })
    // Read back the actual branch so a missing/mistyped base branch is surfaced, not silent.
    const head = execFileSync('git', ['-C', dest, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: 'pipe',
    })
    const branch = (head ? head.toString() : '').trim()
    const warning =
      branch !== entry.baseBranch
        ? `cloned on '${branch}'; requested branch '${entry.baseBranch}' not found`
        : undefined
    return ok({ repoName: entry.repoName, branch, ...(warning ? { warning } : {}) })
  } catch (e) {
    // Remove any partial clone this run created, so a leaked token can't persist in .git/config.
    try { rmSync(dest, { recursive: true, force: true }) } catch {}
    const err = e as { message?: string; stderr?: Buffer | string }
    const raw = [err.message, err.stderr?.toString()].filter(Boolean).join('\n') || 'git clone failed'
    return failure(redactToken(raw, gl.token))
  }
}
```

- [ ] **Step 4: Run the whole file to verify all `cloneRepo` tests pass**

Run: `npx vitest run lib/setup/repos.io.test.ts`
Expected: PASS. (The redaction and partial-clone tests still hold; note `rev-parse` now runs but throwing mocks short-circuit earlier.)

- [ ] **Step 5: Commit**

```bash
git add lib/setup/repos.ts lib/setup/repos.io.test.ts
git commit -m "feat: surface wrong-branch warning from cloneRepo"
```

---

### Task 3: Force re-clone of broken dirs + clone route `force` flag

**Files:**
- Modify: `lib/setup/repos.ts` (`cloneRepo` — use the `force` option)
- Modify: `app/api/setup/repos/clone/route.ts:7-19`
- Test: `lib/setup/repos.io.test.ts` (two new cases)

**Interfaces:**
- Consumes: `cloneRepo(entry, { force })` from Task 2.
- Produces: `POST /api/setup/repos/clone` accepts `{ repoName?: string; force?: boolean }` and returns `ok([{ repoName, result }])` where `result` is `Result<{ repoName; branch; warning? }>`.

- [ ] **Step 1: Add failing tests for force re-clone behavior**

In `lib/setup/repos.io.test.ts`, inside `describe('cloneRepo', ...)`, add:

```ts
it('force re-clones a present-not-git dir: removes it, then clones', () => {
  process.env.GITLAB_HOST = 'https://gl.x'
  process.env.GITLAB_TOKEN = 'secret'
  // dest exists, but dest/.git does not => present-not-git
  existsMock.mockImplementation((p) => String(p) === '/tmp/root/auction/api')
  const res = cloneRepo(entry, { force: true })
  expect(res.ok).toBe(true)
  expect(rmMock).toHaveBeenCalledWith('/tmp/root/auction/api', { recursive: true, force: true })
  const argLists = execMock.mock.calls.map((c) => c[1] as string[])
  expect(argLists.some((a) => a[0] === 'clone')).toBe(true)
})

it('force refuses to delete a valid git repo (present)', () => {
  process.env.GITLAB_HOST = 'https://gl.x'
  process.env.GITLAB_TOKEN = 'secret'
  // both dest and dest/.git exist => present (healthy)
  existsMock.mockReturnValue(true)
  const res = cloneRepo(entry, { force: true })
  expect(res.ok).toBe(false)
  expect(res.ok === false && res.message).toContain('git repository')
  expect(rmMock).not.toHaveBeenCalled()
  expect(execMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/setup/repos.io.test.ts -t "force"`
Expected: FAIL — force is ignored; the present-not-git case hits the "already exists" guard, and the healthy-repo case does not return the refusal message.

- [ ] **Step 3: Implement the force logic in `cloneRepo`**

In `lib/setup/repos.ts`, rename the option param to `opts` and replace the existence-guard line. Change the signature and the guard block to:

```ts
export function cloneRepo(
  entry: RepoEntry,
  opts: { force?: boolean } = {},
): Result<{ repoName: string; branch: string; warning?: string }> {
  const gl = resolveGitlab()
  if (!gl) return unconfigured('set GITLAB_HOST and GITLAB_TOKEN to clone')
  const dest = join(installRoot(), entry.repoName)
  if (existsSync(dest)) {
    const isGitRepo = existsSync(join(dest, '.git'))
    if (isGitRepo) return failure(`${dest} is already a git repository — refusing to delete it`)
    if (!opts.force) return failure(`${dest} already exists`)
    // present-not-git + force: remove the broken/partial dir before re-cloning.
    try { rmSync(dest, { recursive: true, force: true }) } catch {}
  }
  try {
    // ...unchanged clone/checkout/set-url/rev-parse body from Task 2...
```

Keep the rest of the `try { ... } catch { ... }` body exactly as written in Task 2 (from `mkdirSync(...)` through the final `return failure(redactToken(...))`).

- [ ] **Step 4: Run the file to verify all pass**

Run: `npx vitest run lib/setup/repos.io.test.ts`
Expected: PASS. (The existing `'refuses to overwrite an existing directory'` test calls `cloneRepo(entry)` with `existsMock` returning `true` for all paths → `dest/.git` also "exists" → now returns the "already a git repository" refusal. Update that test's expectation string from `'already exists'` to `'git repository'` to match; it still asserts `res.ok === false` and `execMock` not called.)

- [ ] **Step 5: Update the pre-existing overwrite test to the new refusal message**

In `lib/setup/repos.io.test.ts`, in the `'refuses to overwrite an existing directory and does not clone'` test, change:

```ts
  expect(res.ok === false && res.message).toContain('already exists')
```
to:
```ts
  expect(res.ok === false && res.message).toContain('git repository')
```

Run: `npx vitest run lib/setup/repos.io.test.ts`
Expected: PASS.

- [ ] **Step 6: Make the clone route accept `force`**

Replace the `POST` body in `app/api/setup/repos/clone/route.ts` (lines 7-19) with:

```ts
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const repoName = typeof body?.repoName === 'string' ? body.repoName : undefined
  const force = body?.force === true
  const status = getStatus()
  if (!status.configured) {
    return NextResponse.json(unconfigured('set GITLAB_HOST and GITLAB_TOKEN to clone'))
  }
  const results = selectCloneTargets(status, repoName).map((t) => ({
    repoName: t.repoName,
    result: cloneRepo(t, { force }),
  }))
  return NextResponse.json(ok(results))
}
```

Note: `selectCloneTargets(status, repoName)` returns only the named repo when `repoName` is set, regardless of its state, so a `present-not-git` named repo is selectable for a force re-clone.

- [ ] **Step 7: Commit**

```bash
git add lib/setup/repos.ts lib/setup/repos.io.test.ts app/api/setup/repos/clone/route.ts
git commit -m "feat: force re-clone broken repo dirs via clone route"
```

---

### Task 4: GitLab token validation + `.env.local` persistence

**Files:**
- Create: `lib/setup/gitlab-token.ts`
- Test: `lib/setup/gitlab-token.test.ts`

**Interfaces:**
- Consumes: `buildCloneUrl`, `redactToken`, `parseAgentRepos` from `@/lib/setup/repos`; `ok`, `failure` from `@/lib/result`.
- Produces:
  - `upsertEnv(content: string, updates: Record<string, string>): string`
  - `validateGitlabToken(host: string, token: string, repoName: string): Result<null>`
  - `persistGitlabCreds(host: string, token: string): Result<null>`
  - `saveGitlabToken(host: string, token: string): Result<null>`

- [ ] **Step 1: Write failing tests**

Create `lib/setup/gitlab-token.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/dashboard.config', () => ({
  dashboardConfig: {
    agentRepos: { 'auction/api': 'auction/api@main' },
    workspaceDir: '/tmp/root',
    gitlabHost: 'https://gitlab.example.com',
  },
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  // repos.ts (imported transitively) also uses these:
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

import { existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { upsertEnv, saveGitlabToken } from '@/lib/setup/gitlab-token'

const existsMock = vi.mocked(existsSync)
const writeMock = vi.mocked(writeFileSync)
const execMock = vi.mocked(execFileSync)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
})

describe('upsertEnv', () => {
  it('appends both keys to empty content', () => {
    const out = upsertEnv('', { GITLAB_HOST: 'https://gl.x', GITLAB_TOKEN: 't' })
    expect(out).toContain('GITLAB_HOST=https://gl.x')
    expect(out).toContain('GITLAB_TOKEN=t')
  })
  it('replaces an existing key and preserves others', () => {
    const out = upsertEnv('FOO=1\nGITLAB_TOKEN=old\n', { GITLAB_TOKEN: 'new' })
    expect(out).toContain('FOO=1')
    expect(out).toContain('GITLAB_TOKEN=new')
    expect(out).not.toContain('old')
  })
})

describe('saveGitlabToken', () => {
  it('does not persist when validation fails', () => {
    execMock.mockImplementation(() => {
      throw Object.assign(new Error('ls-remote failed for secret'), { stderr: 'HTTP 401' })
    })
    const res = saveGitlabToken('https://gl.x', 'secret')
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('secret')
    expect(writeMock).not.toHaveBeenCalled()
    expect(process.env.GITLAB_TOKEN).toBeUndefined()
  })
  it('validates then persists and sets process.env', () => {
    execMock.mockReturnValue('' as never) // ls-remote succeeds
    existsMock.mockReturnValue(false) // no existing .env.local
    const res = saveGitlabToken('https://gl.x', 'secret')
    expect(res.ok).toBe(true)
    expect(writeMock).toHaveBeenCalledTimes(1)
    const written = String(writeMock.mock.calls[0][1])
    expect(written).toContain('GITLAB_HOST=https://gl.x')
    expect(written).toContain('GITLAB_TOKEN=secret')
    expect(process.env.GITLAB_TOKEN).toBe('secret')
    expect(process.env.GITLAB_HOST).toBe('https://gl.x')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/setup/gitlab-token.test.ts`
Expected: FAIL — module `@/lib/setup/gitlab-token` does not exist.

- [ ] **Step 3: Implement `lib/setup/gitlab-token.ts`**

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Result, ok, failure } from '@/lib/result'
import { buildCloneUrl, redactToken, parseAgentRepos } from '@/lib/setup/repos'

/** Upsert KEY=value lines into an .env file's content. Replaces existing keys, appends new ones, preserves the rest. */
export function upsertEnv(content: string, updates: Record<string, string>): string {
  const remaining = { ...updates }
  const lines = content.split('\n').map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/)
    if (m && m[1] in remaining) {
      const key = m[1]
      const value = remaining[key]
      delete remaining[key]
      return `${key}=${value}`
    }
    return line
  })
  let result = lines.join('\n')
  const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`)
  if (appended.length) {
    if (result.length && !result.endsWith('\n')) result += '\n'
    result += appended.join('\n') + '\n'
  }
  return result
}

/** Verify a token has read access to a repo via `git ls-remote`. Exercises the read_repository scope. */
export function validateGitlabToken(host: string, token: string, repoName: string): Result<null> {
  try {
    execFileSync('git', ['ls-remote', '--heads', buildCloneUrl(host, token, repoName)], {
      stdio: 'pipe',
      timeout: 30_000,
    })
    return ok(null)
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer | string }
    const raw = [err.message, err.stderr?.toString()].filter(Boolean).join('\n') || 'git ls-remote failed'
    return failure(redactToken(raw, token))
  }
}

/** Write GITLAB_HOST/GITLAB_TOKEN to .env.local and apply them to this process's env immediately. */
export function persistGitlabCreds(host: string, token: string): Result<null> {
  const path = join(process.cwd(), '.env.local')
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(path, upsertEnv(existing, { GITLAB_HOST: host, GITLAB_TOKEN: token }))
    process.env.GITLAB_HOST = host
    process.env.GITLAB_TOKEN = token
    return ok(null)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Failed to write .env.local')
  }
}

/** Validate a token against the first configured repo (if any), then persist it. */
export function saveGitlabToken(host: string, token: string): Result<null> {
  if (!host || !token) return failure('GitLab host and token are both required.')
  const repos = parseAgentRepos()
  if (repos.length > 0) {
    const check = validateGitlabToken(host, token, repos[0].repoName)
    if (!check.ok) return check
  }
  return persistGitlabCreds(host, token)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/setup/gitlab-token.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/setup/gitlab-token.ts lib/setup/gitlab-token.test.ts
git commit -m "feat: validate-and-persist GitLab token to .env.local"
```

---

### Task 5: GitLab token API route (loopback-only)

**Files:**
- Create: `app/api/setup/gitlab-token/route.ts`

**Interfaces:**
- Consumes: `isLoopbackHost` from `@/lib/sso-login`; `saveGitlabToken` from `@/lib/setup/gitlab-token`; `ok`, `failure` from `@/lib/result`.
- Produces: `POST /api/setup/gitlab-token` with body `{ host?: string; token: string }` → `Result<null>`; 403 off-loopback.

- [ ] **Step 1: Implement the route**

There is no route-level unit test harness in this repo (tests target `lib/**`), so this task is implementation + type-check + manual verification, consistent with the existing untested `clone/route.ts`. Create `app/api/setup/gitlab-token/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { ok, failure } from '@/lib/result'
import { isLoopbackHost } from '@/lib/sso-login'
import { saveGitlabToken } from '@/lib/setup/gitlab-token'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // Local-only: this writes a secret to .env.local, so it must never be reachable off-host.
  if (!isLoopbackHost(req.headers.get('host'))) {
    return NextResponse.json(failure('GitLab token can only be set locally.'), { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const host = typeof body?.host === 'string' ? body.host.trim() : ''
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  if (!token) return NextResponse.json(failure('A GitLab token is required.'))
  if (!host) return NextResponse.json(failure('A GitLab host is required.'))
  return NextResponse.json(saveGitlabToken(host, token))
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors from the new file.

- [ ] **Step 3: Commit**

```bash
git add app/api/setup/gitlab-token/route.ts
git commit -m "feat: loopback-only GitLab token API route"
```

---

### Task 6: Client-safe helpers (`repos-client.ts`)

**Files:**
- Create: `lib/setup/repos-client.ts`
- Test: `lib/setup/repos-client.test.ts`

**Interfaces:**
- Consumes: type-only `SetupStatus` from `@/lib/setup/repos` (erased at build — keeps this module free of `node:*` imports so it is safe in client bundles).
- Produces:
  - `reposGateState(status: SetupStatus): 'complete' | 'needs-setup'`
  - `createTokenUrl(host: string): string`

- [ ] **Step 1: Write failing tests**

Create `lib/setup/repos-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { reposGateState, createTokenUrl } from '@/lib/setup/repos-client'
import type { SetupStatus } from '@/lib/setup/repos'

function status(states: Array<'present' | 'missing' | 'present-not-git'>): SetupStatus {
  return {
    configured: true,
    root: '/r',
    host: 'https://gl.x',
    repos: states.map((state, i) => ({
      group: 'g', app: `a${i}`, repoName: `g/a${i}`, baseBranch: 'main', path: `/r/g/a${i}`, state,
    })),
  }
}

describe('reposGateState', () => {
  it('is complete when all repos are present', () => {
    expect(reposGateState(status(['present', 'present']))).toBe('complete')
  })
  it('is complete when no repos are configured', () => {
    expect(reposGateState(status([]))).toBe('complete')
  })
  it('is needs-setup when any repo is missing or not-git', () => {
    expect(reposGateState(status(['present', 'missing']))).toBe('needs-setup')
    expect(reposGateState(status(['present-not-git']))).toBe('needs-setup')
  })
})

describe('createTokenUrl', () => {
  it('builds a pre-filled PAT URL, trimming a trailing slash', () => {
    expect(createTokenUrl('https://gitlab.bastrucks.com/')).toBe(
      'https://gitlab.bastrucks.com/-/user_settings/personal_access_tokens?name=dev-dashboard&scopes=read_repository',
    )
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/setup/repos-client.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/setup/repos-client.ts`**

```ts
// Client-safe helpers for the repo-setup gate. NO `node:*` / `server-only` imports —
// these run in the browser. The SetupStatus import is type-only (erased at build).
import type { SetupStatus } from '@/lib/setup/repos'

/** Gate passes when every configured repo is present (or none are configured). */
export function reposGateState(status: SetupStatus): 'complete' | 'needs-setup' {
  return status.repos.every((r) => r.state === 'present') ? 'complete' : 'needs-setup'
}

/** Pre-filled GitLab personal-access-token creation URL (read_repository scope). */
export function createTokenUrl(host: string): string {
  const base = host.replace(/\/+$/, '')
  return `${base}/-/user_settings/personal_access_tokens?name=dev-dashboard&scopes=read_repository`
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/setup/repos-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/repos-client.ts lib/setup/repos-client.test.ts
git commit -m "feat: client-safe repos gate-state + create-token URL helpers"
```

---

### Task 7: Shared `<ReposSetup>` component (token form + per-repo clone UI)

**Files:**
- Create: `components/repos-setup.tsx`

**Interfaces:**
- Consumes: `usePoll` (`@/lib/use-poll`), `PanelShell` (`@/components/panel-shell`), `Button` (`@/components/ui/button`), `Badge` (`@/components/ui/badge`), `cn` (`@/lib/utils`), `createTokenUrl` (`@/lib/setup/repos-client`), types `SetupStatus`, `RepoState` (`@/lib/setup/repos`).
- Produces: `export function ReposSetup(): JSX.Element` — a self-contained panel used by the gate and `/setup`.

- [ ] **Step 1: Implement the component**

This is UI (no `lib/**` test harness runs on it). Create `components/repos-setup.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PanelShell } from '@/components/panel-shell'
import { cn } from '@/lib/utils'
import { createTokenUrl } from '@/lib/setup/repos-client'
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

type RowRun = { state: 'cloning' | 'done' | 'error'; message?: string }

type CloneResult =
  | { ok: true; data: { branch: string; warning?: string } }
  | { ok: false; message: string }

async function cloneOne(repoName: string, force: boolean): Promise<CloneResult> {
  try {
    const res = await fetch('/api/setup/repos/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoName, force }),
    })
    const json = await res.json()
    // Route returns ok([{ repoName, result }]); unwrap the single result.
    if (json?.ok && Array.isArray(json.data) && json.data[0]?.result) return json.data[0].result
    if (json && json.ok === false) return json // route-level unconfigured/error
    return { ok: false, message: 'Unexpected clone response.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Clone request failed.' }
  }
}

function TokenForm({ host: initialHost }: { host: string }) {
  const [host, setHost] = useState(initialHost)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/setup/gitlab-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, token }),
      })
      const json = await res.json()
      if (!json?.ok) setError(json?.message ?? 'Could not save the token.')
      else setToken('') // poll will flip `configured` to true and swap this form out
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-sm text-amber-500">
        Set a GitLab token (scope: read_repository) to clone your repositories.
      </p>
      <a
        href={createTokenUrl(host)}
        target="_blank"
        rel="noreferrer"
        className="inline-block font-mono text-sm text-primary underline hover:opacity-80"
      >
        Create a token in GitLab →
      </a>
      <p className="font-mono text-[11px] text-muted-foreground">
        On older GitLab, use <code>/-/profile/personal_access_tokens</code> instead.
      </p>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">GitLab host</span>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="font-mono text-xs text-muted-foreground">Personal access token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="glpat-…"
          className="h-9 w-full rounded-none border border-border bg-background px-2 font-mono text-sm"
        />
      </label>
      {error && <p className="font-mono text-sm text-destructive">[ FAIL ] {error}</p>}
      <Button size="sm" disabled={saving || !token} onClick={save}>
        {saving ? 'Validating…' : 'Save token'}
      </Button>
    </div>
  )
}

export function ReposSetup() {
  const { data, loading } = usePoll<SetupStatus>('/api/setup/repos', 5000)
  const [runs, setRuns] = useState<Record<string, RowRun>>({})
  const [busy, setBusy] = useState(false)

  async function run(repoName: string, force: boolean) {
    setBusy(true)
    setRuns((r) => ({ ...r, [repoName]: { state: 'cloning' } }))
    const res = await cloneOne(repoName, force)
    setRuns((r) => ({
      ...r,
      [repoName]: res.ok
        ? { state: 'done', message: res.data.warning }
        : { state: 'error', message: res.message },
    }))
    setBusy(false)
  }

  async function runAll(repoNames: string[]) {
    setBusy(true)
    for (const name of repoNames) {
      setRuns((r) => ({ ...r, [name]: { state: 'cloning' } }))
      const res = await cloneOne(name, false)
      setRuns((r) => ({
        ...r,
        [name]: res.ok
          ? { state: 'done', message: res.data.warning }
          : { state: 'error', message: res.message },
      }))
    }
    setBusy(false)
  }

  return (
    <PanelShell<SetupStatus> title="repos" result={data} loading={loading}>
      {(status) => {
        if (!status.configured) return <TokenForm host={status.host} />
        const missing = status.repos.filter((r) => r.state === 'missing')
        return (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs text-muted-foreground">root: {status.root}</p>
              {missing.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => runAll(missing.map((m) => m.repoName))}>
                  {busy ? 'Cloning…' : `Clone all missing (${missing.length})`}
                </Button>
              )}
            </div>
            <ul className="space-y-1">
              {status.repos.map((r) => {
                const runState = runs[r.repoName]
                return (
                  <li key={r.repoName} className="flex flex-col gap-0.5 font-mono text-sm">
                    <div className="flex items-center justify-between gap-3">
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
                      {r.state === 'missing' && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(r.repoName, false)}>
                          {runState?.state === 'cloning' ? 'Cloning…' : 'Clone'}
                        </Button>
                      )}
                      {r.state === 'present-not-git' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`This deletes ${r.path} and re-clones. Continue?`)) run(r.repoName, true)
                          }}
                        >
                          {runState?.state === 'cloning' ? 'Cloning…' : 'Re-clone'}
                        </Button>
                      )}
                    </div>
                    {runState?.state === 'error' && (
                      <span className="text-destructive">[ FAIL ] {runState.message}</span>
                    )}
                    {runState?.state === 'done' && runState.message && (
                      <span className="text-amber-500">⚠ {runState.message}</span>
                    )}
                  </li>
                )
              })}
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

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/repos-setup.tsx
git commit -m "feat: shared ReposSetup panel with token form + live per-repo clone"
```

---

### Task 8: `<ReposSetupGate>` blocking wrapper

**Files:**
- Create: `components/repos-setup-gate.tsx`

**Interfaces:**
- Consumes: `reposGateState` (`@/lib/setup/repos-client`), `ReposSetup` (`@/components/repos-setup`), types `Result` (`@/lib/result`), `SetupStatus` (`@/lib/setup/repos`).
- Produces: `export function ReposSetupGate({ children }: { children: React.ReactNode }): JSX.Element` and a default export.

- [ ] **Step 1: Implement the gate**

Create `components/repos-setup-gate.tsx`:

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import type { Result } from '@/lib/result'
import type { SetupStatus } from '@/lib/setup/repos'
import { reposGateState } from '@/lib/setup/repos-client'
import { ReposSetup } from '@/components/repos-setup'

const POLL_MS = 3000

export function ReposSetupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'complete' | 'needs-setup'>('checking')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const tick = async () => {
      try {
        const res = await fetch('/api/setup/repos')
        const json = (await res.json()) as Result<SetupStatus>
        if (!alive.current) return
        if (json.ok) setState(reposGateState(json.data))
      } catch {
        // transient — keep the current state and retry on the next tick
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [])

  if (state === 'complete') return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-3">
        <h1 className="font-mono text-lg text-primary">dev-dashboard — repo setup required</h1>
        {state === 'checking' ? (
          <p className="font-mono text-sm text-muted-foreground">Checking repositories…</p>
        ) : (
          <ReposSetup />
        )}
      </div>
    </div>
  )
}

export default ReposSetupGate
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/repos-setup-gate.tsx
git commit -m "feat: no-bypass ReposSetupGate blocking wrapper"
```

---

### Task 9: Wire the gate into the layout; update `/setup`; remove the banner + old panel

**Files:**
- Modify: `app/(dashboard)/layout.tsx:14-15,38-58`
- Modify: `app/(dashboard)/setup/page.tsx`
- Delete: `components/repos-banner.tsx`, `components/repos-panel.tsx`

**Interfaces:**
- Consumes: `ReposSetupGate`, `ReposSetup`.

- [ ] **Step 1: Confirm nothing else imports the files being removed**

Run: `grep -rn "repos-banner\|ReposBanner\|repos-panel\|ReposPanel" app components lib`
Expected: only `app/(dashboard)/layout.tsx` (ReposBanner) and `app/(dashboard)/setup/page.tsx` (ReposPanel). If anything else references them, update it in this task.

- [ ] **Step 2: Nest the gate inside `AwsLoginGate` and drop the banner in the layout**

In `app/(dashboard)/layout.tsx`, replace the `ReposBanner` import (line 15) with the gate import:

```tsx
import { ReposSetupGate } from "@/components/repos-setup-gate";
```

Change the body so the gate wraps the dashboard chrome and the `<ReposBanner />` line is removed:

```tsx
        <AwsLoginGate>
          <ReposSetupGate>
            <TooltipProvider>
              <SidebarProvider>
                <AppSidebar />
                <SidebarInset>
                  <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur">
                    <SidebarTrigger className="-ml-1" />
                    <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
                    <PageBreadcrumb />
                    <div className="ml-auto">
                      <CommandPalette />
                    </div>
                  </header>
                  <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
                    {children}
                  </main>
                </SidebarInset>
              </SidebarProvider>
            </TooltipProvider>
          </ReposSetupGate>
        </AwsLoginGate>
```

(The `<ReposBanner />` element that sat above `<main>` is gone.)

- [ ] **Step 3: Point the setup page at the shared component**

Replace `app/(dashboard)/setup/page.tsx`:

```tsx
import { ReposSetup } from '@/components/repos-setup'

export default function SetupPage() {
  return (
    <div className="space-y-4">
      <ReposSetup />
    </div>
  )
}
```

- [ ] **Step 4: Delete the superseded files**

```bash
git rm components/repos-banner.tsx components/repos-panel.tsx
```

- [ ] **Step 5: Type-check, lint, and run the full test suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no type errors, no lint errors, all Vitest tests pass.

- [ ] **Step 6: Manual smoke test**

Run: `npm run dev`, then in the browser:
1. With `GITLAB_TOKEN` unset in `.env.local`: after the AWS gate, the repo-setup gate blocks with the token form. The "Create a token in GitLab →" link points at `https://gitlab.bastrucks.com/-/user_settings/personal_access_tokens?name=dev-dashboard&scopes=read_repository`.
2. Paste an invalid token → "Save token" shows a redacted validation error; `.env.local` is unchanged.
3. Paste a valid token → form validates, `.env.local` gains `GITLAB_HOST`/`GITLAB_TOKEN`, gate swaps to clone controls (no restart).
4. Clone a missing repo → row shows `Cloning… → ✓`; a repo with a bad base branch shows a `⚠` warning; once all repos are `present`, the gate reveals the dashboard.

- [ ] **Step 7: Commit**

```bash
git add "app/(dashboard)/layout.tsx" "app/(dashboard)/setup/page.tsx"
git commit -m "feat: enforce repo setup via gate; retire repos banner/panel"
```

---

## Self-Review Notes

- **Spec coverage:** cloning fixes (Tasks 2–3, 7), hard gate (Tasks 6, 8, 9), token entry (Tasks 4, 5, 7), config default + status host (Task 1), banner removal (Task 9). All spec sections mapped.
- **Type consistency:** `cloneRepo(entry, opts)` returns `{ repoName; branch; warning? }` (Tasks 2–3), unwrapped by `cloneOne`'s `CloneResult` (Task 7). `SetupStatus.host` added in Task 1 and consumed in Tasks 6–8. `reposGateState`/`createTokenUrl` signatures match across Tasks 6, 7, 8.
- **No placeholders:** every code step shows full code; commands include expected output.
