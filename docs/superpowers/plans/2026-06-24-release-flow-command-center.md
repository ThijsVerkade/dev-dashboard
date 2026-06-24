# Release Flow command center — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive Jira tickets through their lifecycle automatically as agents work (In Progress → Code Review → Acceptatie), and surface all agent activity on the Release Flow screen via a right-side drawer, per-ticket indicators, and Sonner toasts.

**Architecture:** Phase A adds a best-effort Jira transition primitive and wires it into three existing server paths (agent start, runner job-exit, board merge), recording async outcomes on job meta. Phase B consumes those signals on the client: a shared agents component set, a Sheet-based drawer mounted in `BoardPanel`, per-row badges, and toasts derived by diffing the existing 3s job poll plus action responses.

**Tech Stack:** Next.js (App Router, breaking-change fork — read `node_modules/next/dist/docs/` before route work), TypeScript, Vitest, shadcn/ui (`Sheet`, `Button`, `Badge`), `sonner`, GitLab via `@gitbeaker/rest`, Jira REST v3.

## Global Constraints

- All network calls return the `Result<T>` type from `lib/result.ts` (`ok` / `failure` / `unconfigured`). Never throw across a module boundary.
- Jira/GitLab modules are `server-only`; never import them into client components.
- Jira transitions are **best-effort, non-blocking** — a failed transition never fails the start/merge action (mirrors existing `void setIssueApps(...)`).
- 403 responses append the hint `" (token lacks Jira write permission)"`, matching `assignIssue`/`addComment`.
- Status names are env-overridable with defaults `In Progress` / `Code Review` / `Acceptatie`; an empty configured name skips that transition.
- Pure helpers are unit-tested in a sibling `*.test.ts` (existing convention); Vitest run via `npx vitest run <path>`.
- Tests-first (TDD), commit after each green task.

---

# Phase A — Jira status transitions (backend)

### Task A1: Transition primitive + config

**Files:**
- Modify: `dashboard.config.ts` (add three status fields to the `dashboardConfig` object, ~line 90)
- Modify: `lib/sources/jira.ts` (add `findTransitionId` pure helper + `transitionIssueTo`)
- Test: `lib/sources/jira.test.ts` (add `findTransitionId` cases)

**Interfaces:**
- Produces:
  - `findTransitionId(transitions: Array<{ id: string; to?: { name?: string } }>, targetStatusName: string): string | null`
  - `transitionIssueTo(key: string, targetStatusName: string): Promise<Result<{ key: string; moved: boolean }>>`
  - `dashboardConfig.jiraInProgressStatus`, `.jiraCodeReviewStatus`, `.jiraAcceptanceStatus` (all `string`)

- [ ] **Step 1: Write the failing test** — append to `lib/sources/jira.test.ts`:

```ts
import { findTransitionId } from './jira'

describe('findTransitionId', () => {
  const transitions = [
    { id: '11', to: { name: 'In Progress' } },
    { id: '21', to: { name: 'Code Review' } },
    { id: '31', to: { name: 'Acceptatie' } },
  ]
  it('matches target status by to.name, case-insensitively', () => {
    expect(findTransitionId(transitions, 'code review')).toBe('21')
    expect(findTransitionId(transitions, 'Acceptatie')).toBe('31')
  })
  it('returns null when no transition leads to the target', () => {
    expect(findTransitionId(transitions, 'Done')).toBeNull()
  })
  it('returns null for an empty target', () => {
    expect(findTransitionId(transitions, '   ')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/sources/jira.test.ts -t findTransitionId`
Expected: FAIL — `findTransitionId` is not exported.

- [ ] **Step 3: Add config fields** — in `dashboard.config.ts`, inside the `dashboardConfig` object (after `acceptanceCriteriaField`, before the closing `}`):

```ts
  // Jira workflow status names the agent moves tickets to. Empty => skip that transition.
  jiraInProgressStatus: process.env.JIRA_IN_PROGRESS_STATUS ?? 'In Progress',
  jiraCodeReviewStatus: process.env.JIRA_CODE_REVIEW_STATUS ?? 'Code Review',
  jiraAcceptanceStatus: process.env.JIRA_ACCEPTANCE_STATUS ?? 'Acceptatie',
```

- [ ] **Step 4: Implement the helper + primitive** — append to `lib/sources/jira.ts`:

```ts
/** Find the transition id whose target status (`to.name`) matches, case-insensitively. */
export function findTransitionId(
  transitions: Array<{ id: string; to?: { name?: string } }>,
  targetStatusName: string,
): string | null {
  const target = targetStatusName.trim().toLowerCase()
  if (!target) return null
  const hit = transitions.find((t) => (t.to?.name ?? '').trim().toLowerCase() === target)
  return hit ? hit.id : null
}

/**
 * Best-effort transition of an issue to a named target status. Looks up the issue's
 * available transitions and posts the matching one. If none matches but the issue is
 * already at the target, reports a no-op success; otherwise a failure. Empty target => no-op.
 */
export async function transitionIssueTo(
  key: string,
  targetStatusName: string,
): Promise<Result<{ key: string; moved: boolean }>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  if (!targetStatusName.trim()) return ok({ key, moved: false })
  try {
    const tRes = await fetch(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json' },
    })
    if (!tRes.ok) {
      const detail = (await tRes.text()).slice(0, 200)
      const hint = tRes.status === 403 ? ' (token lacks Jira write permission)' : ''
      return failure(`Jira ${tRes.status}${hint}: ${detail}`)
    }
    const transitions = ((await tRes.json())?.transitions ?? []) as Array<{ id: string; to?: { name?: string } }>
    const id = findTransitionId(transitions, targetStatusName)
    if (!id) {
      const statusRes = await fetch(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`, {
        headers: { Authorization: basicAuth(cfg), Accept: 'application/json' },
      })
      const current = statusRes.ok ? ((await statusRes.json())?.fields?.status?.name ?? '') : ''
      if (current.trim().toLowerCase() === targetStatusName.trim().toLowerCase()) return ok({ key, moved: false })
      return failure(`no transition to '${targetStatusName}' from '${current || 'unknown'}'`)
    }
    const postRes = await fetch(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id } }),
    })
    if (!postRes.ok) {
      const detail = (await postRes.text()).slice(0, 200)
      const hint = postRes.status === 403 ? ' (token lacks Jira write permission)' : ''
      return failure(`Jira ${postRes.status}${hint}: ${detail}`)
    }
    return ok({ key, moved: true })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/sources/jira.test.ts -t findTransitionId`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add dashboard.config.ts lib/sources/jira.ts lib/sources/jira.test.ts
git commit -m "feat: jira transitionIssueTo primitive + workflow status config"
```

---

### Task A2: Branch→key + all-merged pure helpers

**Files:**
- Modify: `lib/sources/board.ts` (add `keyFromBranch`, `allMergedForKey`, `allMrsAcrossProjects`)
- Test: `lib/sources/board.test.ts` (add cases for the two pure helpers)

**Interfaces:**
- Consumes: `MergeRequest` from `./gitlab` (already imported in `board.ts`); `getDiscoveredProjects`, `getMergeRequests` (already imported).
- Produces:
  - `keyFromBranch(branch: string): string | null`
  - `allMergedForKey(key: string, mrs: MergeRequest[], justMerged?: { project: string; iid: number }): boolean`
  - `allMrsAcrossProjects(): Promise<MergeRequest[]>`

- [ ] **Step 1: Write the failing test** — append to `lib/sources/board.test.ts`:

```ts
import { keyFromBranch, allMergedForKey } from './board'
import type { MergeRequest } from './gitlab'

const mr = (over: Partial<MergeRequest>): MergeRequest => ({
  iid: 1, title: '', webUrl: '', draft: false, sourceBranch: '', state: 'opened',
  sha: '', mergeable: false, project: 'g/p', ...over,
})

describe('keyFromBranch', () => {
  it('extracts the Jira key from a feature branch', () => {
    expect(keyFromBranch('feat/NBDE-817-add-thing')).toBe('NBDE-817')
  })
  it('is case-insensitive on input but returns upper-case', () => {
    expect(keyFromBranch('feat/nbde-9-x')).toBe('NBDE-9')
  })
  it('returns null when no key is present', () => {
    expect(keyFromBranch('hotfix/no-key-here')).toBeNull()
  })
})

describe('allMergedForKey', () => {
  it('false when the key has no MRs', () => {
    expect(allMergedForKey('NBDE-1', [mr({ sourceBranch: 'feat/OTHER-2' })])).toBe(false)
  })
  it('false when some of the key\'s MRs are still open', () => {
    const mrs = [
      mr({ iid: 1, project: 'g/a', sourceBranch: 'feat/NBDE-1-a', state: 'merged' }),
      mr({ iid: 2, project: 'g/b', sourceBranch: 'feat/NBDE-1-b', state: 'opened' }),
    ]
    expect(allMergedForKey('NBDE-1', mrs)).toBe(false)
  })
  it('treats the just-merged MR (by project+iid) as merged', () => {
    const mrs = [
      mr({ iid: 1, project: 'g/a', sourceBranch: 'feat/NBDE-1-a', state: 'merged' }),
      mr({ iid: 2, project: 'g/b', sourceBranch: 'feat/NBDE-1-b', state: 'opened' }),
    ]
    expect(allMergedForKey('NBDE-1', mrs, { project: 'g/b', iid: 2 })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/sources/board.test.ts -t keyFromBranch`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement** — append to `lib/sources/board.ts`:

```ts
/** Extract the Jira key (e.g. NBDE-817) from a source branch, upper-cased, or null. */
export function keyFromBranch(branch: string): string | null {
  const m = branch.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/)
  return m ? m[0] : null
}

/**
 * True when every MR whose source branch references `key` is merged. `justMerged`
 * (project+iid) is counted as merged even if a fresh fetch still shows it open
 * (GitLab merge can lag). False when the key has no MRs at all.
 */
export function allMergedForKey(
  key: string,
  mrs: MergeRequest[],
  justMerged?: { project: string; iid: number },
): boolean {
  const k = key.toUpperCase()
  const forKey = mrs.filter((m) => m.sourceBranch.toUpperCase().includes(k))
  if (forKey.length === 0) return false
  return forKey.every(
    (m) => m.state === 'merged' || (!!justMerged && m.project === justMerged.project && m.iid === justMerged.iid),
  )
}

/** Flatten the open+merged MRs of every discovered project into one list (best-effort). */
export async function allMrsAcrossProjects(): Promise<MergeRequest[]> {
  const projectsRes = await getDiscoveredProjects()
  if (!projectsRes.ok) return []
  const lists = await Promise.all(
    projectsRes.data.map(async (p) => {
      const r = await getMergeRequests(p)
      return r.ok ? r.data : []
    }),
  )
  return lists.flat()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/sources/board.test.ts -t keyFromBranch && npx vitest run lib/sources/board.test.ts -t allMergedForKey`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/board.ts lib/sources/board.test.ts
git commit -m "feat: keyFromBranch + allMergedForKey + allMrsAcrossProjects helpers"
```

---

### Task A3: → In Progress on agent start

**Files:**
- Modify: `app/api/agent/start/route.ts` (transition after dispatch; include outcome in response)

**Interfaces:**
- Consumes: `transitionIssueTo` (A1), `dashboardConfig.jiraInProgressStatus` (A1).
- Produces: response `data.jira?: { moved: boolean; status?: string; error?: string }` on the implement path.

- [ ] **Step 1: Add imports** — in `app/api/agent/start/route.ts`, extend the existing imports:

```ts
import { setIssueApps, transitionIssueTo } from '@/lib/sources/jira'
import { agentGroups, reposForGroup, dashboardConfig } from '@/dashboard.config'
```

- [ ] **Step 2: Transition after a successful implement dispatch** — replace the tail of the function (from `if (!ids.length)` onward) with:

```ts
  if (!ids.length) return NextResponse.json(failure(errors.join(' | ') || 'No jobs started'))

  // Best-effort: move the ticket to In Progress once at least one implement job is up.
  const moveRes = await transitionIssueTo(trimmedKey, dashboardConfig.jiraInProgressStatus)
  const jira = moveRes.ok
    ? { moved: moveRes.data.moved, status: dashboardConfig.jiraInProgressStatus }
    : { moved: false, error: moveRes.message }

  return NextResponse.json(ok({ ids, ...(errors.length ? { errors } : {}), jira }))
```

- [ ] **Step 3: Manual verification** — there is no automated test for routes in this repo; verify the wiring compiles and the shape is right:

Run: `npx tsc --noEmit`
Expected: no errors. Confirm by reading the diff that `jira` is only built on the implement path (the acceptance branch already `return`s earlier at the top of the function).

- [ ] **Step 4: Commit**

```bash
git add app/api/agent/start/route.ts
git commit -m "feat: move ticket to In Progress on agent dispatch"
```

---

### Task A4: → Code Review when all of a ticket's jobs finish

**Files:**
- Modify: `lib/agent/runner.ts` (add `jiraMoved`/`jiraMoveError`/`mrUrl` to `JobMeta`; record MR url + transition in the implement exit handler; add `maybeMoveToCodeReview`)

**Interfaces:**
- Consumes: `transitionIssueTo` (A1), `dashboardConfig.jiraCodeReviewStatus` (A1), existing `listJobs`, `readMeta`, `writeMeta`, `readTail`, `logPath`, `TAIL_BYTES`.
- Produces: `JobMeta.jiraMoved?: string`, `JobMeta.jiraMoveError?: string`, `JobMeta.mrUrl?: string`.

- [ ] **Step 1: Extend `JobMeta`** — in `lib/agent/runner.ts`, add three optional fields to the `JobMeta` type (after `pid: number`):

```ts
  /** MR url scraped from the log once the implement agent opens it. */
  mrUrl?: string
  /** Jira status this job's completion moved the ticket to (Code Review), if it did. */
  jiraMoved?: string
  /** Error message if the post-completion Jira transition failed. */
  jiraMoveError?: string
```

- [ ] **Step 2: Add the import** — extend the jira import at the top of `runner.ts`:

```ts
import { getIssueDetail, getAcceptanceDetail, addComment, transitionIssueTo } from '@/lib/sources/jira'
```

- [ ] **Step 3: Replace the implement exit handler** — in `startJob`, replace the existing `child.on('exit', ...)` block (the one setting `done`/`failed`) with:

```ts
    child.on('exit', (code) => {
      const m = readMeta(id)
      if (!m) return
      m.status = code === 0 ? 'done' : 'failed'
      if (code === 0) {
        let log = ''
        try { log = readTail(logPath(id), TAIL_BYTES) } catch { /* no log */ }
        const mr = log.match(/https?:\/\/\S*?merge_requests\/\d+/)
        if (mr) m.mrUrl = mr[0]
      }
      writeMeta(m)
      if (code === 0) void maybeMoveToCodeReview(m.key)
    })
```

- [ ] **Step 4: Add `maybeMoveToCodeReview`** — add near the other module-level helpers in `runner.ts` (e.g. after `finish`):

```ts
/**
 * Move a ticket to Code Review once no implement job for it is still running.
 * Best-effort; records the outcome on the ticket's most recent implement job so the
 * dashboard can surface it via the jobs poll.
 */
async function maybeMoveToCodeReview(key: string): Promise<void> {
  const target = dashboardConfig.jiraCodeReviewStatus
  if (!target) return
  const stillRunning = listJobs().some(
    (j) => j.key === key && j.profile === 'implement' && j.status === 'running',
  )
  if (stillRunning) return
  const res = await transitionIssueTo(key, target)
  const job = listJobs().find((j) => j.key === key && j.profile === 'implement')
  if (!job) return
  const meta = readMeta(job.id)
  if (!meta) return
  if (res.ok && res.data.moved) meta.jiraMoved = target
  else if (!res.ok) meta.jiraMoveError = res.message
  writeMeta(meta)
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/runner.ts
git commit -m "feat: move ticket to Code Review when its agents finish; record MR url"
```

---

### Task A5: → Acceptatie when all of a ticket's MRs are merged

**Files:**
- Modify: `app/api/board/merge/route.ts` (after merge, transition when all MRs for the key are merged; return outcome)

**Interfaces:**
- Consumes: `mergeMr` (existing), `keyFromBranch` + `allMergedForKey` + `allMrsAcrossProjects` (A2), `transitionIssueTo` + `dashboardConfig.jiraAcceptanceStatus` (A1).
- Produces: response `data: { merged: true; jira?: { moved: boolean; status?: string; error?: string } }`.

- [ ] **Step 1: Add imports** — at the top of `app/api/board/merge/route.ts`:

```ts
import { getMergeRequests, getMrApprovals, getPipelines, mergeMr } from '@/lib/sources/gitlab'
import { computeReadyToMerge, pipelineForSha, keyFromBranch, allMergedForKey, allMrsAcrossProjects } from '@/lib/sources/board'
import { transitionIssueTo } from '@/lib/sources/jira'
import { dashboardConfig } from '@/dashboard.config'
import { ok, failure } from '@/lib/result'
```

- [ ] **Step 2: Replace the merge tail** — replace the final `return NextResponse.json(await mergeMr(project, iid))` with:

```ts
  const merged = await mergeMr(project, iid)
  if (!merged.ok) return NextResponse.json(merged)

  // Best-effort: once every MR for this ticket is merged, move it to Acceptatie.
  let jira: { moved: boolean; status?: string; error?: string } | undefined
  const key = keyFromBranch(mr.sourceBranch)
  if (key) {
    const allMrs = await allMrsAcrossProjects()
    if (allMergedForKey(key, allMrs, { project, iid })) {
      const moveRes = await transitionIssueTo(key, dashboardConfig.jiraAcceptanceStatus)
      jira = moveRes.ok
        ? { moved: moveRes.data.moved, status: dashboardConfig.jiraAcceptanceStatus }
        : { moved: false, error: moveRes.message }
    }
  }

  return NextResponse.json(ok({ merged: true, ...(jira ? { jira } : {}) }))
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (Note: the board client's `post()` only checks `json.ok`, so the richer success payload is backward-compatible.)

- [ ] **Step 4: Commit**

```bash
git add app/api/board/merge/route.ts
git commit -m "feat: move ticket to Acceptatie when all its MRs are merged"
```

---

# Phase B — Agents in the Release Flow (frontend)

### Task B1: Install Sonner + mount Toaster

**Files:**
- Modify: `package.json` (add `sonner`)
- Modify: `app/(dashboard)/layout.tsx` (mount `<Toaster>`)

**Interfaces:**
- Produces: a globally-mounted `<Toaster>` so any client component can call `toast(...)`.

- [ ] **Step 1: Install**

Run: `npm install sonner`
Expected: `sonner` appears in `package.json` dependencies.

- [ ] **Step 2: Mount the Toaster** — in `app/(dashboard)/layout.tsx`, add the import and render it inside `<body>` (after the `</SidebarProvider>`-wrapping `TooltipProvider`, before `</body>`):

```tsx
import { Toaster } from 'sonner'
```

Place just before the closing `</body>`:

```tsx
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json app/\(dashboard\)/layout.tsx
git commit -m "chore: add sonner and mount Toaster in dashboard layout"
```

---

### Task B2: `deriveJobEvents` pure util

**Files:**
- Create: `lib/agent/job-events.ts`
- Test: `lib/agent/job-events.test.ts`

**Interfaces:**
- Consumes: `JobMeta` from `@/lib/agent/runner` (type-only import).
- Produces:
  - `type JobEvent` (discriminated union, see below)
  - `deriveJobEvents(prev: Map<string, JobMeta>, next: JobMeta[]): JobEvent[]`
  - `indexJobs(list: JobMeta[]): Map<string, JobMeta>`

- [ ] **Step 1: Write the failing test** — `lib/agent/job-events.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveJobEvents, indexJobs } from './job-events'
import type { JobMeta } from './runner'

const job = (over: Partial<JobMeta>): JobMeta => ({
  id: 'NBDE-1-1', key: 'NBDE-1', repo: 'g/a', branch: 'feat/NBDE-1', baseBranch: 'main',
  profile: 'implement', status: 'running', startedAt: '2026-06-24T10:00:00Z', pid: 1, ...over,
})

describe('deriveJobEvents', () => {
  it('emits nothing for a newly-observed job (no prior state)', () => {
    expect(deriveJobEvents(new Map(), [job({})])).toEqual([])
  })
  it('emits done when a running job becomes done', () => {
    const prev = indexJobs([job({ status: 'running' })])
    const evs = deriveJobEvents(prev, [job({ status: 'done' })])
    expect(evs).toEqual([{ type: 'done', id: 'NBDE-1-1', key: 'NBDE-1', repo: 'g/a' }])
  })
  it('emits failed with reason', () => {
    const prev = indexJobs([job({ status: 'running' })])
    const evs = deriveJobEvents(prev, [job({ status: 'failed', reason: 'boom' })])
    expect(evs).toEqual([{ type: 'failed', id: 'NBDE-1-1', key: 'NBDE-1', repo: 'g/a', reason: 'boom' }])
  })
  it('emits blocked with reason', () => {
    const prev = indexJobs([job({ status: 'running' })])
    const evs = deriveJobEvents(prev, [job({ status: 'blocked', reason: 'no staging' })])
    expect(evs).toEqual([{ type: 'blocked', id: 'NBDE-1-1', key: 'NBDE-1', repo: 'g/a', reason: 'no staging' }])
  })
  it('emits mr-opened when mrUrl first appears', () => {
    const prev = indexJobs([job({ status: 'running' })])
    const evs = deriveJobEvents(prev, [job({ status: 'running', mrUrl: 'https://gl/x/merge_requests/3' })])
    expect(evs).toEqual([{ type: 'mr-opened', id: 'NBDE-1-1', key: 'NBDE-1', url: 'https://gl/x/merge_requests/3' }])
  })
  it('emits jira-moved when jiraMoved first appears', () => {
    const prev = indexJobs([job({ status: 'done' })])
    const evs = deriveJobEvents(prev, [job({ status: 'done', jiraMoved: 'Code Review' })])
    expect(evs).toEqual([{ type: 'jira-moved', id: 'NBDE-1-1', key: 'NBDE-1', status: 'Code Review' }])
  })
  it('emits jira-error when jiraMoveError first appears', () => {
    const prev = indexJobs([job({ status: 'done' })])
    const evs = deriveJobEvents(prev, [job({ status: 'done', jiraMoveError: 'no path' })])
    expect(evs).toEqual([{ type: 'jira-error', id: 'NBDE-1-1', key: 'NBDE-1', error: 'no path' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent/job-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/agent/job-events.ts`:

```ts
import type { JobMeta } from './runner'

export type JobEvent =
  | { type: 'done'; id: string; key: string; repo: string }
  | { type: 'failed'; id: string; key: string; repo: string; reason?: string }
  | { type: 'blocked'; id: string; key: string; repo: string; reason?: string }
  | { type: 'mr-opened'; id: string; key: string; url: string }
  | { type: 'jira-moved'; id: string; key: string; status: string }
  | { type: 'jira-error'; id: string; key: string; error: string }

/** Index a job list by id for cheap diffing between polls. */
export function indexJobs(list: JobMeta[]): Map<string, JobMeta> {
  return new Map(list.map((j) => [j.id, j]))
}

/**
 * Diff the previous job map against the next list, emitting one event per meaningful
 * change. Jobs not present in `prev` produce no events (avoids toasting on first load).
 */
export function deriveJobEvents(prev: Map<string, JobMeta>, next: JobMeta[]): JobEvent[] {
  const events: JobEvent[] = []
  for (const job of next) {
    const before = prev.get(job.id)
    if (!before) continue
    if (before.status !== job.status) {
      if (job.status === 'done') events.push({ type: 'done', id: job.id, key: job.key, repo: job.repo })
      else if (job.status === 'failed')
        events.push({ type: 'failed', id: job.id, key: job.key, repo: job.repo, reason: job.reason })
      else if (job.status === 'blocked')
        events.push({ type: 'blocked', id: job.id, key: job.key, repo: job.repo, reason: job.reason })
    }
    if (!before.mrUrl && job.mrUrl) events.push({ type: 'mr-opened', id: job.id, key: job.key, url: job.mrUrl })
    if (!before.jiraMoved && job.jiraMoved)
      events.push({ type: 'jira-moved', id: job.id, key: job.key, status: job.jiraMoved })
    if (!before.jiraMoveError && job.jiraMoveError)
      events.push({ type: 'jira-error', id: job.id, key: job.key, error: job.jiraMoveError })
  }
  return events
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent/job-events.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/job-events.ts lib/agent/job-events.test.ts
git commit -m "feat: deriveJobEvents pure util for agent toast diffing"
```

---

### Task B3: Extract shared agent components from AgentsPanel

**Files:**
- Create: `components/agents/job-view.tsx` (move `JobView` + its `StatusPill`, `elapsed`, `timeOf`, `postJson`, `KIND_CLASS`, `STATUS_CLASS` helpers)
- Create: `components/agents/dispatch-form.tsx` (move the "Send Ticket to Claude" card body into a reusable `DispatchForm`)
- Modify: `components/agents-panel.tsx` (import the extracted pieces; keep the page working)

**Interfaces:**
- Produces:
  - `components/agents/job-view.tsx`: `export function JobView({ id, token, onSelect }: { id: string; token: string | null; onSelect: (id: string) => void })`; also `export function StatusPill({ status }: { status: JobMeta['status'] })`.
  - `components/agents/dispatch-form.tsx`: `export function DispatchForm({ onDispatched }: { onDispatched?: (ids: string[]) => void })`.

- [ ] **Step 1: Create `components/agents/job-view.tsx`** — move the `STATUS_CLASS`, `elapsed`, `postJson`, `StatusPill`, `timeOf`, `KIND_CLASS`, and `JobView` definitions verbatim out of `components/agents-panel.tsx` into this new file. Add `'use client'` at the top and the imports they need:

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { JobMeta, JobDetail } from '@/lib/agent/runner'
import { AGENT_PROFILES } from '@/lib/agent/profiles'
import { buildTriggerHeaders } from '@/lib/agent-token-client'
```

Export both `StatusPill` and `JobView` (add `export` to each). Keep their bodies exactly as they are in `agents-panel.tsx` today.

- [ ] **Step 2: Create `components/agents/dispatch-form.tsx`** — extract the group `<select>` + key `<Input>` + send button + PIN row from `AgentsPanel` into a standalone client component:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buildTriggerHeaders, loadAgentToken, saveAgentToken, clearAgentToken } from '@/lib/agent-token-client'

export function DispatchForm({ onDispatched }: { onDispatched?: (ids: string[]) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [groups, setGroups] = useState<string[]>([])
  const [group, setGroup] = useState('')
  useEffect(() => { setToken(loadAgentToken()) }, [])
  useEffect(() => {
    fetch('/api/agent/groups').then((r) => r.json()).then((j) => {
      if (j.ok) { setGroups(j.data.groups); setGroup(j.data.groups[0] ?? '') }
    }).catch(() => {})
  }, [])

  async function send() {
    const k = key.trim()
    if (!k || busy || !group) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST', headers: buildTriggerHeaders(token),
        body: JSON.stringify({ key: k, group }),
      })
      const json = await res.json()
      if (json.ok) { setMsg(`Dispatched ${k}`); setKey(''); onDispatched?.(json.data.ids ?? []) }
      else setMsg(json.message ?? 'Failed to start')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Request failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Target group"
          className="rounded-none border border-input bg-transparent px-2 font-mono text-sm">
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <Input value={key} onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Jira ticket key, e.g. NBDE-817" className="rounded-none font-mono text-sm" />
        <Button onClick={send} disabled={busy || !group} className="rounded-none font-mono">
          {busy ? 'Sending…' : 'Send to Claude'}
        </Button>
      </div>
      {msg && <p className="font-mono text-xs text-muted-foreground">{msg}</p>}
      {token ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          PIN set ·{' '}
          <button type="button" onClick={() => { clearAgentToken(); setToken(null) }}
            className="text-primary underline underline-offset-2">forget</button>
        </p>
      ) : (
        <Input type="password" placeholder="Trigger PIN (only if AGENT_TRIGGER_TOKEN is set)"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const v = (e.target as HTMLInputElement).value.trim()
            if (v) { saveAgentToken(v); setToken(v) }
          }} className="rounded-none font-mono text-xs" />
      )}
      <p className="font-mono text-[11px] text-amber-500">
        ⚠ Runs an autonomous agent with bypassed permissions; pushes a branch and opens an MR.
      </p>
    </div>
  )
}
```

- [ ] **Step 3: Rewire `components/agents-panel.tsx`** — delete the now-extracted definitions (`STATUS_CLASS`, `elapsed`, `postJson`, `StatusPill`, `timeOf`, `KIND_CLASS`, `JobView`) and the inline dispatch markup; import the shared pieces instead:

```tsx
import { JobView, StatusPill } from '@/components/agents/job-view'
import { DispatchForm } from '@/components/agents/dispatch-form'
```

Replace the first `Card` body (the "Send Ticket to Claude" form) with `<DispatchForm onDispatched={(ids) => setSelected(ids[0] ?? null)} />`, and keep the `MobileQrDialog` in that card header. Keep the "Agent Jobs" list and `{selected && <JobView .../>}` as-is. The remaining unused imports in `agents-panel.tsx` (e.g. `Input`, token helpers, `MobileQrDialog` if still used) should be pruned to whatever the trimmed file actually references.

- [ ] **Step 4: Verify the page still builds and renders**

Run: `npx tsc --noEmit`
Expected: no errors. Then `npm run dev` and load `/agents`: the dispatch form, job list, and live job view still work.

- [ ] **Step 5: Commit**

```bash
git add components/agents/job-view.tsx components/agents/dispatch-form.tsx components/agents-panel.tsx
git commit -m "refactor: extract JobView + DispatchForm into shared components/agents"
```

---

### Task B4: Agents drawer + header button on the board

**Files:**
- Create: `components/agents/agents-drawer.tsx`
- Modify: `components/board-panel.tsx` (mount the drawer; add the header button; lift `focusKey`/`open` state)

**Interfaces:**
- Consumes: `JobView`, `StatusPill` (B3), `DispatchForm` (B3), `usePoll`, `JobMeta`, shadcn `Sheet`.
- Produces: `export function AgentsDrawer({ open, onOpenChange, focusKey, jobs }: { open: boolean; onOpenChange: (o: boolean) => void; focusKey: string | null; jobs: JobMeta[] })`.

- [ ] **Step 1: Create the drawer** — `components/agents/agents-drawer.tsx`:

```tsx
'use client'
import { useState, useEffect } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { JobView, StatusPill } from '@/components/agents/job-view'
import { DispatchForm } from '@/components/agents/dispatch-form'
import { loadAgentToken } from '@/lib/agent-token-client'
import { cn } from '@/lib/utils'
import type { JobMeta } from '@/lib/agent/runner'

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

export function AgentsDrawer({
  open, onOpenChange, focusKey, jobs,
}: { open: boolean; onOpenChange: (o: boolean) => void; focusKey: string | null; jobs: JobMeta[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  useEffect(() => { setToken(loadAgentToken()) }, [])

  // When opened focused on a ticket, default selection to that ticket's newest job.
  useEffect(() => {
    if (!open) return
    if (focusKey) {
      const first = jobs.find((j) => j.key === focusKey)
      setSelected(first ? first.id : null)
    }
  }, [open, focusKey, jobs])

  const list = focusKey ? jobs.filter((j) => j.key === focusKey) : jobs

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[34rem] max-w-[95vw] flex-col gap-0 overflow-y-auto p-0">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="font-mono text-sm">
            <span className="text-muted-foreground">$ </span>
            {focusKey ? `Agents · ${focusKey}` : 'Agents'}
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-4 p-4">
          <DispatchForm onDispatched={(ids) => setSelected(ids[0] ?? null)} />
          <div className="space-y-1">
            {list.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">no jobs{focusKey ? ' for this ticket' : ' yet'}</p>
            ) : (
              list.map((j) => (
                <button key={j.id} onClick={() => setSelected(j.id)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-x-3 gap-y-1 border border-transparent px-2 py-1.5 text-left font-mono text-xs hover:border-border hover:bg-muted/40',
                    selected === j.id && 'border-border bg-muted/40',
                  )}>
                  <span className="font-semibold text-foreground">{j.key}</span>
                  <span className="rounded-none border border-border px-1 text-[10px] uppercase text-muted-foreground">{j.profile}</span>
                  <span className="text-muted-foreground">{j.repo}</span>
                  <span className="ml-auto text-muted-foreground/60">{timeOf(j.startedAt)}</span>
                  <StatusPill status={j.status} />
                </button>
              ))
            )}
          </div>
          {selected && <JobView id={selected} token={token} onSelect={setSelected} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 2: Poll jobs + mount the drawer in `BoardPanel`** — in `components/board-panel.tsx`, add imports:

```tsx
import { AgentsDrawer } from '@/components/agents/agents-drawer'
import type { JobMeta } from '@/lib/agent/runner'
```

(The `Bot` icon is already imported in `board-panel.tsx`.) Inside `BoardPanel`, after the existing `usePoll<Board>` line, add:

```tsx
  const jobsPoll = usePoll<JobMeta[]>('/api/agent/jobs', 3000)
  const jobs = jobsPoll.data?.ok ? jobsPoll.data.data : []
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const activeCount = jobs.filter((j) => j.status === 'running').length
```

- [ ] **Step 3: Add the header button** — in the assignee-filter row (the `<div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">`), append at the end, before its closing `</div>`:

```tsx
              <Button variant="outline" size="sm" className="ml-auto h-7 font-mono text-xs"
                onClick={() => { setFocusKey(null); setDrawerOpen(true) }}>
                <Bot className="size-3.5" /> Agents{activeCount ? ` (${activeCount} active)` : ''}
              </Button>
```

- [ ] **Step 4: Render the drawer** — just before the closing `</div>` that wraps the panel body (next to `<TicketDetail .../>`), add:

```tsx
            <AgentsDrawer open={drawerOpen} onOpenChange={setDrawerOpen} focusKey={focusKey} jobs={jobs} />
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. `npm run dev`, open the board: the "Agents" button opens a right drawer listing jobs; the dispatch form and live view work inside it.

- [ ] **Step 6: Commit**

```bash
git add components/agents/agents-drawer.tsx components/board-panel.tsx
git commit -m "feat: agents drawer + header button on Release Flow"
```

---

### Task B5: Per-ticket agent indicator badge

**Files:**
- Create: `components/agents/agent-row-badge.tsx`
- Modify: `components/board-panel.tsx` (render the badge on each row; open the drawer focused)

**Interfaces:**
- Consumes: `JobMeta`.
- Produces: `export function AgentRowBadge({ jobs, onClick }: { jobs: JobMeta[]; onClick: () => void })` — renders nothing when `jobs` is empty.

- [ ] **Step 1: Create the badge** — `components/agents/agent-row-badge.tsx`:

```tsx
'use client'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JobMeta } from '@/lib/agent/runner'

/** Worst-of status ordering for the dot color (running pulses). */
function tone(jobs: JobMeta[]): string {
  if (jobs.some((j) => j.status === 'running')) return 'text-primary animate-pulse'
  if (jobs.some((j) => j.status === 'failed')) return 'text-destructive'
  if (jobs.some((j) => j.status === 'blocked')) return 'text-amber-500'
  return 'text-muted-foreground'
}

export function AgentRowBadge({ jobs, onClick }: { jobs: JobMeta[]; onClick: () => void }) {
  if (jobs.length === 0) return null
  return (
    <button type="button" onClick={onClick}
      title={`${jobs.length} agent job${jobs.length === 1 ? '' : 's'} for this ticket`}
      className={cn('flex items-center gap-0.5 font-mono text-[10px]', tone(jobs))}>
      <Bot className="size-3" />
      {jobs.length}
    </button>
  )
}
```

- [ ] **Step 2: Group jobs by key + render the badge** — in `components/board-panel.tsx`, add the import:

```tsx
import { AgentRowBadge } from '@/components/agents/agent-row-badge'
```

Inside the render callback (the `{(board) => { ... }}` body, where `jobs` is in scope), before the `return (`, build a lookup:

```tsx
        const jobsByKey = new Map<string, JobMeta[]>()
        for (const j of jobs) {
          const arr = jobsByKey.get(j.key) ?? []
          arr.push(j); jobsByKey.set(j.key, arr)
        }
```

In the per-row action cluster (the `<div className="flex items-center gap-1">` holding the `Bot` dispatch button and `AssigneePicker`), add the badge as the first child:

```tsx
                              <AgentRowBadge
                                jobs={jobsByKey.get(row.key) ?? []}
                                onClick={() => { setFocusKey(row.key); setDrawerOpen(true) }}
                              />
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. `npm run dev`: dispatch an agent for a ticket; its row shows a pulsing bot badge with a count; clicking it opens the drawer filtered to that ticket.

- [ ] **Step 4: Commit**

```bash
git add components/agents/agent-row-badge.tsx components/board-panel.tsx
git commit -m "feat: per-ticket agent indicator badge on the board"
```

---

### Task B6: Wire Sonner toasts (job diff + action outcomes)

**Files:**
- Create: `components/agents/use-job-toasts.ts` (client hook that diffs the polled jobs and fires toasts)
- Modify: `components/board-panel.tsx` (call the hook; toast the merge response's `jira` outcome)
- Modify: `components/agents/dispatch-form.tsx` (toast the start response's `jira` outcome)

**Interfaces:**
- Consumes: `deriveJobEvents`, `indexJobs` (B2), `JobMeta`, `sonner`'s `toast`.
- Produces: `export function useJobToasts(jobs: JobMeta[]): void`.

- [ ] **Step 1: Create the hook** — `components/agents/use-job-toasts.ts`:

```ts
'use client'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { deriveJobEvents, indexJobs } from '@/lib/agent/job-events'
import type { JobMeta } from '@/lib/agent/runner'

/** Fire a toast for each lifecycle change between job polls. Skips the first poll. */
export function useJobToasts(jobs: JobMeta[]): void {
  const prev = useRef<Map<string, JobMeta> | null>(null)
  useEffect(() => {
    if (prev.current === null) { prev.current = indexJobs(jobs); return }
    for (const ev of deriveJobEvents(prev.current, jobs)) {
      switch (ev.type) {
        case 'done':
          toast.success(`${ev.key} — agent done`, { description: ev.repo })
          break
        case 'failed':
          toast.error(`${ev.key} — agent failed`, { description: ev.reason ?? ev.repo })
          break
        case 'blocked':
          toast.warning(`${ev.key} — blocked`, { description: ev.reason ?? ev.repo })
          break
        case 'mr-opened':
          toast.info(`${ev.key} — MR opened`, {
            description: ev.url,
            action: { label: 'Open', onClick: () => window.open(ev.url, '_blank', 'noreferrer') },
          })
          break
        case 'jira-moved':
          toast.info(`${ev.key} → ${ev.status}`, { description: 'Jira status updated' })
          break
        case 'jira-error':
          toast.warning(`${ev.key} — Jira not updated`, { description: ev.error })
          break
      }
    }
    prev.current = indexJobs(jobs)
  }, [jobs])
}
```

- [ ] **Step 2: Call the hook in `BoardPanel`** — in `components/board-panel.tsx`, add the imports and call it at the top level of the component, after the `jobs` declaration from Task B4:

```tsx
import { useJobToasts } from '@/components/agents/use-job-toasts'
import { toast } from 'sonner'
```

```tsx
  useJobToasts(jobs)
```

- [ ] **Step 3: Toast the merge `jira` outcome** — in `board-panel.tsx`, the Merge button currently calls `post('/api/board/merge', ...)`, which discards the body. Replace that Merge button's `onClick` body with a direct fetch so the outcome is visible:

```tsx
                                  onClick={() => confirm(`Merge MR !${row.mr!.iid} into main`, async () => {
                                    const res = await fetch('/api/board/merge', {
                                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ project: row.repo!.project, iid: row.mr!.iid }),
                                    })
                                    const json = await res.json()
                                    if (!json.ok) { setError(json.message ?? 'Merge failed'); return }
                                    setError(null)
                                    if (json.data?.jira?.status && json.data.jira.moved)
                                      toast.info(`${row.key} → ${json.data.jira.status}`, { description: 'Jira status updated' })
                                    else if (json.data?.jira?.error)
                                      toast.warning(`${row.key} — Jira not updated`, { description: json.data.jira.error })
                                  })}
```

- [ ] **Step 4: Toast the start `jira` outcome in `DispatchForm`** — in `components/agents/dispatch-form.tsx`, add `import { toast } from 'sonner'` and, in `send()` inside the `if (json.ok) {` block, before `onDispatched?.(...)`:

```tsx
        if (json.data?.jira?.status && json.data.jira.moved)
          toast.info(`${k} → ${json.data.jira.status}`, { description: 'Jira status updated' })
        else if (json.data?.jira?.error)
          toast.warning(`${k} — Jira not updated`, { description: json.data.jira.error })
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. `npm run dev`: dispatching shows a "→ In Progress" toast; when an agent finishes, a "done" + "→ Code Review" toast appears within ~3s; merging shows "→ Acceptatie" when it's the last MR.

- [ ] **Step 6: Commit**

```bash
git add components/agents/use-job-toasts.ts components/board-panel.tsx components/agents/dispatch-form.tsx
git commit -m "feat: Sonner toasts for agent lifecycle + Jira transitions"
```

---

### Task B7: De-emphasize the standalone /agents nav entry

**Files:**
- Modify: `components/nav-items.tsx` (move the Agents entry to the end of the nav list)

**Interfaces:**
- Consumes: existing nav items array.

- [ ] **Step 1: Reorder** — in `components/nav-items.tsx`, move the `{ href: "/agents", title: "Agents", icon: Workflow }` entry to the end of the nav list so the Release Flow (board) is the primary surface and `/agents` reads as a fallback. Do not remove it (the user chose "keep page as fallback").

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. `npm run dev`: `/agents` still loads and works; it sits last in the sidebar.

- [ ] **Step 3: Commit**

```bash
git add components/nav-items.tsx
git commit -m "chore: de-emphasize standalone /agents nav entry (drawer is primary)"
```

---

## Final verification

- [ ] Run the whole suite: `npx vitest run` — expected: all green (new tests for `findTransitionId`, `keyFromBranch`, `allMergedForKey`, `deriveJobEvents` plus the existing suite).
- [ ] Run `npx tsc --noEmit` — expected: no errors.
- [ ] Update the MR/PR description for branch `feat/dev-dashboard` to cover both pieces (per global rule: keep the description in sync with the implementation).
