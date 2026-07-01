# dev-dashboard

A local dashboard unifying GitLab pipelines, AWS CloudWatch logs, and Claude Code activity in one pane — so you don't have to keep 3–4 apps open.

## Setup

1. `npm install`
2. `cp .env.local.example .env.local`. The example is pre-filled for BAS, so you
   normally only set your AWS profile (`CW_ENV_PROFILES` / `AWS_PROFILE`) and your own
   `JIRA_EMAIL`. **You do not need to put any tokens in the file** — the app collects and
   validates them for you in step 3 and writes them to `.env.local`.
3. `npm run dev`, then open http://localhost:3000. The app is gated: it walks you
   through setup in order and only unlocks once all three pass —
   1. **AWS** — click **Log in to AWS SSO** (one login authorizes dev/stg/prod).
   2. **GitLab + repos** — paste a GitLab token (there's a **Create a token →** link;
      scope `read_repository` to clone, `api` for the Release Flow write actions). It's
      validated and saved, then **Clone all missing** installs the configured repos into
      `./repos` (or `WORKSPACE_DIR`). A **Re-clone** button repairs a broken checkout.
   3. **Jira** — enter your Jira host, account email, and an API token (with an Atlassian
      **Create a token →** link). Validated and saved.
   You can revisit all of this later on the **Setup** page. Prefer the CLI? `npm run setup`
   clones the repos from a terminal (`npm run setup -- --check` just reports status).
4. **Claude activity** needs nothing — it runs the bundled `ccusage` against your local `~/.claude` data.

> **Security:** `.env.local` is gitignored and holds your tokens; **never commit real
> tokens to `.env.local.example`** (it is tracked). Each person uses their own tokens.

## Run

- `npm run dev` → http://localhost:3000
- `npm test` → unit tests for the connectors
- `npm run build` → production build

### Run with Docker

A dev-mode container is provided (it runs `next dev`; the production `next build` is
currently blocked by a Next 16 types issue). It reuses your host's AWS SSO session,
`~/.claude` data, `./repos`, and `.env.local` via bind mounts — so credentials and clones
persist on the host, not in the image.

1. **On the host, log in once** so the container can reuse the cached SSO session:
   `aws sso login --profile platform-dev`. The in-app *Log in to AWS SSO* button can't
   open a browser from inside the container, so this step happens on the host.
2. `cp .env.local.example .env.local` and set your values. Tokens can still be entered in
   the setup gate — the writes land in the mounted `.env.local`.
3. `docker compose up` → http://localhost:3000. (Stop a local `npm run dev` first if it's
   holding port 3000.)

`~/.claude` is mounted read-only for the Claude panel; repos clone into `./repos` on the host.

## What you get

- **GitLab Pipelines** — recent pipelines for your configured projects; click a pipeline → its jobs → click a job to **live-tail its trace** (ANSI-stripped, clean lines).
- **CloudWatch Logs** — pick a log group and **live-tail** events (deduped, no skipped late-arriving lines).
- **Claude Activity** — total cost & tokens plus a per-session table, refreshed from `ccusage`.

## How it works

- All secrets stay server-side: the browser only talks to this app's own API routes (`app/api/*`), which hold the credentials. Nothing leaves your machine.
- Connectors live in `lib/sources/` (`gitlab.ts`, `cloudwatch.ts`, `claude.ts`), each wrapping a mature library and returning a typed `Result` so panels render configured / not-configured / error states uniformly.
- Status lists auto-poll (~30–60s); opened logs/traces stream via Server-Sent Events.
- **Mostly read-only:** the v1 panels never trigger, cancel, or mutate anything upstream. The one exception is the **Release Flow board** (below), whose merge / deploy-staging / tag actions write to GitLab and require an `api`-scoped token.

## Release Flow board

The **Release Flow board** shows active-sprint tickets alongside their MR status, environment deployments, and write actions (merge, deploy to staging, tag for production).

### GitLab token scope

`GITLAB_TOKEN` needs the **`api`** scope to perform write actions (merge an MR, play the staging job, create a tag). Using `read_api` still shows the board but all action buttons are disabled — useful if you want a read-only view.

### Modelled flow

```
feature branch → MR → merge to main   (dev / acc auto-deploy)
                                ↓
                   play deploy:staging  (staging)
                                ↓
                          tag main      (production)
```

### Configuration

| Setting | Purpose |
|---|---|
| `GITLAB_STAGING_JOB` env var | Override the manual staging job name (default: `deploy:staging`) |
| `dashboard.config.ts` `cloudwatchLogGroups` | Map `"<project>:<env>"` → CloudWatch log group to enable per-env log tailing from the board |

Example `dashboard.config.ts` snippet:

```ts
cloudwatchLogGroups: {
  "group/proj-a:staging": "/ecs/proj-a-staging",
  "group/proj-a:production": "/ecs/proj-a-production",
},
```

### Acceptance-tester agent profile

Set environment variables to enable browser-based acceptance testing on Acceptance-column tickets:

```
# Per-Jira-project staging base URL (the acceptance agent browser-tests here):
STAGING_URLS="NBDE:https://staging.example.com"
# Optional: Jira custom field id holding acceptance criteria (else read from the description):
ACCEPTANCE_CRITERIA_FIELD=
# NOTE: staging LOGIN credentials are NOT configured here — the agent uses the target
# repo's own local credentials from its checkout. The dashboard never stores secrets.
```

## Trigger agents from your phone (Tailscale)

The Agents page dispatches a Jira ticket to a headless `claude` agent that
runs **on this machine**. `/m` is a phone-optimized view of it: your assigned
tickets each with a **Dispatch** button, plus a live list of running jobs you
can open and cancel. Set it up once:

**1. Install Tailscale on both devices, same account.**
   - Mac: `brew install --cask tailscale` (or the Mac App Store app), then sign in.
     Homebrew puts the `tailscale` CLI on your `PATH`, which the QR feature uses.
   - Phone: install the Tailscale app (App Store / Play Store) and sign in to the
     **same** account so both devices share one tailnet.

**2. Enable MagicDNS** (one-time). In the [Tailscale admin console](https://login.tailscale.com/admin/dns)
   → **DNS** → enable **MagicDNS**. This gives the Mac a stable name.

**3. Find the Mac's tailnet name:**
   ```bash
   tailscale status      # the Mac's row shows e.g. macbook.tailXXXX.ts.net
   ```

**4. Configure `.env.local`:**
   ```
   # Map a Jira project key -> local repo dir so dispatch can resolve a checkout:
   AGENT_REPOS="NBDE:auction-api"
   # Shared PIN required to dispatch/cancel from any device (recommended):
   AGENT_TRIGGER_TOKEN=pick-a-secret-pin
   # Optional: override the QR target if `tailscale status` isn't on PATH:
   MOBILE_BASE_URL=http://macbook.tailXXXX.ts.net:3000
   ```

**5. Run the dashboard bound to all interfaces** (on the Mac):
   ```bash
   npm run dev:lan      # next dev -H 0.0.0.0  (or `npm run start:lan` for a prod build)
   ```
   macOS may prompt to allow incoming connections for `node` — allow it.

**6. Join from the phone — two ways:**
   - **Easiest:** on the desktop Agents page, click **📱 Open on phone** and scan the
     QR code with your phone's camera. (The QR encodes the Mac's Tailscale `/m` URL,
     auto-detected via `tailscale status`, or `MOBILE_BASE_URL` if set.)
   - **Manual:** open `http://<mac>.tailXXXX.ts.net:3000/m` in the phone's browser.

**7.** Enter the PIN once on the phone (stored on the device), then tap **Dispatch**.
   The agent runs on your Mac; the page live-streams its progress.

> The Mac must stay awake and keep `dev:lan` running for the phone to reach it.

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
joins; the PIN mitigates this — but note that the PIN only protects the
mutating endpoints: on an untrusted network, read-only endpoints such as
`/api/jira/my` and agent job logs/transcripts are readable by anyone who can
reach the port, so prefer `start:lan`/`dev:lan` only on a trusted network or
tailnet. Leave the server on `npm run dev` (loopback-only) when you don't
need phone access.

## Notes & known limitations

- The Claude session table's "Project" column shows the `ccusage` agent name (e.g. `claude`), not a repo path — `ccusage` does not expose a project path per session.
- CloudWatch tailing polls `FilterLogEvents` with an overlap window + dedupe. For heavy production streams, AWS's `StartLiveTail` API would be a more robust upgrade.
