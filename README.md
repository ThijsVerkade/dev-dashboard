# dev-dashboard

A local dashboard unifying GitLab pipelines, AWS CloudWatch logs, and Claude Code activity in one pane — so you don't have to keep 3–4 apps open.

## Setup

1. `npm install`
2. `cp .env.local.example .env.local` and fill in:
   - `GITLAB_HOST` — e.g. `https://gitlab.example.com`
   - `GITLAB_TOKEN` — a personal access token, scope `read_api`
   - `GITLAB_PROJECTS` — comma-separated project ids or paths to show (e.g. `group/proj-a,group/proj-b`)
3. (Optional) Configure AWS for the **Logs** panel: set `AWS_REGION` + `AWS_PROFILE`, or run `aws sso login`. Without it the Logs panel shows a "not configured" note — the rest of the dashboard works regardless.
4. **Claude activity** needs nothing — it runs the bundled `ccusage` against your local `~/.claude` data.

## Run

- `npm run dev` → http://localhost:3000
- `npm test` → unit tests for the connectors
- `npm run build` → production build

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
runs **on this machine**. To trigger and watch jobs from your phone:

1. Install [Tailscale](https://tailscale.com/) on both the Mac and the phone,
   signed into the same tailnet.
2. On the Mac, run the dashboard bound to all interfaces:
   - `npm run dev:lan` (or `npm run start:lan` for a production build)
3. On the phone, open `http://<mac>.<tailnet>.ts.net:3000/m` — the Mac's
   Tailscale MagicDNS name. `/m` is a phone-optimized view: your assigned
   tickets with a **Dispatch** button, plus a live list of running jobs.

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
