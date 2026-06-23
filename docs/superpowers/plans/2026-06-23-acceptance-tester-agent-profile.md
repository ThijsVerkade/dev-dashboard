# Acceptance-Tester Agent Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second agent profile, `acceptance`, that verifies a ticket's staging deploy (GitLab `deploy:staging` green + clean CloudWatch startup) then browser-tests the ticket's acceptance criteria via the chrome-devtools MCP, reporting pass/fail back to Jira — while the existing `implement` profile stays unchanged.

**Architecture:** The dashboard server orchestrates the deterministic, auth-heavy gates (Jira read/write, GitLab job status, CloudWatch tail) reusing existing `lib/sources/*` code, then spawns a headless `claude -p` (cwd = repo checkout) that only drives the browser and emits a structured verdict the server parses and posts to Jira. Pure logic (readiness, criteria extraction, verdict parsing, ADF comment builders, prompt) lives in a unit-tested module; orchestration (polling, spawning, Jira POST) lives in the runner.

**Tech Stack:** Next.js (App Router), TypeScript, Node `child_process`, Vitest, existing GitLab/Jira/CloudWatch source modules, chrome-devtools MCP.

## Global Constraints

- This is NOT stock Next.js — read the relevant guide in `node_modules/next/dist/docs/` before writing route/server code (per `AGENTS.md`).
- The dashboard stores, persists, and passes **no staging credentials**. Login credentials live in the target repo on the PC; the agent uses them from the repo checkout.
- The `implement` profile keeps today's exact behavior; `startJob` defaults to `'implement'`.
- The acceptance agent never modifies code, never creates a branch/commit, and never transitions the Jira ticket — it only posts comments.
- Acceptance-stage detection uses the existing heuristic `/accept/i.test(status)` (matches `components/board-panel.tsx:40`).
- Verdict marker the agent must emit: a line `ACCEPTANCE-RESULT: PASS` or `ACCEPTANCE-RESULT: FAIL`.
- Config is env-driven via the existing `parseEnvMap`/`parseEnvList` helpers in `dashboard.config.ts`, keyed by Jira project key (e.g. `NBDE`).
- All async source calls return `Result<T>` from `lib/result.ts` (`ok`/`failure`/`unconfigured`).

---

### Task 1: Agent profile type + staging config

**Files:**
- Create: `lib/agent/profiles.ts`
- Create: `lib/agent/profiles.test.ts`
- Modify: `dashboard.config.ts` (add `stagingUrls`, `acceptanceCriteriaField`)

**Interfaces:**
- Produces: `type AgentProfile = 'implement' | 'acceptance'`; `isAgentProfile(x: unknown): x is AgentProfile`; `AGENT_PROFILES: Record<AgentProfile, { label: string }>`; `dashboardConfig.stagingUrls: Record<string,string>`; `dashboardConfig.acceptanceCriteriaField: string`.

- [ ] **Step 1: Write the failing test**

`lib/agent/profiles.test.ts`:
```ts
import { expect, test } from 'vitest'
import { isAgentProfile, AGENT_PROFILES } from './profiles'

test('isAgentProfile accepts the two known profiles and rejects anything else', () => {
  expect(isAgentProfile('implement')).toBe(true)
  expect(isAgentProfile('acceptance')).toBe(true)
  expect(isAgentProfile('nope')).toBe(false)
  expect(isAgentProfile(undefined)).toBe(false)
  expect(isAgentProfile(123)).toBe(false)
})

test('AGENT_PROFILES has a label for each profile', () => {
  expect(AGENT_PROFILES.implement.label).toBeTruthy()
  expect(AGENT_PROFILES.acceptance.label).toBeTruthy()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent/profiles.test.ts`
Expected: FAIL — cannot find module `./profiles`.

- [ ] **Step 3: Write minimal implementation**

`lib/agent/profiles.ts`:
```ts
export type AgentProfile = 'implement' | 'acceptance'

export const AGENT_PROFILES: Record<AgentProfile, { label: string }> = {
  implement: { label: 'Implement' },
  acceptance: { label: 'Acceptance test' },
}

export function isAgentProfile(x: unknown): x is AgentProfile {
  return x === 'implement' || x === 'acceptance'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent/profiles.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add config fields**

In `dashboard.config.ts`, add these two entries inside the `dashboardConfig` object (next to `agentRepos`):
```ts
  // Map Jira project key -> staging base URL, e.g.
  // STAGING_URLS="NBDE:https://staging.example.com,ERP:https://erp-stg.example.com".
  // Missing key => the acceptance profile is not runnable for that project.
  stagingUrls: parseEnvMap(process.env.STAGING_URLS),
  // Optional Jira custom field id holding acceptance criteria; empty => read from description.
  acceptanceCriteriaField: process.env.ACCEPTANCE_CRITERIA_FIELD ?? '',
```

- [ ] **Step 6: Verify the app still type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/profiles.ts lib/agent/profiles.test.ts dashboard.config.ts
git commit -m "feat: agent profile type + staging config"
```

---

### Task 2: Acceptance pure logic (criteria, readiness, verdict, prompt, comments)

**Files:**
- Create: `lib/agent/acceptance-logic.ts`
- Create: `lib/agent/acceptance-logic.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no I/O).
- Produces:
  - `type AcceptanceDetail = { key: string; summary: string; description: string; url: string; status: string; assignee: { displayName: string; accountId: string } | null; acceptanceCriteria: string | null }`
  - `type AdfDoc = { type: 'doc'; version: 1; content: unknown[] }`
  - `type Verdict = { result: 'pass' | 'fail' | 'unknown'; findings: string }`
  - `extractCriteriaFromDescription(description: string): string | null`
  - `checkReadiness(detail: AcceptanceDetail): string[]` (empty array = ready; otherwise human-readable missing items)
  - `parseVerdict(log: string): Verdict`
  - `isCleanStartup(events: { message: string }[]): boolean`
  - `buildAcceptancePrompt(detail: AcceptanceDetail, opts: { stagingUrl: string }): string`
  - `buildMissingInfoComment(detail: AcceptanceDetail, missing: string[]): AdfDoc`
  - `buildResultComment(verdict: Verdict): AdfDoc`

- [ ] **Step 1: Write the failing tests**

`lib/agent/acceptance-logic.test.ts`:
```ts
import { expect, test } from 'vitest'
import {
  extractCriteriaFromDescription, checkReadiness, parseVerdict, isCleanStartup,
  buildAcceptancePrompt, buildMissingInfoComment, buildResultComment,
  type AcceptanceDetail,
} from './acceptance-logic'

const base: AcceptanceDetail = {
  key: 'NBDE-817', summary: 'Telephone bids', description: '', url: 'https://x/browse/NBDE-817',
  status: 'Acceptance', assignee: { displayName: 'Ann', accountId: 'acc-1' },
  acceptanceCriteria: 'Given a lot, when I place a phone bid, it is recorded.',
}

test('extractCriteriaFromDescription pulls the Acceptance Criteria section', () => {
  const desc = 'Intro line\n\nAcceptance Criteria\n- bid recorded\n- email sent\n\nNotes\nignore me'
  expect(extractCriteriaFromDescription(desc)).toBe('- bid recorded\n- email sent')
})

test('extractCriteriaFromDescription returns null when absent', () => {
  expect(extractCriteriaFromDescription('just a description')).toBeNull()
  expect(extractCriteriaFromDescription('')).toBeNull()
})

test('checkReadiness returns empty when ready', () => {
  expect(checkReadiness(base)).toEqual([])
})

test('checkReadiness flags wrong status and missing criteria', () => {
  const missing = checkReadiness({ ...base, status: 'In Progress', acceptanceCriteria: null })
  expect(missing.some((m) => /Acceptance stage/i.test(m))).toBe(true)
  expect(missing.some((m) => /acceptance criteria/i.test(m))).toBe(true)
})

test('parseVerdict reads the last PASS/FAIL marker and trailing findings', () => {
  expect(parseVerdict('blah\nACCEPTANCE-RESULT: PASS all good').result).toBe('pass')
  expect(parseVerdict('ACCEPTANCE-RESULT: PASS\nACCEPTANCE-RESULT: FAIL step 3 broke').result).toBe('fail')
  expect(parseVerdict('no marker here')).toEqual({ result: 'unknown', findings: '' })
  expect(parseVerdict('ACCEPTANCE-RESULT: FAIL login button missing').findings).toContain('login button missing')
})

test('isCleanStartup is false on error markers or no events, true otherwise', () => {
  expect(isCleanStartup([{ message: 'Server listening on 3000' }])).toBe(true)
  expect(isCleanStartup([{ message: 'Unhandled Exception: boom' }])).toBe(false)
  expect(isCleanStartup([])).toBe(false)
})

test('buildAcceptancePrompt embeds url, criteria and the verdict marker instruction', () => {
  const p = buildAcceptancePrompt(base, { stagingUrl: 'https://staging.x' })
  expect(p).toContain('https://staging.x')
  expect(p).toContain('phone bid')
  expect(p).toContain('ACCEPTANCE-RESULT:')
  expect(p).toContain('chrome-devtools')
  expect(p.toLowerCase()).toContain("repository's own")
})

test('buildMissingInfoComment mentions the assignee and lists missing items', () => {
  const doc = buildMissingInfoComment(base, ['no acceptance criteria found'])
  const json = JSON.stringify(doc)
  expect(doc.type).toBe('doc')
  expect(json).toContain('acc-1')           // mention accountId
  expect(json).toContain('no acceptance criteria found')
})

test('buildResultComment reflects pass/fail', () => {
  expect(JSON.stringify(buildResultComment({ result: 'pass', findings: '' }))).toMatch(/PASS|passed/i)
  expect(JSON.stringify(buildResultComment({ result: 'fail', findings: 'x' }))).toMatch(/FAIL|failed/i)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agent/acceptance-logic.test.ts`
Expected: FAIL — cannot find module `./acceptance-logic`.

- [ ] **Step 3: Write the implementation**

`lib/agent/acceptance-logic.ts`:
```ts
export type AcceptanceDetail = {
  key: string
  summary: string
  description: string
  url: string
  status: string
  assignee: { displayName: string; accountId: string } | null
  acceptanceCriteria: string | null
}

export type AdfDoc = { type: 'doc'; version: 1; content: unknown[] }
export type Verdict = { result: 'pass' | 'fail' | 'unknown'; findings: string }

const ERROR_MARKER = /error|exception|fatal|panic|crash|traceback|unhandled/i

/** Pull the text under an "Acceptance Criteria" heading up to the next blank-line block. */
export function extractCriteriaFromDescription(description: string): string | null {
  const lines = description.split('\n')
  const start = lines.findIndex((l) => /^\s*#*\s*acceptance criteria\s*:?\s*$/i.test(l))
  if (start === -1) return null
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (body.length > 0 && line.trim() === '') break // stop at first blank line after content starts
    if (body.length === 0 && line.trim() === '') continue // skip leading blanks
    body.push(line)
  }
  const text = body.join('\n').trim()
  return text || null
}

/** Returns the list of missing prerequisites; empty array means ready to test. */
export function checkReadiness(detail: AcceptanceDetail): string[] {
  const missing: string[] = []
  if (!/accept/i.test(detail.status))
    missing.push(`ticket is not in the Acceptance stage (status: ${detail.status || 'unknown'})`)
  if (!detail.acceptanceCriteria)
    missing.push(
      "no acceptance criteria found (add an 'Acceptance Criteria' section to the description, or set ACCEPTANCE_CRITERIA_FIELD)",
    )
  return missing
}

/** Parse the agent's structured verdict from its log; last marker wins. */
export function parseVerdict(log: string): Verdict {
  const matches = [...log.matchAll(/ACCEPTANCE-RESULT:\s*(PASS|FAIL)/gi)]
  const last = matches.at(-1)
  if (!last) return { result: 'unknown', findings: '' }
  const result = last[1].toUpperCase() === 'PASS' ? 'pass' : 'fail'
  const after = log.slice((last.index ?? 0) + last[0].length).trim()
  return { result, findings: after.slice(0, 1000) }
}

/** A clean startup: we saw log events and none look like an error/crash. */
export function isCleanStartup(events: { message: string }[]): boolean {
  if (events.length === 0) return false
  return !events.some((e) => ERROR_MARKER.test(e.message))
}

/** Instruction handed to the headless browser-testing agent. */
export function buildAcceptancePrompt(detail: AcceptanceDetail, opts: { stagingUrl: string }): string {
  return [
    `You are acceptance-testing Jira ticket ${detail.key} on the STAGING environment.`,
    `Do NOT modify code, create branches, or commit. You only test and report.`,
    ``,
    `## Ticket`,
    `Key: ${detail.key}`,
    `Summary: ${detail.summary}`,
    `URL: ${detail.url}`,
    ``,
    `## Acceptance criteria`,
    detail.acceptanceCriteria || '(none provided)',
    ``,
    `## Staging`,
    `Base URL: ${opts.stagingUrl}`,
    `If a login is required, use this repository's own local credentials (its .env/config in this checkout).`,
    `No credentials are provided in this prompt.`,
    ``,
    `## How to test`,
    `1. Use the chrome-devtools MCP to open the staging base URL.`,
    `2. Walk through each acceptance criterion in a real browser, observing actual behavior.`,
    `3. Capture concrete evidence (what you did, what you saw) for each criterion.`,
    ``,
    `## Report (REQUIRED, last line)`,
    `End your final message with exactly one line: \`ACCEPTANCE-RESULT: PASS\` if every criterion`,
    `is satisfied, otherwise \`ACCEPTANCE-RESULT: FAIL\`, followed by a one-paragraph summary of findings.`,
  ].join('\n')
}

function assigneeNode(detail: AcceptanceDetail): unknown {
  return detail.assignee
    ? { type: 'mention', attrs: { id: detail.assignee.accountId, text: `@${detail.assignee.displayName}` } }
    : { type: 'text', text: 'Assignee' }
}

export function buildMissingInfoComment(detail: AcceptanceDetail, missing: string[]): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          assigneeNode(detail),
          { type: 'text', text: ' — this ticket cannot be acceptance-tested yet. Missing:' },
        ],
      },
      {
        type: 'bulletList',
        content: missing.map((m) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: m }] }],
        })),
      },
    ],
  }
}

export function buildResultComment(verdict: Verdict): AdfDoc {
  const headline =
    verdict.result === 'pass'
      ? 'Acceptance test PASSED ✅ on staging.'
      : 'Acceptance test FAILED ❌ on staging.'
  const content: unknown[] = [
    { type: 'paragraph', content: [{ type: 'text', text: headline, marks: [{ type: 'strong' }] }] },
  ]
  if (verdict.findings)
    content.push({ type: 'paragraph', content: [{ type: 'text', text: verdict.findings }] })
  return { type: 'doc', version: 1, content }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agent/acceptance-logic.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/acceptance-logic.ts lib/agent/acceptance-logic.test.ts
git commit -m "feat: acceptance pure logic (readiness, verdict, prompt, comments)"
```

---

### Task 3: Jira — fetch acceptance detail + add comment

**Files:**
- Modify: `lib/sources/jira.ts`
- Create: `lib/sources/jira-acceptance.test.ts`

**Interfaces:**
- Consumes: `AcceptanceDetail`, `AdfDoc`, `extractCriteriaFromDescription` from `lib/agent/acceptance-logic`.
- Produces:
  - `mapAcceptanceDetail(json: any, host: string, criteriaField: string): AcceptanceDetail` (pure, exported for testing)
  - `getAcceptanceDetail(key: string): Promise<Result<AcceptanceDetail>>`
  - `addComment(issueKey: string, body: AdfDoc): Promise<Result<{ key: string }>>`

- [ ] **Step 1: Write the failing test**

`lib/sources/jira-acceptance.test.ts`:
```ts
import { expect, test } from 'vitest'
import { mapAcceptanceDetail } from './jira'

const host = 'https://bas.atlassian.net'

test('mapAcceptanceDetail extracts status, assignee, and criteria from description', () => {
  const json = {
    key: 'NBDE-817',
    fields: {
      summary: 'Telephone bids',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acceptance Criteria' }] }, { type: 'paragraph', content: [{ type: 'text', text: '- bid recorded' }] }] },
      status: { name: 'Acceptance' },
      assignee: { displayName: 'Ann', accountId: 'acc-1' },
    },
  }
  const d = mapAcceptanceDetail(json, host, '')
  expect(d.key).toBe('NBDE-817')
  expect(d.status).toBe('Acceptance')
  expect(d.assignee).toEqual({ displayName: 'Ann', accountId: 'acc-1' })
  expect(d.acceptanceCriteria).toContain('bid recorded')
  expect(d.url).toBe('https://bas.atlassian.net/browse/NBDE-817')
})

test('mapAcceptanceDetail prefers a custom field for criteria when configured', () => {
  const json = {
    key: 'NBDE-1',
    fields: { summary: 's', description: null, status: { name: 'Acceptatie' }, assignee: null, customfield_123: 'field criteria' },
  }
  const d = mapAcceptanceDetail(json, host, 'customfield_123')
  expect(d.assignee).toBeNull()
  expect(d.acceptanceCriteria).toBe('field criteria')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/sources/jira-acceptance.test.ts`
Expected: FAIL — `mapAcceptanceDetail` is not exported.

- [ ] **Step 3: Implement in `lib/sources/jira.ts`**

Add the import near the top (alongside the existing `import type { IssueDetail } from '@/lib/agent/prompt'`):
```ts
import { extractCriteriaFromDescription, type AcceptanceDetail, type AdfDoc } from '@/lib/agent/acceptance-logic'
```

Append these to the file (after `getIssueDetail`):
```ts
/** Pure mapping of a Jira issue payload into the acceptance-testing shape. */
export function mapAcceptanceDetail(json: any, host: string, criteriaField: string): AcceptanceDetail {
  const f = json.fields ?? {}
  const key = json.key
  const description = flattenAdf(f.description)
  const fromField = criteriaField ? (typeof f[criteriaField] === 'string' ? f[criteriaField].trim() : flattenAdf(f[criteriaField])) : ''
  const acceptanceCriteria = (fromField && fromField.trim()) || extractCriteriaFromDescription(description)
  return {
    key,
    summary: f.summary ?? '',
    description,
    url: `${host}/browse/${key}`,
    status: f.status?.name ?? '',
    assignee: f.assignee?.accountId
      ? { displayName: f.assignee.displayName ?? '', accountId: f.assignee.accountId }
      : null,
    acceptanceCriteria: acceptanceCriteria || null,
  }
}

/** Fetch the fields the acceptance profile needs. */
export async function getAcceptanceDetail(key: string): Promise<Result<AcceptanceDetail>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  const field = dashboardConfig.acceptanceCriteriaField
  const fields = ['summary', 'description', 'status', 'assignee', ...(field ? [field] : [])].join(',')
  try {
    const url = `${cfg.host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`
    const res = await fetch(url, { headers: { Authorization: basicAuth(cfg), Accept: 'application/json' } })
    if (!res.ok) return failure(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return ok(mapAcceptanceDetail(await res.json(), cfg.host, field))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}

/** Post an ADF comment to an issue. */
export async function addComment(issueKey: string, body: AdfDoc): Promise<Result<{ key: string }>> {
  const cfg = env.jira()
  if (!cfg) return unconfigured('Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN in .env.local')
  try {
    const res = await fetch(`${cfg.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      headers: { Authorization: basicAuth(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      const hint = res.status === 403 ? ' (token lacks Jira write permission)' : ''
      return failure(`Jira ${res.status}${hint}: ${detail}`)
    }
    return ok({ key: issueKey })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Jira request failed')
  }
}
```

Note: `dashboardConfig` is already imported at the top of `jira.ts`; `basicAuth`, `flattenAdf`, `env`, `ok`, `failure`, `unconfigured` are already in scope.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/sources/jira-acceptance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/sources/jira.ts lib/sources/jira-acceptance.test.ts
git commit -m "feat: jira getAcceptanceDetail + addComment"
```

---

### Task 4: Deploy gate (GitLab deploy:staging green + clean CloudWatch startup)

**Files:**
- Create: `lib/agent/deploy-gate.ts`

**Interfaces:**
- Consumes: `isCleanStartup` from `lib/agent/acceptance-logic`; `getBoard` from `lib/sources/board`; `getEvents` from `lib/sources/cloudwatch`; `Result`/`ok`/`failure` from `lib/result`.
- Produces: `checkStagingDeploy(key: string): Promise<Result<{ project: string; logGroup?: string }>>` — resolves only when the ticket's `deploy:staging` job is `success` (polled), then confirms a clean CloudWatch startup if a staging log group is configured. Returns `failure(reason)` on timeout / no MR / unclean startup.

Note: this hits live GitLab/CloudWatch and is verified manually (per spec). No unit test for the polling loop; `isCleanStartup` is already unit-tested in Task 2.

- [ ] **Step 1: Write the implementation**

`lib/agent/deploy-gate.ts`:
```ts
import 'server-only'
import { getBoard } from '@/lib/sources/board'
import { getEvents } from '@/lib/sources/cloudwatch'
import { isCleanStartup } from '@/lib/agent/acceptance-logic'
import { Result, ok, failure } from '@/lib/result'

const POLL_INTERVAL_MS = 15_000
const MAX_POLLS = 20 // ~5 minutes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Find the board row for a ticket key (across all stage columns). */
async function findRow(key: string) {
  const board = await getBoard()
  if (!board.ok) return board
  const row = board.data.columns.flatMap((c) => c.rows).find((r) => r.key === key)
  return ok(row ?? null)
}

/**
 * Wait until the ticket's deploy:staging job is success, then confirm a clean
 * CloudWatch startup. Resolves with the project + (optional) staging log group.
 */
export async function checkStagingDeploy(key: string): Promise<Result<{ project: string; logGroup?: string }>> {
  let project = ''
  let logGroup: string | undefined

  for (let i = 0; i < MAX_POLLS; i++) {
    const r = await findRow(key)
    if (!r.ok) return r
    const row = r.data
    if (!row) return failure(`No board row for ${key} (is it in the current sprint?)`)
    if (!row.mr) return failure(`No merge request matched to ${key}; nothing is deployed`)
    project = row.repo?.project ?? project
    const stagingEnv = row.envs.find((e) => /staging/i.test(e.name))
    logGroup = stagingEnv?.logGroup

    if (row.stagingJob?.status === 'success') {
      if (!logGroup) return ok({ project }) // deploy green; no log group configured to verify
      const events = await getEvents(logGroup, Date.now() - 5 * 60 * 1000)
      if (!events.ok) return events
      if (!isCleanStartup(events.data))
        return failure('deploy:staging is green but the staging logs show errors or no startup')
      return ok({ project, logGroup })
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return failure('timed out waiting for deploy:staging to go green')
}
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/agent/deploy-gate.ts
git commit -m "feat: staging deploy gate (gitlab job + cloudwatch)"
```

---

### Task 5: Runner — profile-aware jobs + acceptance orchestration

**Files:**
- Modify: `lib/agent/runner.ts`

**Interfaces:**
- Consumes: Task 1 (`AgentProfile`, `isAgentProfile`), Task 2 (`buildAcceptancePrompt`, `parseVerdict`, `checkReadiness`, `buildMissingInfoComment`, `buildResultComment`, `AcceptanceDetail`), Task 3 (`getAcceptanceDetail`, `addComment`), Task 4 (`checkStagingDeploy`).
- Produces: `JobStatus` gains `'blocked'`; `JobMeta` gains `profile: AgentProfile`, `phase?: string`, `reason?: string`, `result?: 'pass' | 'fail'`; `startJob(key: string, profile?: AgentProfile)` (defaults `'implement'`).

- [ ] **Step 1: Extend the job types**

In `lib/agent/runner.ts`, update the type declarations near the top:
```ts
export type JobStatus = 'running' | 'done' | 'failed' | 'canceled' | 'blocked'
export type JobMeta = {
  id: string
  key: string
  repo: string
  branch: string
  baseBranch: string
  profile: AgentProfile
  status: JobStatus
  phase?: string
  reason?: string
  result?: 'pass' | 'fail'
  startedAt: string
  pid: number
}
```

Add imports at the top of the file:
```ts
import { type AgentProfile } from '@/lib/agent/profiles'
import { getAcceptanceDetail, addComment } from '@/lib/sources/jira'
import {
  buildAcceptancePrompt, parseVerdict, checkReadiness,
  buildMissingInfoComment, buildResultComment, type AcceptanceDetail,
} from '@/lib/agent/acceptance-logic'
import { checkStagingDeploy } from '@/lib/agent/deploy-gate'
```
(`dashboardConfig`, `getIssueDetail`, the `node:fs` helpers, `projectKeyOf`, `parseRepoSpec`, `slugify` are already imported.)

- [ ] **Step 2: Make `startJob` dispatch on profile**

Change the signature and add a dispatch at the top of `startJob`:
```ts
export async function startJob(key: string, profile: AgentProfile = 'implement'): Promise<Result<{ id: string }>> {
  if (profile === 'acceptance') return startAcceptanceJob(key)
  // ...existing implement body unchanged, EXCEPT add `profile: 'implement'` to the meta object...
}
```
In the existing implement `meta` object literal (the one with `status: 'running'`), add the field `profile: 'implement',`.

- [ ] **Step 3: Add a small phase/finish helper and the acceptance orchestrator**

Append to `runner.ts`:
```ts
function setPhase(id: string, phase: string): void {
  const m = readMeta(id)
  if (m) { m.phase = phase; writeMeta(m) }
}
function finish(id: string, status: JobStatus, extra: Partial<JobMeta> = {}): void {
  const m = readMeta(id)
  if (m) { Object.assign(m, extra, { status }); writeMeta(m) }
}

/**
 * Acceptance profile: verify readiness + staging deploy (in-process), then spawn a
 * headless browser-testing agent and post the verdict to Jira. Gates run async after
 * the job id is returned; the dashboard server must stay up for the run to complete.
 */
async function startAcceptanceJob(key: string): Promise<Result<{ id: string }>> {
  const projectKey = projectKeyOf(key)
  const stagingUrl = dashboardConfig.stagingUrls[projectKey]
  const spec = dashboardConfig.agentRepos[projectKey]
  if (!spec) return failure(`No repo mapped for project "${projectKey}". Set AGENT_REPOS.`)
  const { repo: repoName } = parseRepoSpec(spec)
  const repoPath = join(workspaceDir(), repoName)
  if (!existsSync(join(repoPath, '.git'))) return failure(`Git repo not found at ${repoPath}`)

  const detailRes = await getAcceptanceDetail(key)
  if (!detailRes.ok) return detailRes
  const detail = detailRes.data

  const id = `${detail.key}-${Date.now()}`
  mkdirSync(JOBS_DIR, { recursive: true })
  const meta: JobMeta = {
    id, key: detail.key, repo: repoName, branch: '', baseBranch: '',
    profile: 'acceptance', status: 'running', phase: 'readiness',
    startedAt: new Date().toISOString(), pid: 0,
  }
  writeMeta(meta)

  // Run gates + agent without blocking the HTTP response.
  void runAcceptance(id, repoPath, stagingUrl, detail).catch((e) => {
    finish(id, 'failed', { reason: e instanceof Error ? e.message : 'acceptance run crashed' })
  })
  return ok({ id })
}

async function runAcceptance(
  id: string,
  repoPath: string,
  stagingUrl: string | undefined,
  detail: AcceptanceDetail,
): Promise<void> {
  // 1. Readiness
  if (!stagingUrl) {
    finish(id, 'blocked', { reason: `No staging URL for ${projectKeyOf(detail.key)} (set STAGING_URLS)` })
    return
  }
  const missing = checkReadiness(detail)
  if (missing.length > 0) {
    await addComment(detail.key, buildMissingInfoComment(detail, missing))
    finish(id, 'blocked', { reason: missing.join('; ') })
    return
  }

  // 2. Deploy gate
  setPhase(id, 'deploy')
  const deploy = await checkStagingDeploy(detail.key)
  if (!deploy.ok) {
    await addComment(detail.key, buildMissingInfoComment(detail, [`cannot test yet: ${deploy.message}`]))
    finish(id, 'blocked', { reason: deploy.message })
    return
  }

  // 3. Browser test (headless agent)
  setPhase(id, 'test')
  const prompt = buildAcceptancePrompt(detail, { stagingUrl })
  const out = openSync(logPath(id), 'a')
  const child = spawn(
    CLAUDE_BIN,
    ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
    { cwd: repoPath, detached: true, stdio: ['ignore', out, out] },
  )
  closeSync(out)
  const started = readMeta(id)
  if (started) { started.pid = child.pid ?? 0; writeMeta(started) }

  child.on('exit', () => {
    // 4. Report
    let log = ''
    try { log = readTail(logPath(id), TAIL_BYTES) } catch { /* no log */ }
    const verdict = parseVerdict(log)
    if (verdict.result === 'unknown') {
      finish(id, 'failed', { reason: 'agent produced no ACCEPTANCE-RESULT verdict' })
      return
    }
    void addComment(detail.key, buildResultComment(verdict))
    finish(id, 'done', { phase: 'reported', result: verdict.result })
  })
  child.on('error', () => finish(id, 'failed', { reason: 'failed to spawn browser agent' }))
  child.unref()
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Run the agent test suite to confirm no regression**

Run: `npx vitest run lib/agent/`
Expected: PASS (profiles, acceptance-logic, prompt tests all green).

- [ ] **Step 6: Commit**

```bash
git add lib/agent/runner.ts
git commit -m "feat: acceptance orchestration in runner + blocked status"
```

---

### Task 6: API — accept the `profile` parameter

**Files:**
- Modify: `app/api/agent/start/route.ts`

**Interfaces:**
- Consumes: `startJob`, `isAgentProfile`.

- [ ] **Step 1: Update the route**

Replace the body of `app/api/agent/start/route.ts` with:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { startJob } from '@/lib/agent/runner'
import { isAgentProfile } from '@/lib/agent/profiles'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { key?: string; profile?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('Invalid JSON body'))
  }
  const key = body?.key
  if (!key || typeof key !== 'string') return NextResponse.json(failure('key is required'))
  const profile = body?.profile ?? 'implement'
  if (!isAgentProfile(profile)) return NextResponse.json(failure(`Unknown profile "${profile}"`))
  return NextResponse.json(await startJob(key.trim(), profile))
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/agent/start/route.ts
git commit -m "feat: agent start API accepts profile param"
```

---

### Task 7: UI — blocked status, profile/phase display, and "Test in acceptance" button

**Files:**
- Modify: `components/agents-panel.tsx`
- Modify: `components/board-panel.tsx`

**Interfaces:**
- Consumes: `JobMeta` (now with `profile`, `phase`, `reason`, `result`, `'blocked'` status); `AGENT_PROFILES`.

- [ ] **Step 1: Add the `blocked` status style in `agents-panel.tsx`**

In the `STATUS_CLASS` record, add the `blocked` entry:
```ts
const STATUS_CLASS: Record<JobMeta['status'], string> = {
  running: 'text-primary border-primary/40 animate-pulse',
  done: 'text-primary border-primary/40',
  failed: 'text-destructive border-destructive/40',
  canceled: 'text-muted-foreground border-border',
  blocked: 'text-amber-500 border-amber-500/40',
}
```

- [ ] **Step 2: Import `AGENT_PROFILES`**

At the top of `components/agents-panel.tsx`, add:
```ts
import { AGENT_PROFILES } from '@/lib/agent/profiles'
```

- [ ] **Step 3: Show profile + phase/reason in the job list row**

In `AgentsPanel`'s job list `.map((j) => ...)`, replace the existing `key`/`repo`/`branch` spans with:
```tsx
                  <span className="font-semibold text-foreground">{j.key}</span>
                  <span className="rounded-none border border-border px-1 text-[10px] uppercase text-muted-foreground">{j.profile}</span>
                  <span className="text-muted-foreground">{j.repo}</span>
                  {j.profile === 'acceptance'
                    ? <span className="truncate text-muted-foreground">{j.reason ?? j.phase ?? ''}</span>
                    : <span className="truncate text-muted-foreground">{j.branch}</span>}
```
(Leave the trailing `timeOf` span and `StatusPill` as-is.)

- [ ] **Step 4: Guard the `JobView` header for acceptance jobs**

In `JobView`, replace the repo/branch header spans so acceptance jobs (empty `branch`/`baseBranch`) show profile/phase/result instead:
```tsx
          <span>{meta.key}</span>
          <span className="text-muted-foreground">{meta.repo}</span>
          {meta.profile === 'acceptance' ? (
            <span className="text-muted-foreground">{AGENT_PROFILES.acceptance.label}{meta.phase ? ` · ${meta.phase}` : ''}{meta.result ? ` · ${meta.result}` : ''}</span>
          ) : (
            <span className="text-muted-foreground">{meta.baseBranch} ← {meta.branch}</span>
          )}
```

- [ ] **Step 5: Add the "Test in acceptance" button on Acceptance-stage cards in `board-panel.tsx`**

Update the lucide import line to include the icon:
```ts
import { Bot, Check, ChevronsUpDown, FlaskConical } from 'lucide-react'
```
Inside `STAGES.map((stage) => ...)`, in each row's action cluster (right after the existing `Bot` button, still inside `<div className="flex items-center gap-1">`), add:
```tsx
                              {stage.id === 'acceptance' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  title="Acceptance-test this ticket on staging (verifies the deploy, then browser-tests it; comments the result on Jira)"
                                  className="size-5 p-0 text-muted-foreground hover:text-primary"
                                  onClick={() => confirm(`Acceptance-test ${row.key} on staging`, async () => {
                                    const err = await post('/api/agent/start', { key: row.key, profile: 'acceptance' })
                                    if (err) setError(err)
                                    else setNotice(`Acceptance test dispatched for ${row.key} → see Agents page`)
                                  })}
                                >
                                  <FlaskConical className="size-3" />
                                </Button>
                              )}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add components/agents-panel.tsx components/board-panel.tsx
git commit -m "feat: acceptance UI — blocked status, profile/phase, Test-in-acceptance button"
```

---

### Task 8: Documentation & env sample

**Files:**
- Modify: `.env.example` (create if absent) and/or `README.md` — whichever the repo uses for config docs.

**Interfaces:** none.

- [ ] **Step 1: Check what exists**

```bash
ls .env.example README.md 2>/dev/null
grep -n "AGENT_REPOS\|STAGING\|GITLAB_STAGING_JOB" .env.example README.md 2>/dev/null
```

- [ ] **Step 2: Add the acceptance config block**

Add (to `.env.example` if present, else the config section of `README.md`):
```bash
# Acceptance-tester agent profile
# Per-Jira-project staging base URL (the acceptance agent browser-tests here):
STAGING_URLS="NBDE:https://staging.example.com"
# Optional: Jira custom field id holding acceptance criteria (else read from the description):
ACCEPTANCE_CRITERIA_FIELD=
# NOTE: staging LOGIN credentials are NOT configured here — the agent uses the target
# repo's own local credentials from its checkout. The dashboard never stores secrets.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document acceptance profile env config"
```

---

## Manual verification (after all tasks)

Prerequisites: `STAGING_URLS` set for a real project; `AGENT_REPOS` mapped; the chrome-devtools MCP available to the spawned `claude` (globally configured or via a project `.mcp.json`); a Jira ticket in Acceptance with an "Acceptance Criteria" section; its MR deployed via `deploy:staging`.

1. Start the dashboard (`npm run dev`).
2. On the Release Flow board, open the Acceptance column; click the flask button on a ticket.
3. On the Agents page, watch the job: phase should move `readiness → deploy → test → reported`.
4. Confirm: a **blocked** job posts a Jira comment listing what's missing and @-mentions the assignee; a completed run posts a PASS/FAIL comment with findings.
5. Negative checks: a ticket not in Acceptance / missing criteria → `blocked` with a Jira comment; a project without `STAGING_URLS` → `blocked` with reason and **no** Jira comment.

## Self-Review notes

- **Spec coverage:** profiles (T1), readiness + criteria + assignee mention (T2/T3), Jira comment write (T3), deploy gate GitLab+CloudWatch (T4), browser agent + verdict + report + `blocked` status (T5), API profile param (T6), Acceptance-only button + UI (T7), config without credentials + docs (T1/T8). Missing-info→assignee mention covered by `buildMissingInfoComment` (T2) wired in T5.
- **No credentials in dashboard:** enforced — only `STAGING_URLS`/`ACCEPTANCE_CRITERIA_FIELD` are added; the prompt instructs the agent to use the repo's own creds.
- **Type consistency:** `AcceptanceDetail`, `AdfDoc`, `Verdict` defined in T2 and imported unchanged by T3/T5; `AgentProfile` from T1 used by T5/T6; `checkStagingDeploy` return shape from T4 consumed in T5.
