# dev-dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Next.js dashboard that unifies GitLab pipelines, AWS CloudWatch logs, and Claude Code activity into one pane, with live-tailing logs.

**Architecture:** A single Next.js (App Router) app run locally. Secrets live only in server-side Route Handlers; the browser talks only to our own server. Three isolated connector modules (`lib/sources/`) wrap mature libraries — `@gitbeaker/rest`, `@aws-sdk/client-cloudwatch-logs`, and the `ccusage` CLI. Each connector returns a discriminated `Result` so panels render configured / not-configured / error states uniformly. Status lists auto-poll; opened logs/traces stream via SSE.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, Vitest, `@gitbeaker/rest@43`, `@aws-sdk/client-cloudwatch-logs@3`, `ccusage@20` (invoked as a CLI).

## Global Constraints

- Node `>=24`, npm `>=11` (verified locally: Node 24.2.0, npm 11.3.0).
- Next.js `16.2.9`, App Router only — no Pages Router.
- TypeScript strict mode on.
- Secrets (`GITLAB_TOKEN`, AWS creds) MUST only be read in server modules (`lib/sources/*`, route handlers). Never import a connector into a Client Component.
- Every connector function returns `Result<T>` (defined in Task 2) — never throws to the caller.
- Read-only: no task triggers, cancels, or mutates any upstream resource.
- Dashboard is localhost-only; no auth layer.
- Each connector must treat missing credentials as `{ ok: false, reason: 'unconfigured' }`, not an error.

---

## File Structure

- `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `app/globals.css` — scaffold & tooling.
- `.env.local.example` — documented env template (committed; real `.env.local` is git-ignored).
- `dashboard.config.ts` — non-secret config: which GitLab projects + CloudWatch log groups to show.
- `lib/result.ts` — `Result<T>` discriminated union + helpers.
- `lib/env.ts` — typed, server-only env accessors.
- `lib/sources/gitlab.ts` — GitLab connector.
- `lib/sources/cloudwatch.ts` — CloudWatch connector.
- `lib/sources/claude.ts` — Claude (ccusage) connector.
- `lib/sources/*.test.ts` — unit tests per connector.
- `app/api/gitlab/pipelines/route.ts`, `app/api/gitlab/pipelines/[pipelineId]/jobs/route.ts`, `app/api/gitlab/jobs/[jobId]/trace/route.ts` (SSE) — GitLab endpoints.
- `app/api/cloudwatch/groups/route.ts`, `app/api/cloudwatch/tail/route.ts` (SSE) — CloudWatch endpoints.
- `app/api/claude/summary/route.ts`, `app/api/claude/sessions/route.ts` — Claude endpoints.
- `app/page.tsx`, `app/layout.tsx` — dashboard shell.
- `components/` — `panel-shell.tsx`, `pipelines-panel.tsx`, `logs-panel.tsx`, `claude-panel.tsx`, `live-tail.tsx`, `status-badge.tsx`.
- `lib/use-poll.ts` — client polling hook.
- `README.md` — setup instructions.

---

## Task 1: Scaffold Next.js app + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `.gitignore`
- Test: `lib/smoke.test.ts`

**Interfaces:**
- Produces: a runnable Next app (`npm run dev`) and a working test runner (`npm test`).

- [ ] **Step 1: Scaffold with create-next-app**

Run (non-interactive):
```bash
npx --yes create-next-app@16.2.9 . \
  --ts --app --tailwind --eslint --src-dir=false \
  --import-alias "@/*" --use-npm --turbopack --no-git --yes
```
If the directory-not-empty prompt blocks (the `docs/` folder exists), scaffold into a temp dir and move files in:
```bash
npx --yes create-next-app@16.2.9 .scaffold --ts --app --tailwind --eslint --src-dir=false --import-alias "@/*" --use-npm --turbopack --no-git --yes \
  && cp -R .scaffold/. . && rm -rf .scaffold
```

- [ ] **Step 2: Add Vitest**

Run:
```bash
npm install --save-dev vitest@latest
```
Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
})
```
Add to `package.json` `"scripts"`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 3: Write a smoke test**

Create `lib/smoke.test.ts`:
```ts
import { expect, test } from 'vitest'

test('test runner works', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 4: Run the smoke test (expect PASS)**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: build completes with no type errors.

- [ ] **Step 6: Confirm `.gitignore` ignores secrets**

Ensure `.gitignore` contains `.env*.local` and `node_modules` (create-next-app adds these; verify).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold next.js app with vitest"
```

---

## Task 2: Shared Result type + config + env

**Files:**
- Create: `lib/result.ts`, `lib/env.ts`, `dashboard.config.ts`, `.env.local.example`
- Test: `lib/result.test.ts`

**Interfaces:**
- Produces:
  - `type Result<T> = { ok: true; data: T } | { ok: false; reason: 'unconfigured' | 'error'; message: string }`
  - `ok<T>(data: T): Result<T>`
  - `unconfigured(message: string): Result<never>`
  - `failure(message: string): Result<never>`
  - `dashboardConfig: { gitlabProjects: string[]; cloudwatchLogGroups: string[] }`
  - `env.gitlab(): { host: string; token: string } | null` (null when unset)
  - `env.awsRegion(): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `lib/result.test.ts`:
```ts
import { expect, test } from 'vitest'
import { ok, unconfigured, failure } from './result'

test('ok wraps data', () => {
  expect(ok(42)).toEqual({ ok: true, data: 42 })
})

test('unconfigured carries reason and message', () => {
  expect(unconfigured('set GITLAB_TOKEN')).toEqual({
    ok: false, reason: 'unconfigured', message: 'set GITLAB_TOKEN',
  })
})

test('failure carries error reason', () => {
  expect(failure('boom')).toEqual({ ok: false, reason: 'error', message: 'boom' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/result.test.ts`
Expected: FAIL — cannot find module './result'.

- [ ] **Step 3: Implement `lib/result.ts`**

```ts
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'unconfigured' | 'error'; message: string }

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function unconfigured(message: string): Result<never> {
  return { ok: false, reason: 'unconfigured', message }
}

export function failure(message: string): Result<never> {
  return { ok: false, reason: 'error', message }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/result.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Implement `lib/env.ts` (server-only)**

Run: `npm install server-only`

```ts
import 'server-only'

export const env = {
  gitlab(): { host: string; token: string } | null {
    const host = process.env.GITLAB_HOST
    const token = process.env.GITLAB_TOKEN
    if (!host || !token) return null
    return { host, token }
  },
  awsRegion(): string | undefined {
    return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION
  },
}
```

- [ ] **Step 6: Implement `dashboard.config.ts`**

```ts
// Non-secret config: which resources the dashboard surfaces.
// Project ids/paths come from GITLAB_PROJECTS (comma-separated) if set,
// otherwise edit the defaults below.
const fromEnv = (process.env.GITLAB_PROJECTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const dashboardConfig = {
  gitlabProjects: fromEnv.length > 0 ? fromEnv : ([] as string[]),
  cloudwatchLogGroups: [] as string[], // e.g. ['/aws/lambda/my-fn']
}
```

- [ ] **Step 7: Write `.env.local.example`**

```bash
# GitLab (required for the Pipelines panel)
GITLAB_HOST=https://gitlab.example.com
GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx          # personal access token, scope: read_api
GITLAB_PROJECTS=group/project-a,group/project-b  # comma-separated ids or paths

# AWS (optional — enables the Logs panel). Standard SDK resolution also works (~/.aws, SSO).
# AWS_REGION=eu-west-1
# AWS_PROFILE=default
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add Result type, env accessors, and dashboard config"
```

---

## Task 3: GitLab connector

**Files:**
- Create: `lib/sources/gitlab.ts`
- Test: `lib/sources/gitlab.test.ts`

**Interfaces:**
- Consumes: `Result`, `ok`, `unconfigured`, `failure` from `@/lib/result`; `env` from `@/lib/env`; `dashboardConfig` from `@/dashboard.config`.
- Produces:
  - `type Pipeline = { id: number; status: string; ref: string; sha: string; webUrl: string; updatedAt: string; project: string }`
  - `type Job = { id: number; name: string; stage: string; status: string; webUrl: string }`
  - `getPipelines(): Promise<Result<Pipeline[]>>` — recent pipelines across `dashboardConfig.gitlabProjects`
  - `getJobs(projectId: string, pipelineId: number): Promise<Result<Job[]>>`
  - `getJobTrace(projectId: string, jobId: number): Promise<Result<string>>`
  - `mapPipeline(raw, project): Pipeline` (exported for testing)

- [ ] **Step 1: Install gitbeaker**

Run: `npm install @gitbeaker/rest@43.8.0`

- [ ] **Step 2: Write the failing test for the pure mapper**

Create `lib/sources/gitlab.test.ts`:
```ts
import { expect, test } from 'vitest'
import { mapPipeline } from './gitlab'

test('mapPipeline maps raw GitLab pipeline to our shape', () => {
  const raw = {
    id: 101,
    status: 'success',
    ref: 'main',
    sha: 'abc123def456',
    web_url: 'https://gitlab.example.com/g/p/-/pipelines/101',
    updated_at: '2026-06-23T10:00:00Z',
  }
  expect(mapPipeline(raw, 'g/p')).toEqual({
    id: 101,
    status: 'success',
    ref: 'main',
    sha: 'abc123def456',
    webUrl: 'https://gitlab.example.com/g/p/-/pipelines/101',
    updatedAt: '2026-06-23T10:00:00Z',
    project: 'g/p',
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- lib/sources/gitlab.test.ts`
Expected: FAIL — cannot find module './gitlab'.

- [ ] **Step 4: Implement `lib/sources/gitlab.ts`**

```ts
import 'server-only'
import { Gitlab } from '@gitbeaker/rest'
import { env } from '@/lib/env'
import { dashboardConfig } from '@/dashboard.config'
import { Result, ok, unconfigured, failure } from '@/lib/result'

export type Pipeline = {
  id: number; status: string; ref: string; sha: string
  webUrl: string; updatedAt: string; project: string
}
export type Job = {
  id: number; name: string; stage: string; status: string; webUrl: string
}

export function mapPipeline(raw: any, project: string): Pipeline {
  return {
    id: raw.id,
    status: raw.status,
    ref: raw.ref,
    sha: raw.sha,
    webUrl: raw.web_url,
    updatedAt: raw.updated_at,
    project,
  }
}

function client() {
  const cfg = env.gitlab()
  if (!cfg) return null
  return new Gitlab({ host: cfg.host, token: cfg.token })
}

export async function getPipelines(): Promise<Result<Pipeline[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  if (dashboardConfig.gitlabProjects.length === 0)
    return unconfigured('Set GITLAB_PROJECTS in .env.local')
  try {
    const lists = await Promise.all(
      dashboardConfig.gitlabProjects.map(async (project) => {
        const raw = await api.Pipelines.all(project, { perPage: 10, maxPages: 1 })
        return raw.map((p) => mapPipeline(p, project))
      }),
    )
    const all = lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return ok(all)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getJobs(projectId: string, pipelineId: number): Promise<Result<Job[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Jobs.all(projectId, { pipelineId })
    const jobs = raw.map((j: any) => ({
      id: j.id, name: j.name, stage: j.stage, status: j.status, webUrl: j.web_url,
    }))
    return ok(jobs)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getJobTrace(projectId: string, jobId: number): Promise<Result<string>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const trace = await api.Jobs.showLog(projectId, jobId)
    return ok(typeof trace === 'string' ? trace : String(trace))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- lib/sources/gitlab.test.ts`
Expected: 1 passed.

- [ ] **Step 6: Add an unconfigured-path test**

Append to `lib/sources/gitlab.test.ts`:
```ts
import { getPipelines } from './gitlab'

test('getPipelines reports unconfigured when env missing', async () => {
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
  const r = await getPipelines()
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unconfigured')
})
```
Run: `npm test -- lib/sources/gitlab.test.ts`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add GitLab connector (pipelines, jobs, trace)"
```

---

## Task 4: GitLab route handlers + SSE trace

**Files:**
- Create: `app/api/gitlab/pipelines/route.ts`, `app/api/gitlab/pipelines/[pipelineId]/jobs/route.ts`, `app/api/gitlab/jobs/[jobId]/trace/route.ts`

**Interfaces:**
- Consumes: `getPipelines`, `getJobs`, `getJobTrace` from `@/lib/sources/gitlab`.
- Produces HTTP endpoints:
  - `GET /api/gitlab/pipelines` → `Result<Pipeline[]>` as JSON
  - `GET /api/gitlab/pipelines/[pipelineId]/jobs?project=<id>` → `Result<Job[]>` as JSON
  - `GET /api/gitlab/jobs/[jobId]/trace?project=<id>` → SSE stream of trace text (event: `line`, plus `done`/`error`)

- [ ] **Step 1: Pipelines route**

Create `app/api/gitlab/pipelines/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { getPipelines } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getPipelines())
}
```

- [ ] **Step 2: Jobs route**

Create `app/api/gitlab/pipelines/[pipelineId]/jobs/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { getJobs } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId } = await params
  const project = req.nextUrl.searchParams.get('project') ?? ''
  return NextResponse.json(await getJobs(project, Number(pipelineId)))
}
```

- [ ] **Step 3: SSE trace route**

Create `app/api/gitlab/jobs/[jobId]/trace/route.ts`:
```ts
import { NextRequest } from 'next/server'
import { getJobTrace } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

// GitLab traces contain ANSI colour codes and bare carriage returns (progress
// redraws). Strip the escapes and treat \r as a line break so the <pre> renders
// clean lines instead of literal escape sequences and overwritten garbage.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
function toLines(text: string): string[] {
  return text.replace(ANSI, '').split(/\r\n|\r|\n/)
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const project = req.nextUrl.searchParams.get('project') ?? ''
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let lastLength = 0
      let stop = false
      req.signal.addEventListener('abort', () => { stop = true })
      // Guard every send: after a client abort the controller is cancelled and
      // enqueue() throws. Checking `stop` and try/catch prevents an unhandled
      // rejection on the trailing 'done'.
      const send = (event: string, data: string) => {
        if (stop) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        } catch { stop = true }
      }

      for (let i = 0; i < 600 && !stop; i++) {
        const r = await getJobTrace(project, Number(jobId))
        if (!r.ok) { send('error', JSON.stringify(r)); break }
        if (r.data.length > lastLength) {
          // GitLab has no incremental trace endpoint, so we re-fetch the whole
          // trace each tick but only emit the newly-appended slice.
          const chunk = r.data.slice(lastLength)
          lastLength = r.data.length
          for (const line of toLines(chunk)) send('line', JSON.stringify(line))
        }
        await new Promise((res) => setTimeout(res, 2000))
      }
      send('done', '"end"')
      try { controller.close() } catch { /* already closed by client abort */ }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
```

- [ ] **Step 4: Manual verification**

Start `npm run dev`. With a valid `.env.local`, run:
```bash
curl -s http://localhost:3000/api/gitlab/pipelines | head -c 400
```
Expected: JSON `{"ok":true,"data":[...]}` (or `{"ok":false,"reason":"unconfigured",...}` if env unset).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add GitLab route handlers with SSE trace tail"
```

---

## Task 5: CloudWatch connector

**Files:**
- Create: `lib/sources/cloudwatch.ts`
- Test: `lib/sources/cloudwatch.test.ts`

**Interfaces:**
- Consumes: `Result`, helpers from `@/lib/result`; `env` from `@/lib/env`; `dashboardConfig`.
- Produces:
  - `type LogEvent = { id: string; timestamp: number; message: string }` (`id` is the CloudWatch `eventId`, used for dedupe)
  - `getLogGroups(): Promise<Result<string[]>>`
  - `getEvents(logGroup: string, startTime: number): Promise<Result<LogEvent[]>>` (returns events for the window; the route handles overlap + dedupe)
  - `mapEvent(raw): LogEvent` (exported for testing)
  - `isMissingCreds(err: unknown): boolean` (exported for testing)

- [ ] **Step 1: Install AWS SDK**

Run: `npm install @aws-sdk/client-cloudwatch-logs@3.1075.0`

- [ ] **Step 2: Write failing tests for pure helpers**

Create `lib/sources/cloudwatch.test.ts`:
```ts
import { expect, test } from 'vitest'
import { mapEvent, isMissingCreds } from './cloudwatch'

test('mapEvent maps raw CloudWatch event', () => {
  expect(mapEvent({ eventId: 'e1', timestamp: 1718000000000, message: 'hello\n' })).toEqual({
    id: 'e1', timestamp: 1718000000000, message: 'hello',
  })
})

test('isMissingCreds detects credential errors', () => {
  expect(isMissingCreds({ name: 'CredentialsProviderError' })).toBe(true)
  expect(isMissingCreds({ name: 'SomethingElse' })).toBe(false)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- lib/sources/cloudwatch.test.ts`
Expected: FAIL — cannot find module './cloudwatch'.

- [ ] **Step 4: Implement `lib/sources/cloudwatch.ts`**

```ts
import 'server-only'
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { env } from '@/lib/env'
import { dashboardConfig } from '@/dashboard.config'
import { Result, ok, unconfigured, failure } from '@/lib/result'

export type LogEvent = { id: string; timestamp: number; message: string }

export function mapEvent(raw: { eventId?: string; timestamp?: number; message?: string }): LogEvent {
  return {
    id: raw.eventId ?? '',
    timestamp: raw.timestamp ?? 0,
    message: (raw.message ?? '').replace(/\n+$/, ''),
  }
}

export function isMissingCreds(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? ''
  return name === 'CredentialsProviderError' || name === 'CredentialsError'
}

function client() {
  return new CloudWatchLogsClient({ region: env.awsRegion() })
}

export async function getLogGroups(): Promise<Result<string[]>> {
  try {
    if (dashboardConfig.cloudwatchLogGroups.length > 0)
      return ok(dashboardConfig.cloudwatchLogGroups)
    const out = await client().send(new DescribeLogGroupsCommand({ limit: 50 }))
    return ok((out.logGroups ?? []).map((g) => g.logGroupName!).filter(Boolean))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured('AWS credentials not found. Configure ~/.aws or AWS_PROFILE/AWS_REGION.')
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}

export async function getEvents(
  logGroup: string,
  startTime: number,
): Promise<Result<LogEvent[]>> {
  try {
    const out = await client().send(
      new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 200 }),
    )
    return ok((out.events ?? []).map(mapEvent))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured('AWS credentials not found. Configure ~/.aws or AWS_PROFILE/AWS_REGION.')
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- lib/sources/cloudwatch.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add CloudWatch connector with graceful unconfigured handling"
```

---

## Task 6: CloudWatch route handlers + SSE tail

**Files:**
- Create: `app/api/cloudwatch/groups/route.ts`, `app/api/cloudwatch/tail/route.ts`

**Interfaces:**
- Consumes: `getLogGroups`, `getEvents` from `@/lib/sources/cloudwatch`.
- Produces:
  - `GET /api/cloudwatch/groups` → `Result<string[]>` JSON
  - `GET /api/cloudwatch/tail?group=<name>` → SSE stream (event `event` with `LogEvent` JSON, plus `error`/`done`)

- [ ] **Step 1: Groups route**

Create `app/api/cloudwatch/groups/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { getLogGroups } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getLogGroups())
}
```

- [ ] **Step 2: SSE tail route**

Create `app/api/cloudwatch/tail/route.ts`:
```ts
import { NextRequest } from 'next/server'
import { getEvents } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const group = req.nextUrl.searchParams.get('group') ?? ''
  const encoder = new TextEncoder()

  const OVERLAP = 30_000 // re-query 30s back each tick so late-ingested events aren't skipped
  const stream = new ReadableStream({
    async start(controller) {
      let start = Date.now() - 5 * 60 * 1000 // last 5 minutes
      let stop = false
      const seen = new Set<string>() // dedupe by eventId across the overlapping windows
      req.signal.addEventListener('abort', () => { stop = true })
      const send = (event: string, data: string) => {
        if (stop) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        } catch { stop = true }
      }

      for (let i = 0; i < 600 && !stop; i++) {
        const r = await getEvents(group, start)
        if (!r.ok) { send('error', JSON.stringify(r)); break }
        let maxTs = start
        for (const ev of r.data) {
          if (ev.id && seen.has(ev.id)) continue
          if (ev.id) seen.add(ev.id)
          send('event', JSON.stringify(ev))
          if (ev.timestamp > maxTs) maxTs = ev.timestamp
        }
        // Advance the cursor but stay OVERLAP behind newest; dedupe drops re-seen events.
        start = Math.max(start, maxTs - OVERLAP)
        if (seen.size > 5000) seen.clear() // bound memory on long-lived tails
        await new Promise((res) => setTimeout(res, 3000))
      }
      send('done', '"end"')
      try { controller.close() } catch { /* already closed by client abort */ }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
```

- [ ] **Step 3: Manual verification**

With `npm run dev` running:
```bash
curl -s http://localhost:3000/api/cloudwatch/groups
```
Expected (no AWS creds): `{"ok":false,"reason":"unconfigured","message":"AWS credentials not found...."}`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add CloudWatch route handlers with SSE tail"
```

---

## Task 7: Claude connector (wraps ccusage)

**Files:**
- Create: `lib/sources/claude.ts`
- Test: `lib/sources/claude.test.ts`

**Interfaces:**
- Consumes: `Result`, helpers from `@/lib/result`; Node `child_process`.
- Produces:
  - `type ClaudeSummary = { totalCost: number; totalTokens: number; days: { date: string; cost: number; tokens: number }[] }`
  - `type ClaudeSession = { sessionId: string; project: string; cost: number; tokens: number; lastActivity: string }`
  - `parseDaily(json: unknown): ClaudeSummary` (exported for testing)
  - `parseSessions(json: unknown): ClaudeSession[]` (exported for testing)
  - `getSummary(): Promise<Result<ClaudeSummary>>`
  - `getSessions(): Promise<Result<ClaudeSession[]>>`

  Note on ccusage JSON: `ccusage daily --json` returns roughly `{ daily: [{ date, totalTokens, totalCost, ... }], totals: { totalTokens, totalCost } }`; `ccusage session --json` returns `{ sessions: [{ sessionId, project, totalTokens, totalCost, lastActivity }], ... }`. Parsers MUST read defensively (fall back to 0 / '') because exact field names may vary by ccusage version — this is the documented `ccusage` risk from the spec. Step 5 validates the real shape.

- [ ] **Step 0: Install ccusage as a dependency**

Run: `npm install ccusage@20`
(So we invoke the local binary instead of spawning `npx --yes` on every poll.)

- [ ] **Step 1: Write failing tests for the pure parsers**

Create `lib/sources/claude.test.ts`:
```ts
import { expect, test } from 'vitest'
import { parseDaily, parseSessions } from './claude'

test('parseDaily reads totals and per-day rows defensively', () => {
  const json = {
    daily: [{ date: '2026-06-23', totalTokens: 1500, totalCost: 0.42 }],
    totals: { totalTokens: 1500, totalCost: 0.42 },
  }
  expect(parseDaily(json)).toEqual({
    totalCost: 0.42,
    totalTokens: 1500,
    days: [{ date: '2026-06-23', cost: 0.42, tokens: 1500 }],
  })
})

test('parseDaily tolerates missing fields', () => {
  expect(parseDaily({})).toEqual({ totalCost: 0, totalTokens: 0, days: [] })
})

test('parseSessions maps session rows', () => {
  const json = {
    sessions: [
      { sessionId: 's1', project: 'dev-dashboard', totalTokens: 900, totalCost: 0.1, lastActivity: '2026-06-23' },
    ],
  }
  expect(parseSessions(json)).toEqual([
    { sessionId: 's1', project: 'dev-dashboard', cost: 0.1, tokens: 900, lastActivity: '2026-06-23' },
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/sources/claude.test.ts`
Expected: FAIL — cannot find module './claude'.

- [ ] **Step 3: Implement `lib/sources/claude.ts`**

```ts
import 'server-only'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { Result, ok, failure } from '@/lib/result'

const run = promisify(execFile)

export type ClaudeSummary = {
  totalCost: number; totalTokens: number
  days: { date: string; cost: number; tokens: number }[]
}
export type ClaudeSession = {
  sessionId: string; project: string; cost: number; tokens: number; lastActivity: string
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function parseDaily(json: unknown): ClaudeSummary {
  const j = (json ?? {}) as any
  const days = Array.isArray(j.daily)
    ? j.daily.map((d: any) => ({
        date: str(d.date), cost: num(d.totalCost), tokens: num(d.totalTokens),
      }))
    : []
  return {
    totalCost: num(j.totals?.totalCost),
    totalTokens: num(j.totals?.totalTokens),
    days,
  }
}

export function parseSessions(json: unknown): ClaudeSession[] {
  const j = (json ?? {}) as any
  if (!Array.isArray(j.sessions)) return []
  return j.sessions.map((s: any) => ({
    sessionId: str(s.sessionId),
    project: str(s.project),
    cost: num(s.totalCost),
    tokens: num(s.totalTokens),
    lastActivity: str(s.lastActivity),
  }))
}

// Resolve the locally-installed ccusage binary; spawning `npx --yes` on every
// poll (2x/min) would re-resolve the package each time.
const CCUSAGE_BIN = join(process.cwd(), 'node_modules', '.bin', 'ccusage')
const cache = new Map<string, { value: unknown; expires: number }>()
const TTL_MS = 60_000

async function ccusage(subcommand: string): Promise<unknown> {
  const now = Date.now()
  const hit = cache.get(subcommand)
  if (hit && hit.expires > now) return hit.value
  const { stdout } = await run(CCUSAGE_BIN, [subcommand, '--json'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const value = JSON.parse(stdout)
  cache.set(subcommand, { value, expires: now + TTL_MS })
  return value
}

export async function getSummary(): Promise<Result<ClaudeSummary>> {
  try {
    return ok(parseDaily(await ccusage('daily')))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Failed to run ccusage')
  }
}

export async function getSessions(): Promise<Result<ClaudeSession[]>> {
  try {
    return ok(parseSessions(await ccusage('session')))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Failed to run ccusage')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/sources/claude.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Real-data sanity check**

Run: `npx --yes ccusage@20 daily --json | head -c 300`
Expected: JSON with a `daily` array. If field names differ from the parser, adjust `parseDaily`/`parseSessions` AND update the tests in Step 1 to match the real shape, then re-run Step 4.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add Claude connector wrapping ccusage"
```

---

## Task 8: Claude route handlers

**Files:**
- Create: `app/api/claude/summary/route.ts`, `app/api/claude/sessions/route.ts`

**Interfaces:**
- Consumes: `getSummary`, `getSessions` from `@/lib/sources/claude`.
- Produces: `GET /api/claude/summary` → `Result<ClaudeSummary>`; `GET /api/claude/sessions` → `Result<ClaudeSession[]>`.

- [ ] **Step 1: Summary route**

Create `app/api/claude/summary/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { getSummary } from '@/lib/sources/claude'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getSummary())
}
```

- [ ] **Step 2: Sessions route**

Create `app/api/claude/sessions/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { getSessions } from '@/lib/sources/claude'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getSessions())
}
```

- [ ] **Step 3: Manual verification**

With `npm run dev`:
```bash
curl -s http://localhost:3000/api/claude/summary | head -c 300
```
Expected: `{"ok":true,"data":{"totalCost":...}}`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add Claude route handlers"
```

---

## Task 9: Dashboard shell + polling hook + shared UI

**Files:**
- Create: `lib/use-poll.ts`, `components/panel-shell.tsx`, `components/status-badge.tsx`, `components/live-tail.tsx`
- Modify: `app/page.tsx` (replace scaffold), `app/layout.tsx` (set title)

**Interfaces:**
- Produces:
  - `usePoll<T>(url: string, intervalMs: number): { data: Result<T> | null; loading: boolean }` (client hook)
  - `<PanelShell title result loading>{(data) => ...}</PanelShell>` — renders unconfigured/error states centrally
  - `<StatusBadge status />`
  - `<LiveTail src />` — opens an `EventSource` to an SSE endpoint and renders streamed lines

- [ ] **Step 1: Polling hook**

Create `lib/use-poll.ts`:
```ts
'use client'
import { useEffect, useState } from 'react'
import type { Result } from '@/lib/result'

export function usePoll<T>(url: string, intervalMs: number) {
  const [data, setData] = useState<Result<T> | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    const tick = async () => {
      try {
        const res = await fetch(url)
        const json = (await res.json()) as Result<T>
        if (active) setData(json)
      } finally {
        if (active) setLoading(false)
      }
    }
    tick()
    const id = setInterval(tick, intervalMs)
    return () => { active = false; clearInterval(id) }
  }, [url, intervalMs])
  return { data, loading }
}
```

- [ ] **Step 2: StatusBadge + PanelShell**

Create `components/status-badge.tsx`:
```tsx
const COLORS: Record<string, string> = {
  success: 'bg-green-600', running: 'bg-blue-600', pending: 'bg-yellow-600',
  failed: 'bg-red-600', canceled: 'bg-gray-500', skipped: 'bg-gray-400',
}
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs text-white ${COLORS[status] ?? 'bg-gray-500'}`}>
      {status}
    </span>
  )
}
```

Create `components/panel-shell.tsx`:
```tsx
import type { Result } from '@/lib/result'

export function PanelShell<T>({
  title, result, loading, children,
}: {
  title: string
  result: Result<T> | null
  loading: boolean
  children: (data: T) => React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {loading && !result && <p className="text-sm text-gray-500">Loading…</p>}
      {result && !result.ok && result.reason === 'unconfigured' && (
        <p className="text-sm text-amber-600">Not configured: {result.message}</p>
      )}
      {result && !result.ok && result.reason === 'error' && (
        <p className="text-sm text-red-600">Error: {result.message}</p>
      )}
      {result && result.ok && children(result.data)}
    </section>
  )
}
```

- [ ] **Step 3: LiveTail component**

Create `components/live-tail.tsx`:
```tsx
'use client'
import { useEffect, useRef, useState } from 'react'

export function LiveTail({ src }: { src: string }) {
  const [lines, setLines] = useState<string[]>([])
  const boxRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    setLines([])
    const es = new EventSource(src)
    const push = (text: string) => setLines((l) => [...l.slice(-2000), text])
    es.addEventListener('line', (e) => push(JSON.parse((e as MessageEvent).data)))
    es.addEventListener('event', (e) => {
      const ev = JSON.parse((e as MessageEvent).data)
      push(`${new Date(ev.timestamp).toISOString()}  ${ev.message}`)
    })
    // The server's named `error` event carries .data. The NATIVE EventSource
    // error (connection drop) has no .data and would auto-reconnect — which
    // restarts the server's polling loop from scratch. Close on it instead.
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      if (data) push(`[stream error] ${data}`)
      else { push('[disconnected]'); es.close() }
    })
    es.addEventListener('done', () => es.close())
    return () => es.close()
  }, [src])
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [lines])
  return (
    <pre ref={boxRef} className="h-80 overflow-auto rounded bg-black p-3 text-xs text-green-200">
      {lines.join('\n')}
    </pre>
  )
}
```

- [ ] **Step 4: Layout title + page shell**

In `app/layout.tsx` set the exported `metadata.title` to `'dev-dashboard'`. Replace `app/page.tsx`:
```tsx
import { PipelinesPanel } from '@/components/pipelines-panel'
import { LogsPanel } from '@/components/logs-panel'
import { ClaudePanel } from '@/components/claude-panel'

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">dev-dashboard</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <PipelinesPanel />
        <ClaudePanel />
        <div className="lg:col-span-2"><LogsPanel /></div>
      </div>
    </main>
  )
}
```
Note: the three panel components are created in Tasks 10–12; the app will not compile until Task 12 completes. Commit this task's files now; the build check happens in Task 12.

- [ ] **Step 5: Commit**

```bash
git add lib/use-poll.ts components/panel-shell.tsx components/status-badge.tsx components/live-tail.tsx app/page.tsx app/layout.tsx
git commit -m "feat: add dashboard shell, polling hook, and shared UI components"
```

---

## Task 10: Pipelines panel

**Files:**
- Create: `components/pipelines-panel.tsx`

**Interfaces:**
- Consumes: `usePoll`, `PanelShell`, `StatusBadge`, `LiveTail`; endpoints from Task 4; types `Pipeline`, `Job` from `@/lib/sources/gitlab`.

- [ ] **Step 1: Implement the panel**

Create `components/pipelines-panel.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { StatusBadge } from './status-badge'
import { LiveTail } from './live-tail'
import type { Pipeline, Job } from '@/lib/sources/gitlab'

export function PipelinesPanel() {
  const { data, loading } = usePoll<Pipeline[]>('/api/gitlab/pipelines', 30000)
  const [selectedProject, setSelectedProject] = useState('')
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [openJob, setOpenJob] = useState<{ project: string; jobId: number } | null>(null)

  const loadJobs = async (p: Pipeline) => {
    setSelectedProject(p.project)
    setJobs(null)
    setOpenJob(null)
    const res = await fetch(
      `/api/gitlab/pipelines/${p.id}/jobs?project=${encodeURIComponent(p.project)}`,
    )
    const json = await res.json()
    setJobs(json.ok ? json.data : [])
  }

  return (
    <PanelShell title="GitLab Pipelines" result={data} loading={loading}>
      {(pipelines) => (
        <div className="space-y-2">
          {pipelines.map((p) => (
            <div key={`${p.project}-${p.id}`} className="flex items-center gap-2 text-sm">
              <StatusBadge status={p.status} />
              <button className="underline" onClick={() => loadJobs(p)}>
                {p.project} #{p.id} ({p.ref})
              </button>
            </div>
          ))}
          {jobs && (
            <div className="mt-3 space-y-1 border-t pt-2 text-sm">
              {jobs.map((j) => (
                <div key={j.id} className="flex items-center gap-2">
                  <StatusBadge status={j.status} />
                  <button className="underline"
                    onClick={() => setOpenJob({ project: selectedProject, jobId: j.id })}>
                    {j.stage} / {j.name}
                  </button>
                </div>
              ))}
            </div>
          )}
          {openJob && (
            <LiveTail
              src={`/api/gitlab/jobs/${openJob.jobId}/trace?project=${encodeURIComponent(openJob.project)}`}
            />
          )}
        </div>
      )}
    </PanelShell>
  )
}
```

- [ ] **Step 2: Manual verification**

`npm run dev`, open `http://localhost:3000`. Expected: pipeline list renders (or unconfigured note); clicking a pipeline lists its jobs; clicking a job streams its trace.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add pipelines panel with job trace live tail"
```

---

## Task 11: Logs panel

**Files:**
- Create: `components/logs-panel.tsx`

**Interfaces:**
- Consumes: `usePoll`, `PanelShell`, `LiveTail`; endpoints from Task 6.

- [ ] **Step 1: Implement the panel**

Create `components/logs-panel.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { LiveTail } from './live-tail'

export function LogsPanel() {
  const { data, loading } = usePoll<string[]>('/api/cloudwatch/groups', 60000)
  const [group, setGroup] = useState('')
  return (
    <PanelShell title="CloudWatch Logs" result={data} loading={loading}>
      {(groups) => (
        <div className="space-y-3">
          <select className="rounded border p-1 text-sm" value={group}
            onChange={(e) => setGroup(e.target.value)}>
            <option value="">Select a log group…</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          {group && <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(group)}`} />}
        </div>
      )}
    </PanelShell>
  )
}
```

- [ ] **Step 2: Manual verification**

Open the dashboard. Without AWS creds: panel shows "Not configured: AWS credentials not found…". With creds: dropdown lists groups; selecting one streams events.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add CloudWatch logs panel with live tail"
```

---

## Task 12: Claude panel

**Files:**
- Create: `components/claude-panel.tsx`

**Interfaces:**
- Consumes: `usePoll`, `PanelShell`; endpoints from Task 8; types `ClaudeSummary`, `ClaudeSession`.

- [ ] **Step 1: Implement the panel**

Create `components/claude-panel.tsx`:
```tsx
'use client'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import type { ClaudeSummary, ClaudeSession } from '@/lib/sources/claude'

export function ClaudePanel() {
  const summary = usePoll<ClaudeSummary>('/api/claude/summary', 60000)
  const sessions = usePoll<ClaudeSession[]>('/api/claude/sessions', 60000)
  return (
    <PanelShell title="Claude Activity" result={summary.data} loading={summary.loading}>
      {(s) => (
        <div className="space-y-3 text-sm">
          <div className="flex gap-4">
            <div className="rounded border p-3">
              <div className="text-xs text-gray-500">Total cost</div>
              <div className="text-xl font-semibold">${s.totalCost.toFixed(2)}</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-gray-500">Total tokens</div>
              <div className="text-xl font-semibold">{s.totalTokens.toLocaleString()}</div>
            </div>
          </div>
          {sessions.data?.ok && (
            <table className="w-full text-left">
              <thead><tr className="text-xs text-gray-500">
                <th>Project</th><th>Last activity</th><th className="text-right">Tokens</th><th className="text-right">Cost</th>
              </tr></thead>
              <tbody>
                {sessions.data.data.slice(0, 15).map((row) => (
                  <tr key={row.sessionId} className="border-t">
                    <td>{row.project || row.sessionId.slice(0, 8)}</td>
                    <td>{row.lastActivity}</td>
                    <td className="text-right">{row.tokens.toLocaleString()}</td>
                    <td className="text-right">${row.cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </PanelShell>
  )
}
```

- [ ] **Step 2: Build + manual verification**

Run: `npm run build` (expect no type errors — all three panels now exist).
Run `npm run dev`, open dashboard. Expected: Claude cards show your real cost/tokens; sessions table populated.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add Claude activity panel"
```

---

## Task 13: README + final verification

**Files:**
- Create: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Write `README.md`**

```markdown
# dev-dashboard

A local dashboard unifying GitLab pipelines, AWS CloudWatch logs, and Claude Code activity.

## Setup
1. `npm install`
2. `cp .env.local.example .env.local` and fill in `GITLAB_HOST`, `GITLAB_TOKEN` (scope `read_api`), `GITLAB_PROJECTS`.
3. (Optional) Configure AWS for the Logs panel: set `AWS_REGION` + `AWS_PROFILE`, or run `aws sso login`. Without it, the Logs panel shows a "not configured" note.
4. Claude activity needs nothing — it runs `ccusage` against your local `~/.claude` data.

## Run
- `npm run dev` → http://localhost:3000
- `npm test` → unit tests for the connectors

## Notes
- All secrets stay server-side; the browser only talks to this app's own API.
- Read-only: the dashboard never triggers or cancels anything.
```

- [ ] **Step 2: Full test run**

Run: `npm test`
Expected: all connector tests pass.

- [ ] **Step 3: Full build**

Run: `npm run build`
Expected: success, no type errors.

- [ ] **Step 4: End-to-end manual check**

`npm run dev` and confirm in the browser: Pipelines list + drill-in + trace tail; Logs panel state (configured or not); Claude cards + sessions.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: add README and finalize v1"
```

---

## Self-Review Notes

- **Spec coverage:** Pipelines (Tasks 3,4,10) ✓; CloudWatch logs + live tail (Tasks 5,6,11) ✓; Claude activity via ccusage (Tasks 7,8,12) ✓; secrets server-side (Global Constraints + `server-only` imports) ✓; graceful degradation (`Result` + `PanelShell`, Tasks 2,9) ✓; live tail via SSE (Tasks 4,6,9) ✓; config via `.env.local` + `dashboard.config.ts` (Task 2) ✓; out-of-scope items not implemented ✓.
- **ccusage risk:** Task 7 Step 5 explicitly validates real JSON shape and instructs adjusting parsers/tests if field names differ.
- **Type consistency:** `Result`, `Pipeline`, `Job`, `LogEvent`, `ClaudeSummary`, `ClaudeSession` names are used identically across producing and consuming tasks.
