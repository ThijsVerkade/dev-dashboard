# AWS Login Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-block the desktop dashboard behind a login screen that triggers `aws sso login` and only reveals the dashboard once AWS credentials are valid.

**Architecture:** A cheap server probe (`GET /api/cloudwatch/auth-status`) reports whether AWS creds are currently valid. A client gate component wraps the `(dashboard)` layout body: it probes on mount, shows a login screen while creds are missing, triggers the existing `POST /api/cloudwatch/login` route on click, polls the probe until it returns `ok`, then renders the dashboard. The mobile surface is untouched.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, `@aws-sdk/client-cloudwatch-logs`, vitest.

## Global Constraints

- This is **NOT** stock Next.js — read `node_modules/next/dist/docs/` before writing framework code; heed deprecation notices (per `AGENTS.md`).
- Result shape is `lib/result.ts`: `{ ok: true; data: T } | { ok: false; reason: 'unconfigured' | 'error'; message: string }`. Use the `ok()` / `unconfigured()` / `failure()` builders.
- Server-only modules (touching AWS SDK / `node:child_process`) must not be imported into client components. `lib/sources/cloudwatch.ts` starts with `import 'server-only'`.
- The login route is loopback-only by design — do not weaken that.
- Client fetch helpers live in a module **without** `server-only` so both the gate and the panel can import them.
- Commit after each task. Branch is `feat/dev-dashboard` (already off `main`).

---

### Task 1: Client-safe login helpers (pure logic + fetch wrappers)

**Files:**
- Create: `lib/aws-login-client.ts`
- Test: `lib/aws-login-client.test.ts`

**Interfaces:**
- Consumes: `Result` type from `@/lib/result`.
- Produces:
  - `type GateState = 'checking' | 'authed' | 'needs-login' | 'error'`
  - `gateEnv(envs: string[]): string | undefined`
  - `nextGateState(result: Result<unknown>): GateState`
  - `triggerSsoLogin(env: string): Promise<{ ok: boolean; message?: string }>`
  - `fetchAuthStatus(env: string): Promise<Result<{ profile?: string }>>`

- [ ] **Step 1: Write the failing test**

Create `lib/aws-login-client.test.ts`:

```ts
import { expect, test } from 'vitest'
import { gateEnv, nextGateState } from './aws-login-client'
import { ok, unconfigured, failure } from './result'

test('gateEnv prefers dev, else first configured env, else undefined', () => {
  expect(gateEnv(['stg', 'dev', 'prod'])).toBe('dev')
  expect(gateEnv(['stg', 'prod'])).toBe('stg')
  expect(gateEnv([])).toBeUndefined()
})

test('nextGateState maps a Result to a gate status', () => {
  expect(nextGateState(ok({}))).toBe('authed')
  expect(nextGateState(unconfigured('no creds'))).toBe('needs-login')
  expect(nextGateState(failure('boom'))).toBe('error')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/aws-login-client.test.ts`
Expected: FAIL — cannot resolve `./aws-login-client` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/aws-login-client.ts`:

```ts
// Client-safe helpers for the local AWS SSO login flow. Shared by the login
// gate and the Logs panel. NO `server-only` import — these run in the browser.
import type { Result } from '@/lib/result'

export type GateState = 'checking' | 'authed' | 'needs-login' | 'error'

/** Which env the gate probes / logs in for: prefer 'dev', else the first. */
export function gateEnv(envs: string[]): string | undefined {
  if (envs.includes('dev')) return 'dev'
  return envs[0]
}

/** Map an auth-status Result to a gate status. */
export function nextGateState(result: Result<unknown>): GateState {
  if (result.ok) return 'authed'
  return result.reason === 'unconfigured' ? 'needs-login' : 'error'
}

/** Ask the server to run `aws sso login` (opens the browser). Never throws. */
export async function triggerSsoLogin(env: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`/api/cloudwatch/login?env=${encodeURIComponent(env)}`, { method: 'POST' })
    return (await res.json()) as { ok: boolean; message?: string }
  } catch {
    return { ok: false, message: 'Could not reach the login endpoint.' }
  }
}

/** Fetch current AWS auth status for an env. */
export async function fetchAuthStatus(env: string): Promise<Result<{ profile?: string }>> {
  const res = await fetch(`/api/cloudwatch/auth-status?env=${encodeURIComponent(env)}`)
  return (await res.json()) as Result<{ profile?: string }>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/aws-login-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/aws-login-client.ts lib/aws-login-client.test.ts
git commit -m "feat: client-safe AWS login helpers (gate state + fetch wrappers)"
```

---

### Task 2: Server auth-status probe + route

**Files:**
- Modify: `lib/sources/cloudwatch.ts` (add `probeAuth`, after `getServiceMap` ~line 98)
- Create: `app/api/cloudwatch/auth-status/route.ts`

**Interfaces:**
- Consumes: existing `client(env)`, `isMissingCreds(err)`, `ok`/`unconfigured`/`failure` in `cloudwatch.ts`; `DescribeLogGroupsCommand` (already imported).
- Produces: `probeAuth(env: string): Promise<Result<{ profile?: string }>>`; route `GET /api/cloudwatch/auth-status?env=<env>` returning that `Result` as JSON.

> **Note on testing:** `probeAuth` is an I/O function against the AWS SDK, following the same pattern as the existing untested `getServiceMap`. Per repo convention these source functions are verified by build + manual run, not unit tests. Its credential-error mapping reuses the already-correct `isMissingCreds` helper.

- [ ] **Step 1: Add `probeAuth` to `lib/sources/cloudwatch.ts`**

Append after `getServiceMap` (end of file, ~line 98):

```ts
/**
 * Cheap "are AWS creds valid right now?" probe: one DescribeLogGroups call
 * limited to a single group. `ok` = authed, `unconfigured` = needs SSO login,
 * `failure` = some other error. Mirrors getServiceMap's error handling.
 */
export async function probeAuth(env: string): Promise<Result<{ profile?: string }>> {
  const profile = dashboardConfig.cloudwatchEnvProfiles[env]
  try {
    await client(env).send(new DescribeLogGroupsCommand({ limit: 1 }))
    return ok({ profile })
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured(`AWS credentials for "${env}" not found. Log in with AWS SSO to continue.`)
    return failure(e instanceof Error ? e.message : 'AWS auth check failed')
  }
}
```

- [ ] **Step 2: Create the route**

Create `app/api/cloudwatch/auth-status/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { probeAuth } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get('env') ?? 'dev'
  return NextResponse.json(await probeAuth(env))
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (If the repo has no root `tsc`, use `npm run build` and expect a successful compile.)

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, then in another shell:
`curl -s -X GET 'http://localhost:3000/api/cloudwatch/auth-status?env=dev'`
Expected: JSON — `{"ok":true,...}` when logged in, or `{"ok":false,"reason":"unconfigured",...}` when the SSO token is missing/expired.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/cloudwatch.ts app/api/cloudwatch/auth-status/route.ts
git commit -m "feat: AWS auth-status probe + /api/cloudwatch/auth-status route"
```

---

### Task 3: The login gate component + layout wiring

**Files:**
- Create: `components/aws-login-gate.tsx`
- Modify: `app/(dashboard)/layout.tsx` (wrap body content)

**Interfaces:**
- Consumes: `GateState`, `gateEnv`, `nextGateState`, `triggerSsoLogin`, `fetchAuthStatus` from `@/lib/aws-login-client`; existing `GET /api/cloudwatch/environments` (returns `Result<string[]>`).
- Produces: `<AwsLoginGate>{children}</AwsLoginGate>` React component (default + named export `AwsLoginGate`).

- [ ] **Step 1: Create the gate component**

Create `components/aws-login-gate.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  gateEnv, nextGateState, triggerSsoLogin, fetchAuthStatus, type GateState,
} from '@/lib/aws-login-client'
import type { Result } from '@/lib/result'

const POLL_MS = 2000

export function AwsLoginGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const env = useRef<string>('dev')
  const alive = useRef(true)

  // Resolve the gate env, then probe once on mount.
  useEffect(() => {
    alive.current = true
    ;(async () => {
      try {
        const res = await fetch('/api/cloudwatch/environments')
        const json = (await res.json()) as Result<string[]>
        if (json.ok) env.current = gateEnv(json.data) ?? 'dev'
      } catch {
        // fall back to 'dev'
      }
      const status = await fetchAuthStatus(env.current)
      if (!alive.current) return
      const next = nextGateState(status)
      setState(next)
      if (!status.ok) setMessage(status.message)
    })()
    return () => {
      alive.current = false
    }
  }, [])

  // Trigger `aws sso login`, then poll until creds are valid.
  const logIn = useCallback(async () => {
    setBusy(true)
    setMessage('Opening AWS SSO login in your browser — approve it to continue…')
    const started = await triggerSsoLogin(env.current)
    if (!started.ok) {
      setMessage(started.message ?? 'Could not start AWS SSO login.')
      setBusy(false)
      return
    }
    const poll = async () => {
      if (!alive.current) return
      const status = await fetchAuthStatus(env.current)
      if (!alive.current) return
      if (status.ok) {
        setState('authed')
        setBusy(false)
        return
      }
      setTimeout(poll, POLL_MS)
    }
    setTimeout(poll, POLL_MS)
  }, [])

  if (state === 'authed') return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 border border-border bg-card p-6 font-mono">
        <h1 className="text-lg text-primary">dev-dashboard</h1>
        {state === 'checking' ? (
          <p className="text-sm text-muted-foreground">Checking AWS session…</p>
        ) : (
          <>
            <p className="text-sm text-amber-500">
              {message ?? 'AWS sign-in required to use the dashboard.'}
            </p>
            <button
              type="button"
              onClick={logIn}
              disabled={busy}
              className="h-9 rounded-none border border-primary/40 px-3 text-sm text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {busy ? '… waiting for approval' : 'Log in to AWS SSO'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default AwsLoginGate
```

- [ ] **Step 2: Wire the gate into the desktop layout**

In `app/(dashboard)/layout.tsx`, add the import near the other component imports (after line 8):

```tsx
import { AwsLoginGate } from "@/components/aws-login-gate";
```

Then wrap the body content. Replace the `<body>` block (lines 35–54) so the gate encloses everything:

```tsx
      <body className="min-h-full">
        <AwsLoginGate>
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
        </AwsLoginGate>
      </body>
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: successful compile, no type errors.

- [ ] **Step 4: Manual verification**

- With a valid SSO token: run `npm run dev`, open `http://localhost:3000` → dashboard appears (gate flashes "Checking AWS session…" briefly, then reveals).
- With an expired token (`aws sso logout` first, and temporarily disable the `predev` login by running `next dev` directly): open the dashboard → login screen appears → click "Log in to AWS SSO" → browser SSO opens → after approval the dashboard reveals within ~2s.
- Confirm the **mobile** route (the `(mobile)` surface) is NOT gated.

- [ ] **Step 5: Commit**

```bash
git add components/aws-login-gate.tsx "app/(dashboard)/layout.tsx"
git commit -m "feat: dashboard-wide AWS SSO login gate on the desktop layout"
```

---

### Task 4: DRY — Logs panel reuses the shared login helper

**Files:**
- Modify: `components/logs-panel.tsx` (replace inline login fetch with `triggerSsoLogin`)

**Interfaces:**
- Consumes: `triggerSsoLogin` from `@/lib/aws-login-client`.
- Produces: no new exports; behavior unchanged (per-panel mid-session re-auth still works).

- [ ] **Step 1: Import the shared helper**

In `components/logs-panel.tsx`, add after the existing imports (after line 11):

```tsx
import { triggerSsoLogin } from '@/lib/aws-login-client'
```

- [ ] **Step 2: Replace the inline fetch in `triggerLogin`**

Replace the `triggerLogin` callback body (lines 36–46) with a version that delegates the fetch:

```tsx
  const triggerLogin = useCallback(async (targetEnv: string) => {
    if (!targetEnv) return
    setLoginMsg('Opening AWS SSO login in your browser — approve it to continue…')
    const json = await triggerSsoLogin(targetEnv)
    if (!json.ok) setLoginMsg(json.message ?? 'Could not start AWS SSO login.')
  }, [])
```

- [ ] **Step 3: Verify build + existing tests**

Run: `npm run build && npx vitest run`
Expected: successful compile; all existing tests pass (including `lib/sso-login.test.ts` and `lib/aws-login-client.test.ts`).

- [ ] **Step 4: Manual verification**

Run `npm run dev` while logged in, open the Logs panel; let the SSO token expire (or `aws sso logout` in another shell), wait for the panel to poll → it should show "⟳ re-authenticate (AWS SSO)" and the button should still open the browser login. Behavior identical to before.

- [ ] **Step 5: Commit**

```bash
git add components/logs-panel.tsx
git commit -m "refactor: Logs panel reuses shared triggerSsoLogin helper"
```

---

## Self-Review

**Spec coverage:**
- Auth-status probe (server) → Task 2. ✅
- Gate component + hard block on `(dashboard)` layout → Task 3. ✅
- Gate env selection (`gateEnv`) → Task 1. ✅
- Reuse existing login route / `sso-login.ts` unchanged → Tasks 3 & 4 (no edits to those files). ✅
- Logs panel re-auth stays; shared client helper extracted → Tasks 1 & 4. ✅
- Mobile untouched → Task 3 only edits `(dashboard)/layout.tsx`; verification step confirms mobile ungated. ✅
- No-profile-configured edge case → probe returns `unconfigured`, gate shows login, click surfaces login-route message (existing behavior). ✅
- Testing: `gateEnv` + `nextGateState` unit-tested (Task 1); `probeAuth` verified by build + manual per repo convention (Task 2, noted). ✅

**Placeholder scan:** No TBD/TODO; all code steps contain full code. ✅

**Type consistency:** `GateState`, `gateEnv`, `nextGateState`, `triggerSsoLogin`, `fetchAuthStatus`, `probeAuth` signatures match across Tasks 1–4. `Result<{ profile?: string }>` used consistently by `probeAuth`, the route, and `fetchAuthStatus`. ✅
