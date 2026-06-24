# Release Flow command center — design

Date: 2026-06-24

## Goal

Make the Release Flow screen the single command center for agent-driven work:

1. **Jira status transitions** — the agent workflow drives a ticket through its
   Jira lifecycle automatically: To Do → In Progress (agent starts) → Code Review
   (agent finishes, MR open) → Acceptatie (all MRs merged).
2. **Agents in the Release Flow** — surface who/what is working on each ticket
   directly on the board, with a fancy right-side agents drawer, and live updates
   via Sonner toasts. The standalone `/agents` page is folded into the drawer but
   kept as a fallback.

Two coherent pieces, one design, implemented as two plans (A then B).

---

## Piece 1 — Jira status transitions (backend)

### Transition primitive

New best-effort function in `lib/sources/jira.ts`:

```
transitionIssueTo(key, targetStatusName): Promise<Result<{ key; moved: boolean }>>
```

- `GET /rest/api/3/issue/{key}/transitions` → find the transition whose `to.name`
  matches `targetStatusName` (case-insensitive).
- If found → `POST /rest/api/3/issue/{key}/transitions` with `{ transition: { id } }`,
  return `ok({ key, moved: true })`.
- If no match → fetch current status; if already at target, `ok({ key, moved: false })`
  (no-op success); otherwise `failure("no transition to '<target>' from '<current>'")`.
- 403 → reuse the existing "(token lacks Jira write permission)" hint pattern.
- An empty target status name ⇒ skip entirely, returning `ok({ key, moved: false })`.

The transition-matching logic (match `to.name`; detect already-there) is extracted as
a pure, unit-tested helper.

### Config (`dashboard.config.ts`)

Env-overridable, with the confirmed names as defaults:

```
jiraInProgressStatus: process.env.JIRA_IN_PROGRESS_STATUS ?? 'In Progress'
jiraCodeReviewStatus: process.env.JIRA_CODE_REVIEW_STATUS ?? 'Code Review'
jiraAcceptanceStatus: process.env.JIRA_ACCEPTANCE_STATUS  ?? 'Acceptatie'
```

### Triggers

| Transition | Where | Condition |
|---|---|---|
| → **In Progress** | `POST /api/agent/start` route, once after dispatch | ≥1 *implement* job spawned. The acceptance profile returns earlier in the route, so it's naturally excluded. |
| → **Code Review** | `runner.ts` job-exit handler | A job exits `0` **and** no other implement job for the same `key` is still `running` (all the ticket's jobs are done). Symmetric with the merge rule. |
| → **Acceptatie** | `POST /api/board/merge` route, after `mergeMr` succeeds | All of the ticket's MRs are merged. Key extracted from `mr.sourceBranch` (`feat/<KEY>-…`); MRs gathered across discovered projects and checked `every(state === 'merged')`, counting the just-merged iid as merged. |

All three are **best-effort, non-blocking**: the start/merge action always succeeds;
a failed transition is surfaced as a warning, never fatal (mirrors the existing
`void setIssueApps(...)` pattern).

### Surfacing outcomes to the client

- **In Progress & Acceptatie** (synchronous in their routes): the route response
  includes the transition outcome (moved / no-op / error) so the client can toast
  immediately and show failures.
- **Code Review** (async, server-side in the runner): the runner records the outcome
  on the job meta via two new optional `JobMeta` fields — `jiraMoved?: string`
  (the status moved to) and `jiraMoveError?: string`. The existing 3s
  `/api/agent/jobs` poll already returns meta, so the client diffs and toasts it.

### Helpers (pure, unit-tested)

- `keyFromBranch(branch)` → extract Jira key (`[A-Z][A-Z0-9]+-\d+`) from a source branch.
- `allMergedForKey(key, mrs)` → predicate over a flat MR list.
- transition-match helper described above.

---

## Piece 2 — Agents in the Release Flow (frontend)

### a) Per-ticket agent indicator

Board rows are keyed by Jira `key`; jobs (`JobMeta`) carry `key`. Group jobs by key;
a row with active/recent jobs shows a small agent badge (count + worst-of status,
pulsing when any job is `running`). Clicking the badge opens the drawer focused on
that ticket.

### b) Right-side agents drawer

A shadcn `Sheet` mounted in `BoardPanel`:

- A persistent **"Agents (N active)"** button in the board header opens the full list.
- A per-row badge opens the drawer focused on that ticket.
- Inside: the dispatch form + the live job list + the live event stream. The
  `JobView` / dispatch logic is lifted out of `AgentsPanel` into a shared component
  consumed by both the drawer and the fallback `/agents` page (no duplication).

`/agents` stays working but de-emphasized in the nav.

### c) Sonner toasts

Add `sonner`; mount `<Toaster>` in the dashboard layout (`app/(dashboard)/layout.tsx`).
Two diff sources drive toasts:

- **Job-list diff** (3s `/api/agent/jobs` poll): *job finished* (done ✓ / failed ✗),
  *blocked*, *MR opened* (with link). MR-opened detection reuses the existing
  log-scan regex surfaced through job detail.
- **Jira status moved** (→ In Progress / Code Review / Acceptatie):
  - In Progress & Acceptatie from the start/merge HTTP response outcomes.
  - Code Review from the `jiraMoved` / `jiraMoveError` job-meta fields surfaced by
    the jobs poll.

### d) Shared client diff util (pure, unit-tested)

`deriveJobEvents(prev: Map<id, JobMeta>, next: JobMeta[]): JobEvent[]` — pure function
turning a previous job map + next list into lifecycle events (finished/failed/blocked/
mr-opened/jira-moved). The drawer component owns the single subscription and fires
`toast(...)` per event.

### Toast event matrix

| Event | Trigger | Style |
|---|---|---|
| Job done | status running → done | success |
| Job failed | status running → failed | destructive |
| Job blocked | status → blocked | warning |
| MR opened | mrUrl first seen for a job | info + link |
| Jira moved | response outcome / `jiraMoved` field | info |

---

## Testing

- Pure helpers unit-tested next to their source (existing `*.test.ts` convention):
  transition-match, `keyFromBranch`, `allMergedForKey`, `deriveJobEvents`.
- All network calls wrapped in the `Result` type, matching `jira.ts` / `gitlab.ts`.
- No new realtime infra: polling + client-side diffing only.

## Implementation order

1. **Plan A** — Jira transitions: primitive + config + 3 triggers + `JobMeta` fields +
   route response outcomes.
2. **Plan B** — Release Flow UI: shared agent components, drawer + per-row indicators,
   Sonner toasts (consumes A's meta fields / response outcomes).

## Out of scope

- Websockets / server push (polling is the established pattern).
- Mobile agents view changes (`/m`) — unchanged.
- Reworking the acceptance readiness status check (still uses `/accept/i`).
