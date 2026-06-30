# Domain-scoped multi-service CloudWatch logs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick a domain + environment and live-tail all its App Runner services (fe, bff, api, fe-erp, bff-erp) in one combined console, toggling services in and out.

**Architecture:** Auto-discover domains/services by listing `/aws/apprunner/*/application` log groups in the selected environment's AWS account (one named profile per env), parsing `<domain>-<service>-<env>` from the names. The client opens one SSE stream per enabled service (reusing the existing per-group tail route) and merges events into a single timestamp-sorted buffer; toggling a service opens/closes only that stream.

**Tech Stack:** Next.js 16 (App Router), React 19, `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/credential-provider-ini` (`fromIni`), shadcn UI (`select`, `badge`, `button`), vitest, server-sent events.

## Global Constraints

- This is a heavily modified Next.js — read `node_modules/next/dist/docs/` before writing framework code; heed deprecation notices. (from AGENTS.md)
- Server-only data modules import `'server-only'` at the top (see `lib/sources/cloudwatch.ts`).
- All data-fetching functions return `Result<T>` from `lib/result.ts` (`ok` / `unconfigured` / `failure`). Never throw across the API boundary.
- Terminal/monospace styling, dark theme; match existing `components/live-tail.tsx` look.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Run tests with `npm test` (vitest run).
- Region/credential resolution must preserve today's behavior when `CW_ENV_PROFILES` is unset (default credential chain, single implicit `dev` env).

---

## File Structure

- **Modify** `dashboard.config.ts` — add `cloudwatchEnvProfiles` (`CW_ENV_PROFILES`, `=`-separated) and `cloudwatchRegion` (`CW_REGION` ?? `AWS_REGION` ?? `AWS_DEFAULT_REGION`); **remove** `cloudwatchLogGroups`.
- **Modify** `lib/dashboard-config.test.ts` — tests for the new `=`-map parse.
- **Modify** `lib/sources/cloudwatch.ts` — add `parseServiceName`, `serviceLabel`, `buildServiceMap`, `getServiceMap`, `logEnvironments`, env-aware `client(env)`, env arg on `getEvents`; **remove** `getLogGroups`.
- **Modify** `lib/sources/cloudwatch.test.ts` — tests for parsing, labels, `buildServiceMap`, `logEnvironments`.
- **Create** `app/api/cloudwatch/domains/route.ts` — `GET ?env=` → `Result<ServiceMap>`.
- **Create** `app/api/cloudwatch/environments/route.ts` — `GET` → `Result<string[]>`.
- **Modify** `app/api/cloudwatch/tail/route.ts` — accept `env` query param.
- **Delete** `app/api/cloudwatch/groups/route.ts`.
- **Create** `lib/log-merge.ts` + `lib/log-merge.test.ts` — pure `mergeLine` reducer (dedupe + sorted insert + cap).
- **Create** `components/log-console.tsx` — manages one `EventSource` per enabled service; renders merged buffer.
- **Modify** `components/logs-panel.tsx` — env selector, domain selector, service chips, deep-link, wires `LogConsole`.
- **Modify** `.env.local.example` — document `CW_ENV_PROFILES`, `CW_REGION`.

---

### Task 1: Config — env→profile map and region

**Files:**
- Modify: `dashboard.config.ts`
- Test: `lib/dashboard-config.test.ts`

**Interfaces:**
- Consumes: existing `parseEnvList`.
- Produces: `dashboardConfig.cloudwatchEnvProfiles: Record<string, string>`, `dashboardConfig.cloudwatchRegion: string | undefined`, and exported helper `parseEnvMapEq(raw: string | undefined): Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Add to `lib/dashboard-config.test.ts`:

```ts
import { parseEnvMapEq } from '@/dashboard.config'

test('parseEnvMapEq parses key=value pairs', () => {
  expect(parseEnvMapEq('dev=auction-dev,stg=auction-stg')).toEqual({
    dev: 'auction-dev',
    stg: 'auction-stg',
  })
})

test('parseEnvMapEq keeps colons inside the value', () => {
  expect(parseEnvMapEq('prod=role:arn:partition')).toEqual({ prod: 'role:arn:partition' })
})

test('parseEnvMapEq returns empty for undefined', () => {
  expect(parseEnvMapEq(undefined)).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/dashboard-config.test.ts`
Expected: FAIL — `parseEnvMapEq` is not exported.

- [ ] **Step 3: Implement**

In `dashboard.config.ts`, add the parser near `parseEnvMap`:

```ts
/** Parse "KEY=value,KEY2=value2" splitting on the first "=" (values may contain ":"). */
export const parseEnvMapEq = (raw: string | undefined): Record<string, string> =>
  Object.fromEntries(
    parseEnvList(raw)
      .map((entry): [string, string] | null => {
        const eq = entry.indexOf('=')
        if (eq === -1) return null
        const key = entry.slice(0, eq).trim()
        const value = entry.slice(eq + 1).trim()
        return key && value ? [key, value] : null
      })
      .filter((e): e is [string, string] => !!e),
  )
```

In the `dashboardConfig` object: delete the `cloudwatchLogGroups` line and add:

```ts
  // env name -> AWS named profile, e.g. CW_ENV_PROFILES="dev=auction-dev,stg=auction-stg,prod=auction-prod".
  cloudwatchEnvProfiles: parseEnvMapEq(process.env.CW_ENV_PROFILES),
  // CloudWatch region for App Runner log discovery/tail.
  cloudwatchRegion: process.env.CW_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/dashboard-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard.config.ts lib/dashboard-config.test.ts
git commit -m "feat: config for CloudWatch env profiles and region"
```

---

### Task 2: Service-name parsing and friendly labels (pure)

**Files:**
- Modify: `lib/sources/cloudwatch.ts`
- Test: `lib/sources/cloudwatch.test.ts`

**Interfaces:**
- Produces:
  - `parseServiceName(serviceName: string): { domain: string; service: string; env?: string }`
  - `serviceLabel(rawService: string): string`
- These are pure (no AWS) and used by `buildServiceMap` (Task 3).

- [ ] **Step 1: Write the failing test**

Add to `lib/sources/cloudwatch.test.ts`:

```ts
import { parseServiceName, serviceLabel } from './cloudwatch'

test('parseServiceName splits domain, service, env', () => {
  expect(parseServiceName('auction-erp-bff-dev')).toEqual({ domain: 'auction', service: 'erp-bff', env: 'dev' })
  expect(parseServiceName('auction-api-dev')).toEqual({ domain: 'auction', service: 'api', env: 'dev' })
  expect(parseServiceName('auction-frontend-stg')).toEqual({ domain: 'auction', service: 'frontend', env: 'stg' })
})

test('parseServiceName leaves env undefined when no env suffix', () => {
  expect(parseServiceName('auction-api')).toEqual({ domain: 'auction', service: 'api', env: undefined })
})

test('serviceLabel maps known services and passes through unknown', () => {
  expect(serviceLabel('frontend')).toBe('fe')
  expect(serviceLabel('erp-frontend')).toBe('fe-erp')
  expect(serviceLabel('erp-bff')).toBe('bff-erp')
  expect(serviceLabel('bff')).toBe('bff')
  expect(serviceLabel('api')).toBe('api')
  expect(serviceLabel('worker')).toBe('worker')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/sources/cloudwatch.test.ts`
Expected: FAIL — `parseServiceName` / `serviceLabel` not exported.

- [ ] **Step 3: Implement**

Add to `lib/sources/cloudwatch.ts`:

```ts
const ENV_TOKENS = ['dev', 'stg', 'prod'] as const

/** Parse an App Runner service name "<domain>-<service>-<env>". */
export function parseServiceName(serviceName: string): { domain: string; service: string; env?: string } {
  const parts = serviceName.split('-')
  const last = parts[parts.length - 1]
  const env = (ENV_TOKENS as readonly string[]).includes(last) ? last : undefined
  const core = env ? parts.slice(0, -1) : parts
  const [domain, ...rest] = core
  return { domain: domain ?? '', service: rest.join('-'), env }
}

const SERVICE_LABELS: Record<string, string> = {
  frontend: 'fe',
  'erp-frontend': 'fe-erp',
  bff: 'bff',
  'erp-bff': 'bff-erp',
  api: 'api',
}

/** Friendly label for a raw service, passing unknown values through unchanged. */
export function serviceLabel(rawService: string): string {
  return SERVICE_LABELS[rawService] ?? rawService
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/sources/cloudwatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/cloudwatch.ts lib/sources/cloudwatch.test.ts
git commit -m "feat: parse App Runner service names into domain/service/env"
```

---

### Task 3: Discovery (`buildServiceMap`/`getServiceMap`), env-aware client, `logEnvironments`

**Files:**
- Modify: `lib/sources/cloudwatch.ts`
- Test: `lib/sources/cloudwatch.test.ts`

**Interfaces:**
- Consumes: `parseServiceName`, `serviceLabel` (Task 2); `dashboardConfig.cloudwatchEnvProfiles`, `dashboardConfig.cloudwatchRegion` (Task 1); `fromIni` from `@aws-sdk/credential-provider-ini`.
- Produces:
  - `type ServiceMap = Record<string, Record<string, string>>` (domain → label → logGroupName)
  - `buildServiceMap(groupNames: string[]): ServiceMap` (pure)
  - `getServiceMap(env: string): Promise<Result<ServiceMap>>`
  - `getEvents(logGroup: string, startTime: number, env: string): Promise<Result<LogEvent[]>>` (env arg added)
  - `logEnvironments(): string[]`
- Removes: `getLogGroups`.

> **Testing note:** Only the pure `buildServiceMap` and `logEnvironments` are unit-tested. `getServiceMap`/`getEvents` are thin SDK wrappers verified manually in Task 6.

- [ ] **Step 1: Write the failing test**

Add to `lib/sources/cloudwatch.test.ts`:

```ts
import { buildServiceMap, logEnvironments } from './cloudwatch'

test('buildServiceMap groups application log groups by domain and label', () => {
  const groups = [
    '/aws/apprunner/auction-frontend-dev/abc/application',
    '/aws/apprunner/auction-frontend-dev/abc/service',     // dropped: not /application
    '/aws/apprunner/auction-erp-bff-dev/def/application',
    '/aws/apprunner/lease-api-dev/ghi/application',
  ]
  expect(buildServiceMap(groups)).toEqual({
    auction: {
      fe: '/aws/apprunner/auction-frontend-dev/abc/application',
      'bff-erp': '/aws/apprunner/auction-erp-bff-dev/def/application',
    },
    lease: { api: '/aws/apprunner/lease-api-dev/ghi/application' },
  })
})

test('logEnvironments returns single dev when CW_ENV_PROFILES unset', () => {
  // Tests run without CW_ENV_PROFILES -> single 'dev' fallback.
  expect(logEnvironments()).toEqual(['dev'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/sources/cloudwatch.test.ts`
Expected: FAIL — `buildServiceMap` / `logEnvironments` not exported.

- [ ] **Step 3: Implement**

In `lib/sources/cloudwatch.ts`:

- Add import at top (after the SDK import):

```ts
import { fromIni } from '@aws-sdk/credential-provider-ini'
```

- Replace the existing `client()` function with an env-aware one:

```ts
function client(env: string) {
  const profile = dashboardConfig.cloudwatchEnvProfiles[env]
  return new CloudWatchLogsClient({
    region: dashboardConfig.cloudwatchRegion,
    credentials: profile ? fromIni({ profile }) : undefined,
  })
}
```

- Add `ServiceMap`, `buildServiceMap`, `logEnvironments`, and the discovery entry; **delete** the old `getLogGroups` function:

```ts
export type ServiceMap = Record<string, Record<string, string>>

/** Pure: build domain -> { label -> logGroupName } from raw `/application` group names. */
export function buildServiceMap(groupNames: string[]): ServiceMap {
  const map: ServiceMap = {}
  for (const name of groupNames) {
    if (!name.endsWith('/application')) continue
    const serviceName = name.slice('/aws/apprunner/'.length).split('/')[0]
    const { domain, service } = parseServiceName(serviceName)
    if (!domain) continue
    ;(map[domain] ??= {})[serviceLabel(service)] = name
  }
  return map
}

/** Environment names available for log viewing (config keys, or single 'dev' fallback). */
export function logEnvironments(): string[] {
  const keys = Object.keys(dashboardConfig.cloudwatchEnvProfiles)
  return keys.length > 0 ? keys : ['dev']
}

export async function getServiceMap(env: string): Promise<Result<ServiceMap>> {
  try {
    const c = client(env)
    const names: string[] = []
    let nextToken: string | undefined
    do {
      const out = await c.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/apprunner/', nextToken }),
      )
      for (const g of out.logGroups ?? []) if (g.logGroupName) names.push(g.logGroupName)
      nextToken = out.nextToken
    } while (nextToken)
    return ok(buildServiceMap(names))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured(`AWS credentials for "${env}" not found. Check the profile / re-auth (SSO).`)
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}
```

- Update `getEvents` to thread `env`:

```ts
export async function getEvents(
  logGroup: string,
  startTime: number,
  env: string,
): Promise<Result<LogEvent[]>> {
  try {
    const out = await client(env).send(
      new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 200 }),
    )
    return ok((out.events ?? []).map(mapEvent))
  } catch (e) {
    if (isMissingCreds(e))
      return unconfigured(`AWS credentials for "${env}" not found. Check the profile / re-auth (SSO).`)
    return failure(e instanceof Error ? e.message : 'CloudWatch request failed')
  }
}
```

Keep the `DescribeLogGroupsCommand` import — it's still used by `getServiceMap`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/sources/cloudwatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/cloudwatch.ts lib/sources/cloudwatch.test.ts
git commit -m "feat: discover App Runner services per env; remove flat group list"
```

---

### Task 4: API routes — domains, environments, env-aware tail; delete groups

**Files:**
- Create: `app/api/cloudwatch/domains/route.ts`
- Create: `app/api/cloudwatch/environments/route.ts`
- Modify: `app/api/cloudwatch/tail/route.ts`
- Delete: `app/api/cloudwatch/groups/route.ts`

**Interfaces:**
- Consumes: `getServiceMap`, `logEnvironments`, `getEvents` (Task 3); `ok` from `@/lib/result`.
- Produces HTTP endpoints:
  - `GET /api/cloudwatch/environments` → `Result<string[]>`
  - `GET /api/cloudwatch/domains?env=<env>` → `Result<ServiceMap>`
  - `GET /api/cloudwatch/tail?env=<env>&group=<logGroupName>` → SSE
- No unit test (route wiring); verified in Task 6 Step 4.

- [ ] **Step 1: Create the environments route**

`app/api/cloudwatch/environments/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { ok } from '@/lib/result'
import { logEnvironments } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(ok(logEnvironments()))
}
```

- [ ] **Step 2: Create the domains route**

`app/api/cloudwatch/domains/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getServiceMap } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get('env') ?? 'dev'
  return NextResponse.json(await getServiceMap(env))
}
```

- [ ] **Step 3: Update the tail route to pass env**

In `app/api/cloudwatch/tail/route.ts`, read `env` and pass it to `getEvents`. Replace the opening of `GET`:

```ts
  const group = req.nextUrl.searchParams.get('group') ?? ''
  const env = req.nextUrl.searchParams.get('env') ?? 'dev'
  if (!group) return new Response('group query param required', { status: 400 })
```

and change the call inside the loop:

```ts
        const r = await getEvents(group, start, env)
```

- [ ] **Step 4: Delete the old groups route**

```bash
rm app/api/cloudwatch/groups/route.ts
```

(`tsc` will still flag `components/logs-panel.tsx` until Task 6 — that is expected; the type check is run to green in Task 6 Step 4.)

- [ ] **Step 5: Commit**

```bash
git add app/api/cloudwatch/
git commit -m "feat: cloudwatch domains + environments routes; env-aware tail"
```

---

### Task 5: Pure log-merge reducer

**Files:**
- Create: `lib/log-merge.ts`
- Test: `lib/log-merge.test.ts`

**Interfaces:**
- Produces:
  - `type LogLine = { service: string; timestamp: number; message: string; id: string }`
  - `mergeLine(buffer: LogLine[], incoming: LogLine, cap: number): LogLine[]`
- Consumed by `components/log-console.tsx` (Task 6).

Behavior: dedupe on `service + id`; insert keeping the buffer sorted ascending by `timestamp` (equal timestamps stable/appended after existing); cap to the most recent `cap` lines (drop from the front).

- [ ] **Step 1: Write the failing test**

`lib/log-merge.test.ts`:

```ts
import { expect, test } from 'vitest'
import { mergeLine, type LogLine } from './log-merge'

const line = (service: string, timestamp: number, id: string): LogLine => ({ service, timestamp, message: `${service}-${id}`, id })

test('inserts in timestamp order across services', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 30, 'a'), 100)
  buf = mergeLine(buf, line('bff', 10, 'b'), 100)
  buf = mergeLine(buf, line('fe', 20, 'c'), 100)
  expect(buf.map((l) => l.id)).toEqual(['b', 'c', 'a'])
})

test('dedupes on service + id', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 10, 'a'), 100)
  buf = mergeLine(buf, line('api', 10, 'a'), 100)
  expect(buf).toHaveLength(1)
})

test('same id from different services is kept', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 10, 'x'), 100)
  buf = mergeLine(buf, line('bff', 10, 'x'), 100)
  expect(buf).toHaveLength(2)
})

test('caps to the most recent N lines', () => {
  let buf: LogLine[] = []
  buf = mergeLine(buf, line('api', 1, 'a'), 2)
  buf = mergeLine(buf, line('api', 2, 'b'), 2)
  buf = mergeLine(buf, line('api', 3, 'c'), 2)
  expect(buf.map((l) => l.id)).toEqual(['b', 'c'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/log-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/log-merge.ts`:

```ts
export type LogLine = { service: string; timestamp: number; message: string; id: string }

/** Insert `incoming` into a timestamp-sorted buffer, deduping on service+id and capping length. */
export function mergeLine(buffer: LogLine[], incoming: LogLine, cap: number): LogLine[] {
  if (incoming.id && buffer.some((l) => l.service === incoming.service && l.id === incoming.id)) {
    return buffer
  }
  // Find insert point: first index from the end whose timestamp is <= incoming.
  let i = buffer.length
  while (i > 0 && buffer[i - 1].timestamp > incoming.timestamp) i--
  const next = [...buffer.slice(0, i), incoming, ...buffer.slice(i)]
  return next.length > cap ? next.slice(next.length - cap) : next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/log-merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/log-merge.ts lib/log-merge.test.ts
git commit -m "feat: pure timestamp-sorted log-merge reducer"
```

---

### Task 6: Combined console + rewritten logs panel

**Files:**
- Create: `components/log-console.tsx`
- Modify: `components/logs-panel.tsx`
- Modify: `.env.local.example`

**Interfaces:**
- Consumes: `mergeLine`, `LogLine` (Task 5); `ServiceMap` (Task 3); endpoints from Task 4; `usePoll` from `@/lib/use-poll`; `PanelShell`; shadcn `Select`, `Badge`; `cn` from `@/lib/utils`.
- Produces:
  - `LogConsole({ env, services }: { env: string; services: { label: string; group: string }[] })`
  - Rewritten `LogsPanel` (export name unchanged: `export function LogsPanel()`).

> **Next.js note:** `LogsPanel` is a client component. Read deep-link params from `window.location.search` inside a `useState` initializer (client-only) to avoid needing a `useSearchParams` Suspense boundary. Read `node_modules/next/dist/docs/` if unsure about App Router client APIs before editing.

- [ ] **Step 1: Implement `LogConsole`**

`components/log-console.tsx` — opens one `EventSource` per service, merges via `mergeLine`, renders the buffer. Modeled on `components/live-tail.tsx`.

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { mergeLine, type LogLine } from '@/lib/log-merge'

const CAP = 2000

// Stable color per service slot so each tag is visually distinct.
const TAG_COLORS = ['text-sky-400', 'text-emerald-400', 'text-amber-400', 'text-fuchsia-400', 'text-rose-400']

export function LogConsole({ env, services }: { env: string; services: { label: string; group: string }[] }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  // Reset the buffer when env or the set of service labels changes.
  const key = `${env}|${services.map((s) => s.label).sort().join(',')}`
  useEffect(() => { setLines([]) }, [key])

  useEffect(() => {
    const sources = services.map(({ label, group }) => {
      const es = new EventSource(`/api/cloudwatch/tail?env=${encodeURIComponent(env)}&group=${encodeURIComponent(group)}`)
      es.addEventListener('event', (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as { id: string; timestamp: number; message: string }
        setLines((buf) => mergeLine(buf, { service: label, ...ev }, CAP))
      })
      es.addEventListener('error', (e) => {
        const data = (e as MessageEvent).data
        if (data) setLines((buf) => mergeLine(buf, { service: label, id: `err-${label}-${data}`, timestamp: Date.now(), message: `[stream error] ${data}` }, CAP))
        else es.close()
      })
      es.addEventListener('done', () => es.close())
      return es
    })
    return () => sources.forEach((es) => es.close())
  }, [env, services])

  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [lines])

  const colorFor = (label: string) => TAG_COLORS[Math.max(0, services.findIndex((s) => s.label === label)) % TAG_COLORS.length]

  return (
    <div
      ref={boxRef}
      className="relative z-[60] h-96 overflow-auto rounded-none border border-border bg-black p-3 font-mono text-xs leading-relaxed text-primary"
    >
      {lines.length === 0 ? (
        <span className="text-primary/40">— awaiting stream —</span>
      ) : (
        lines.map((l) => (
          <div key={`${l.service}:${l.id}`} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="select-none text-primary/40" aria-hidden>{new Date(l.timestamp).toISOString().slice(11, 19)}</span>
            <span className={`select-none ${colorFor(l.service)}`}>[{l.service}]</span>
            <span className="flex-1">{l.message}</span>
          </div>
        ))
      )}
    </div>
  )
}
```

> **Important — referential stability:** the `services` array MUST be memoized in `LogsPanel` (Step 2) with `useMemo`, otherwise the streaming `useEffect` re-runs (reconnecting every stream) on each render.

- [ ] **Step 2: Rewrite `LogsPanel`**

Replace the entire contents of `components/logs-panel.tsx`:

```tsx
'use client'
import { useMemo, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { LogConsole } from './log-console'
import type { ServiceMap } from '@/lib/sources/cloudwatch'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

function initialParams(): { env?: string; domain?: string } {
  if (typeof window === 'undefined') return {}
  const p = new URLSearchParams(window.location.search)
  return { env: p.get('env') ?? undefined, domain: p.get('domain') ?? undefined }
}

export function LogsPanel() {
  const [{ env: envParam, domain: domainParam }] = useState(initialParams)
  const envs = usePoll<string[]>('/api/cloudwatch/environments', 300000)
  const [env, setEnv] = useState<string>(envParam ?? '')
  const effectiveEnv = env || (envs.data?.ok ? envs.data.data[0] ?? '' : '')

  const domainsRes = usePoll<ServiceMap>(
    effectiveEnv ? `/api/cloudwatch/domains?env=${encodeURIComponent(effectiveEnv)}` : '/api/cloudwatch/domains',
    60000,
  )

  const [domain, setDomain] = useState<string>(domainParam ?? '')
  const [disabled, setDisabled] = useState<Set<string>>(new Set())

  const serviceMap = domainsRes.data?.ok ? domainsRes.data.data : {}
  const domainNames = Object.keys(serviceMap).sort()
  const effectiveDomain = domain && serviceMap[domain] ? domain : ''
  const domainServices: Record<string, string> = effectiveDomain ? serviceMap[effectiveDomain] : {}
  const allLabels = Object.keys(domainServices).sort()

  // Memoized so LogConsole's stream effect only reconnects on real changes.
  const labelsKey = allLabels.join(',')
  const disabledKey = [...disabled].sort().join(',')
  const services = useMemo(
    () => allLabels.filter((l) => !disabled.has(l)).map((label) => ({ label, group: domainServices[label] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelsKey, effectiveEnv, effectiveDomain, disabledKey],
  )

  const toggle = (label: string) =>
    setDisabled((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  return (
    <PanelShell title="CloudWatch Logs" result={envs.data} loading={envs.loading}>
      {(envList) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={effectiveEnv} onValueChange={(v) => { setEnv(v); setDomain(''); setDisabled(new Set()) }}>
              <SelectTrigger className="w-40 font-mono"><SelectValue placeholder="env…" /></SelectTrigger>
              <SelectContent className="font-mono">
                {envList.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={effectiveDomain} onValueChange={(v) => { setDomain(v); setDisabled(new Set()) }}>
              <SelectTrigger className="w-56 font-mono"><SelectValue placeholder="domain…" /></SelectTrigger>
              <SelectContent className="font-mono">
                {domainNames.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {effectiveDomain && (
            <div className="flex flex-wrap gap-2">
              {allLabels.map((label) => (
                <button key={label} type="button" onClick={() => toggle(label)}>
                  <Badge
                    variant="outline"
                    className={cn(
                      'rounded-none px-2 font-mono text-[11px] cursor-pointer',
                      disabled.has(label) ? 'text-muted-foreground border-border opacity-50' : 'text-primary border-primary/40',
                    )}
                  >
                    [{label}]
                  </Badge>
                </button>
              ))}
            </div>
          )}

          {effectiveDomain
            ? <LogConsole env={effectiveEnv} services={services} />
            : <p className="font-mono text-sm text-muted-foreground">select a domain to tail its services…</p>}
        </div>
      )}
    </PanelShell>
  )
}
```

- [ ] **Step 3: Document env vars**

In `.env.local.example`, replace the AWS block (the `# AWS (optional …)`, `# AWS_REGION=…`, `# AWS_PROFILE=…` lines) with:

```bash
# AWS / CloudWatch (optional — enables the Logs panel). App Runner application logs are
# discovered per environment. Each environment is a separate AWS account reached via a
# named profile (SSO or static creds in ~/.aws). Region defaults to AWS_REGION if CW_REGION unset.
# CW_REGION=eu-central-1
# CW_ENV_PROFILES="dev=auction-dev,stg=auction-stg,prod=auction-prod"
# If CW_ENV_PROFILES is unset, a single "dev" env uses the default credential chain.
```

- [ ] **Step 4: Verify build + tests + lint**

```bash
npx tsc --noEmit
npm test
npm run lint
```

Expected: type check clean (no remaining `/api/cloudwatch/groups` or `getLogGroups` references), all tests pass, lint clean.

Manual (requires AWS creds; if unavailable, confirm the panel renders the env selector and the `unconfigured` amber message on domain load):
1. `npm run dev`, open `/logs`.
2. Pick env → domain → confirm chips appear and the console interleaves multiple services by timestamp.
3. Toggle a chip off → that service's lines stop; others keep going. Toggle on → it resumes.
4. Open `/logs?env=dev&domain=auction` → env + domain preselected.

- [ ] **Step 5: Commit**

```bash
git add components/log-console.tsx components/logs-panel.tsx .env.local.example
git commit -m "feat: domain-scoped multi-service CloudWatch log console"
```

---

## Self-Review

**Spec coverage:**
- Config (`CW_ENV_PROFILES`, `CW_REGION`, remove `cloudwatchLogGroups`) → Task 1 + Task 3 (removal of `getLogGroups`) + Task 6 (.env docs). ✓
- App Runner discovery + parse + labels → Tasks 2, 3. ✓
- Per-env client via `fromIni` → Task 3. ✓
- Routes (domains, environments, env-aware tail, remove groups) → Task 4. ✓
- Combined timestamp-sorted console, one stream per service, toggles → Tasks 5, 6. ✓
- Deep-link `?domain=&env=` → Task 6. ✓
- Error handling (per-env unconfigured, empty domain, per-stream error inline, unknown service pass-through) → Tasks 2 (pass-through), 3 (unconfigured), 6 (per-stream error). ✓
- Application logs only (drop `/service`) → Task 3 `buildServiceMap`. ✓
- Tests without AWS (parse, label, buildServiceMap, logEnvironments, mergeLine) → Tasks 2, 3, 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `ServiceMap` (Task 3) used in Tasks 4/6; `LogLine`/`mergeLine` (Task 5) used in Task 6; `getEvents(group, start, env)` (Task 3) called in Task 4; `parseServiceName`/`serviceLabel` (Task 2) used in Task 3 `buildServiceMap`; `parseEnvMapEq`/`cloudwatchEnvProfiles`/`cloudwatchRegion` (Task 1) used in Task 3. Consistent. ✓

**Known limitation (acceptable):** `getServiceMap`/`getEvents`/route wiring not unit-tested (thin SDK/HTTP wrappers); pure cores tested. Verified manually in Task 6 Step 4.
