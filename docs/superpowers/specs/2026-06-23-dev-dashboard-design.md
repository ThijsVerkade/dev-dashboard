# dev-dashboard — Design Spec

- **Date:** 2026-06-23
- **Status:** Approved (design), pending implementation plan
- **Author:** thijs.verkade@basworld.com (with Claude Code)

## Problem

Monitoring day-to-day dev work currently requires juggling 3–4 separate applications:
GitLab (CI pipelines), AWS (CloudWatch logs / deploys), and the Claude account/usage
surface. There is no single place to watch logs, deployments/pipelines, and Claude
activity together. The goal is a **simple, locally-run dashboard** that unifies these
into one pane.

## Goals

- One local Next.js app (`npm run dev` → `localhost`) showing, in one view:
  1. **GitLab pipelines** for configured projects, drillable to jobs and a **live-tailed job trace**.
  2. **AWS CloudWatch logs** — pick a log group and **live tail** events.
  3. **Claude Code activity** — usage & cost summary, session history, per-session token/cost drill-in.
- Keep all secrets server-side; nothing leaves the machine.
- Reuse mature existing libraries instead of reinventing parsers/clients.
- Graceful degradation: a panel whose credentials are missing shows a "not configured —
  here's how" card instead of erroring or blocking the rest of the app.

## Non-Goals (v1)

- AWS deploy detail beyond CloudWatch (CodePipeline / ECS / CodeDeploy status).
- Historical storage / time-series database of past runs.
- Alerting / notifications.
- Authentication on the dashboard itself (it is localhost-only).
- Editing/triggering anything (read-only views only).

## Decision: build vs. reuse

Existing tooling was reviewed before committing to a build:

- **Claude activity is a solved problem.** Tools like `ccusage` (~4.8k★, JSON output),
  `claude-usage`, and `Claude-Code-Usage-Monitor` already parse the local
  `~/.claude/projects/**/*.jsonl` data and produce token/cost breakdowns. We will **wrap
  `ccusage`** rather than write our own parser.
- **GitLab + CloudWatch unified view has no perfect off-the-shelf fit.** Grafana and
  Backstage can pull GitLab CI and CloudWatch but are heavy, metrics-oriented (not
  "click a pipeline → tail this job's log"), and have **no concept of Claude Code activity**.
- **The gap** is the *combination* of these specific three sources — especially Claude
  Code activity — in one local pane. That gap justifies a **thin shell** that wraps
  existing libraries and supplies only the glue + unified UI.

## Architecture

A single Next.js application (App Router, TypeScript).

```
Browser (client components)
   │  fetch (status, ~30s poll)  +  EventSource (SSE live tail)
   ▼
Next.js Route Handlers  (app/api/*)   ← secrets live ONLY here
   │
   ├─ lib/sources/gitlab.ts      → @gitbeaker/rest        → GitLab REST API
   ├─ lib/sources/cloudwatch.ts  → @aws-sdk/client-cloudwatch-logs → AWS
   └─ lib/sources/claude.ts      → ccusage (JSON)          → local ~/.claude files
```

- **Client never holds tokens.** The browser only talks to our own Next.js server; the
  server-side connectors hold credentials and talk to upstreams.
- **Connectors are isolated modules** under `lib/sources/`, each with a typed interface,
  independently testable, and each returning a discriminated result
  (`{ ok: true, data } | { ok: false, reason: 'unconfigured' | 'error', message }`) so
  the UI can render configured / not-configured / error states uniformly.

### Connectors

| Connector | Wraps | Responsibilities |
|---|---|---|
| `gitlab.ts` | `@gitbeaker/rest` | List recent pipelines for configured projects; list jobs for a pipeline; fetch a job trace (used by live-tail). |
| `cloudwatch.ts` | `@aws-sdk/client-cloudwatch-logs` | List configured log groups; fetch recent events; poll for new events (used by live-tail). Optional — reports `unconfigured` when AWS creds are absent. |
| `claude.ts` | `ccusage` (invoked via local install / `npx`, JSON output) | Produce usage & cost rollups (today / 7d), a sessions list, and per-session token/cost detail by parsing `ccusage` JSON. |

### UI

A single dashboard page with three panels/tabs:

- **Pipelines (GitLab):** table of recent pipelines with status badges; click → jobs list →
  click a job → **live-tail trace** view.
- **Logs (CloudWatch):** select a log group → **live tail** of events. Shows the
  not-configured card until AWS is set up.
- **Claude Activity:** usage & cost summary cards (today / 7d), sessions table, click a
  session → token/cost + recent messages drill-in.

### Live data

- **Status lists** (pipeline list, log group list, Claude summary) auto-poll roughly every
  30s via client-side `fetch` against our Route Handlers.
- **Opened logs/traces** stream via an **SSE** Route Handler: the server polls the upstream
  (GitLab job trace endpoint / CloudWatch `GetLogEvents`) and pushes only new lines to the
  client `EventSource`. SSE chosen over WebSockets — one-directional, simpler in Next.js,
  sufficient for log streaming.

## Configuration

- `.env.local` (server-only):
  - `GITLAB_HOST` (e.g. `https://gitlab.example.com`)
  - `GITLAB_TOKEN` (personal access token, `read_api`)
  - `GITLAB_PROJECTS` (comma-separated project IDs or paths to display)
  - AWS: standard SDK resolution (`AWS_REGION`, `AWS_PROFILE`, or `~/.aws`) — optional.
- `dashboard.config.ts` (committed, non-secret): which GitLab projects and which CloudWatch
  log groups to surface.
- `ccusage` requires no configuration.

## Error handling & degradation

- Each connector returns a typed discriminated result; panels render one of:
  **configured & data**, **not configured (with setup hint)**, or **error (with message)**.
- AWS is the primary not-yet-configured case at launch; its panel must not block GitLab or
  Claude panels.
- **`ccusage` risk:** invoked as an external tool; if its JSON schema differs from what we
  expect, the Claude panel degrades to a clear parse-error state rather than crashing the app.

## Testing

- Unit-test each connector's parsing/mapping logic against captured sample payloads
  (GitLab pipeline/job JSON, CloudWatch events, `ccusage` JSON).
- Test the discriminated result behavior for unconfigured / error paths.
- Manual verification: run the app locally against the real GitLab token; confirm live tail
  streams; confirm AWS panel shows the not-configured card cleanly; confirm Claude panel
  renders from real local data.

## Open setup notes

- AWS is **not configured locally yet**; the Logs panel ships degrading gracefully and the
  README documents how to set up AWS credentials to enable it.
- GitLab token is available and is the primary working source at launch.
