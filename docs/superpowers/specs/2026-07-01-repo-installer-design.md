# Self-Service Repo Installer — Design

**Date:** 2026-07-01
**Status:** Approved (design)

## Problem

The dashboard already models autonomous work per repo: `AGENT_REPOS` maps
`<group>/<app>` → `<repo path>@<base branch>` (e.g. `auction/api@main`,
`lease/api@main`), and the agent runner fans out one headless Claude agent per
repo in an isolated git worktree. But it **assumes those repos are already
cloned on disk** under `WORKSPACE_DIR` (default `~/workspace`). Today each
person must clone every repo by hand before the dashboard is useful.

**Goal:** make the dashboard install its configured repos itself, so anyone
setting it up can get from a fresh checkout to a working agent-ready dashboard
without manual `git clone`.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Trigger | **Both** — a CLI setup script *and* an in-app panel |
| Install location | **Inside the dashboard folder** (`<dashboard>/repos`) |
| Source of truth | **`AGENT_REPOS`** config (explicit list) |
| Auth | **HTTPS with `GITLAB_TOKEN`** |
| Existing clones | **Leave untouched**, only report present; clone only what's missing |
| Startup gate | **Warn, don't block** |

## Architecture

One shared module owns all logic; three thin surfaces consume it.

### `lib/setup/repos.ts` (shared core)

Responsibilities:

- **List configured repos.** Read `dashboardConfig.agentRepos`, parse each spec
  with the existing repo-spec parser into
  `{ group, app, repoName, baseBranch }`. `repoName` is the path segment used to
  locate the clone (e.g. `auction/api`); `baseBranch` is the branch to check out
  on clone.
- **Resolve the install root.** `installRoot()` = `WORKSPACE_DIR` if set, else
  `<process.cwd()>/repos`. This is the same value the agent runner resolves via
  `workspaceDir()`, so clones land exactly where the runner later looks
  (`join(installRoot, repoName)`).
- **Classify each repo's state:**
  - `present` — `<root>/<repoName>/.git` exists.
  - `present-not-git` — directory exists but is not a git repo (flagged,
    never overwritten).
  - `missing` — directory does not exist.
- **Clone a missing repo** over HTTPS and return a typed `Result`.
- **Aggregate status** into `{ configured: boolean, root, repos: RepoStatus[] }`
  where `configured` reflects whether `GITLAB_HOST` + `GITLAB_TOKEN` are set
  (cloning is impossible otherwise).

Pure helpers (no I/O) are separated from the fs/git-touching functions so they
can be unit-tested directly:

- `parseAgentRepos(map): RepoEntry[]`
- `buildCloneUrl(host, token, repoName): string`
- `redactToken(text, token): string`
- `classifyState(rootExists, gitExists): RepoState` (or equivalent)

### Clone mechanics & token safety

1. Build the authenticated URL:
   `https://oauth2:<GITLAB_TOKEN>@<host without scheme>/<repoName>.git`.
2. `git clone --branch <baseBranch> <authUrl> <root>/<repoName>`
   (fall back to default branch if the branch flag fails).
3. **Immediately** `git -C <dest> remote set-url origin <clean https url>`
   (no token) so the token is **never persisted** into `.git/config`.
4. **Redact** the token from every log line, command echo, and error message
   returned to the CLI, API, or UI.

Because existing clones are left untouched, we never auto-pull, so the absence
of persisted credentials does not block normal operation. Future manual pulls
rely on the user's own git credential helper.

**Token scope:** cloning over HTTPS requires the token to include
`read_repository` (the `api` scope includes it; `read_api` alone cannot clone).
This will be documented in the README and `.env.local.example`.

### Surface 1 — CLI: `npm run setup`

`scripts/setup-repos.mjs`, added as `"setup"` in `package.json`.

- Prints a table of every configured repo with its state.
- Clones each `missing` repo, streaming progress; skips `present` and
  `present-not-git` (the latter printed as a warning).
- Prints a final summary (`cloned N, present M, skipped K, failed J`).
- Idempotent: re-running when everything is present is a no-op that just
  reports status. Exits non-zero only on an actual clone failure.
- If `GITLAB_HOST`/`GITLAB_TOKEN` are unset, prints how to configure them and
  exits without attempting clones.

### Surface 2 — API routes

Server-side only (token never reaches the browser), following the existing
`app/api/*` + typed `Result` pattern:

- `GET /api/setup/repos` → the aggregated status object.
- `POST /api/setup/repos/clone` → body `{ repoName?: string }`. With a
  `repoName`, clones that one repo; without, clones **all missing**. Returns
  per-repo `Result`s. (Clone is synchronous per request; the set is small.)

### Surface 3 — UI panel

A "Repos" status section (placed on the dashboard alongside the existing
panels; exact home decided in the plan):

- Lists each configured repo grouped by `group`, each with a status dot
  (present / not-a-git-repo / missing) and its resolved path.
- Per-missing-repo **Clone** button and a **Clone all missing** button, calling
  the POST route and refreshing status on completion.
- A **top banner** shown whenever any repo is missing: "N configured repos are
  not installed — install them" linking to the panel.
- When `GITLAB_HOST`/`GITLAB_TOKEN` are unconfigured, the panel shows a
  "not configured" note (mirrors how other panels degrade) and disables clone
  actions.

## Location & git hygiene

- Default `WORKSPACE_DIR` to `<dashboard>/repos` (resolved in the shared
  `installRoot()` and reused by the agent runner's `workspaceDir()` so both
  agree).
- Add `/repos` to `.gitignore` so cloned repos and their `.wt/` worktrees are
  never committed into the dashboard repo.
- Keep the `WORKSPACE_DIR` env override so power users can still point at
  `~/workspace` or elsewhere.

## Startup gate (non-blocking)

Extend the `predev` step (or a small companion script it calls) to print a
**warning** when repos are missing — e.g. `⚠ 3 configured repos not installed
— run \`npm run setup\` or use the dashboard Repos panel` — then continue.
Startup is never blocked. Agent dispatch for a still-missing repo already fails
gracefully (`noRepoFailure`); the panel surfaces that state up front.

## Error handling

- **Not configured:** missing host/token → status `configured: false`; CLI and
  UI show a configure-me message; no clone attempted.
- **Clone failure** (auth, network, bad path): captured per repo as a failed
  `Result`; other repos still proceed; token redacted from the error.
- **`present-not-git`:** reported as a warning; never cloned over or deleted.
- **Partial success:** CLI exit code and API response reflect that some repos
  failed while others succeeded.

## Testing

Vitest unit tests (fs/git mocked), matching the connector test style:

- `parseAgentRepos` — spec/shorthand parsing → correct `RepoEntry[]`.
- `buildCloneUrl` / `redactToken` — correct URL shape; token never leaks.
- State classification — `present` / `present-not-git` / `missing` from mocked
  fs results.
- Status aggregation — `configured` flag reflects host/token presence.

## Out of scope (YAGNI)

- Auto-discovering repos from GitLab groups (explicit `AGENT_REPOS` only).
- Auto-updating/pulling existing clones.
- SSH cloning.
- Blocking startup until repos are present.
