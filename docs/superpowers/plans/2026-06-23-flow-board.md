# Release Flow Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a release flow board to the dev-dashboard: one row per active-sprint Jira ticket, correlated to its GitLab MR / pipeline / approvals / environments, from which the user can merge, deploy staging, cut a production tag, and tail the deployed env's logs.

**Architecture:** A server-side aggregator (`lib/sources/board.ts`) composes the existing Jira + GitLab connectors into one fully-correlated `Board` model served by `GET /api/board` and polled by a new client `components/board-panel.tsx`. Correlation is isolated as pure functions (testable). Three `POST` routes perform write actions (merge / play staging job / create tag), each re-validating its precondition server-side via the same pure functions. Env log-tailing reuses the existing CloudWatch SSE route and `LiveTail` component via a resolved `project:env → log group` map.

**Tech Stack:** Next.js 16 App Router (TypeScript), `@gitbeaker/rest`, `@aws-sdk/client-cloudwatch-logs`, Vitest, Tailwind. React 19.

## Global Constraints

- Secrets live ONLY in server modules (`lib/sources/*`, route handlers); the browser never holds tokens. `lib/sources/*` import `'server-only'`.
- Every connector function returns `Result<T>` from `@/lib/result` (`ok` / `unconfigured` / `failure`). Never throw across the connector boundary.
- Write actions require `GITLAB_TOKEN` with `api` scope (v1 only needed `read_api`). When the token lacks it, the board reports `canWrite: false` and the UI disables (not hides) action buttons.
- Follow the existing connector pattern exactly: a private `client()` returning `null` when `env.gitlab()` is null, `try/catch` returning `failure(...)`, `unconfigured(...)` when creds/config missing.
- Feature workflow being modelled: branch name contains the Jira key → MR targets `main`; merge → dev/acc; play manual `deploy:staging` job → staging; create tag of `main` → production.
- Unit tests use Vitest (`import { expect, test } from 'vitest'`), colocated as `*.test.ts`, asserting against captured sample payloads — match the style in `lib/sources/gitlab.test.ts`.
- Run all tests with `npm test` (vitest run). Typecheck/build with `npm run build`.

---

### Task 1: Config additions (log-group map + staging job name)

**Files:**
- Modify: `dashboard.config.ts`

**Interfaces:**
- Produces: `dashboardConfig.cloudwatchLogGroups: Record<string,string>` (keyed `"<project path>:<env name>"`), `dashboardConfig.stagingJobName: string`.

- [ ] **Step 1: Add the two config fields**

Edit `dashboard.config.ts` — replace the `cloudwatchLogGroups: []` line and add `stagingJobName`:

```ts
export const dashboardConfig = {
  gitlabProjects: parseEnvList(process.env.GITLAB_PROJECTS),
  gitlabGroups: parseEnvList(process.env.GITLAB_GROUPS),
  gitlabExcludes: parseEnvList(process.env.GITLAB_EXCLUDE),
  // Map "<gitlab project path>:<environment name>" -> CloudWatch log group.
  // e.g. { 'mygroup/svc:staging': '/aws/ecs/svc-stg' }. Missing key => env not clickable.
  cloudwatchLogGroups: {} as Record<string, string>,
  jiraProjects: parseEnvList(process.env.JIRA_PROJECTS),
  // Name of the manual GitLab job that deploys staging (played from the board).
  stagingJobName: process.env.GITLAB_STAGING_JOB ?? 'deploy:staging',
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: build succeeds (no type errors). The old `cloudwatchLogGroups: [] as string[]` had no consumers that break — confirm by `grep -rn cloudwatchLogGroups lib app components` returning only the config file.

- [ ] **Step 3: Commit**

```bash
git add dashboard.config.ts
git commit -m "feat: add log-group map and staging job name to dashboard config"
```

---

### Task 2: GitLab read extensions — MR / deployment / tag / approvals + token scope

**Files:**
- Modify: `lib/sources/gitlab.ts`
- Test: `lib/sources/gitlab.test.ts`

**Interfaces:**
- Consumes: existing `client()`, `env.gitlab()`, `Result`, `mapPipeline`/`Pipeline`, `Job` from this file.
- Produces (types): `MergeRequest`, `Deployment`, `Tag`, `Approvals`.
- Produces (pure mappers): `mapMergeRequest(raw, project) => MergeRequest`, `mapDeployment(raw) => Deployment`, `mapTag(raw, project, host) => Tag`, `hasApiScope(scopes: string[]) => boolean`.
- Produces (fetchers): `getMergeRequests(project) => Result<MergeRequest[]>`, `getDeployments(project) => Result<Deployment[]>`, `getTags(project) => Result<Tag[]>`, `getMrApprovals(project, iid) => Result<Approvals>`, `getCanWrite() => Promise<boolean>`, `getDiscoveredProjects() => Result<string[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/sources/gitlab.test.ts`:

```ts
import {
  mapMergeRequest, mapDeployment, mapTag, hasApiScope,
} from './gitlab'

test('mapMergeRequest normalises fields and computes mergeable', () => {
  const raw = {
    iid: 7, title: 'PROJ-12 add thing', web_url: 'https://gl/x/-/merge_requests/7',
    draft: false, source_branch: 'feature/PROJ-12-add-thing', state: 'opened',
    sha: 'deadbeef', merged_at: null, detailed_merge_status: 'mergeable',
  }
  expect(mapMergeRequest(raw, 'x/y')).toEqual({
    iid: 7, title: 'PROJ-12 add thing', webUrl: 'https://gl/x/-/merge_requests/7',
    draft: false, sourceBranch: 'feature/PROJ-12-add-thing', state: 'opened',
    sha: 'deadbeef', mergedAt: undefined, mergeable: true, project: 'x/y',
  })
})

test('mapMergeRequest is not mergeable when draft or status not mergeable', () => {
  expect(mapMergeRequest({ iid: 1, draft: true, detailed_merge_status: 'mergeable', source_branch: 'b', state: 'opened' }, 'p').mergeable).toBe(false)
  expect(mapMergeRequest({ iid: 1, draft: false, detailed_merge_status: 'ci_still_running', source_branch: 'b', state: 'opened' }, 'p').mergeable).toBe(false)
})

test('mapMergeRequest falls back to legacy merge_status', () => {
  expect(mapMergeRequest({ iid: 1, source_branch: 'b', state: 'opened', merge_status: 'can_be_merged' }, 'p').mergeable).toBe(true)
})

test('mapDeployment reads environment name and timestamps', () => {
  expect(mapDeployment({
    status: 'success', sha: 'abc', ref: 'main',
    created_at: '2026-06-20T10:00:00Z', updated_at: '2026-06-20T10:05:00Z',
    environment: { name: 'staging' },
  })).toEqual({ environment: 'staging', status: 'success', sha: 'abc', ref: 'main', deployedAt: '2026-06-20T10:05:00Z' })
})

test('mapTag builds a web url under the project tags path', () => {
  expect(mapTag({ name: 'v1.2.3' }, 'g/p', 'https://gl')).toEqual({
    name: 'v1.2.3', webUrl: 'https://gl/g/p/-/tags/v1.2.3',
  })
})

test('hasApiScope detects api scope', () => {
  expect(hasApiScope(['read_api', 'api'])).toBe(true)
  expect(hasApiScope(['read_api'])).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- gitlab`
Expected: FAIL — `mapMergeRequest`/`mapDeployment`/`mapTag`/`hasApiScope` are not exported.

- [ ] **Step 3: Add types, mappers, and fetchers**

In `lib/sources/gitlab.ts`, add after the existing `Job` type:

```ts
export type MergeRequest = {
  iid: number; title: string; webUrl: string; draft: boolean
  sourceBranch: string; state: 'opened' | 'merged' | 'closed'
  sha: string; mergedAt?: string; mergeable: boolean; project: string
}
export type Deployment = { environment: string; status: string; sha: string; ref: string; deployedAt: string }
export type Tag = { name: string; webUrl: string }
export type Approvals = { required: number; given: number }

export function mapMergeRequest(raw: any, project: string): MergeRequest {
  const draft = raw.draft ?? raw.work_in_progress ?? false
  const detailed = raw.detailed_merge_status ?? (raw.merge_status === 'can_be_merged' ? 'mergeable' : raw.merge_status)
  return {
    iid: raw.iid,
    title: raw.title ?? '',
    webUrl: raw.web_url ?? '',
    draft,
    sourceBranch: raw.source_branch ?? '',
    state: raw.state,
    sha: raw.sha ?? '',
    mergedAt: raw.merged_at ?? undefined,
    mergeable: detailed === 'mergeable' && !draft,
    project,
  }
}

export function mapDeployment(raw: any): Deployment {
  return {
    environment: raw.environment?.name ?? '',
    status: raw.status ?? raw.deployable?.status ?? '',
    sha: raw.sha ?? '',
    ref: raw.ref ?? '',
    deployedAt: raw.updated_at ?? raw.created_at ?? '',
  }
}

export function mapTag(raw: any, project: string, host: string): Tag {
  return { name: raw.name, webUrl: `${host}/${project}/-/tags/${encodeURIComponent(raw.name)}` }
}

export function hasApiScope(scopes: string[]): boolean {
  return scopes.includes('api')
}

export async function getDiscoveredProjects(): Promise<Result<string[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  if (dashboardConfig.gitlabProjects.length === 0 && dashboardConfig.gitlabGroups.length === 0)
    return unconfigured('Set GITLAB_GROUPS or GITLAB_PROJECTS in .env.local')
  try {
    return ok(await discoverProjects(api))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getMergeRequests(project: string): Promise<Result<MergeRequest[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const opened = await api.MergeRequests.all({ projectId: project, state: 'opened', targetBranch: 'main', perPage: 100, maxPages: 1 })
    const merged = await api.MergeRequests.all({ projectId: project, state: 'merged', orderBy: 'updated_at', perPage: 50, maxPages: 1 })
    return ok([...opened, ...merged].map((m: any) => mapMergeRequest(m, project)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getDeployments(project: string): Promise<Result<Deployment[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Deployments.all(project, { orderBy: 'created_at', sort: 'desc', perPage: 100, maxPages: 1 })
    return ok(raw.map((d: any) => mapDeployment(d)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getTags(project: string): Promise<Result<Tag[]>> {
  const api = client()
  const cfg = env.gitlab()
  if (!api || !cfg) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Tags.all(project, { orderBy: 'updated', sort: 'desc', perPage: 50, maxPages: 1 })
    return ok(raw.map((t: any) => mapTag(t, project, cfg.host)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getMrApprovals(project: string, iid: number): Promise<Result<Approvals>> {
  const cfg = env.gitlab()
  if (!cfg) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const res = await fetch(
      `${cfg.host}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}/approvals`,
      { headers: { 'PRIVATE-TOKEN': cfg.token } },
    )
    if (!res.ok) return failure(`GitLab ${res.status}`)
    const j = await res.json()
    const required = j.approvals_required ?? 0
    const given = Array.isArray(j.approved_by) ? j.approved_by.length : Math.max(0, required - (j.approvals_left ?? 0))
    return ok({ required, given })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

// Probe token scopes; default to false (no writes) on any failure.
export async function getCanWrite(): Promise<boolean> {
  const cfg = env.gitlab()
  if (!cfg) return false
  try {
    const res = await fetch(`${cfg.host}/api/v4/personal_access_tokens/self`, { headers: { 'PRIVATE-TOKEN': cfg.token } })
    if (!res.ok) return false
    const j = await res.json()
    return Array.isArray(j.scopes) && hasApiScope(j.scopes)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- gitlab`
Expected: PASS (all mapper + scope tests green; existing tests still pass).

- [ ] **Step 5: Commit**

```bash
git add lib/sources/gitlab.ts lib/sources/gitlab.test.ts
git commit -m "feat: GitLab MR/deployment/tag/approvals reads + token scope probe"
```

---

### Task 3: Pure correlation core (`board.ts` functions)

**Files:**
- Create: `lib/sources/board.ts`
- Test: `lib/sources/board.test.ts`

**Interfaces:**
- Consumes: `Issue` from `./jira`; `MergeRequest`, `Deployment`, `Tag`, `Approvals`, `Pipeline`, `Job` from `./gitlab`.
- Produces (types): `Board`, `BoardColumn`, `BoardRow`, `BoardEnv`, `ProjectData`, `MrDetail`. Note `BoardRow.mr` includes `sha` (consumed by the deploy-staging route and UI).
- Produces (pure fns): `matchMr(key, mrs)`, `pipelineForSha(sha, pipelines)`, `computeReadyToMerge(mr, approvals, pipelineStatus)`, `latestPerEnv(deps)`, `envOnThisTicket(mr, dep)`, `suggestNextTag(tags)`, `resolveLogGroup(project, env, map)`, `findStagingJob(jobs, name)`, `isPlayableStagingJob(job, pipelineStatus)`, `assembleBoard(args)`.

- [ ] **Step 1: Write the failing tests**

Create `lib/sources/board.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  matchMr, pipelineForSha, computeReadyToMerge, latestPerEnv, envOnThisTicket,
  suggestNextTag, resolveLogGroup, findStagingJob, isPlayableStagingJob, assembleBoard,
} from './board'
import type { MergeRequest, Deployment, Tag, Pipeline, Job } from './gitlab'

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  iid: 1, title: 't', webUrl: 'u', draft: false, sourceBranch: 'feature/PROJ-1-x',
  state: 'opened', sha: 's1', mergeable: true, project: 'g/p', ...over,
})

test('matchMr finds an MR whose branch contains the key, case-insensitive', () => {
  const mrs = [mr({ iid: 2, sourceBranch: 'feature/proj-1-thing' }), mr({ iid: 3, sourceBranch: 'feature/PROJ-2-y' })]
  expect(matchMr('PROJ-1', mrs)?.iid).toBe(2)
  expect(matchMr('PROJ-9', mrs)).toBeUndefined()
})

test('matchMr prefers an opened MR over a merged one', () => {
  const mrs = [mr({ iid: 5, state: 'merged' }), mr({ iid: 6, state: 'opened' })]
  expect(matchMr('PROJ-1', mrs)?.iid).toBe(6)
})

test('pipelineForSha matches by sha', () => {
  const pl: Pipeline[] = [{ id: 9, status: 'success', ref: 'main', sha: 's1', webUrl: 'w', updatedAt: '', project: 'g/p' }]
  expect(pipelineForSha('s1', pl)?.id).toBe(9)
  expect(pipelineForSha('nope', pl)).toBeUndefined()
})

test('computeReadyToMerge requires approvals met, green pipeline, mergeable', () => {
  expect(computeReadyToMerge(mr(), { required: 2, given: 2 }, 'success')).toBe(true)
  expect(computeReadyToMerge(mr(), { required: 2, given: 1 }, 'success')).toBe(false)
  expect(computeReadyToMerge(mr(), { required: 0, given: 0 }, 'running')).toBe(false)
  expect(computeReadyToMerge(mr({ mergeable: false }), { required: 0, given: 0 }, 'success')).toBe(false)
})

test('latestPerEnv keeps the most recent deployment per environment', () => {
  const deps: Deployment[] = [
    { environment: 'staging', status: 'success', sha: 'a', ref: 'main', deployedAt: '2026-06-20T09:00:00Z' },
    { environment: 'staging', status: 'success', sha: 'b', ref: 'main', deployedAt: '2026-06-21T09:00:00Z' },
    { environment: 'dev', status: 'success', sha: 'c', ref: 'main', deployedAt: '2026-06-20T09:00:00Z' },
  ]
  const out = latestPerEnv(deps)
  expect(out.find((d) => d.environment === 'staging')?.sha).toBe('b')
  expect(out).toHaveLength(2)
})

test('envOnThisTicket true only when MR merged at/before the deploy', () => {
  const dep: Deployment = { environment: 'dev', status: 'success', sha: 'x', ref: 'main', deployedAt: '2026-06-21T10:00:00Z' }
  expect(envOnThisTicket(mr({ state: 'merged', mergedAt: '2026-06-21T09:00:00Z' }), dep)).toBe(true)
  expect(envOnThisTicket(mr({ state: 'merged', mergedAt: '2026-06-21T11:00:00Z' }), dep)).toBe(false)
  expect(envOnThisTicket(mr({ state: 'opened' }), dep)).toBe(false)
})

test('suggestNextTag bumps patch of latest semver, default v0.1.0', () => {
  expect(suggestNextTag([{ name: 'v1.2.3', webUrl: '' }, { name: 'v1.2.0', webUrl: '' }])).toBe('v1.2.4')
  expect(suggestNextTag([])).toBe('v0.1.0')
})

test('resolveLogGroup looks up project:env', () => {
  const map = { 'g/p:staging': '/aws/ecs/p-stg' }
  expect(resolveLogGroup('g/p', 'staging', map)).toBe('/aws/ecs/p-stg')
  expect(resolveLogGroup('g/p', 'dev', map)).toBeUndefined()
})

test('findStagingJob + isPlayableStagingJob', () => {
  const jobs: Job[] = [
    { id: 1, name: 'build', stage: 'build', status: 'success', webUrl: 'w' },
    { id: 2, name: 'deploy:staging', stage: 'deploy', status: 'manual', webUrl: 'w' },
  ]
  const job = findStagingJob(jobs, 'deploy:staging')
  expect(job?.id).toBe(2)
  expect(isPlayableStagingJob(job!, 'success')).toBe(true)
  expect(isPlayableStagingJob(job!, 'running')).toBe(false)
})

test('assembleBoard groups rows by status and correlates a ticket', () => {
  const issues = [
    { key: 'PROJ-1', summary: 'one', status: 'In Progress', statusCategory: 'indeterminate', assignee: 'A', priority: '', updated: '', url: 'j1' },
    { key: 'PROJ-9', summary: 'lonely', status: 'To Do', statusCategory: 'new', assignee: 'B', priority: '', updated: '', url: 'j9' },
  ]
  const projects = [{
    project: 'g/p',
    mrs: [mr({ iid: 7, sourceBranch: 'feature/PROJ-1-x', sha: 's1' })],
    pipelines: [{ id: 4, status: 'success', ref: 'main', sha: 's1', webUrl: 'w', updatedAt: '', project: 'g/p' }] as Pipeline[],
    deployments: [{ environment: 'dev', status: 'success', sha: 'x', ref: 'main', deployedAt: '2026-06-22T00:00:00Z' }],
    tags: [{ name: 'v1.0.0', webUrl: 'tg' }] as Tag[],
  }]
  const mrDetails = [{ project: 'g/p', iid: 7, approvals: { required: 1, given: 1 }, stagingJob: undefined }]
  const board = assembleBoard({ issues, projects, mrDetails, logGroups: {}, canWrite: true, stagingJobName: 'deploy:staging' })

  expect(board.canWrite).toBe(true)
  expect(board.columns.map((c) => c.status)).toEqual(['In Progress', 'To Do'])
  const row = board.columns[0].rows[0]
  expect(row.key).toBe('PROJ-1')
  expect(row.mr?.iid).toBe(7)
  expect(row.mr?.sha).toBe('s1')
  expect(row.mr?.pipelineStatus).toBe('success')
  expect(row.readyToMerge).toBe(true)
  expect(row.suggestedTag).toBe('v1.0.1')
  // PROJ-9 has no MR
  expect(board.columns[1].rows[0].mr).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- board`
Expected: FAIL — `./board` module does not exist.

- [ ] **Step 3: Implement `lib/sources/board.ts`**

```ts
import type { Issue } from './jira'
import type { MergeRequest, Deployment, Tag, Approvals, Pipeline, Job } from './gitlab'

export type BoardEnv = {
  name: string; state: string; sha: string; ref: string; deployedAt: string
  onThisTicket: boolean; logGroup?: string
}
export type BoardRow = {
  key: string; summary: string; assignee: string; status: string; url: string
  repo?: { project: string; webUrl: string }
  mr?: {
    iid: number; title: string; webUrl: string; draft: boolean; sourceBranch: string; sha: string
    state: 'opened' | 'merged' | 'closed'
    approvalsRequired: number; approvalsGiven: number
    pipelineStatus?: string; mergeable: boolean; mergedAt?: string
  }
  readyToMerge: boolean
  stagingJob?: { id: number; status: string; playable: boolean }
  envs: BoardEnv[]
  latestTag?: { name: string; webUrl: string }
  suggestedTag?: string
}
export type BoardColumn = { status: string; statusCategory: string; rows: BoardRow[] }
export type Board = { columns: BoardColumn[]; canWrite: boolean }

export type ProjectData = {
  project: string; mrs: MergeRequest[]; pipelines: Pipeline[]; deployments: Deployment[]; tags: Tag[]
}
export type MrDetail = { project: string; iid: number; approvals: Approvals; stagingJob?: Job }

export function matchMr(key: string, mrs: MergeRequest[]): MergeRequest | undefined {
  const k = key.toUpperCase()
  const hits = mrs.filter((m) => m.sourceBranch.toUpperCase().includes(k))
  if (hits.length === 0) return undefined
  // Prefer an opened MR; otherwise the first (lists are newest-first).
  return hits.find((m) => m.state === 'opened') ?? hits[0]
}

export function pipelineForSha(sha: string, pipelines: Pipeline[]): Pipeline | undefined {
  return pipelines.find((p) => p.sha === sha)
}

export function computeReadyToMerge(mr: MergeRequest, approvals: Approvals, pipelineStatus?: string): boolean {
  return mr.mergeable && approvals.given >= approvals.required && pipelineStatus === 'success'
}

export function latestPerEnv(deps: Deployment[]): Deployment[] {
  const byEnv = new Map<string, Deployment>()
  for (const d of deps) {
    const cur = byEnv.get(d.environment)
    if (!cur || d.deployedAt > cur.deployedAt) byEnv.set(d.environment, d)
  }
  return [...byEnv.values()]
}

export function envOnThisTicket(mr: MergeRequest | undefined, dep: Deployment): boolean {
  if (!mr || mr.state !== 'merged' || !mr.mergedAt || !dep.deployedAt) return false
  return mr.mergedAt <= dep.deployedAt
}

export function suggestNextTag(tags: Tag[]): string {
  const semver = /^v?(\d+)\.(\d+)\.(\d+)$/
  for (const t of tags) {
    const m = t.name.match(semver)
    if (m) return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`
  }
  return 'v0.1.0'
}

export function resolveLogGroup(project: string, env: string, map: Record<string, string>): string | undefined {
  return map[`${project}:${env}`]
}

export function findStagingJob(jobs: Job[], name: string): Job | undefined {
  return jobs.find((j) => j.name === name)
}

export function isPlayableStagingJob(job: Job, pipelineStatus?: string): boolean {
  return pipelineStatus === 'success' && job.status === 'manual'
}

export function assembleBoard(args: {
  issues: Issue[]
  projects: ProjectData[]
  mrDetails: MrDetail[]
  logGroups: Record<string, string>
  canWrite: boolean
  stagingJobName: string
}): Board {
  const { issues, projects, mrDetails } = args
  const allMrs = projects.flatMap((p) => p.mrs)
  const byProject = new Map(projects.map((p) => [p.project, p]))

  const rows: BoardRow[] = issues.map((issue) => {
    const matched = matchMr(issue.key, allMrs)
    const base: BoardRow = {
      key: issue.key, summary: issue.summary, assignee: issue.assignee,
      status: issue.status, url: issue.url, readyToMerge: false, envs: [],
    }
    if (!matched) return base

    const pd = byProject.get(matched.project)
    const pipeline = pd ? pipelineForSha(matched.sha, pd.pipelines) : undefined
    const detail = mrDetails.find((d) => d.project === matched.project && d.iid === matched.iid)
    const approvals = detail?.approvals ?? { required: 0, given: 0 }

    const envs: BoardEnv[] = pd
      ? latestPerEnv(pd.deployments).map((d) => ({
          name: d.environment, state: d.status, sha: d.sha, ref: d.ref, deployedAt: d.deployedAt,
          onThisTicket: envOnThisTicket(matched, d),
          logGroup: resolveLogGroup(matched.project, d.environment, args.logGroups),
        }))
      : []

    const stagingJob = detail?.stagingJob
      ? { id: detail.stagingJob.id, status: detail.stagingJob.status, playable: isPlayableStagingJob(detail.stagingJob, pipeline?.status) }
      : undefined

    return {
      ...base,
      repo: { project: matched.project, webUrl: matched.webUrl },
      mr: {
        iid: matched.iid, title: matched.title, webUrl: matched.webUrl, draft: matched.draft,
        sourceBranch: matched.sourceBranch, sha: matched.sha, state: matched.state,
        approvalsRequired: approvals.required, approvalsGiven: approvals.given,
        pipelineStatus: pipeline?.status, mergeable: matched.mergeable, mergedAt: matched.mergedAt,
      },
      readyToMerge: computeReadyToMerge(matched, approvals, pipeline?.status),
      stagingJob,
      envs,
      latestTag: pd?.tags[0],
      suggestedTag: pd ? suggestNextTag(pd.tags) : undefined,
    }
  })

  // Group into columns, preserving first-seen status order.
  const order: string[] = []
  const cols = new Map<string, BoardColumn>()
  for (const issue of issues) {
    if (!cols.has(issue.status)) {
      order.push(issue.status)
      cols.set(issue.status, { status: issue.status, statusCategory: issue.statusCategory, rows: [] })
    }
  }
  for (const row of rows) cols.get(row.status)!.rows.push(row)
  return { columns: order.map((s) => cols.get(s)!), canWrite: args.canWrite }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- board`
Expected: PASS (all correlation tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/sources/board.ts lib/sources/board.test.ts
git commit -m "feat: pure correlation core for the release flow board"
```

---

### Task 4: Board aggregator (`getBoard`) + GET route

**Files:**
- Modify: `lib/sources/board.ts` (add `getBoard`)
- Create: `app/api/board/route.ts`
- Test: `lib/sources/board.test.ts` (add unconfigured-path test)

**Interfaces:**
- Consumes: `getActiveSprint` from `./jira`; `getDiscoveredProjects`, `getMergeRequests`, `getDeployments`, `getTags`, `getMrApprovals`, `getCanWrite`, `getJobs`, `getPipelines` from `./gitlab`; `assembleBoard`, `matchMr`, `pipelineForSha`, `findStagingJob` from this file; `dashboardConfig`.
- Produces: `getBoard() => Promise<Result<Board>>`.

- [ ] **Step 1: Write the failing test**

Append to `lib/sources/board.test.ts`:

```ts
import { getBoard } from './board'

test('getBoard reports unconfigured when Jira env missing', async () => {
  delete process.env.JIRA_HOST
  delete process.env.JIRA_EMAIL
  delete process.env.JIRA_TOKEN
  const r = await getBoard()
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unconfigured')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- board`
Expected: FAIL — `getBoard` is not exported.

- [ ] **Step 3: Implement `getBoard`**

Add to the top imports of `lib/sources/board.ts`:

```ts
import 'server-only'
import { getActiveSprint } from './jira'
import {
  getDiscoveredProjects, getMergeRequests, getDeployments, getTags,
  getMrApprovals, getCanWrite, getJobs, getPipelines,
} from './gitlab'
import { dashboardConfig } from '@/dashboard.config'
import { ok, type Result } from '@/lib/result'
```

Append at the end of `lib/sources/board.ts`:

```ts
export async function getBoard(): Promise<Result<Board>> {
  const sprint = await getActiveSprint()
  if (!sprint.ok) return sprint

  const projectsRes = await getDiscoveredProjects()
  if (!projectsRes.ok) return projectsRes

  const pipelinesRes = await getPipelines()
  const allPipelines = pipelinesRes.ok ? pipelinesRes.data : []

  // Per project: MRs, deployments, tags. Failures degrade to empty for that project.
  const projects: ProjectData[] = await Promise.all(
    projectsRes.data.map(async (project) => {
      const [mrs, deployments, tags] = await Promise.all([getMergeRequests(project), getDeployments(project), getTags(project)])
      return {
        project,
        mrs: mrs.ok ? mrs.data : [],
        pipelines: allPipelines.filter((p) => p.project === project),
        deployments: deployments.ok ? deployments.data : [],
        tags: tags.ok ? tags.data : [],
      }
    }),
  )

  // For only the MRs matched to a sprint ticket, fetch approvals + staging job (bounded by sprint size).
  const allMrs = projects.flatMap((p) => p.mrs)
  const matched = sprint.data
    .map((issue) => matchMr(issue.key, allMrs))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
  const uniqueMatched = [...new Map(matched.map((m) => [`${m.project}#${m.iid}`, m])).values()]

  const mrDetails: MrDetail[] = await Promise.all(
    uniqueMatched.map(async (m) => {
      const approvalsRes = await getMrApprovals(m.project, m.iid)
      const pd = projects.find((p) => p.project === m.project)
      const pipeline = pd ? pipelineForSha(m.sha, pd.pipelines) : undefined
      let stagingJob
      if (pipeline) {
        const jobsRes = await getJobs(m.project, pipeline.id)
        if (jobsRes.ok) stagingJob = findStagingJob(jobsRes.data, dashboardConfig.stagingJobName)
      }
      return {
        project: m.project, iid: m.iid,
        approvals: approvalsRes.ok ? approvalsRes.data : { required: 0, given: 0 },
        stagingJob,
      }
    }),
  )

  const canWrite = await getCanWrite()
  return ok(assembleBoard({
    issues: sprint.data, projects, mrDetails,
    logGroups: dashboardConfig.cloudwatchLogGroups, canWrite,
    stagingJobName: dashboardConfig.stagingJobName,
  }))
}
```

- [ ] **Step 4: Create the GET route**

Create `app/api/board/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getBoard } from '@/lib/sources/board'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getBoard())
}
```

- [ ] **Step 5: Run test + build**

Run: `npm test -- board && npm run build`
Expected: test PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/sources/board.ts lib/sources/board.test.ts app/api/board/route.ts
git commit -m "feat: board aggregator and GET /api/board route"
```

---

### Task 5: GitLab write functions + pure tag guard

**Files:**
- Modify: `lib/sources/gitlab.ts`
- Test: `lib/sources/gitlab.test.ts`

**Interfaces:**
- Produces (pure): `isValidNewTag(name: string, existing: Tag[]) => { ok: true } | { ok: false; message: string }`.
- Produces (writes): `mergeMr(project, iid) => Result<true>`, `playJob(project, jobId) => Result<true>`, `createTag(project, name, ref) => Result<Tag>`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/sources/gitlab.test.ts`:

```ts
import { isValidNewTag } from './gitlab'

test('isValidNewTag rejects blank, bad format, and duplicates', () => {
  expect(isValidNewTag('v1.2.3', []).ok).toBe(true)
  expect(isValidNewTag('', []).ok).toBe(false)
  expect(isValidNewTag('not a tag', []).ok).toBe(false)
  expect(isValidNewTag('v1.0.0', [{ name: 'v1.0.0', webUrl: '' }]).ok).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- gitlab`
Expected: FAIL — `isValidNewTag` is not exported.

- [ ] **Step 3: Implement the guard and write functions**

Add to `lib/sources/gitlab.ts`:

```ts
export function isValidNewTag(name: string, existing: Tag[]): { ok: true } | { ok: false; message: string } {
  if (!name.trim()) return { ok: false, message: 'Tag name is required' }
  if (!/^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(name)) return { ok: false, message: `Invalid tag format: ${name}` }
  if (existing.some((t) => t.name === name)) return { ok: false, message: `Tag ${name} already exists` }
  return { ok: true }
}

export async function mergeMr(project: string, iid: number): Promise<Result<true>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    await api.MergeRequests.merge(project, iid)
    return ok(true)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab merge failed')
  }
}

export async function playJob(project: string, jobId: number): Promise<Result<true>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    await api.Jobs.play(project, jobId)
    return ok(true)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab job play failed')
  }
}

export async function createTag(project: string, name: string, ref: string): Promise<Result<Tag>> {
  const api = client()
  const cfg = env.gitlab()
  if (!api || !cfg) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Tags.create(project, name, ref)
    return ok(mapTag(raw as any, project, cfg.host))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab tag create failed')
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- gitlab`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/gitlab.ts lib/sources/gitlab.test.ts
git commit -m "feat: GitLab write actions (merge, play job, create tag) + tag guard"
```

---

### Task 6: Write routes with server-side precondition re-validation

**Files:**
- Create: `app/api/board/merge/route.ts`
- Create: `app/api/board/deploy-staging/route.ts`
- Create: `app/api/board/tag/route.ts`

**Interfaces:**
- Consumes: `getMergeRequests`, `getMrApprovals`, `mergeMr`, `getJobs`, `playJob`, `getTags`, `createTag`, `isValidNewTag`, `getPipelines` from `@/lib/sources/gitlab`; `computeReadyToMerge`, `pipelineForSha`, `findStagingJob`, `isPlayableStagingJob` from `@/lib/sources/board`; `dashboardConfig`; `failure` from `@/lib/result`.
- Each route: `POST` with JSON body, returns `Result<...>` JSON. Re-validates server-side before mutating; never trusts the client.

- [ ] **Step 1: Create the merge route**

Create `app/api/board/merge/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getMergeRequests, getMrApprovals, getPipelines, mergeMr } from '@/lib/sources/gitlab'
import { computeReadyToMerge, pipelineForSha } from '@/lib/sources/board'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { project, iid } = await req.json()
  if (!project || typeof iid !== 'number') return NextResponse.json(failure('project and iid are required'))

  const mrs = await getMergeRequests(project)
  if (!mrs.ok) return NextResponse.json(mrs)
  const mr = mrs.data.find((m) => m.iid === iid)
  if (!mr) return NextResponse.json(failure(`MR !${iid} not found in ${project}`))

  const approvals = await getMrApprovals(project, iid)
  if (!approvals.ok) return NextResponse.json(approvals)
  const pipelines = await getPipelines()
  const pl = pipelines.ok ? pipelineForSha(mr.sha, pipelines.data) : undefined

  if (!computeReadyToMerge(mr, approvals.data, pl?.status))
    return NextResponse.json(failure('MR is not ready to merge (approvals, pipeline, or conflicts)'))

  return NextResponse.json(await mergeMr(project, iid))
}
```

- [ ] **Step 2: Create the deploy-staging route**

Create `app/api/board/deploy-staging/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getJobs, getPipelines, playJob } from '@/lib/sources/gitlab'
import { findStagingJob, isPlayableStagingJob, pipelineForSha } from '@/lib/sources/board'
import { dashboardConfig } from '@/dashboard.config'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { project, sha } = await req.json()
  if (!project || !sha) return NextResponse.json(failure('project and sha are required'))

  const pipelines = await getPipelines()
  const pl = pipelines.ok ? pipelineForSha(sha, pipelines.data) : undefined
  if (!pl) return NextResponse.json(failure('No pipeline found for that commit'))

  const jobs = await getJobs(project, pl.id)
  if (!jobs.ok) return NextResponse.json(jobs)
  const job = findStagingJob(jobs.data, dashboardConfig.stagingJobName)
  if (!job) return NextResponse.json(failure(`No "${dashboardConfig.stagingJobName}" job on pipeline #${pl.id}`))
  if (!isPlayableStagingJob(job, pl.status))
    return NextResponse.json(failure('Staging job is not playable (pipeline not green or job not manual)'))

  return NextResponse.json(await playJob(project, job.id))
}
```

- [ ] **Step 3: Create the tag route**

Create `app/api/board/tag/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createTag, getTags, isValidNewTag } from '@/lib/sources/gitlab'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { project, name } = await req.json()
  if (!project || !name) return NextResponse.json(failure('project and name are required'))

  const tags = await getTags(project)
  if (!tags.ok) return NextResponse.json(tags)
  const valid = isValidNewTag(name, tags.data)
  if (!valid.ok) return NextResponse.json(failure(valid.message))

  // Production tags are always cut from main (per workflow).
  return NextResponse.json(await createTag(project, name, 'main'))
}
```

- [ ] **Step 4: Build to typecheck the routes**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/board/merge/route.ts app/api/board/deploy-staging/route.ts app/api/board/tag/route.ts
git commit -m "feat: board write routes with server-side precondition checks"
```

---

### Task 7: Board UI panel (flow strip, actions, env log tail) + mount

**Files:**
- Create: `components/board-panel.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `usePoll` from `@/lib/use-poll`; `Board`, `BoardRow` types from `@/lib/sources/board`; `LiveTail` from `@/components/live-tail`; `PanelShell` from `@/components/panel-shell`.
- This is UI; verification is typecheck/build + manual run (no unit test — matches existing panel components which have none).

- [ ] **Step 1: Implement the board panel**

Create `components/board-panel.tsx`. It polls `/api/board` every 30s, renders status columns of cards with a flow strip and contextual action buttons, opens a confirm dialog before any write (POSTs to the matching route), surfaces errors, and opens a `LiveTail` against `/api/cloudwatch/tail?group=...` when an env with a `logGroup` is clicked.

```tsx
'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from '@/components/panel-shell'
import { LiveTail } from '@/components/live-tail'
import type { Board, BoardRow } from '@/lib/sources/board'

type Pending = { label: string; run: () => Promise<void> } | null

function flowStrip(row: BoardRow): string {
  const mark = (ok: boolean) => (ok ? '✓' : '–')
  const mr = row.mr
  const env = (name: string) => `${name} ${mark(row.envs.some((e) => e.name === name && e.onThisTicket))}`
  return [
    `branch ${mark(Boolean(mr))}`,
    `MR ${mark(Boolean(mr))}`,
    mr ? `approvals ${mr.approvalsGiven}/${mr.approvalsRequired}` : 'approvals –',
    `pipeline ${mr?.pipelineStatus ?? '–'}`,
    env('dev'), env('acceptance'), env('staging'), env('production'),
  ].join(' · ')
}

async function post(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  return json.ok ? null : json.message ?? 'Action failed'
}

export function BoardPanel() {
  const { data, loading } = usePoll<Board>('/api/board', 30_000)
  const [pending, setPending] = useState<Pending>(null)
  const [tailGroup, setTailGroup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const confirm = (label: string, run: () => Promise<void>) => setPending({ label, run })

  return (
    <PanelShell<Board> title="Release Flow" result={data} loading={loading}>
      {(board) => (
        <div className="space-y-4">
          {!board.canWrite && (
            <p className="text-xs text-amber-600">Read-only GitLab token — actions disabled. Use an `api`-scoped token to enable merge/deploy/tag.</p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {board.columns.map((col) => (
              <div key={col.status} className="space-y-2">
                <h3 className="text-sm font-semibold">{col.status} <span className="text-gray-400">({col.rows.length})</span></h3>
                {col.rows.map((row) => (
                  <div key={row.key} className="rounded border border-gray-200 dark:border-gray-800 p-2 text-xs space-y-1">
                    <div className="flex justify-between gap-2">
                      <a href={row.url} target="_blank" className="font-mono">{row.key}</a>
                      <span className="truncate text-gray-500">{row.assignee}</span>
                    </div>
                    <div className="truncate">{row.summary}</div>
                    <div className="font-mono text-[11px] text-gray-500">{flowStrip(row)}</div>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {row.mr && (
                        <button
                          disabled={!board.canWrite || !row.readyToMerge}
                          title={!board.canWrite ? 'Needs api-scoped token' : !row.readyToMerge ? 'Not ready (approvals/pipeline/conflicts)' : ''}
                          className="rounded bg-green-600 px-2 py-0.5 text-white disabled:opacity-40"
                          onClick={() => confirm(`Merge MR !${row.mr!.iid} into main`, async () => {
                            setError(await post('/api/board/merge', { project: row.repo!.project, iid: row.mr!.iid }))
                          })}
                        >Merge</button>
                      )}
                      {row.stagingJob && (
                        <button
                          disabled={!board.canWrite || !row.stagingJob.playable}
                          title={!row.stagingJob.playable ? 'Pipeline not green or job not manual' : ''}
                          className="rounded bg-blue-600 px-2 py-0.5 text-white disabled:opacity-40"
                          onClick={() => confirm(`Play deploy:staging for ${row.key}`, async () => {
                            setError(await post('/api/board/deploy-staging', { project: row.repo!.project, sha: row.mr!.sha }))
                          })}
                        >Deploy staging</button>
                      )}
                      {row.repo && (
                        <button
                          disabled={!board.canWrite}
                          className="rounded bg-purple-600 px-2 py-0.5 text-white disabled:opacity-40"
                          onClick={() => {
                            const name = prompt('New production tag (on main):', row.suggestedTag ?? 'v0.1.0')
                            if (!name) return
                            confirm(`Create tag ${name} on main`, async () => {
                              setError(await post('/api/board/tag', { project: row.repo!.project, name }))
                            })
                          }}
                        >Cut tag</button>
                      )}
                      {row.envs.filter((e) => e.onThisTicket && e.logGroup).map((e) => (
                        <button key={e.name} className="rounded border px-2 py-0.5"
                          onClick={() => setTailGroup(e.logGroup!)}>logs: {e.name}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {tailGroup && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs"><span className="font-mono">{tailGroup}</span>
                <button onClick={() => setTailGroup(null)}>close</button></div>
              <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(tailGroup)}`} />
            </div>
          )}

          {pending && (
            <div className="fixed inset-0 flex items-center justify-center bg-black/40">
              <div className="space-y-3 rounded bg-white p-4 text-sm dark:bg-gray-900">
                <p>{pending.label}?</p>
                <div className="flex justify-end gap-2">
                  <button className="rounded border px-3 py-1" onClick={() => setPending(null)}>Cancel</button>
                  <button className="rounded bg-blue-600 px-3 py-1 text-white"
                    onClick={async () => { const p = pending; setPending(null); setError(null); await p.run() }}>Confirm</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  )
}
```

Note on re-poll after an action: `usePoll` re-fetches every 30s, so the strip reflects reality within one cycle. The action's error (if any) is shown immediately via `setError`. No optimistic mutation of board state.

- [ ] **Step 2: Mount the board as the primary panel**

Edit `app/page.tsx` to add the import and render `BoardPanel` full-width at the top:

```tsx
import { BoardPanel } from '@/components/board-panel'
import { PipelinesPanel } from '@/components/pipelines-panel'
import { LogsPanel } from '@/components/logs-panel'
import { ClaudePanel } from '@/components/claude-panel'
import { JiraPanel } from '@/components/jira-panel'

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">dev-dashboard</h1>
      <BoardPanel />
      <div className="grid gap-6 lg:grid-cols-2">
        <PipelinesPanel />
        <ClaudePanel />
        <JiraPanel />
        <div className="lg:col-span-2"><LogsPanel /></div>
      </div>
    </main>
  )
}
```

- [ ] **Step 3: Build to typecheck**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open `http://localhost:3000`. Confirm:
- The Release Flow panel renders status columns matching your Jira sprint.
- A ticket with a `feature/<KEY>-…` branch shows MR / approvals / pipeline / env marks; one without a branch shows `branch –`.
- Merge is disabled unless approvals met + pipeline green + mergeable; the confirm dialog appears and, on confirm, the action runs and the strip updates within ~30s.
- With a read-only token, the amber banner shows and all action buttons are disabled.
- An env with a configured `cloudwatchLogGroups` entry shows a `logs:` button that opens the live tail; without a mapping, no button (no error).

- [ ] **Step 5: Commit**

```bash
git add components/board-panel.tsx app/page.tsx
git commit -m "feat: release flow board UI panel with actions and env log tail"
```

---

### Task 8: Docs — README + env example

**Files:**
- Modify: `README.md`
- Modify: `.env.local.example`

- [ ] **Step 1: Document the write-token requirement and config**

In `README.md`, add a "Release Flow board" section noting: `GITLAB_TOKEN` needs `api` scope for merge/deploy/tag (read-only `read_api` still shows the board, actions disabled); `dashboard.config.ts` `cloudwatchLogGroups` maps `"<project>:<env>"` → CloudWatch log group to enable per-env log tailing; `GITLAB_STAGING_JOB` overrides the manual staging job name (default `deploy:staging`); the modelled flow is feature→MR→main (dev/acc), play `deploy:staging` (staging), tag main (prod).

- [ ] **Step 2: Update `.env.local.example`**

Add commented entries:

```
# Release flow board
# GITLAB_TOKEN needs `api` scope (not just read_api) to merge / deploy staging / tag.
# GITLAB_STAGING_JOB=deploy:staging
```

- [ ] **Step 3: Commit**

```bash
git add README.md .env.local.example
git commit -m "docs: document release flow board token scope and config"
```

---

## Self-Review

**Spec coverage:**
- Active-sprint board grouped by status → Task 3 (`assembleBoard` grouping) + Task 4 (`getBoard` via `getActiveSprint`). ✓
- Jira-key→branch/MR correlation → Task 3 `matchMr`. ✓
- `readyToMerge` = approvals + green + mergeable → Task 3 `computeReadyToMerge`. ✓
- Env detection via GitLab Deployments + per-ticket attribution → Task 2 `getDeployments`/`mapDeployment`, Task 3 `latestPerEnv`/`envOnThisTicket`. ✓
- Merge / deploy-staging / cut-tag write actions with server-side preconditions → Task 5 (functions + guards) + Task 6 (routes). ✓
- Staging = play manual `deploy:staging` job → Task 3 `findStagingJob`/`isPlayableStagingJob`, Task 6 deploy-staging route. ✓
- Prod tag with next-version suggestion → Task 3 `suggestNextTag`, Task 6 tag route, Task 7 prompt prefill. ✓
- `canWrite` from token scope; disabled buttons → Task 2 `getCanWrite`, Task 7 UI. ✓
- Env log tail via project:env→log group, reusing CloudWatch SSE → Task 1 config, Task 3 `resolveLogGroup`, Task 7 `LiveTail`. ✓
- Graceful degradation (per-project failures, AWS unconfigured) → Task 4 (empty-on-failure), Task 7 (no button without mapping). ✓
- Confirmation before every action → Task 7 dialog. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — all code blocks are complete and concrete. ✓

**Type consistency:** `MergeRequest`/`Deployment`/`Tag`/`Approvals`/`Job`/`Pipeline` defined in Task 2 are consumed with identical field names in Tasks 3–6. `BoardRow.mr` includes `sha` (Task 3), which the deploy-staging button (Task 7) and route (Task 6) rely on — verified consistent. `computeReadyToMerge`/`pipelineForSha`/`findStagingJob`/`isPlayableStagingJob` signatures match between definition (Task 3) and use (Tasks 4, 6). ✓
