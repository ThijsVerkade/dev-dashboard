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
- **Read-only:** the dashboard never triggers, cancels, or mutates anything upstream.

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

## Notes & known limitations

- The Claude session table's "Project" column shows the `ccusage` agent name (e.g. `claude`), not a repo path — `ccusage` does not expose a project path per session.
- CloudWatch tailing polls `FilterLogEvents` with an overlap window + dedupe. For heavy production streams, AWS's `StartLiveTail` API would be a more robust upgrade.
