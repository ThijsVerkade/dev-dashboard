# Unified Claude + CloudWatch Dashboard — Design

Date: 2026-07-01
Status: Approved (pending spec review)

## Problem

The Claude activity view (`/claude`) and the CloudWatch logs view (`/logs`) are two
separate pages with fixed-size cards. The user wants a single dashboard that shows
**which Claude activities are running** alongside **CloudWatch logs**, with panels
that can be dragged bigger and smaller.

Two limitations in today's Claude view:

- The live feed shows only the *single* most-recently-modified transcript. There is
  no overview of the multiple Claude sessions that may be running concurrently.
- Panels are fixed-size cards; nothing is resizable.

## Goals

- One page that combines a Claude "what's running" view with the CloudWatch logs view.
- A multi-session overview of running Claude activities, click-to-drill into a
  session's live feed.
- Drag-to-resize split panes; sizes remembered across reloads.
- Replace the separate `/claude` and `/logs` sidebar pages with this one page.

## Non-goals

- No new CloudWatch functionality — the existing `LogsPanel` is reused unchanged.
- No per-panel "maximize to fullscreen" button (drag-to-resize covers the ask).
- The Claude billing summary (cost/tokens chart + sessions table) is not a
  "what's running" view and does not belong on this dashboard.

## Layout & routing

- **Nav:** remove the `/claude` and `/logs` entries from `navItems`; add one entry
  **"Dashboard"** (icon `LayoutDashboard` from lucide-react) at the top of the list,
  route `/dashboard`.
- **Redirects:** `/claude` and `/logs` redirect to `/dashboard` so existing links keep
  working. The Logs panel constructs `/logs?env=&domain=`-style URLs; the redirect must
  preserve the query string so those still land correctly. Implemented as Next.js
  `redirect()` in thin `app/(dashboard)/claude/page.tsx` and `.../logs/page.tsx`
  (reading `searchParams` and forwarding them), or via `next.config.ts` redirects —
  whichever preserves query params cleanly. The combined page reads the same
  `env`/`domain` query params on load.
- **Structure:** the page is a horizontal `ResizablePanelGroup`:
  - Left panel: Claude, itself a vertical `ResizablePanelGroup` — *running sessions*
    list (top) over *live feed* (bottom).
  - Right panel: CloudWatch (`LogsPanel`, unchanged).
  - Three draggable handles total (one outer horizontal, one nested vertical).

## Claude multi-session data

Extend `lib/sources/claude-live.ts` (reusing its existing pure helpers
`parseTranscriptTail`, `normalizeEvents`, `deriveStatus`, `projectFromDir`, `readTail`):

- **`getActiveSessions(): Promise<Result<ActiveSession[]>>`**
  - Scans all `~/.claude/projects/*/*.jsonl`.
  - Keeps transcripts modified within a recency window (**10 minutes**), sorted
    newest-first, capped at **8**.
  - For each kept transcript, reads a *small* tail (a few KB — enough to derive the
    latest status without the full 256KB read) and produces:
    `ActiveSession = { sessionId, project, model, status, lastActivity, lastEventLabel }`.
  - `status` reuses `deriveStatus` (`running <tool>`, `working`, `responding`,
    `starting`, `idle <n>s`).
  - Errors follow the existing `Result` conventions (`unconfigured` when the projects
    dir is absent, `failure` on unexpected errors).

- **`getLive(sessionId?: string)`** — add an optional session id. When provided, tail
  that specific transcript; when omitted, keep today's "newest transcript" behavior.
  Guard against path traversal: resolve the id to a known transcript from the scan
  rather than trusting it as a path.

- **Routes:**
  - New `GET /api/claude/sessions/live` → `getActiveSessions()`.
  - `GET /api/claude/live?session=<id>` → `getLive(session)` (param optional; current
    callers keep working).

## Claude UI

New `components/claude-activity.tsx` (client):

- Polls `/api/claude/sessions/live` (~3s) for the overview and
  `/api/claude/live?session=<selected>` (2.5s) for the detail feed.
- **Sessions list:** one row per running session — project · model · animated status
  pill (reusing the existing `StatusPill` look) · truncated last action
  (`lastEventLabel`). The selected row is highlighted.
- **Selection:** clicking a row selects it. With no explicit selection, auto-follow the
  most-recent session (index 0) so behavior matches today out of the box. If the
  selected session drops out of the active list, fall back to auto-follow.
- **Live feed:** the existing `EventRow` rendering and autoscroll, kept as-is, driven by
  the selected session.
- Wrapped in `PanelShell` for consistent loading/error states.

The existing `ClaudeLivePanel` component is superseded by `claude-activity.tsx` and
removed once the new page is wired up.

## Resizable mechanics

- Add dependency `react-resizable-panels`.
- Add `components/ui/resizable.tsx` — the standard shadcn wrapper
  (`ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`), themed to match the
  terminal aesthetic (thin bordered handles, square corners like the rest of the UI).
- Persist layout via the library's `autoSaveId` (localStorage) on each group so sizing
  sticks per group.
- Min-sizes on every panel so none can be dragged to zero.
- Narrow/mobile viewports: the splits collapse to stacked, full-width panels (resize is
  a desktop affordance). Implemented with a viewport check (reuse `useIsMobile` /
  `use-mobile.ts`) that renders a plain stacked layout below the breakpoint.

## Claude billing summary relocation

`ClaudePanel` (cost/tokens chart + sessions table, backed by `ccusage`) moves to the
**Agents** page, rendered below `AgentsPanel`:

```tsx
// app/(dashboard)/agents/page.tsx
export default function AgentsPage() {
  return (
    <div className="space-y-4">
      <AgentsPanel />
      <ClaudePanel />
    </div>
  )
}
```

`ClaudePanel` and its `/api/claude/summary` + `/api/claude/sessions` routes are
unchanged.

## Testing

- Extend `lib/sources/claude-live.test.ts` with unit tests for the new pure logic:
  - recency-window filtering, newest-first ordering, and the cap at 8;
  - per-session status/last-action derivation from a small tail;
  - `getLive` targeting a specific session id and the path-traversal guard.
- Follow existing vitest patterns (temp dirs / fixture transcripts as the current tests
  do).
- No tests for the presentational `resizable.tsx` wrapper.

## Files

Added:
- `app/(dashboard)/dashboard/page.tsx` — the combined page.
- `components/combined-dashboard.tsx` — resizable layout wiring.
- `components/claude-activity.tsx` — multi-session overview + live feed.
- `components/ui/resizable.tsx` — shadcn resizable wrapper.
- `app/api/claude/sessions/live/route.ts` — active-sessions endpoint.

Modified:
- `components/nav-items.tsx` — swap `/claude` + `/logs` for `/dashboard`.
- `lib/sources/claude-live.ts` — `getActiveSessions`, `getLive(sessionId?)`.
- `app/api/claude/live/route.ts` — accept `?session=`.
- `app/(dashboard)/claude/page.tsx`, `app/(dashboard)/logs/page.tsx` — redirect to
  `/dashboard` (query-string preserving), or `next.config.ts` redirects.
- `app/(dashboard)/agents/page.tsx` — add `ClaudePanel`.
- `lib/sources/claude-live.test.ts` — new tests.
- `package.json` — add `react-resizable-panels`.

Removed:
- `components/claude-live.tsx` (superseded by `claude-activity.tsx`).
