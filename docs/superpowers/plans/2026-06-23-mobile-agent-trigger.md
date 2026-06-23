# Mobile Agent Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user trigger and monitor headless-`claude` agent jobs from a phone over Tailscale, with the agent still running on the Mac, guarded by an optional shared-secret PIN.

**Architecture:** A new mobile-optimized page (`/m`) is a thin client over the existing agent/Jira API routes. The dashboard server binds to all interfaces so the Mac is reachable at its Tailscale MagicDNS address. An optional `AGENT_TRIGGER_TOKEN` env var gates the mutating endpoints (`start`, `cancel`) via an `x-agent-token` header; both the mobile page and the existing desktop panel attach the PIN from `localStorage`.

**Tech Stack:** Next.js 16 App Router (route handlers + RSC), React 19, TypeScript, Tailwind v4, shadcn/ui, Vitest (node env), `node:crypto`.

## Global Constraints

- **Next.js is non-standard here.** Per `AGENTS.md`: before writing any Next.js code (route handlers, pages, metadata/viewport), read the relevant guide under `node_modules/next/dist/docs/`. Route handlers in this repo use `export const dynamic = 'force-dynamic'` and `params` typed as `Promise<{ … }>` (see `app/api/agent/jobs/[id]/cancel/route.ts`).
- **Result type:** all API routes return a `Result<T>` from `lib/result.ts` (`ok` / `failure` / `unconfigured`). Do not invent new envelope shapes.
- **Tests:** Vitest `environment: 'node'`, `include: ['lib/**/*.test.ts']` only. Testable logic must live under `lib/` (route handlers and `components/` are not collected). Use `import { expect, test } from 'vitest'`.
- **server-only:** files that must never reach the client start with `import 'server-only'` (aliased to a no-op in tests). Client-importable helpers must NOT import `server-only` or `node:*`.
- **Back-compat:** when `AGENT_TRIGGER_TOKEN` is unset/empty, all requests are allowed — existing desktop behavior is unchanged.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/agent/token.ts` (create) | Server: `isAgentRequestAuthorized(headers)` — timing-safe PIN check; allows all when unset. |
| `lib/agent/token.test.ts` (create) | Unit tests for the gate (4 cases). |
| `app/api/agent/start/route.ts` (modify) | Reject unauthorized dispatch before spawning. |
| `app/api/agent/jobs/[id]/cancel/route.ts` (modify) | Reject unauthorized cancel. |
| `lib/agent-token-client.ts` (create) | Client: `buildTriggerHeaders` (pure) + `localStorage` load/save/clear of the PIN. |
| `lib/agent-token-client.test.ts` (create) | Unit tests for `buildTriggerHeaders`. |
| `components/mobile-agents.tsx` (create) | Mobile UI: PIN entry, "my tickets" with dispatch, running-jobs list, slim job detail. |
| `app/m/page.tsx` (create) | Route that renders `<MobileAgents />`. |
| `components/agents-panel.tsx` (modify) | Desktop: attach PIN header to start/cancel/retry; small PIN entry affordance. |
| `package.json` (modify) | Add `dev:lan` / `start:lan` scripts. |
| `README.md` (modify) | Document Tailscale access, the `/m` page, and `AGENT_TRIGGER_TOKEN`. |

---

## Task 1: Server token gate

**Files:**
- Create: `lib/agent/token.ts`
- Test: `lib/agent/token.test.ts`

**Interfaces:**
- Produces: `isAgentRequestAuthorized(headers: Headers): boolean` — `true` when `AGENT_TRIGGER_TOKEN` is unset/empty, or when the `x-agent-token` header timing-safely equals it; `false` otherwise.

- [ ] **Step 1: Write the failing test**

Create `lib/agent/token.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { isAgentRequestAuthorized } from './token'

afterEach(() => {
  delete process.env.AGENT_TRIGGER_TOKEN
})

const h = (token?: string) => new Headers(token ? { 'x-agent-token': token } : {})

test('allows any request when AGENT_TRIGGER_TOKEN is unset', () => {
  expect(isAgentRequestAuthorized(h())).toBe(true)
  expect(isAgentRequestAuthorized(h('whatever'))).toBe(true)
})

test('allows when the header matches the configured token', () => {
  process.env.AGENT_TRIGGER_TOKEN = 's3cret-pin'
  expect(isAgentRequestAuthorized(h('s3cret-pin'))).toBe(true)
})

test('denies when the header is missing', () => {
  process.env.AGENT_TRIGGER_TOKEN = 's3cret-pin'
  expect(isAgentRequestAuthorized(h())).toBe(false)
})

test('denies when the header is wrong, including a different length', () => {
  process.env.AGENT_TRIGGER_TOKEN = 's3cret-pin'
  expect(isAgentRequestAuthorized(h('nope'))).toBe(false)
  expect(isAgentRequestAuthorized(h('s3cret-pi'))).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent/token.test.ts`
Expected: FAIL — cannot resolve `./token` / `isAgentRequestAuthorized is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/agent/token.ts`:

```ts
import 'server-only'
import { timingSafeEqual } from 'node:crypto'

const HEADER = 'x-agent-token'

/** Constant-time compare; returns false (fast) when lengths differ. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Whether a mutating agent request is authorized.
 * AGENT_TRIGGER_TOKEN unset/empty => all requests allowed (back-compat).
 * Set => request must carry a matching `x-agent-token` header.
 */
export function isAgentRequestAuthorized(headers: Headers): boolean {
  const expected = process.env.AGENT_TRIGGER_TOKEN
  if (!expected) return true
  return safeEqual(headers.get(HEADER) ?? '', expected)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent/token.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent/token.ts lib/agent/token.test.ts
git commit -m "feat: server-side agent trigger token gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Gate the mutating routes

**Files:**
- Modify: `app/api/agent/start/route.ts`
- Modify: `app/api/agent/jobs/[id]/cancel/route.ts`

**Interfaces:**
- Consumes: `isAgentRequestAuthorized(headers: Headers)` from Task 1; `failure(message)` from `lib/result.ts`.

> No Vitest coverage here (route handlers are outside the `lib/**` include); the gate logic is fully tested in Task 1. Verify manually in Step 3.

- [ ] **Step 1: Gate the start route**

Replace the full contents of `app/api/agent/start/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { startJob } from '@/lib/agent/runner'
import { isAgentRequestAuthorized } from '@/lib/agent/token'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!isAgentRequestAuthorized(req.headers))
    return NextResponse.json(failure('Unauthorized: invalid or missing agent token'), { status: 401 })
  let body: { key?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('Invalid JSON body'))
  }
  const key = body?.key
  if (!key || typeof key !== 'string') return NextResponse.json(failure('key is required'))
  return NextResponse.json(await startJob(key.trim()))
}
```

- [ ] **Step 2: Gate the cancel route**

Replace the full contents of `app/api/agent/jobs/[id]/cancel/route.ts` with:

```ts
import { NextResponse } from 'next/server'
import { cancelJob } from '@/lib/agent/runner'
import { isAgentRequestAuthorized } from '@/lib/agent/token'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRequestAuthorized(req.headers))
    return NextResponse.json(failure('Unauthorized: invalid or missing agent token'), { status: 401 })
  const { id } = await params
  return NextResponse.json(cancelJob(id))
}
```

- [ ] **Step 3: Verify manually**

Run the type check and a live probe:

```bash
npx tsc --noEmit
# In one terminal:  AGENT_TRIGGER_TOKEN=test-pin npm run dev
# In another:
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/agent/start \
  -H 'Content-Type: application/json' -d '{"key":"NBDE-1"}'        # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/agent/start \
  -H 'Content-Type: application/json' -H 'x-agent-token: test-pin' -d '{"key":"NBDE-1"}'  # expect 200
```
Expected: `tsc` clean; first curl `401`, second `200` (a `Result` body — it may still be a `failure` about repo mapping, but the status is 200, proving the gate passed).

- [ ] **Step 4: Commit**

```bash
git add app/api/agent/start/route.ts app/api/agent/jobs/\[id\]/cancel/route.ts
git commit -m "feat: require agent token on start/cancel routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Client token helper

**Files:**
- Create: `lib/agent-token-client.ts`
- Test: `lib/agent-token-client.test.ts`

**Interfaces:**
- Produces:
  - `buildTriggerHeaders(token: string | null): Record<string, string>` — always `{ 'Content-Type': 'application/json' }`, plus `{ 'x-agent-token': token }` when `token` is truthy.
  - `loadAgentToken(): string | null` — reads `localStorage`; returns `null` server-side.
  - `saveAgentToken(token: string): void`
  - `clearAgentToken(): void`

> This file is client-importable: NO `import 'server-only'`, NO `node:*`. `localStorage` access is guarded behind `typeof window` so importing it (and the test) is safe in node.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-token-client.test.ts`:

```ts
import { expect, test } from 'vitest'
import { buildTriggerHeaders } from './agent-token-client'

test('always includes JSON content-type', () => {
  expect(buildTriggerHeaders(null)['Content-Type']).toBe('application/json')
})

test('omits the token header when there is no token', () => {
  expect('x-agent-token' in buildTriggerHeaders(null)).toBe(false)
  expect('x-agent-token' in buildTriggerHeaders('')).toBe(false)
})

test('attaches the token header when a token is provided', () => {
  expect(buildTriggerHeaders('pin123')['x-agent-token']).toBe('pin123')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent-token-client.test.ts`
Expected: FAIL — cannot resolve `./agent-token-client`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/agent-token-client.ts`:

```ts
const KEY = 'agent-trigger-token'
const HEADER = 'x-agent-token'

/** Headers for a mutating agent request; attaches the PIN when present. */
export function buildTriggerHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers[HEADER] = token
  return headers
}

export function loadAgentToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(KEY)
}

export function saveAgentToken(token: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, token)
}

export function clearAgentToken(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(KEY)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent-token-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent-token-client.ts lib/agent-token-client.test.ts
git commit -m "feat: client helper for agent trigger PIN

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Mobile page (`/m`)

**Files:**
- Create: `components/mobile-agents.tsx`
- Create: `app/m/page.tsx`

**Interfaces:**
- Consumes: `buildTriggerHeaders`, `loadAgentToken`, `saveAgentToken`, `clearAgentToken` (Task 3); `usePoll` (`lib/use-poll.ts`); types `Issue` (`lib/sources/jira.ts`), `JobMeta`/`JobDetail` (`lib/agent/runner.ts`). API routes already exist: `GET /api/jira/my`, `GET /api/agent/jobs`, `GET /api/agent/jobs/[id]`, `POST /api/agent/start`, `POST /api/agent/jobs/[id]/cancel`.

> Mobile viewport: Next.js injects `<meta name="viewport" content="width=device-width, initial-scale=1">` by default (the root layout sets only `metadata`, not `viewport`), so no extra config is needed. Confirm in Step 4 via page source.

- [ ] **Step 1: Create the client component**

Create `components/mobile-agents.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import {
  buildTriggerHeaders,
  loadAgentToken,
  saveAgentToken,
  clearAgentToken,
} from '@/lib/agent-token-client'
import type { Issue } from '@/lib/sources/jira'
import type { JobMeta, JobDetail } from '@/lib/agent/runner'

const STATUS_COLOR: Record<JobMeta['status'], string> = {
  running: 'text-primary',
  done: 'text-primary',
  failed: 'text-destructive',
  canceled: 'text-muted-foreground',
}

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function PinBar({ token, onSave, onClear }: {
  token: string | null
  onSave: (t: string) => void
  onClear: () => void
}) {
  const [value, setValue] = useState('')
  if (token) {
    return (
      <div className="flex items-center justify-between border border-border p-3 font-mono text-xs">
        <span className="text-muted-foreground">PIN saved on this device</span>
        <button onClick={onClear} className="text-primary underline underline-offset-2">
          Forget
        </button>
      </div>
    )
  }
  return (
    <div className="flex gap-2 border border-border p-3">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Trigger PIN"
        className="min-w-0 flex-1 bg-transparent font-mono text-base outline-none"
      />
      <button
        onClick={() => value && onSave(value)}
        className="shrink-0 border border-border px-3 py-2 font-mono text-sm text-primary"
      >
        Save
      </button>
    </div>
  )
}

function MobileJobDetail({ id, token }: { id: string; token: string | null }) {
  const job = usePoll<JobDetail>(`/api/agent/jobs/${id}`, 3000)
  const [busy, setBusy] = useState(false)
  if (!job.data?.ok) return null
  const { meta, events, mrUrl } = job.data.data
  const running = meta.status === 'running'

  async function cancel() {
    setBusy(true)
    try {
      await fetch(`/api/agent/jobs/${id}/cancel`, { method: 'POST', headers: buildTriggerHeaders(token) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border border-border p-3">
      <div className="flex items-center gap-2 font-mono text-sm">
        <span className="font-semibold">{meta.key}</span>
        <span className={STATUS_COLOR[meta.status]}>● {meta.status}</span>
        {running && (
          <button
            onClick={cancel}
            disabled={busy}
            className="ml-auto border border-border px-2 py-1 text-xs"
          >
            Cancel
          </button>
        )}
      </div>
      {mrUrl && (
        <a href={mrUrl} target="_blank" rel="noreferrer" className="block font-mono text-xs text-primary underline">
          → {mrUrl}
        </a>
      )}
      <div className="max-h-72 space-y-0.5 overflow-y-auto bg-muted/20 p-2 font-mono text-xs">
        {events.length === 0 ? (
          <p className="text-muted-foreground">waiting for output…</p>
        ) : (
          events.slice(-40).map((e, i) => (
            <div key={`${e.ts}-${i}`} className="break-words">
              <span className="text-muted-foreground/60">{timeOf(e.ts)} </span>
              {e.label}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function MobileAgents() {
  const [token, setToken] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    setToken(loadAgentToken())
  }, [])

  const tickets = usePoll<Issue[]>('/api/jira/my', 20000)
  const jobs = usePoll<JobMeta[]>('/api/agent/jobs', 3000)
  const ticketList = tickets.data?.ok ? tickets.data.data : []
  const jobList = jobs.data?.ok ? jobs.data.data : []

  async function dispatch(key: string) {
    setBusyKey(key)
    setMsg(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: buildTriggerHeaders(token),
        body: JSON.stringify({ key }),
      })
      const json = await res.json()
      if (json.ok) {
        setMsg(`Dispatched ${key}`)
        setSelected(json.data.id)
      } else {
        setMsg(json.message ?? 'Failed to start')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4 font-mono">
      <h1 className="text-sm tracking-tight text-muted-foreground">$ agents — mobile</h1>

      <PinBar
        token={token}
        onSave={(t) => { saveAgentToken(t); setToken(t) }}
        onClear={() => { clearAgentToken(); setToken(null) }}
      />

      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

      <section className="space-y-2">
        <h2 className="text-xs text-muted-foreground">My tickets</h2>
        {ticketList.length === 0 ? (
          <p className="text-xs text-muted-foreground">no tickets</p>
        ) : (
          ticketList.map((t) => (
            <div key={t.key} className="flex items-center gap-2 border border-border p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t.key}</div>
                <div className="truncate text-xs text-muted-foreground">{t.summary}</div>
              </div>
              <button
                onClick={() => dispatch(t.key)}
                disabled={busyKey === t.key}
                className="shrink-0 border border-primary/40 px-3 py-2 text-sm text-primary disabled:opacity-50"
              >
                {busyKey === t.key ? '…' : 'Dispatch'}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs text-muted-foreground">Running jobs</h2>
        {jobList.length === 0 ? (
          <p className="text-xs text-muted-foreground">no jobs yet</p>
        ) : (
          jobList.map((j) => (
            <button
              key={j.id}
              onClick={() => setSelected(j.id === selected ? null : j.id)}
              className="flex w-full items-center gap-2 border border-border p-3 text-left text-xs"
            >
              <span className="font-semibold">{j.key}</span>
              <span className="truncate text-muted-foreground">{j.branch}</span>
              <span className={`ml-auto ${STATUS_COLOR[j.status]}`}>● {j.status}</span>
            </button>
          ))
        )}
      </section>

      {selected && <MobileJobDetail id={selected} token={token} />}
    </div>
  )
}
```

- [ ] **Step 2: Create the route**

Create `app/m/page.tsx`:

```tsx
import { MobileAgents } from '@/components/mobile-agents'

export default function MobilePage() {
  return <MobileAgents />
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 4: Verify in a browser**

```bash
npm run dev
```
Open `http://localhost:3000/m`. Expected: a narrow single-column page with a PIN bar, a "My tickets" list (or "no tickets" if Jira unconfigured), and "Running jobs". View source and confirm `<meta name="viewport" content="width=device-width, initial-scale=1"/>` is present. Dispatching a real ticket key shows it appear under Running jobs and opens the detail tail.

- [ ] **Step 5: Commit**

```bash
git add components/mobile-agents.tsx app/m/page.tsx
git commit -m "feat: mobile agent trigger page at /m

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Send the PIN from the desktop panel

**Files:**
- Modify: `components/agents-panel.tsx`

**Interfaces:**
- Consumes: `buildTriggerHeaders`, `loadAgentToken`, `saveAgentToken`, `clearAgentToken` (Task 3).

Goal: the desktop panel attaches the PIN header to its three mutating calls (`send`, `JobView.cancel`, `JobView.retry`) and offers a small PIN entry. The PIN is read once and passed down to `JobView`.

- [ ] **Step 1: Import the client helper**

At the top of `components/agents-panel.tsx`, add to the existing imports:

```tsx
import {
  buildTriggerHeaders,
  loadAgentToken,
  saveAgentToken,
  clearAgentToken,
} from '@/lib/agent-token-client'
```

- [ ] **Step 2: Replace the module-level `postJson` helper**

Find:

```tsx
async function postJson(url: string): Promise<{ ok: boolean; data?: any; message?: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  return res.json()
}
```

Replace with (header now carries the PIN):

```tsx
async function postJson(url: string, token: string | null): Promise<{ ok: boolean; data?: any; message?: string }> {
  const res = await fetch(url, { method: 'POST', headers: buildTriggerHeaders(token) })
  return res.json()
}
```

- [ ] **Step 3: Thread the token through `JobView`**

Change the `JobView` signature from:

```tsx
function JobView({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
```
to:
```tsx
function JobView({ id, token, onSelect }: { id: string; token: string | null; onSelect: (id: string) => void }) {
```

In `JobView`, change the `cancel` call from `await postJson(`/api/agent/jobs/${id}/cancel`)` to:

```tsx
      await postJson(`/api/agent/jobs/${id}/cancel`, token)
```

And change the `retry` fetch headers from `headers: { 'Content-Type': 'application/json' }` to:

```tsx
        headers: buildTriggerHeaders(token),
```

- [ ] **Step 4: Hold the token in `AgentsPanel` and pass it down**

In `AgentsPanel`, add token state near the other `useState` hooks:

```tsx
  const [token, setToken] = useState<string | null>(null)
  useEffect(() => {
    setToken(loadAgentToken())
  }, [])
```

(Ensure `useEffect` is in the React import: `import { useEffect, useRef, useState } from 'react'`.)

In `AgentsPanel`'s `send`, change the dispatch fetch headers from `headers: { 'Content-Type': 'application/json' }` to:

```tsx
        headers: buildTriggerHeaders(token),
```

Change the render of the selected job from:

```tsx
      {selected && <JobView id={selected} onSelect={setSelected} />}
```
to:
```tsx
      {selected && <JobView id={selected} token={token} onSelect={setSelected} />}
```

- [ ] **Step 5: Add a PIN affordance to the "Send Ticket to Claude" card**

Inside the first `<CardContent className="space-y-2 pt-4">`, immediately after the existing `{msg && <p …>}` line, add:

```tsx
          {token ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              PIN set ·{' '}
              <button
                type="button"
                onClick={() => { clearAgentToken(); setToken(null) }}
                className="text-primary underline underline-offset-2"
              >
                forget
              </button>
            </p>
          ) : (
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="Trigger PIN (only if AGENT_TRIGGER_TOKEN is set)"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const v = (e.target as HTMLInputElement).value.trim()
                  if (v) { saveAgentToken(v); setToken(v) }
                }}
                className="rounded-none font-mono text-xs"
              />
            </div>
          )}
```

- [ ] **Step 6: Type-check and verify**

Run: `npx tsc --noEmit`
Expected: clean.

Then with `AGENT_TRIGGER_TOKEN` unset, run `npm run dev` and confirm the desktop Agents page dispatches a ticket exactly as before (no PIN needed). Set the PIN field, and it should persist (the card shows "PIN set · forget").

- [ ] **Step 7: Commit**

```bash
git add components/agents-panel.tsx
git commit -m "feat: desktop agents panel sends trigger PIN

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: LAN scripts and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add LAN run scripts**

In `package.json`, within `"scripts"`, add `dev:lan` and `start:lan` so the block reads:

```json
  "scripts": {
    "dev": "next dev",
    "dev:lan": "next dev -H 0.0.0.0",
    "build": "next build",
    "start": "next start",
    "start:lan": "next start -H 0.0.0.0",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 2: Verify the script binds to all interfaces**

Run: `npm run dev:lan`
Expected: Next.js logs a `Network:` URL alongside `Local:` (e.g. `http://0.0.0.0:3000`), confirming it bound beyond loopback. Stop it with Ctrl-C.

- [ ] **Step 3: Document Tailscale access + the PIN**

In `README.md`, add a new section immediately before `## Notes & known limitations`:

```markdown
## Trigger agents from your phone (Tailscale)

The Agents page dispatches a Jira ticket to a headless `claude` agent that
runs **on this machine**. To trigger and watch jobs from your phone:

1. Install [Tailscale](https://tailscale.com/) on both the Mac and the phone,
   signed into the same tailnet.
2. On the Mac, run the dashboard bound to all interfaces:
   - `npm run dev:lan` (or `npm run start:lan` for a production build)
3. On the phone, open `http://<mac>.<tailnet>.ts.net:3000/m` — the Mac's
   Tailscale MagicDNS name. `/m` is a phone-optimized view: your assigned
   tickets with a **Dispatch** button, plus a live list of running jobs.

### Trigger PIN (`AGENT_TRIGGER_TOKEN`)

Dispatching runs an autonomous agent with bypassed permissions, so the
mutating endpoints can require a shared secret as defense-in-depth on top of
Tailscale:

- Set `AGENT_TRIGGER_TOKEN=<some-pin>` in `.env.local`.
- When set, `POST /api/agent/start` and the cancel endpoint require an
  `x-agent-token` header matching the PIN. Enter the PIN once on each device
  (phone `/m` page or the desktop Agents page) — it is stored in
  `localStorage` and attached automatically.
- When unset, no PIN is required (default).

Binding to `0.0.0.0` also exposes port 3000 on any other network the Mac
joins; the PIN mitigates this. Leave the server on `npm run dev`
(loopback-only) when you don't need phone access.
```

- [ ] **Step 4: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass (including the two new files).

```bash
git add package.json README.md
git commit -m "feat: LAN run scripts and Tailscale/phone docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` — all green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] Manual: with `AGENT_TRIGGER_TOKEN` set, `/m` on the phone dispatches a ticket only after the PIN is entered; the desktop panel still works on localhost; a wrong/absent PIN yields a 401 surfaced as a failure message.
- [ ] Update the open MR/PR description for `feat/dev-dashboard` to mention the mobile trigger + PIN (per the repo's global rule on keeping MR descriptions current).
