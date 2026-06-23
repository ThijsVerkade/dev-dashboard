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

## Notes & known limitations

- The Claude session table's "Project" column shows the `ccusage` agent name (e.g. `claude`), not a repo path — `ccusage` does not expose a project path per session.
- CloudWatch tailing polls `FilterLogEvents` with an overlap window + dedupe. For heavy production streams, AWS's `StartLiveTail` API would be a more robust upgrade.
