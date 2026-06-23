# dev-dashboard v2 — Release Flow Board — Design Spec

- **Date:** 2026-06-23
- **Status:** Approved (design), pending implementation plan
- **Author:** thijs.verkade@basworld.com (with Claude Code)
- **Builds on:** `2026-06-23-dev-dashboard-design.md` (v1: separate read-only panels)

## Problem

v1 gives separate read-only panels (GitLab pipelines, CloudWatch logs, Claude activity,
Jira issues). Day-to-day delivery still means jumping between Jira (what's in the sprint),
GitLab (is the MR approved / green / merged / deployed) and AWS (are the deployed logs
healthy), and switching back to GitLab to actually merge, deploy staging, and tag a
release.

The goal is a single **release flow board**: one row per active-sprint Jira ticket,
correlated to its GitLab work and AWS deployment state, from which the user can **merge**,
**deploy to staging**, **cut a production tag**, and **tail logs** — without opening Jira,
GitLab, or AWS directly.

## Goals

- A board that mirrors the team's Jira board: active-sprint tickets grouped by status column.
- Each ticket row is enriched with its GitLab state: matched branch/MR, approval state,
  pipeline status, and which environments it is deployed to.
- Surface the **flow** as a left-to-right progression and expose the right action at each
  step:
  1. **Merge MR** → into `main` (auto-deploys dev/acc).
  2. **Deploy to staging** → play the manual `deploy:staging` job once the pipeline is green.
  3. **Cut tag** → create a version tag on `main` (the tag's pipeline deploys production).
- Click a live environment badge → **live-tail** that environment's CloudWatch logs.
- All correlation and all secrets stay server-side. The browser only talks to our own
  Next.js routes.
- Graceful degradation: a read-only GitLab token disables (not hides) write actions with a
  clear reason; missing AWS config makes log badges non-clickable rather than erroring.

## Non-Goals (v2)

- Editing Jira (status transitions, comments) from the board — read-only on the Jira side.
- Rolling back / deleting deployments, deleting tags, or reverting merges.
- Historical storage / time-series of past pipelines or deployments.
- Alerting / notifications.
- Authentication on the dashboard (localhost-only, unchanged from v1).
- Multi-target merges or GitFlow release branches — this team merges feature → `main`,
  then tags `main`.

## Workflow being modelled (confirmed with user)

- Branches are named with the Jira key, e.g. `feature/PROJ-123-...`.
- Feature branch → **MR into `main`**. Merging deploys to **dev** and **acceptance**
  automatically via the pipeline.
- **Staging** is deployed by **playing a manual `deploy:staging` job** in the pipeline,
  available once the pipeline has succeeded.
- **Production** is always deployed by **creating a tag of `main`** (the tag pipeline
  deploys prod). "When something is done good we first do main, then a tag of main."
- "Approved / ready to merge" means: required MR approvals met **AND** latest pipeline
  succeeded **AND** the MR is mergeable (no conflicts, not a draft) — i.e. GitLab would
  actually let the merge through.
- Environment truth comes from the **GitLab Environments/Deployments API**.

## Architecture

Extends the v1 architecture (Next.js App Router, secrets only in Route Handlers,
connectors under `lib/sources/`). Approach chosen: a **server-side aggregator** that
composes the existing connectors and returns one fully-correlated board model the client
polls.

```
Browser (client components)
   │  fetch /api/board (~30s poll)   +  EventSource (SSE live tail)   +  POST actions
   ▼
Next.js Route Handlers (app/api/board/*)        ← secrets + correlation live ONLY here
   │
   └─ lib/sources/board.ts   (aggregator / correlation — pure, testable)
        ├─ jira.ts        → active sprint issues
        ├─ gitlab.ts      → open MRs, pipelines, deployments, tags  (+ merge/play/tag writes)
        └─ cloudwatch.ts  → env log tail (existing SSE), via project:env → log group map
```

### Aggregation pipeline (batched by project, not per ticket)

1. `getActiveSprint()` → tickets; extract the Jira key from each.
2. For each configured GitLab project, **once** (not per ticket):
   - open MRs (`MergeRequests.all({ state: 'opened', targetBranch: 'main' })`, plus recently
     merged so merged rows still correlate),
   - recent pipelines (already available via `getPipelines`),
   - deployments per environment (`Deployments.all`),
   - latest tags (`Tags.all`).
3. Correlate **in memory** (pure functions):
   - match an MR to a ticket when the Jira key appears in the MR `source_branch`,
   - compute `readyToMerge` from approvals + pipeline + mergeable,
   - mark which environments the ticket has reached (see matching rule below),
   - attach latest tag + suggested next version.
4. Group rows into Jira status columns. Tickets with **no** GitLab match still appear
   (with `repo`/`mr` undefined) so the board stays a faithful mirror of the Jira board.

GitLab calls scale as ≈ `4 × #projects`, independent of ticket count.

### Data model

```ts
type Board = {
  columns: { status: string; statusCategory: string; rows: BoardRow[] }[]
  // write-action availability, derived from token scope (see Token scope)
  canWrite: boolean
}

type BoardRow = {
  // Jira
  key: string; summary: string; assignee: string; status: string; url: string
  // GitLab correlation (undefined when no branch/MR matches this key)
  repo?: { project: string; webUrl: string }
  mr?: {
    iid: number; title: string; webUrl: string; draft: boolean; sourceBranch: string
    state: 'opened' | 'merged' | 'closed'
    approvalsRequired: number; approvalsGiven: number
    pipelineStatus?: string                 // success | running | failed | …
    mergeable: boolean                       // GitLab can-merge: no conflicts, not draft
    mergedAt?: string
  }
  readyToMerge: boolean                       // approvals met && pipeline success && mergeable
  // The manual staging job, when present on the latest pipeline
  stagingJob?: { id: number; status: string; playable: boolean }
  // Environments from the Deployments API; most recent deploy per env
  envs: {
    name: string                              // dev | acceptance | staging | production | …
    state: string                             // success | running | failed
    sha: string; ref: string; deployedAt: string
    onThisTicket: boolean                     // this ticket's work is included on that env
    logGroup?: string                         // resolved from dashboard.config (clickable if set)
  }[]
  // Release
  latestTag?: { name: string; webUrl: string }
  suggestedTag?: string                       // next-version suggestion for the prod tag
}
```

### Environment-to-ticket matching

Shared environments (dev/acc/staging deploy `main`; production deploys a tag) contain many
tickets' commits. A deployment counts for a ticket (`onThisTicket: true`) when the ticket's
MR is merged and `mr.mergedAt <= deployment.deployedAt` — a cheap timestamp heuristic. If
this proves inaccurate in practice, upgrade to true ancestry via `Repositories.compare`
(is the MR's merge commit an ancestor of the deployed sha). The heuristic is the v2 default;
the upgrade is explicitly out of scope unless needed.

## Write actions & safety

Three new `POST` route handlers, each a thin wrapper over a new `gitlab.ts` function, each
**re-validating its precondition server-side** (the client's "ready" state is never trusted):

| Route | Calls | Server precondition |
|---|---|---|
| `POST /api/board/merge` | `MergeRequests.merge(project, iid)` | MR mergeable, approvals met, not draft |
| `POST /api/board/deploy-staging` | `Jobs.play(project, jobId)` | job is the manual `deploy:staging` job and its pipeline succeeded |
| `POST /api/board/tag` | `Tags.create(project, name, 'main')` | ref is `main`; tag name does not already exist |

- **Token scope.** Writes require `GITLAB_TOKEN` with `api` scope (v1 only needed
  `read_api`). The aggregator reports `canWrite` (probe token scope, or treat a configured
  override flag); when false, action buttons render **disabled with a "needs write token"
  tooltip** instead of failing on click. README documents the scope upgrade.
- **Confirmation.** Every action opens a confirm dialog stating exactly what will happen
  ("Merge MR !123 into main", "Play deploy:staging on pipeline #456", "Create tag v1.2.4 on
  main"). No one-click irreversible actions.
- **Tag versioning.** The server reads the latest tag (`Tags.all`, semver-sorted) and
  suggests the next patch bump as `suggestedTag`; the dialog lets the user edit before
  confirming.
- **After any action**, the board re-polls so the UI reflects real upstream state rather
  than an optimistic guess. Action routes return the upstream error message verbatim on
  failure (surfaced in the dialog).

## UI

- **`components/board-panel.tsx`** becomes the primary view. Existing pipelines / logs /
  Claude panels remain as secondary tabs.
- Columns = Jira statuses (mirrors the board). Each card shows the summary plus a compact
  **flow strip**:
  `branch ✓ · MR ✓ · approvals 2/2 · pipeline ✓ · dev ✓ acc ✓ stg – prod –`
  followed by the contextual action button(s): Merge → Deploy staging → Cut tag, each
  enabled only when its step is reachable.
- Clicking a **live env badge** opens the existing SSE log tail for that env's CloudWatch
  log group. Non-clickable when no `project:env` mapping exists.
- Design is intentionally minimal for v2; visual polish is a later pass.

## Configuration

- `dashboard.config.ts` gains an env→log-group map:
  ```ts
  cloudwatchLogGroups: {} as Record<string, string>,
  // e.g. { 'group/svc:staging': '/aws/ecs/svc-stg', 'group/svc:production': '/aws/ecs/svc-prod' }
  ```
  Keyed by `"<gitlab project path>:<environment name>"`. Missing key → badge not clickable.
- `.env.local`: `GITLAB_TOKEN` upgraded to `api` scope to enable write actions. All other
  v1 variables unchanged. AWS remains optional/unconfigured; log tail degrades cleanly.
- Active-sprint scope reuses v1's `JIRA_PROJECTS` / `getActiveSprint()`.

## Error handling & degradation

- The board route returns the v1 discriminated `Result`. Partial upstream failures degrade
  per-section: a project whose GitLab calls fail contributes no correlation but does not
  fail the whole board; its rows still show Jira data with an inline "GitLab unavailable"
  note.
- Read-only token → `canWrite: false`, actions disabled with explanation.
- AWS unconfigured → env badges render but are not clickable; no errors.
- Action routes return upstream failure messages verbatim; the board re-polls after.

## Testing

- **Pure correlation functions** unit-tested against captured payloads (matching existing
  `lib/sources/*.test.ts`): Jira-key→MR match, `readyToMerge` gate, env-to-ticket matching
  (timestamp heuristic), next-version suggestion, status-column grouping, and rows with no
  GitLab match.
- **Write routes**: precondition-guard tests (refuse merge when not mergeable, refuse
  staging play when job isn't the manual staging job / pipeline not green, refuse tag when
  ref isn't `main` or tag exists) — without hitting real GitLab.
- **Manual verification**: run locally against the real GitLab token; confirm a row's flow
  strip matches GitLab; confirm merge/deploy-staging/tag dialogs perform the action and the
  board re-polls; confirm env log tail streams when a log group is mapped, and degrades
  cleanly when not.
