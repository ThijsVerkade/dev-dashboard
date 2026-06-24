# Group-Based Agent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard dispatch autonomous Claude agents against a product *group* (auction / lease) — fanning out one agent per repo — instead of only the single Jira-project-mapped repo set.

**Architecture:** `AGENT_REPOS` is re-namespaced from `<JiraKey>/<app>` to `<group>/<app>` (with a no-`:value` shorthand). New config helpers resolve repos by group. The runner, start route, and apps route take an explicit `group`. The Jira key still supplies the prompt, branch name, and comments. The board dialog gains a group selector + subset picker; quick-send paths fire the whole selected group immediately.

**Tech Stack:** Next.js (App Router, breaking-change version — read `node_modules/next/dist/docs/` before touching route/runtime APIs), TypeScript, React client components, Vitest, Tailwind/shadcn UI primitives.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-24-group-dispatch-design.md` — every task must conform to it.
- Group = the segment of an `AGENT_REPOS` key before the first `/`; app = the remainder.
- Shorthand entry `auction/api@main` ⇒ key `auction/api`, repo `auction/api`, branch `main`. `@branch` optional, defaults to `main`.
- Explicit entry `auction/api:custom/path@develop` ⇒ key `auction/api`, repo `custom/path`, branch `develop`.
- Whole-group dispatch is expressed as `apps: []` on the wire; the server expands it to `reposForGroup(group)`.
- Jira label format is `app:<group>/<app>` (e.g. `app:auction/api`).
- Quick-send (desktop `AgentsPanel`, `MobileAgents`) fires immediately — no confirmation dialog.
- Run tests with `npx vitest run <file>`. Typecheck with `npx tsc --noEmit`.

---

### Task 1: Config — group-aware parser and resolvers (additive)

Add the new group helpers alongside the existing `reposForProject`/`resolveAgentRepo` so the build stays green; old callers are migrated in Task 2.

**Files:**
- Modify: `dashboard.config.ts`
- Test: `lib/dashboard-config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `agentGroups(map?: Record<string,string>, order?: string[]): string[]` — ordered group names. `order` (from `AGENT_GROUPS`) wins; else first-seen order of group segments in `map` keys.
  - `reposForGroup(group: string, map?: Record<string,string>): string[]` — sorted app names whose key starts with `${group}/`.
  - `resolveGroupRepo(group: string, app: string, map?: Record<string,string>): string | undefined` — the `repo@branch` spec for `${group}/${app}`, else `undefined`.
  - `dashboardConfig.agentGroupsOrder: string[]` — parsed from `AGENT_GROUPS`.

- [ ] **Step 1: Write failing tests**

Replace the entire contents of `lib/dashboard-config.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { agentGroups, reposForGroup, resolveGroupRepo } from '@/dashboard.config'

// Shorthand (no ":value") and explicit-override entries coexist.
const MAP = {
  'auction/api': 'auction/api@main',
  'auction/fe': 'auction/fe@main',
  'lease/api': 'lease/api@main',
  'lease/fe-bff': 'lease/custom-bff@develop', // explicit override: repo + branch differ
}

test('agentGroups derives distinct groups in first-seen order', () => {
  expect(agentGroups(MAP)).toEqual(['auction', 'lease'])
})

test('agentGroups honours an explicit order when given', () => {
  expect(agentGroups(MAP, ['lease', 'auction'])).toEqual(['lease', 'auction'])
})

test('agentGroups ignores ordered names that have no repos', () => {
  expect(agentGroups(MAP, ['lease', 'ghost', 'auction'])).toEqual(['lease', 'auction'])
})

test('reposForGroup lists a group apps, sorted; empty for unknown group', () => {
  expect(reposForGroup('auction', MAP)).toEqual(['api', 'fe'])
  expect(reposForGroup('lease', MAP)).toEqual(['api', 'fe-bff'])
  expect(reposForGroup('nope', MAP)).toEqual([])
})

test('resolveGroupRepo returns the spec for a group+app, else undefined', () => {
  expect(resolveGroupRepo('auction', 'api', MAP)).toBe('auction/api@main')
  expect(resolveGroupRepo('lease', 'fe-bff', MAP)).toBe('lease/custom-bff@develop')
  expect(resolveGroupRepo('auction', 'ghost', MAP)).toBeUndefined()
  expect(resolveGroupRepo('ghost', 'api', MAP)).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/dashboard-config.test.ts`
Expected: FAIL — `agentGroups`/`reposForGroup`/`resolveGroupRepo` are not exported.

- [ ] **Step 3: Add a shorthand-aware parser and the group helpers**

In `dashboard.config.ts`, replace the `parseEnvMap` helper with a version that accepts both `KEY:value` and bare-`value` (shorthand) entries:

```typescript
// Parse "KEY:value,KEY2:value2" into a record. Also accepts shorthand entries with
// no ":value" — e.g. "auction/api@main" — where the key is the path before any "@"
// and the value is the whole entry (path@branch). Used for agent repo mapping.
const parseEnvMap = (raw: string | undefined): Record<string, string> =>
  Object.fromEntries(
    parseEnvList(raw)
      .map((entry): [string, string] | null => {
        const colon = entry.indexOf(':')
        if (colon === -1) {
          const key = entry.split('@')[0].trim() // "auction/api@main" -> "auction/api"
          return key ? [key, entry] : null
        }
        const key = entry.slice(0, colon).trim()
        const value = entry.slice(colon + 1).trim()
        return key && value ? [key, value] : null
      })
      .filter((e): e is [string, string] => !!e),
  )
```

Add the group helpers after `resolveAgentRepo` (leave `reposForProject`/`resolveAgentRepo` in place for now):

```typescript
/** Group name of an AGENT_REPOS key, e.g. groupOf('auction/api') -> 'auction'. */
function groupOf(key: string): string {
  const i = key.indexOf('/')
  return i === -1 ? key : key.slice(0, i)
}

/** Ordered group names. `order` (AGENT_GROUPS) wins; else first-seen order in the map. */
export function agentGroups(
  map: Record<string, string> = dashboardConfig.agentRepos,
  order: string[] = dashboardConfig.agentGroupsOrder,
): string[] {
  const present = new Set(Object.keys(map).map(groupOf))
  if (order.length) return order.filter((g) => present.has(g))
  const seen: string[] = []
  for (const key of Object.keys(map)) {
    const g = groupOf(key)
    if (!seen.includes(g)) seen.push(g)
  }
  return seen
}

/** App names configured for a group, e.g. reposForGroup('auction') -> ['api','fe']. */
export function reposForGroup(
  group: string,
  map: Record<string, string> = dashboardConfig.agentRepos,
): string[] {
  const prefix = `${group}/`
  return Object.keys(map)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort()
}

/** Resolve the repo spec for a group+app, or undefined if unmapped. */
export function resolveGroupRepo(
  group: string,
  app: string,
  map: Record<string, string> = dashboardConfig.agentRepos,
): string | undefined {
  return map[`${group}/${app}`]
}
```

Add `agentGroupsOrder` to the `dashboardConfig` object (near `agentRepos`):

```typescript
  // Optional explicit group order/allowlist, e.g. AGENT_GROUPS="auction,lease".
  agentGroupsOrder: parseEnvList(process.env.AGENT_GROUPS),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/dashboard-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (old helpers still present, so existing callers compile).

- [ ] **Step 6: Commit**

```bash
git add dashboard.config.ts lib/dashboard-config.test.ts
git commit -m "feat: group-aware AGENT_REPOS parser and resolvers"
```

---

### Task 2: Backend dispatch model — runner, start route, apps route, groups route

Swap the dispatch model from Jira-key to group across the server, and remove the now-dead `reposForProject`/`resolveAgentRepo`.

**Files:**
- Modify: `lib/agent/runner.ts`
- Modify: `app/api/agent/start/route.ts`
- Modify: `app/api/agent/apps/route.ts`
- Create: `app/api/agent/groups/route.ts`
- Modify: `dashboard.config.ts` (delete old helpers)

**Interfaces:**
- Consumes: `agentGroups`, `reposForGroup`, `resolveGroupRepo` (Task 1); `projectKeyOf`, `parseRepoSpec` (`lib/agent/prompt.ts`); `parseAppLabels` (`lib/sources/jira.ts`).
- Produces:
  - `startJob(key: string, profile?: AgentProfile, group?: string, app?: string): Promise<Result<{ id: string }>>`
  - `JobMeta.group?: string`
  - `GET /api/agent/apps?key=<KEY>` → `{ ok: true, data: { groups: { name: string; apps: { name: string; repo: string; baseBranch: string }[] }[]; selected: string[] } }`
  - `GET /api/agent/groups` → `{ ok: true, data: { groups: string[] } }`
  - `POST /api/agent/start` body `{ key: string; profile?: string; group?: string; app?: string; apps?: string[] }`

- [ ] **Step 1: Update the runner signature and group resolution**

In `lib/agent/runner.ts`:

Change the import line:

```typescript
import { dashboardConfig, resolveGroupRepo, reposForGroup, agentGroups } from '@/dashboard.config'
```

Add `group` to `JobMeta` (after the `app` field, ~line 34):

```typescript
  /** App name within the project (e.g. 'api'), when the ticket targets a specific repo. */
  app?: string
  /** Product group the repo belongs to (e.g. 'auction'). */
  group?: string
```

Replace `noRepoFailure` so it reports by group:

```typescript
/** No-repo-mapped failure, with a hint listing the group's configured apps. */
function noRepoFailure(group: string): Result<never> {
  const apps = reposForGroup(group)
  const hint = apps.length
    ? `Pass one of its apps: ${apps.join(', ')}.`
    : `Group "${group}" has no repos. Set AGENT_REPOS (e.g. ${group}/api@main).`
  return failure(`No repo mapped for "${group}/${'<app>'}". ${hint}`)
}
```

Replace the `startJob` signature and the lines that resolve the repo:

```typescript
export async function startJob(
  key: string,
  profile: AgentProfile = 'implement',
  group?: string,
  app?: string,
): Promise<Result<{ id: string }>> {
  if (profile === 'acceptance') return startAcceptanceJob(key, group, app)
  if (!group) return failure('group is required')
  if (!app) return noRepoFailure(group)
  const spec = resolveGroupRepo(group, app)
  if (!spec) return noRepoFailure(group)
```

In the `meta` object built inside `startJob`, set `group` and keep `app`:

```typescript
      repo: repoName,
      app,
      group,
      worktree: wtDir,
```

Replace `startAcceptanceJob` signature + staging lookup + repo resolution:

```typescript
async function startAcceptanceJob(key: string, group?: string, app?: string): Promise<Result<{ id: string }>> {
  if (!group) return failure('group is required')
  if (!app) return noRepoFailure(group)
  const stagingUrl = dashboardConfig.stagingUrls[group]
  const spec = resolveGroupRepo(group, app)
  if (!spec) return noRepoFailure(group)
```

In the acceptance `meta` object add `group` (next to `app`):

```typescript
    id, key: detail.key, repo: repoName, app, group, branch: '', baseBranch: '',
```

In `runAcceptance`, the readiness "no staging URL" message currently references `projectKeyOf` — change it to reference the group. Replace that line:

```typescript
    finish(id, 'blocked', { reason: `No staging URL for group (set STAGING_URLS)` })
```

- [ ] **Step 2: Update the start route**

First widen the typed `body` declaration (~line 13) to include `group`:

```typescript
  let body: { key?: string; profile?: string; group?: string; app?: string; apps?: unknown }
```

Then replace the POST handler from the `apps` parsing onward:

```typescript
  const group = typeof body?.group === 'string' ? body.group.trim() : ''
  if (!group) return NextResponse.json(failure('group is required'))
  if (!agentGroups().includes(group)) return NextResponse.json(failure(`Unknown group "${group}"`))

  // A ticket may target several repos: dispatch one isolated job per selected app.
  // Empty apps => the whole group (every repo configured under it).
  const picked = (Array.isArray(body.apps) ? body.apps : body.app ? [body.app] : [])
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    .map((a) => a.trim())
  const apps = picked.length ? picked : reposForGroup(group)
  if (!apps.length) return NextResponse.json(failure(`Group "${group}" has no repos configured`))

  const results = await Promise.all(apps.map((app) => startJob(trimmedKey, profile, group, app)))
  const ids = results.flatMap((r) => (r.ok ? [r.data.id] : []))
  const errors = results.flatMap((r, i) => (r.ok ? [] : [`${apps[i]}: ${r.message}`]))

  // Record the apps that actually started (group-qualified), so the ticket reflects it.
  const startedApps = apps.filter((_, i) => results[i].ok).map((app) => `${group}/${app}`)
  if (startedApps.length) void setIssueApps(trimmedKey, startedApps)

  if (!ids.length) return NextResponse.json(failure(errors.join(' | ') || 'No jobs started'))
  return NextResponse.json(ok({ ids, ...(errors.length ? { errors } : {}) }))
```

Add the import at the top of the file:

```typescript
import { agentGroups, reposForGroup } from '@/dashboard.config'
```

- [ ] **Step 3: Update the apps route to return groups + selection**

Replace the body of `app/api/agent/apps/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { agentGroups, reposForGroup, resolveGroupRepo } from '@/dashboard.config'
import { parseRepoSpec } from '@/lib/agent/prompt'
import { getIssueDetail } from '@/lib/sources/jira'
import { ok, failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

/**
 * Groups + their apps a ticket can be dispatched to, plus the group-qualified apps
 * (`<group>/<app>`) currently recorded on it. GET /api/agent/apps?key=NBDE-417
 */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')?.trim()
  if (!key) return NextResponse.json(failure('key is required'))

  const groups = agentGroups().map((name) => ({
    name,
    apps: reposForGroup(name).map((app) => {
      const { repo, baseBranch } = parseRepoSpec(resolveGroupRepo(name, app) ?? '')
      return { name: app, repo, baseBranch }
    }),
  }))

  const detail = await getIssueDetail(key)
  const selected = detail.ok ? (detail.data.apps ?? []) : []

  return NextResponse.json(ok({ groups, selected }))
}
```

- [ ] **Step 4: Create the groups route**

Create `app/api/agent/groups/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { agentGroups } from '@/dashboard.config'
import { ok } from '@/lib/result'

export const dynamic = 'force-dynamic'

/** Configured product groups for quick-send dispatch. GET /api/agent/groups */
export async function GET() {
  return NextResponse.json(ok({ groups: agentGroups() }))
}
```

- [ ] **Step 5: Delete the dead Jira-keyed helpers**

In `dashboard.config.ts`, delete `reposForProject` and `resolveAgentRepo` (and the doc comment block above `reposForProject` describing the `PROJECT/app` scheme). Their only callers were the runner and apps route, both migrated above.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `tsc` reports an unused/old reference, grep for `reposForProject`/`resolveAgentRepo` and remove the straggler.

- [ ] **Step 7: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS (config + gitlab + jira suites).

- [ ] **Step 8: Commit**

```bash
git add lib/agent/runner.ts app/api/agent/start/route.ts app/api/agent/apps/route.ts app/api/agent/groups/route.ts dashboard.config.ts
git commit -m "feat: dispatch agents by product group (server)"
```

---

### Task 3: Board DispatchDialog — group selector + subset picker

**Files:**
- Modify: `components/board-panel.tsx`

**Interfaces:**
- Consumes: `GET /api/agent/apps?key=` → `{ groups, selected }` (Task 2); `POST /api/agent/start` with `{ key, group, apps }`.
- Produces: no new exports (internal `DispatchDialog` component change).

- [ ] **Step 1: Replace the AppOption type and dialog state**

In `components/board-panel.tsx`, replace the `AppOption` type and the `DispatchDialog` state/fetch block (the `apps`/`sel` state and its `useEffect`) with group-aware versions:

```typescript
type AppOption = { name: string; repo: string; baseBranch: string }
type GroupOption = { name: string; apps: AppOption[] }

/**
 * Pick a product group and which app(s) a ticket targets, then dispatch one autonomous
 * Claude agent per repo (each in its own worktree). Pre-selects the group + apps already
 * recorded on the ticket; the selection is written back as `app:<group>/<app>` labels.
 */
function DispatchDialog({ row, onClose, onDone }: { row: BoardRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [groups, setGroups] = useState<GroupOption[] | null>(null)
  const [group, setGroup] = useState<string>('')
  const [sel, setSel] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/agent/apps?key=${encodeURIComponent(row.key)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (!j.ok) { setErr(j.message ?? 'Failed to load apps'); setGroups([]); return }
        const gs: GroupOption[] = j.data.groups ?? []
        setGroups(gs)
        // Recorded labels look like "auction/api"; default to their group, else the first.
        const recorded: string[] = j.data.selected ?? []
        const firstRecordedGroup = recorded[0]?.split('/')[0]
        const initial = gs.find((g) => g.name === firstRecordedGroup)?.name ?? gs[0]?.name ?? ''
        setGroup(initial)
        setSel(recorded.filter((s) => s.startsWith(`${initial}/`)).map((s) => s.slice(initial.length + 1)))
      })
      .catch(() => { if (alive) { setErr('Failed to load apps'); setGroups([]) } })
    return () => { alive = false }
  }, [row.key])

  const activeApps = groups?.find((g) => g.name === group)?.apps ?? []
  const hasGroups = !!groups && groups.length > 0
  const allSelected = activeApps.length > 0 && sel.length === activeApps.length

  const pickGroup = (name: string) => { setGroup(name); setSel([]) }
  const toggle = (name: string) =>
    setSel((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]))
  const toggleAll = () =>
    setSel(allSelected ? [] : activeApps.map((a) => a.name))
```

- [ ] **Step 2: Replace the dispatch function to send the group**

Replace the `dispatch` function inside `DispatchDialog`:

```typescript
  async function dispatch(whole: boolean) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: row.key, group, apps: whole ? [] : sel }),
      })
      const j = await res.json()
      if (j.ok) {
        const n = j.data.ids?.length ?? 0
        onDone(`Dispatched ${row.key} → ${n} agent${n === 1 ? '' : 's'} (see Agents page)`)
        onClose()
      } else {
        setErr(j.message ?? 'Dispatch failed')
      }
    } finally {
      setBusy(false)
    }
  }
```

- [ ] **Step 3: Replace the dialog body (group chips + app list + actions)**

Replace the JSX returned by `DispatchDialog` (from the `{err && ...}` line down through the action buttons) with:

```tsx
        {err && <p className="text-[11px] text-destructive">[ FAIL ] {err}</p>}

        {groups === null ? (
          <p className="text-[11px] text-muted-foreground">loading…</p>
        ) : !hasGroups ? (
          <p className="text-[11px] text-amber-500">
            No groups configured — set AGENT_REPOS (e.g. auction/api@main).
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => pickGroup(g.name)}
                  className={cn(
                    'border px-2 py-1 text-xs',
                    g.name === group ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:bg-muted/40',
                  )}
                >
                  {g.name}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">Which application(s)? Pre-filled from the ticket.</p>
              <button type="button" onClick={toggleAll} className="text-[11px] text-primary underline underline-offset-2">
                {allSelected ? 'clear' : 'select all'}
              </button>
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto border border-border bg-background/60 p-1.5">
              {activeApps.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => toggle(a.name)}
                  className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs hover:bg-muted/40"
                >
                  <Check className={cn('size-3.5 shrink-0', sel.includes(a.name) ? 'opacity-100 text-primary' : 'opacity-0')} />
                  <span className="text-foreground">{a.repo}</span>
                  <span className="ml-auto text-muted-foreground">{a.baseBranch}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" variant="outline" onClick={() => dispatch(true)} disabled={busy || !hasGroups}>
            {busy ? '…' : `Whole ${group || 'group'} (${activeApps.length})`}
          </Button>
          <Button size="sm" onClick={() => dispatch(false)} disabled={busy || !hasGroups || sel.length === 0}>
            {busy ? 'Dispatching…' : `Dispatch ${sel.length || ''}`.trim()}
          </Button>
        </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`Check`, `cn`, `Button`, `useState`, `useEffect` are already imported in this file.)

- [ ] **Step 5: Commit**

```bash
git add components/board-panel.tsx
git commit -m "feat: group selector + subset picker in board dispatch dialog"
```

---

### Task 4: Quick-send group selectors (desktop + mobile)

**Files:**
- Modify: `components/agents-panel.tsx`
- Modify: `components/mobile-agents.tsx`

**Interfaces:**
- Consumes: `GET /api/agent/groups` → `{ groups: string[] }`; `POST /api/agent/start` with `{ key, group }` (apps omitted ⇒ whole group).
- Produces: no new exports.

- [ ] **Step 1: Desktop AgentsPanel — load groups + add a selector**

In `components/agents-panel.tsx`, inside `AgentsPanel`, add group state and load it (after the existing `token` effect):

```typescript
  const [groups, setGroups] = useState<string[]>([])
  const [group, setGroup] = useState<string>('')
  useEffect(() => {
    fetch('/api/agent/groups')
      .then((r) => r.json())
      .then((j) => { if (j.ok) { setGroups(j.data.groups); setGroup(j.data.groups[0] ?? '') } })
      .catch(() => {})
  }, [])
```

Replace the `body` line in `send()` so it includes the group:

```typescript
        body: JSON.stringify({ key: k, group }),
```

Guard `send()` so it no-ops without a group (replace the first two lines of `send`):

```typescript
    const k = key.trim()
    if (!k || busy || !group) return
```

In the JSX, add a group `<select>` before the `<Input>` in the send row (inside the `<div className="flex gap-2">`):

```tsx
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className="rounded-none border border-input bg-transparent px-2 font-mono text-sm"
            >
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
```

Update the disabled state of the send Button:

```tsx
            <Button onClick={send} disabled={busy || !group} className="rounded-none font-mono">
```

- [ ] **Step 2: Mobile — load groups + dispatch with the active group**

In `components/mobile-agents.tsx`, inside `MobileAgents`, add group state + load (after the `token` effect):

```typescript
  const [groups, setGroups] = useState<string[]>([])
  const [group, setGroup] = useState<string>('')
  useEffect(() => {
    fetch('/api/agent/groups')
      .then((r) => r.json())
      .then((j) => { if (j.ok) { setGroups(j.data.groups); setGroup(j.data.groups[0] ?? '') } })
      .catch(() => {})
  }, [])
```

Change `dispatch` to send the active group:

```typescript
  async function dispatch(key: string) {
    if (!group) { setMsg('No group configured'); return }
    setBusyKey(key)
    setMsg(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: buildTriggerHeaders(token),
        body: JSON.stringify({ key, group }),
      })
      const json = await res.json()
      if (json.ok) {
        setMsg(`Dispatched ${key} → ${group}`)
        setSelected(json.data.ids?.[0] ?? null)
      } else {
        setMsg(json.message ?? 'Failed to start')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusyKey(null)
    }
  }
```

Add group chips above the "My tickets" section (immediately before the `<section className="space-y-2">` that holds tickets):

```tsx
      {groups.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setGroup(g)}
              className={`border px-3 py-1 text-xs ${g === group ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}
            >
              {g}
            </button>
          ))}
        </div>
      )}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/agents-panel.tsx components/mobile-agents.tsx
git commit -m "feat: group selectors on desktop + mobile quick-send"
```

---

### Task 5: Config docs + the user's live `.env.local`

**Files:**
- Modify: `.env.local.example`
- Modify: `.env.local` (gitignored — NOT committed)

**Interfaces:** none (config only).

- [ ] **Step 1: Update the committed example**

In `.env.local.example`, replace the agent-dispatch comment block (the lines documenting `AGENT_REPOS`) with:

```bash
# Agent dispatch — group your repos as "<group>/<app>" -> "<repo dir under ~/workspace>@<base>".
# A group (e.g. auction, lease) is the dispatch unit: selecting it fans out one autonomous
# agent per repo, each in an isolated worktree opening its own MR. Shorthand: an entry with
# no ":value" defaults its repo path to the key, so "auction/api@main" == "auction/api:auction/api@main".
# AGENT_GROUPS="auction,lease"   # optional: fixes group order in the UI
# AGENT_REPOS="auction/api@main,auction/fe@main,lease/api@main,lease/fe-bff@main"
# STAGING_URLS="auction:https://auction-stg.example.com,lease:https://lease-stg.example.com"
```

- [ ] **Step 2: Update the live config so auction + lease both dispatch**

In `.env.local`, replace the existing `AGENT_REPOS=...` line (and add `AGENT_GROUPS`) with:

```bash
AGENT_GROUPS="auction,lease"
AGENT_REPOS="auction/api@main,auction/api-ai@main,auction/app-fe@main,auction/aws-lambda@main,auction/bff-erp@main,auction/fe@main,auction/fe-erp@main,auction/inventory-capture-ext@main,auction/web-bff@main,lease/api@main,lease/fe-bff@main,lease/fe-erp@main"
```

If `STAGING_URLS` is present and keyed by `NBDE`, re-key it by group (`auction:…,lease:…`); if absent, leave it (the acceptance profile simply stays non-runnable until set).

- [ ] **Step 3: Commit the example only**

```bash
git add .env.local.example
git commit -m "docs: document group-based AGENT_REPOS config"
```

- [ ] **Step 4: Manual end-to-end verification**

Restart the dev server (it reads env at boot), then:

```bash
curl -s localhost:3000/api/agent/groups
```
Expected: `{"ok":true,"data":{"groups":["auction","lease"]}}`

```bash
curl -s "localhost:3000/api/agent/apps?key=NBDE-1" | head -c 400
```
Expected: JSON with a `groups` array containing `auction` (9 apps) and `lease` (3 apps), plus `selected`.

Then in the board UI: open a ticket's dispatch dialog → confirm the `auction | lease` chips appear, switching groups swaps the app list, "select all" and the per-app checkboxes work, and "Whole auction (9)" / "Dispatch N" both POST without error.

---

## Self-Review

**Spec coverage:**
- Config re-namespace + shorthand + helpers → Task 1.
- `STAGING_URLS` re-keyed by group → Task 2 (runner) + Task 5 (config).
- Runner `group` param + `JobMeta.group` + group-keyed staging → Task 2.
- `POST /api/agent/start` `group` + whole-group expansion + group-qualified labels → Task 2.
- `GET /api/agent/apps` returns groups + selection → Task 2.
- Group list for quick paths (`/api/agent/groups`) → Task 2.
- DispatchDialog group selector + subset + select-all → Task 3.
- Quick-send group selectors, fire-immediately → Task 4.
- `app:<group>/<app>` labels (no parser change) → Task 2 start route writes them; `parseAppLabels` unchanged.
- Config tests → Task 1.

**Placeholder scan:** No TBD/TODO; every code step shows full code. The `'<app>'` token in `noRepoFailure` is intentional literal display text, not a placeholder.

**Type consistency:** `agentGroups`/`reposForGroup`/`resolveGroupRepo` signatures match between Task 1 (definition) and Tasks 2–3 (use). `startJob(key, profile, group, app)` order is consistent across the runner definition and the start-route call. The apps route returns `{ groups, selected }` (Task 2) and Task 3 reads exactly those keys. `/api/agent/groups` returns `{ groups: string[] }` and Task 4 reads `j.data.groups`.
