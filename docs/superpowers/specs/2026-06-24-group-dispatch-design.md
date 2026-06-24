# Group-based agent dispatch

Date: 2026-06-24
Status: Approved (design)

## Problem

Agent dispatch is keyed by the **Jira project** parsed from a ticket key: `NBDE-817`
→ `NBDE`, and `AGENT_REPOS` maps `NBDE/<app>` → a repo. The user works across two
product groups — **auction** and **lease** — but both live under the single Jira
project `NBDE`. Consequences:

1. The **auction** repos are not dispatchable at all: nothing in `AGENT_REPOS` points
   at them, so the dispatcher doesn't know they exist.
2. The Jira-key namespace is ambiguous for this user: `NBDE/api` cannot mean both
   `auction/api` and `lease/api`.
3. There is no way to dispatch against a whole product group at once.

On disk and in GitLab the split is explicit:

- `~/workspace/auction/` → api, api-ai, app-fe, aws-lambda, bff-erp, fe, fe-erp,
  inventory-capture-ext, web-bff (9 repos)
- `~/workspace/lease/` → api, fe-bff, fe-erp (3 repos)
- GitLab groups: `basworld/auction`, `basworld/lease`

## Decisions

- **Group is the repo-selecting dimension**, chosen at dispatch time (a ticket key
  cannot reveal auction vs lease because both are NBDE). The Jira key keeps supplying
  the prompt text, branch name, and Jira comments — it no longer selects repos.
- **Dispatching a group fans out one agent per repo** (each in its own isolated git
  worktree, own branch, own MR) — the existing multi-app mechanism, scaled to a group.
  A subset of repos can still be picked.
- **Explicit config** (`AGENT_REPOS` re-namespaced to `<group>/<app>`), not filesystem
  auto-discovery — keeps per-repo base-branch control and matches the project's
  existing env-config convention.
- **Quick paths fire immediately** with no extra confirm, even for the whole 9-repo
  auction group. Only the board `DispatchDialog` offers subset selection.

## Config model (`dashboard.config.ts`)

`AGENT_REPOS` entries are re-namespaced from `<JiraKey>/<app>` to `<group>/<app>`,
with a shorthand: an entry with no `:value` defaults its repo path to the key.

```
AGENT_GROUPS="auction,lease"   # optional: fixes group order; else derived from keys
AGENT_REPOS="auction/api@main,auction/api-ai@main,auction/app-fe@main,auction/aws-lambda@main,auction/bff-erp@main,auction/fe@main,auction/fe-erp@main,auction/inventory-capture-ext@main,auction/web-bff@main,lease/api@main,lease/fe-bff@main,lease/fe-erp@main"
STAGING_URLS="auction:https://auction-stg.example.com,lease:https://lease-stg.example.com"
```

Parsing rules for an `AGENT_REPOS` entry:

- **Shorthand** `auction/api@main` — no `:`. Key = `auction/api` (the part before any
  `@`), repo = `auction/api`, base branch = `main`. `@branch` is optional (defaults to
  `main`, matching `parseRepoSpec`).
- **Explicit** `auction/api:custom/path@develop` — key = `auction/api`, repo =
  `custom/path`, base branch = `develop`. Used when the repo dir differs from the key.
- The **group** is the segment of the key before the first `/`; the **app** is the
  remainder.

New helpers (replacing the Jira-keyed `reposForProject` / `resolveAgentRepo`):

- `agentGroups(): string[]` — ordered group names (from `AGENT_GROUPS` if set, else the
  distinct group segments of `AGENT_REPOS` keys, in first-seen order).
- `reposForGroup(group): string[]` — app names within a group, sorted.
- `resolveGroupRepo(group, app): string | undefined` — repo spec (`repo@branch`) for a
  group+app, or undefined if unmapped.

`projectKeyOf` (in `lib/agent/prompt.ts`) is unchanged and still drives prompt/branch/
comments.

`STAGING_URLS` is re-keyed by group (was Jira project key), since auction and lease
have distinct staging environments. The acceptance profile reads it by group.

## Runner (`lib/agent/runner.ts`)

- `startJob(key, profile, group, app)` and `startAcceptanceJob(key, group, app)` —
  resolve the repo via `resolveGroupRepo(group, app)`.
- `JobMeta` gains `group?: string`, surfaced in the jobs list so `auction/api` is
  distinguishable from `lease/api`.
- `noRepoFailure(group)` lists that group's configured apps in its hint.
- Acceptance staging-URL lookup keyed by group.
- Worktree / fan-out mechanics are unchanged — one isolated job per target already.

## API

### `POST /api/agent/start`

Body gains `group: string` (required). Target resolution:

```
targets = apps.length ? apps : reposForGroup(group)   // empty apps ⇒ whole group
```

- Validates `group` is configured; rejects unknown groups.
- Each app resolved within the group; per-app failures reported as today.
- Apps that actually started are recorded back to the ticket as group-qualified labels
  `app:<group>/<app>` via `setIssueApps`.

### `GET /api/agent/apps?key=NBDE-417`

Returns all groups + their apps, plus the ticket's recorded selection, in one call:

```json
{
  "groups": [
    { "name": "auction", "apps": [{ "name": "api", "repo": "auction/api", "baseBranch": "main" }] },
    { "name": "lease",   "apps": [{ "name": "api", "repo": "lease/api",   "baseBranch": "main" }] }
  ],
  "selected": ["auction/api", "auction/fe"]
}
```

`selected` comes from the ticket's `app:<group>/<app>` labels via the existing
`parseAppLabels` (which returns the substring after `app:` — already group-agnostic).

## UI

### `DispatchDialog` (`components/board-panel.tsx`)

- Add a **group selector** (chips/tabs: `auction | lease`) above the app checkboxes.
- Active group defaults to the group of the recorded labels, else the first group.
- App checkbox list = the active group's apps, pre-ticked from `selected`.
- Add a **select-all** toggle ("whole group").
- Dispatch posts `{ key, group, apps }`. A "Dispatch whole group" action sends
  `apps: []` (server expands to all).

### `AgentsPanel` (desktop quick-send) & `MobileAgents`

- Both currently POST `{ key }` with no picker.
- Add a minimal group selector (`<select>` desktop, chips mobile) next to the send
  action.
- Quick-send dispatches the **whole selected group** by default (apps omitted) and
  **fires immediately** — no confirm, even for the 9-repo auction group.

## Jira labels

- Label convention becomes `app:<group>/<app>` (was `app:<app>`).
- `setIssueApps` and `parseAppLabels` pass arbitrary strings through unchanged — only
  the written values change. No parser changes required.

## Testing (`lib/dashboard-config.test.ts`)

Replace the `reposForProject` / `resolveAgentRepo` cases with coverage for:

- `agentGroups()` — derived order and explicit `AGENT_GROUPS` order.
- `reposForGroup(group)` — apps within a group, sorted; empty for unknown group.
- `resolveGroupRepo(group, app)` — shorthand entries, explicit-override entries,
  default branch, and unmapped → undefined.
- Shorthand vs explicit `AGENT_REPOS` parsing (with and without `@branch`).

## Out of scope

- Filesystem / GitLab auto-discovery of groups (rejected in favour of explicit config).
- Reorganising Jira into per-group projects.
- One-agent-across-all-repos dispatch (fan-out per repo is the chosen model).
- Confirmation guards on quick-send (explicitly declined).
