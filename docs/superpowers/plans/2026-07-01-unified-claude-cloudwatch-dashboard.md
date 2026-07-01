# Unified Claude + CloudWatch Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate `/claude` and `/logs` pages with a single `/dashboard` page that shows a multi-session Claude "what's running" view beside CloudWatch logs, in drag-to-resize split panes.

**Architecture:** Extend the existing `claude-live.ts` transcript scanner to enumerate all recently-active sessions (not just the newest one) and to tail a chosen session. A new `ClaudeActivity` client component renders a running-sessions list over a live feed inside a vertical resizable split; `CombinedDashboard` places it beside the unchanged `LogsPanel` in a horizontal resizable split. The Claude billing summary moves to the Agents page.

**Tech Stack:** Next.js App Router (see `AGENTS.md` — this is NOT stock Next.js; read `node_modules/next/dist/docs/` before touching framework APIs), React client components, `react-resizable-panels`, shadcn UI, vitest.

## Global Constraints

- This Next.js has breaking changes vs. training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code.
- Data-source modules under `lib/sources/` are `server-only`; client components may `import type` from them (types are erased at build). Follow the existing precedent in `components/claude-live.tsx`.
- All I/O returns the `Result<T>` union from `lib/result.ts` (`ok` / `unconfigured` / `failure`). Never throw across a route boundary.
- UI is a terminal aesthetic: `font-mono`, square corners (`rounded-none`), existing color tokens. Match surrounding components.
- Active-session recency window is **10 minutes**; the list is capped at **8** sessions, newest-first.
- Tests use vitest. Run a single file with `npx vitest run <path>`. Lint with `npm run lint`. Build with `npm run build`.

---

### Task 1: Multi-session scanner in `claude-live.ts`

Refactor the single-session scan into a reusable all-sessions scan, add `getActiveSessions()`, and let `getLive()` target a specific session. Two new pure helpers carry the logic and get unit tests.

**Files:**
- Modify: `lib/sources/claude-live.ts`
- Test: `lib/sources/claude-live.test.ts`

**Interfaces:**
- Consumes: existing `parseTranscriptTail`, `normalizeEvents`, `deriveStatus`, `projectFromDir`, `readTail`, `EVENT_LIMIT`, `Result` helpers (all already in this file).
- Produces:
  - `export type SessionFile = { path: string; dir: string; mtimeMs: number }`
  - `export type ActiveSession = { sessionId: string; project: string; model: string; status: string; lastActivity: string; lastEventLabel: string }`
  - `export function selectActiveSessions(files: SessionFile[], nowMs: number, windowMs: number, cap: number): SessionFile[]`
  - `export function findSessionById(files: SessionFile[], sessionId?: string): SessionFile | null`
  - `export async function getActiveSessions(): Promise<Result<ActiveSession[]>>`
  - `export async function getLive(sessionId?: string): Promise<Result<ClaudeLive>>` (signature change — param optional)
  - `sessionId` is the full transcript basename (uuid, no `.jsonl`), used for selection matching. `ClaudeLive.sessionId` stays the 8-char display slice.

- [ ] **Step 1: Write the failing tests**

First extend the existing top-of-file import (do NOT add a second `import ... from './claude-live'` — `no-duplicate-imports` will reject it). It becomes:

```ts
import {
  parseTranscriptTail,
  normalizeEvents,
  summarizeToolInput,
  deriveStatus,
  projectFromDir,
  selectActiveSessions,
  findSessionById,
  type SessionFile,
} from './claude-live'
```

Then append these tests to `lib/sources/claude-live.test.ts`:

```ts
const f = (name: string, mtimeMs: number): SessionFile => ({
  path: `/p/dir/${name}.jsonl`,
  dir: 'dir',
  mtimeMs,
})

test('selectActiveSessions keeps only files within the window, newest-first', () => {
  const now = 1_000_000
  const files = [f('a', now - 5_000), f('b', now - 700_000), f('c', now - 1_000)]
  const active = selectActiveSessions(files, now, 600_000, 8)
  expect(active.map((s) => s.path)).toEqual(['/p/dir/c.jsonl', '/p/dir/a.jsonl'])
})

test('selectActiveSessions caps the list', () => {
  const now = 1_000_000
  const files = Array.from({ length: 12 }, (_, i) => f(`s${i}`, now - i))
  expect(selectActiveSessions(files, now, 600_000, 8)).toHaveLength(8)
})

test('findSessionById returns the newest when no id is given', () => {
  const files = [f('newest', 100), f('older', 50)]
  expect(findSessionById(files)?.path).toBe('/p/dir/newest.jsonl')
})

test('findSessionById matches by transcript basename', () => {
  const files = [f('newest', 100), f('wanted', 50)]
  expect(findSessionById(files, 'wanted')?.path).toBe('/p/dir/wanted.jsonl')
})

test('findSessionById falls back to newest for an unknown or unsafe id (no path built)', () => {
  const files = [f('newest', 100), f('older', 50)]
  expect(findSessionById(files, '../../etc/passwd')?.path).toBe('/p/dir/newest.jsonl')
})

test('findSessionById returns null when there are no files', () => {
  expect(findSessionById([], 'anything')).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/sources/claude-live.test.ts`
Expected: FAIL — `selectActiveSessions`/`findSessionById` are not exported.

- [ ] **Step 3: Implement the scanner refactor**

In `lib/sources/claude-live.ts`:

3a. Add the new constants next to the existing ones (near `IDLE_AFTER_MS`):

```ts
const ACTIVE_WINDOW_MS = 10 * 60_000
const ACTIVE_CAP = 8
const STATUS_TAIL_BYTES = 16 * 1024
```

3b. Add the exported `ActiveSession` type after the `ClaudeLive` type:

```ts
export type ActiveSession = {
  sessionId: string
  project: string
  model: string
  status: string
  lastActivity: string
  lastEventLabel: string
}
```

3c. Add the two pure helpers in the "pure helpers" section (above the I/O section):

```ts
/** Files touched within `windowMs`, newest first, capped at `cap`. */
export function selectActiveSessions(
  files: SessionFile[],
  nowMs: number,
  windowMs: number,
  cap: number,
): SessionFile[] {
  return files
    .filter((file) => nowMs - file.mtimeMs <= windowMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, cap)
}

/** Resolve a session id to a scanned file. Unknown/unsafe ids fall back to the
 *  newest — the id is only ever compared to known basenames, never joined into
 *  a path, so this is the path-traversal guard. */
export function findSessionById(files: SessionFile[], sessionId?: string): SessionFile | null {
  if (files.length === 0) return null
  if (!sessionId) return files[0]
  return files.find((file) => basename(file.path, '.jsonl') === sessionId) ?? files[0]
}
```

3d. Replace the I/O section (from `type SessionFile = ...` through the end of `getLive`) with the all-sessions scan. Export `SessionFile`, make the cache hold the sorted array, and rewrite `getLive` to use `findSessionById`; add `getActiveSessions`:

```ts
export type SessionFile = { path: string; dir: string; mtimeMs: number }

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const SCAN_TTL_MS = 5_000
let scanCache: { value: SessionFile[]; expires: number } | null = null

/** All transcripts across all projects, newest-first. Cached briefly. */
async function scanSessions(): Promise<SessionFile[]> {
  const now = Date.now()
  if (scanCache && scanCache.expires > now) return scanCache.value

  const found: SessionFile[] = []
  const dirs = await readdir(PROJECTS_DIR, { withFileTypes: true })
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dirPath = join(PROJECTS_DIR, d.name)
    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }
    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue
      try {
        const s = await stat(join(dirPath, fileName))
        found.push({ path: join(dirPath, fileName), dir: d.name, mtimeMs: s.mtimeMs })
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  scanCache = { value: found, expires: now + SCAN_TTL_MS }
  return found
}

/** Read only the trailing bytes of a (potentially huge) file. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Overview of every recently-active session (for the sessions list). */
export async function getActiveSessions(): Promise<Result<ActiveSession[]>> {
  try {
    const files = await scanSessions()
    const active = selectActiveSessions(files, Date.now(), ACTIVE_WINDOW_MS, ACTIVE_CAP)
    const sessions = await Promise.all(
      active.map(async (file) => {
        const chunk = await readTail(file.path, STATUS_TAIL_BYTES)
        const lines = parseTranscriptTail(chunk)
        const events = normalizeEvents(lines, EVENT_LIMIT)
        const model =
          [...lines].reverse().find((l) => typeof l?.message?.model === 'string')?.message.model ?? ''
        const last = events[events.length - 1]
        return {
          sessionId: basename(file.path, '.jsonl'),
          project: projectFromDir(file.dir),
          model,
          status: deriveStatus(events, Date.now()),
          lastActivity: last?.ts ?? new Date(file.mtimeMs).toISOString(),
          lastEventLabel: last?.label ?? '',
        }
      }),
    )
    return ok(sessions)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return unconfigured('no Claude sessions found')
    return failure(e instanceof Error ? e.message : 'Failed to read Claude transcripts')
  }
}

export async function getLive(sessionId?: string): Promise<Result<ClaudeLive>> {
  try {
    const files = await scanSessions()
    const session = findSessionById(files, sessionId)
    if (!session) return unconfigured('no Claude sessions found')

    const chunk = await readTail(session.path, TAIL_BYTES)
    const lines = parseTranscriptTail(chunk)
    const events = normalizeEvents(lines, EVENT_LIMIT)

    const model =
      [...lines].reverse().find((l) => typeof l?.message?.model === 'string')?.message.model ?? ''
    const lastActivity = events[events.length - 1]?.ts ?? new Date(session.mtimeMs).toISOString()

    return ok({
      project: projectFromDir(session.dir),
      sessionId: basename(session.path, '.jsonl').slice(0, 8),
      model,
      lastActivity,
      status: deriveStatus(events, Date.now()),
      events,
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return unconfigured('no Claude sessions found')
    return failure(e instanceof Error ? e.message : 'Failed to read Claude transcript')
  }
}
```

Note: `TAIL_BYTES` and `IDLE_AFTER_MS` already exist at the top of the file — keep them. Remove the old `findActiveSession` function entirely (replaced by `scanSessions` + `findSessionById`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/sources/claude-live.test.ts`
Expected: PASS (all existing tests plus the 6 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/sources/claude-live.ts lib/sources/claude-live.test.ts
git commit -m "feat: enumerate all active Claude sessions + target getLive by session id"
```

---

### Task 2: API routes for the overview and targeted feed

**Files:**
- Create: `app/api/claude/sessions/live/route.ts`
- Modify: `app/api/claude/live/route.ts`

**Interfaces:**
- Consumes: `getActiveSessions`, `getLive(sessionId?)` from Task 1.
- Produces: `GET /api/claude/sessions/live` → `Result<ActiveSession[]>`; `GET /api/claude/live?session=<id>` → `Result<ClaudeLive>` (param optional).

- [ ] **Step 1: Create the sessions-overview route**

`app/api/claude/sessions/live/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getActiveSessions } from '@/lib/sources/claude-live'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getActiveSessions())
}
```

- [ ] **Step 2: Update the live route to accept `?session=`**

Replace `app/api/claude/live/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getLive } from '@/lib/sources/claude-live'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get('session') ?? undefined
  return NextResponse.json(await getLive(session))
}
```

- [ ] **Step 3: Verify build/type-check passes**

Run: `npm run build`
Expected: build succeeds (routes compile; no type errors).

- [ ] **Step 4: Commit**

```bash
git add app/api/claude/sessions/live/route.ts app/api/claude/live/route.ts
git commit -m "feat: /api/claude/sessions/live route + session param on /api/claude/live"
```

---

### Task 3: Resizable UI primitive

Add `react-resizable-panels` and the shadcn wrapper, themed to the terminal aesthetic.

**Files:**
- Create: `components/ui/resizable.tsx`
- Modify: `package.json` (via install)

**Interfaces:**
- Produces: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` from `@/components/ui/resizable`.

- [ ] **Step 1: Install the dependency**

Run: `npm install react-resizable-panels`
Expected: `react-resizable-panels` added to `dependencies` in `package.json`.

- [ ] **Step 2: Create the wrapper**

`components/ui/resizable.tsx`:

```tsx
'use client'
import { GripVertical } from 'lucide-react'
import * as ResizablePrimitive from 'react-resizable-panels'
import { cn } from '@/lib/utils'

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn(
        'flex h-full w-full data-[panel-group-direction=vertical]:flex-col',
        className,
      )}
      {...props}
    />
  )
}

const ResizablePanel = ResizablePrimitive.Panel

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        'relative flex w-px items-center justify-center bg-border transition-colors',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2',
        'hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary/60',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        'data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full',
        'data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-2 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center border border-border bg-background">
          <GripVertical className="h-2.5 w-2.5 text-muted-foreground" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
```

- [ ] **Step 3: Verify it type-checks**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json components/ui/resizable.tsx
git commit -m "feat: add react-resizable-panels + shadcn resizable wrapper"
```

---

### Task 4: `ClaudeActivity` component (sessions list + live feed)

A client component: running-sessions list on top, selected session's live feed below, in a vertical resizable split. Owns selection state. Absorbs `StatusPill`, `EventRow`, `KIND_STYLE`, and `timeOf` (previously in `claude-live.tsx`, removed in Task 6).

**Files:**
- Create: `components/claude-activity.tsx`

**Interfaces:**
- Consumes: `ActiveSession`, `ClaudeLive`, `LiveEvent` (type-only) from Task 1; `/api/claude/sessions/live` and `/api/claude/live?session=` from Task 2; `usePoll`; `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle` from Task 3.
- Produces: `export function ClaudeActivity()`.

- [ ] **Step 1: Create the component**

`components/claude-activity.tsx`:

```tsx
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import type { ActiveSession, ClaudeLive, LiveEvent } from '@/lib/sources/claude-live'

function StatusPill({ status }: { status: string }) {
  const kind = status.startsWith('running')
    ? 'running'
    : status.startsWith('idle')
      ? 'idle'
      : 'active'
  const className =
    kind === 'running'
      ? 'text-primary border-primary/40 animate-pulse'
      : kind === 'idle'
        ? 'text-muted-foreground border-border'
        : 'text-primary border-primary/40'
  return (
    <Badge
      variant="outline"
      className={cn('rounded-none bg-transparent px-1.5 font-mono text-[11px] tabular-nums', className)}
    >
      ● {status}
    </Badge>
  )
}

const KIND_STYLE: Record<LiveEvent['kind'], { glyph: string; className: string }> = {
  text: { glyph: '', className: 'text-foreground' },
  tool_use: { glyph: '$', className: 'text-primary' },
  tool_result: { glyph: '⮑', className: 'text-muted-foreground' },
}

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function EventRow({ event }: { event: LiveEvent }) {
  const isPrompt = event.kind === 'text' && event.role === 'user'
  const style = KIND_STYLE[event.kind]
  const glyph = isPrompt ? '›' : style.glyph
  return (
    <div className="flex gap-2 font-mono text-xs leading-relaxed">
      <span className="shrink-0 tabular-nums text-muted-foreground/60">{timeOf(event.ts)}</span>
      <span className={cn('w-3 shrink-0 text-center', isPrompt ? 'text-amber-500' : style.className)}>
        {glyph}
      </span>
      <span className={cn('min-w-0 break-words', isPrompt ? 'text-amber-500' : style.className)}>
        {event.label}
      </span>
    </div>
  )
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: ActiveSession
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-left font-mono text-xs',
        selected
          ? 'border-primary bg-muted/40'
          : 'border-transparent hover:bg-muted/20',
      )}
    >
      <span className="min-w-0 shrink-0 truncate font-semibold text-foreground">{session.project}</span>
      {session.model && <span className="shrink-0 text-muted-foreground/70">{session.model}</span>}
      <span className="ml-auto shrink-0">
        <StatusPill status={session.status} />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{session.lastEventLabel}</span>
    </button>
  )
}

export function ClaudeActivity() {
  const sessions = usePoll<ActiveSession[]>('/api/claude/sessions/live', 3000)
  const list = sessions.data?.ok ? sessions.data.data : []

  const [selected, setSelected] = useState<string | null>(null)
  // Effective selection: the chosen session if still active, else the newest.
  const effective = useMemo(() => {
    if (selected && list.some((s) => s.sessionId === selected)) return selected
    return list[0]?.sessionId ?? null
  }, [selected, list])

  const liveUrl = effective
    ? `/api/claude/live?session=${encodeURIComponent(effective)}`
    : '/api/claude/live'
  const live = usePoll<ClaudeLive>(liveUrl, 2500)

  const scrollRef = useRef<HTMLDivElement>(null)
  const count = live.data?.ok ? live.data.data.events.length : 0
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, effective])

  return (
    <Card className="flex h-full flex-col gap-0 overflow-hidden">
      <CardHeader className="shrink-0 border-b border-border [.border-b]:pb-4">
        <CardTitle className="font-mono text-sm tracking-tight">
          <span className="text-muted-foreground">$ </span>Claude Activity
        </CardTitle>
      </CardHeader>

      <ResizablePanelGroup direction="vertical" autoSaveId="claude-activity-v" className="min-h-0 flex-1">
        <ResizablePanel id="sessions" order={1} defaultSize={35} minSize={15}>
          <div className="h-full overflow-y-auto p-2">
            {sessions.loading && !sessions.data && (
              <div className="space-y-2 p-1">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            )}
            {sessions.data && !sessions.data.ok && (
              <p
                className={cn(
                  'p-1 font-mono text-xs',
                  sessions.data.reason === 'unconfigured' ? 'text-amber-500' : 'text-destructive',
                )}
              >
                {sessions.data.reason === 'unconfigured' ? '[ ---- ] ' : '[ FAIL ] '}
                {sessions.data.message}
              </p>
            )}
            {sessions.data?.ok && list.length === 0 && (
              <p className="p-1 font-mono text-xs text-muted-foreground">no active sessions</p>
            )}
            {list.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                selected={s.sessionId === effective}
                onSelect={() => setSelected(s.sessionId)}
              />
            ))}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="feed" order={2} defaultSize={65} minSize={20}>
          <div ref={scrollRef} className="h-full space-y-0.5 overflow-y-auto bg-muted/20 p-3">
            {live.data?.ok && live.data.data.events.length > 0 ? (
              live.data.data.events.map((e, i) => <EventRow key={`${e.ts}-${i}`} event={e} />)
            ) : (
              <p className="font-mono text-xs text-muted-foreground">no recent activity</p>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Card>
  )
}
```

- [ ] **Step 2: Verify it type-checks/builds**

Run: `npm run build`
Expected: build succeeds. (The component isn't routed yet; this only confirms it compiles.)

- [ ] **Step 3: Commit**

```bash
git add components/claude-activity.tsx
git commit -m "feat: ClaudeActivity — multi-session list over live feed, vertical resize"
```

---

### Task 5: `CombinedDashboard` + `/dashboard` page

Place `ClaudeActivity` beside the unchanged `LogsPanel` in a horizontal resizable split; stack them on mobile.

**Files:**
- Create: `components/combined-dashboard.tsx`
- Create: `app/(dashboard)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `ClaudeActivity` (Task 4), `LogsPanel` (existing), `useIsMobile` (`hooks/use-mobile.ts`), resizable primitives (Task 3).
- Produces: `export function CombinedDashboard()`; default-exported `/dashboard` page.

- [ ] **Step 1: Create the layout component**

`components/combined-dashboard.tsx`:

```tsx
'use client'
import { useIsMobile } from '@/hooks/use-mobile'
import { ClaudeActivity } from '@/components/claude-activity'
import { LogsPanel } from '@/components/logs-panel'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'

export function CombinedDashboard() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-[70vh]">
          <ClaudeActivity />
        </div>
        <LogsPanel />
      </div>
    )
  }

  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="dashboard-h" className="min-h-0 flex-1">
      <ResizablePanel id="claude" order={1} defaultSize={45} minSize={25}>
        <ClaudeActivity />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="logs" order={2} defaultSize={55} minSize={25}>
        <div className="h-full overflow-y-auto pl-4">
          <LogsPanel />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
```

- [ ] **Step 2: Create the page**

`app/(dashboard)/dashboard/page.tsx`:

```tsx
import { CombinedDashboard } from '@/components/combined-dashboard'

export default function DashboardPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CombinedDashboard />
    </div>
  )
}
```

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000/dashboard`.
Expected: Claude sessions list + feed on the left, CloudWatch logs on the right; dragging the vertical divider resizes left/right; dragging the horizontal divider inside the Claude card resizes list/feed; reloading preserves the sizes. Selecting a session in the list switches the feed below. Narrow the window below 768px → panels stack.

- [ ] **Step 4: Commit**

```bash
git add components/combined-dashboard.tsx "app/(dashboard)/dashboard/page.tsx"
git commit -m "feat: /dashboard — resizable Claude activity + CloudWatch logs"
```

---

### Task 6: Swap navigation, redirect old routes, remove dead component

**Files:**
- Modify: `components/nav-items.tsx`
- Modify: `app/(dashboard)/claude/page.tsx`
- Modify: `app/(dashboard)/logs/page.tsx`
- Delete: `components/claude-live.tsx`

**Interfaces:**
- Consumes: `/dashboard` page (Task 5). `navItems` is shared by the sidebar, breadcrumb, and command palette.

- [ ] **Step 1: Update `navItems`**

Replace the `/logs` and `/claude` entries with a single `/dashboard` entry at the top. New `components/nav-items.tsx`:

```tsx
import { GitBranch, LayoutDashboard, Rocket, SquareKanban, Workflow } from "lucide-react"
import type { LucideIcon } from "lucide-react"

export type NavItem = {
  /** Route for this destination. */
  href: string
  title: string
  icon: LucideIcon
}

/**
 * Dashboard destinations. Each is its own page; Release Flow is the home page.
 * Shared by the sidebar, the breadcrumb, and the Cmd+K command palette so they
 * never drift.
 */
export const navItems: NavItem[] = [
  { href: "/dashboard", title: "Dashboard", icon: LayoutDashboard },
  { href: "/", title: "Release Flow", icon: Rocket },
  { href: "/pipelines", title: "Pipelines", icon: GitBranch },
  { href: "/agents", title: "Agents", icon: Workflow },
  { href: "/jira", title: "Jira", icon: SquareKanban },
]
```

- [ ] **Step 2: Redirect `/claude` → `/dashboard`**

Replace `app/(dashboard)/claude/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default function ClaudePage() {
  redirect('/dashboard')
}
```

- [ ] **Step 3: Redirect `/logs` → `/dashboard`, preserving query params**

The Logs panel builds `/logs?env=&domain=` links, so forward the query string. Replace `app/(dashboard)/logs/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') qs.set(key, value)
  }
  const query = qs.toString()
  redirect(query ? `/dashboard?${query}` : '/dashboard')
}
```

(App Router passes `searchParams` as a Promise in this Next.js — confirm against `node_modules/next/dist/docs/` if the shape differs.)

- [ ] **Step 4: Delete the superseded component**

Run: `git rm components/claude-live.tsx`
(Its `StatusPill`/`EventRow`/`timeOf` now live in `claude-activity.tsx`; nothing else imports it — verify with `grep -rn "claude-live'" app components`.)

- [ ] **Step 5: Verify**

Run: `npm run build && npm run lint`
Expected: build + lint pass, no unused-import or missing-module errors.
Then `npm run dev` and confirm: the sidebar shows a single **Dashboard** entry (no Claude/Logs); visiting `/claude` and `/logs?env=staging&domain=foo` both land on `/dashboard` (the latter with the query string intact); Cmd+K lists Dashboard.

- [ ] **Step 6: Commit**

```bash
git add components/nav-items.tsx "app/(dashboard)/claude/page.tsx" "app/(dashboard)/logs/page.tsx"
git commit -m "feat: single Dashboard nav entry; redirect /claude and /logs"
```

---

### Task 7: Fold the Claude billing summary into the Agents page

**Files:**
- Modify: `app/(dashboard)/agents/page.tsx`

**Interfaces:**
- Consumes: `AgentsPanel` (existing), `ClaudePanel` (existing, unchanged).

- [ ] **Step 1: Render `ClaudePanel` below `AgentsPanel`**

Replace `app/(dashboard)/agents/page.tsx`:

```tsx
import { AgentsPanel } from '@/components/agents-panel'
import { ClaudePanel } from '@/components/claude-panel'

export default function AgentsPage() {
  return (
    <div className="space-y-4">
      <AgentsPanel />
      <ClaudePanel />
    </div>
  )
}
```

- [ ] **Step 2: Verify**

Run: `npm run build`, then `npm run dev` and open `/agents`.
Expected: the Agents panel renders as before with the Claude cost/tokens chart + sessions table below it.

- [ ] **Step 3: Commit**

```bash
git add "app/(dashboard)/agents/page.tsx"
git commit -m "feat: fold Claude billing summary into the Agents page"
```

---

## Final verification

- [ ] Run the full test suite: `npx vitest run` — all green.
- [ ] Run `npm run build` and `npm run lint` — both clean.
- [ ] Manual smoke: `/dashboard` shows both panels; both drag handles (horizontal outer, vertical inside the Claude card) work and sizes persist across reload; session selection switches the feed; `/claude` and `/logs?...` redirect correctly; `/agents` shows the billing summary; sidebar/breadcrumb/Cmd+K show one Dashboard entry.
- [ ] Update the PR/MR description if one is open, so it reflects the new `/dashboard`, the nav change, and the billing-summary move.
