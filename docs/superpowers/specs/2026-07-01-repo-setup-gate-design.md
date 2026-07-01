# Design: mandatory repo-setup gate + robust cloning

Date: 2026-07-01
Status: Approved (pending spec review)

## Problem

The self-service repo installer (clone AGENT_REPOS into the workspace) exists, but:

1. **Cloning is unreliable / opaque.** Four observed failure modes:
   - **Silent failures** — the clone API returns a per-repo `Result` (with a
     redacted error message), but the panel discards it and relies only on a 15s
     status poll. A failed clone just stops spinning; the repo stays `missing`
     with no reason shown. (`components/repos-panel.tsx:34-41`)
   - **Unrecoverable broken dirs** — a partial/killed clone (or a stray non-git
     directory) is classified `present-not-git`. The panel offers a Clone button
     only for `missing`, and `cloneRepo` refuses any dir that already exists. The
     broken repo cannot be fixed from the UI. (`repos-panel.tsx:76`, `lib/setup/repos.ts:108`)
   - **"Clone all" times out** — one POST clones every missing repo synchronously
     (`execFileSync`, 5-min timeout *each*). Many/large repos push the single
     request past the fetch/platform timeout; some clone, some do not, and the UI
     shows nothing until it gives up. (`app/api/setup/repos/clone/route.ts:14-17`)
   - **Wrong branch, silently** — after clone, `git checkout <baseBranch>` runs
     with `stdio: 'ignore'` and its error is swallowed. A missing/mistyped branch
     leaves the repo on the remote default with no warning. (`lib/setup/repos.ts:116-120`)

2. **Setup is not enforced.** Repo setup is only a soft banner
   (`components/repos-banner.tsx`) plus a `/setup` page. By contrast, AWS auth is a
   hard gate: `<AwsLoginGate>` wraps the whole dashboard layout and renders a
   blocking full-screen login until authenticated (`app/(dashboard)/layout.tsx:38`).
   The user wants repo setup to be an equally mandatory step.

3. **No in-UI way to provide GitLab credentials.** When `GITLAB_HOST`/`GITLAB_TOKEN`
   are unset, cloning is impossible and the only remedy is editing `.env.local` and
   restarting. There is no guided way to create and enter a token.

## Goals

- Cloning surfaces per-repo success/failure inline, never times out on batches, can
  recover broken directories, and never silently lands on the wrong branch.
- Repo setup becomes a hard gate — the dashboard is unusable until every configured
  repo is present — mirroring the AWS login gate, with **no bypass**.
- Users can create and enter a GitLab token from the gate UI, with a pre-filled
  creation link for `https://gitlab.bastrucks.com`.

## Non-goals

- No background job queue / async clone infrastructure. Cloning stays synchronous
  per request; the *client* sequences requests. (YAGNI for a local dev tool.)
- No change to the token-safety model beyond extending it (embed token for clone →
  strip from origin → remove partial clone on failure → redact errors).
- No auth on the new endpoints beyond the existing **loopback-only** guard.

## Design

### Component boundaries

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `lib/setup/repos.ts` (extended) | Pure + I/O clone logic: status, clone one repo with force/branch handling, GitLab creds resolution | `node:child_process`, `node:fs`, `dashboard.config` |
| `lib/setup/gitlab-token.ts` (new) | Validate-then-persist token: `git ls-remote` validation, `.env.local` upsert (I/O) | `node:child_process`, `node:fs`, `lib/setup/repos` |
| `lib/setup/repos-client.ts` (new) | Client-safe (no server imports): gate-state classifier `reposGateState(status)`, build create-token URL | type-only `SetupStatus` |
| `app/api/setup/repos/clone/route.ts` (extended) | POST `{ repoName, force? }` → clone one repo, return its `Result` | `lib/setup/repos` |
| `app/api/setup/gitlab-token/route.ts` (new) | POST `{ host?, token }` (loopback-only) → validate + persist creds | `lib/setup/gitlab-token`, `lib/setup/repos` |
| `components/repos-setup.tsx` (new, shared) | The clone panel: per-repo live state, per-repo clone/re-clone, sequential client-driven cloning, token form when unconfigured | `/api/setup/*` |
| `components/repos-setup-gate.tsx` (new) | Blocking wrapper mirroring `AwsLoginGate`; renders `repos-setup` full-screen until complete | `components/repos-setup`, `/api/setup/repos` |
| `app/(dashboard)/setup/page.tsx` (updated) | Renders the shared `repos-setup` panel | `components/repos-setup` |
| `app/(dashboard)/layout.tsx` (updated) | Nest `<ReposSetupGate>` inside `<AwsLoginGate>`; remove `<ReposBanner>` | gate + setup components |
| `dashboard.config.ts` (extended) | Default `gitlabHost` = `https://gitlab.bastrucks.com` (overridable by `GITLAB_HOST`) | env |

### 1. Cloning fixes (`lib/setup/repos.ts`)

- **Branch handling & wrong-branch warning.** Clone, then check out `baseBranch`,
  then read back the actual current branch (`git -C <dest> rev-parse --abbrev-ref HEAD`).
  If it does not equal `baseBranch`, the success `Result` carries a non-fatal
  `warning` (e.g. `"cloned on 'master'; requested branch 'main' not found"`). The
  repo is still usable and counts as `present`; the warning is shown in the UI.
  The checkout step no longer silently swallows failure.
- **Force re-clone.** `cloneRepo(entry, { force }: { force?: boolean } = {})`:
  - `force` unset + dir exists → `failure('<dest> already exists')` (unchanged).
  - `force` set + dir exists **and is not a git repo** (`present-not-git`) → `rmSync`
    the dir, then clone.
  - `force` set + dir **is** a valid git repo (`present`) → `failure` refusing to
    delete a healthy clone. Never destroys real work.
  - Partial-clone cleanup on error is retained.
- **Result shape.** `Result<{ repoName: string; branch: string; warning?: string }>`.

### 2. Clone UX (`components/repos-setup.tsx`)

- Client drives cloning **one repo per request, sequentially**. Each repo row shows
  live state: `pending → cloning… → ✓ done (branch) / ✗ error (message)`. This
  removes the batch-timeout failure mode and renders every per-repo `Result`,
  eliminating silent failures.
- "Clone all missing" iterates the missing repos client-side, POSTing each in turn
  and updating that row as its response arrives.
- `present-not-git` rows get a **Re-clone** button that POSTs `{ repoName, force: true }`,
  behind a confirm: "This deletes `<path>` and re-clones. Continue?".
- Warnings (wrong branch) render as an amber note on the row; the repo still counts
  as present.
- This component is reused verbatim by both `/setup` and the gate.

### 3. GitLab token entry (`components/repos-setup.tsx` unconfigured state + new route)

When `SetupStatus.configured === false`, the panel renders a token form instead of
clone controls:

- **"Create a token in GitLab →"** link, deep-linked and pre-filled:
  `${gitlabHost}/-/user_settings/personal_access_tokens?name=dev-dashboard&scopes=read_repository`
  (fallback path for older GitLab: `/-/profile/personal_access_tokens`; noted in UI copy).
- **Token input** (masked) + **host field** defaulted to `gitlabHost`
  (`https://gitlab.bastrucks.com`), editable.
- **Save** → `POST /api/setup/gitlab-token` with `{ host, token }`.

`POST /api/setup/gitlab-token` (`app/api/setup/gitlab-token/route.ts`):

1. **Loopback-only** guard (same `isLoopbackHost` check the AWS login route uses);
   403 otherwise. It writes a secret, so it must not be reachable off-host.
2. **Validate before persisting.** Run `git ls-remote --heads <authenticated-url>`
   against the first configured repo. This exercises exactly the `read_repository`
   scope, so a wrong/expired token fails fast. Errors are redacted and returned; the
   token is **not** written on failure. If no repos are configured, validation is
   skipped (nothing to test against).
3. **Persist** on success: upsert `GITLAB_HOST` and `GITLAB_TOKEN` in `.env.local`
   (create the file if absent; replace existing keys; preserve other lines). Also set
   `process.env.GITLAB_HOST/GITLAB_TOKEN` in-memory so `resolveGitlab()` (which reads
   live `process.env`) picks them up **without a server restart**.
4. Return `ok()`; the panel re-probes `/api/setup/repos`, sees `configured: true`, and
   swaps to clone controls.

`.env.local` is already gitignored and is where these creds live today, so this is the
natural persistence target.

### 4. The gate (`components/repos-setup-gate.tsx`)

Mirrors `AwsLoginGate`:

- Probes `/api/setup/repos` on mount → state `checking | complete | needs-setup`.
- **complete** — every configured repo is `present` (`present-not-git` does **not**
  count), or zero repos are configured → render `children`.
- **needs-setup** — full-screen blocker containing the shared `repos-setup` panel
  (token form when unconfigured, else clone controls). The panel polls status; once
  all repos become `present` the gate flips to `complete` and reveals the app. **No
  bypass.**
- Placement in `app/(dashboard)/layout.tsx`: nested **inside** `<AwsLoginGate>`, so the
  order is AWS auth → repo setup → app.
- `<ReposBanner>` is removed: once past the gate, repos are guaranteed present, so the
  banner is dead weight. The `repos-banner.tsx` file and its layout usage are deleted.

The gate-state classifier is a pure function
`reposGateState(status: SetupStatus): 'complete' | 'needs-setup'` in the client-safe
`lib/setup/repos-client.ts` (no `node:*` imports, only a type-only import of
`SetupStatus`), unit-tested in the same style as `nextGateState`. The create-token URL
builder lives alongside it.

### Data flow

```
Dashboard layout
  <AwsLoginGate>                      probes /api/cloudwatch/auth-status
    <ReposSetupGate>                  probes /api/setup/repos → reposGateState()
      needs-setup → <ReposSetup/>     full-screen
        unconfigured → token form → POST /api/setup/gitlab-token (validate+persist)
        configured   → per-repo rows → POST /api/setup/repos/clone {repoName, force?}
      complete → children (app)
```

### Error handling

- Clone errors: returned per-repo as `failure(redactToken(...))`, rendered on the row.
- Token validation failure: returned as redacted `failure`, shown under the form; not persisted.
- Loopback violation on token route: 403 `failure('… can only be set locally.')`.
- Force re-clone of a healthy repo: `failure` refusing deletion.
- `.env.local` write failure (permissions): `failure` surfaced to the form; in-memory
  env is only set after a successful write so state stays consistent.

### Testing

- `lib/setup/repos.test.ts` / `repos.io.test.ts`:
  - force re-clone removes a `present-not-git` dir and clones; refuses a valid `present`
    git repo; partial-clone cleanup still holds.
  - wrong-branch warning surfaced when requested branch is absent.
- `lib/setup/gitlab-token.test.ts` (new):
  - `.env.local` upsert: creates file, replaces existing `GITLAB_TOKEN`, preserves other
    keys.
  - token is not persisted when validation fails (validation injected/mocked).
- `lib/setup/repos-client.test.ts` (new):
  - `reposGateState`: `complete` when all present or none configured; `needs-setup`
    when any `missing`/`present-not-git`.
  - create-token URL builder produces the pre-filled URL for a given host.

## Decisions (confirmed with user)

- Hard gate, **no bypass**. Missing GitLab creds → token form (not a dead end).
- Gate embeds inline clone controls (shared component), not just a link to `/setup`.
- Token **persists to `.env.local`** (not session-only) and applies in-memory immediately.
- Token is **validated (`git ls-remote`) before being written** — a bad token is never persisted.
- Re-clone is gated behind an explicit `force` flag + UI confirm and can only delete a
  `present-not-git` dir, never a healthy `present` repo.

## Affected files

New: `lib/setup/gitlab-token.ts`, `lib/setup/gitlab-token.test.ts`,
`lib/setup/repos-client.ts`, `lib/setup/repos-client.test.ts`,
`app/api/setup/gitlab-token/route.ts`, `components/repos-setup.tsx`,
`components/repos-setup-gate.tsx`.

Changed: `lib/setup/repos.ts`, `lib/setup/repos.test.ts`, `lib/setup/repos.io.test.ts`,
`app/api/setup/repos/clone/route.ts`, `app/(dashboard)/setup/page.tsx`,
`app/(dashboard)/layout.tsx`, `dashboard.config.ts`.

Removed: `components/repos-banner.tsx`, `components/repos-panel.tsx` (superseded by
`repos-setup.tsx`).
