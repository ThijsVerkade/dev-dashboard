# Fancier log console + App Runner deployment markers

**Date:** 2026-06-30
**Status:** Approved (design)

## Goal

Make the CloudWatch log console more readable and "fancy", and surface a clear
visual indication in the stream whenever a service is (re)deployed.

Two independent but co-located pieces of work:

1. **Deployment detection** — detect App Runner deploy lifecycle events and
   render them as distinct markers inline with the logs.
2. **Visual upgrades** — row polish, autoscroll controls + status, stack-trace
   folding, and the deploy-marker styling.

## Background (current state)

- `components/log-console.tsx` owns the stream. Each enabled service mounts a
  `ServiceStream` that opens an SSE connection to `/api/cloudwatch/tail` for
  that service's `/application` log group. Lines are merged into a single
  timestamp-sorted buffer (`lib/log-merge.ts`, `mergeLine`, cap 2000) and
  rendered with per-service tag colors, severity colors, search highlight, and
  a "hide health checks" noise filter.
- `components/logs-panel.tsx` discovers env → domain → `{ label → logGroup }`
  via `/api/cloudwatch/domains` (`getServiceMap` / `buildServiceMap` in
  `lib/sources/cloudwatch.ts`), renders env/domain selects + per-service toggle
  chips, and passes the enabled services to `LogConsole`.
- `buildServiceMap` currently keeps only `/aws/apprunner/<svc>/<id>/application`
  groups and drops everything else — including the sibling `/service` group that
  carries App Runner operational/deploy events.
- `/api/cloudwatch/tail` is generic: it tails **any** log group passed as
  `?group=`. No new endpoint is required to tail `/service` groups.

## Part A — Deployment detection

### Source

App Runner writes deploy lifecycle text to each service's `…/service` log
group, e.g.:

- `[AppRunner] Deployment started.`
- `[AppRunner] Successfully pulled your application image from ECR.`
- `[AppRunner] Performing health check on port '…'.`
- `[AppRunner] Health check is successful. Routing traffic to application.`
- `[AppRunner] Deployment completed successfully.`
- `[AppRunner] Deployment failed.` / `… Health check failed …`

These share the `/aws/apprunner/` prefix already scanned, so they are already
returned by `DescribeLogGroups` and merely filtered out today.

### Data layer changes (`lib/sources/cloudwatch.ts`)

- Widen the service map so each label carries both its application group and its
  deploy (`/service`) group.
  - New shape per service: `{ app: string; deploy?: string }` instead of a bare
    string. `ServiceMap` becomes `Record<domain, Record<label, ServiceGroups>>`.
- `buildServiceMap` keeps a service when an `/application` group exists, and
  attaches the matching `/service` group (same `<svc>/<id>` path stem) as
  `deploy` when present. A service with no `/service` group keeps `deploy`
  undefined — detection is **silent** in that case (no markers, no error).
- Update `buildServiceMap` unit tests for the new shape and for `/service`
  pairing.
- `getServiceMap` / `/api/cloudwatch/domains` response shape follows the new
  type. `logs-panel.tsx` reads `.app` for the log stream and `.deploy` for the
  deploy stream.

### Classifier (`lib/deploy-events.ts`, new, pure + tested)

```
classifyDeployLine(message: string): DeployPhase | null
type DeployPhase = 'start' | 'success' | 'fail'
```

- Matches the `[AppRunner]` lifecycle phrases above (case-insensitive,
  resilient to surrounding text):
  - `start`  ← "Deployment started" (and image-pull/provisioning as the same
    in-progress phase, collapsed to `start`).
  - `success` ← "Deployment completed successfully" / "Routing traffic to
    application".
  - `fail` ← "Deployment failed" / "Health check failed".
- Returns `null` for everything else (health-check chatter, info lines) so the
  `/service` stream contributes **only** deploy markers, never raw noise.
- Pure function, no I/O. Unit-tested with representative real lines.

### Stream wiring (`components/log-console.tsx`)

- For each enabled service that has a `deploy` group, mount a **second** hidden
  `ServiceStream` on the `/service` group. Deploy streams thus **follow the
  enabled chips**: toggling a service's log chip off also stops watching its
  deploys (consistent with today's "toggle off = stop stream" model).
- A `/service` line is run through `classifyDeployLine`. If it classifies, it is
  merged into the same buffer as a **deploy marker** entry; otherwise dropped.

### Merge / entry type (`lib/log-merge.ts`)

- Buffer entries become a discriminated union:
  - `{ kind: 'log', service, id, timestamp, message }` (today's `LogLine`)
  - `{ kind: 'deploy', service, id, timestamp, phase }`
- `mergeLine` stays pure (timestamp-sorted insert, dedupe by `service:id`, cap).
  Tests extended to cover deploy entries interleaving with logs.

## Part B — Visual upgrades

All rendered in `components/log-console.tsx` (row rendering and the controls bar
split into sibling components if the file grows unwieldy).

1. **Row polish**
   - CSS-grid rows so `time | [tag] | message` columns align across lines.
   - Error rows: faint red row tint + left accent border; warning rows: amber.
     Severity is the existing `severityClass` logic, surfaced as row treatment
     rather than only message color.
   - Hover highlight on rows.

2. **Controls & status**
   - Autoscroll that **auto-pauses when the user scrolls up**; a floating
     **"↓ jump to latest (N new)"** pill resumes and clears the counter.
   - Status bar gains per-severity counts (`E:n  W:n`) alongside the existing
     updated-at + line count.
   - Quick filter chips: **All / Errors / Warnings**, composing with the
     existing search box and "hide health checks" toggle.

3. **Stack-trace folding**
   - Consecutive continuation lines (`  at …`, `Traceback`, NestJS
     `Object(n){…}` dumps and their `correlationId/controller/handler` body)
     fold under their head line as a single expandable row, collapsed by
     default, with a `▸ N more lines` affordance. Folding is grouping at render
     time; it does not drop lines from the buffer.

4. **Deploy markers**
   - Rendered as a **full-width divider banner** spanning the row width, visually
     distinct from log lines and **never muted** by the noise filter or level
     chips:
     - `start`   → in-progress style, e.g. `╾─ ⟳ deploying <service> … ─╼`
     - `success` → success style, `╾─ ✓ deployed <service> ─╼`
     - `fail`    → error style, `╾─ ✗ deploy failed <service> ─╼`
   - A transient toast fires on a fresh `success`/`fail` marker **while the user
     is scrolled away** from the bottom (so an active deploy isn't missed).

## Non-goals (YAGNI)

- No App Runner `DescribeService` API polling / IAM changes — detection is from
  logs only.
- No deploy history persistence; markers live only in the in-memory buffer.
- No deploy markers for services whose log chip is toggled off.
- No new backend endpoint — the generic tail route is reused.

## Testing

- `lib/deploy-events.test.ts` — classifier over real `[AppRunner]` lines +
  negative cases.
- `lib/log-merge.test.ts` — extended for the union entry type and
  deploy/log interleaving + dedupe.
- `lib/sources/cloudwatch.test.ts` — `buildServiceMap` with the new
  `{ app, deploy }` shape and `/service` pairing (and missing-`/service`).
- Component behavior (folding, autoscroll-pause, chip composition) verified
  manually in the running dashboard.

## Files touched

| File | Change |
|------|--------|
| `lib/sources/cloudwatch.ts` (+ test) | service map carries `{ app, deploy? }` |
| `lib/deploy-events.ts` (+ test) | new pure deploy-line classifier |
| `lib/log-merge.ts` (+ test) | entries become log/deploy union |
| `app/api/cloudwatch/domains/route.ts` | response follows new map shape |
| `components/logs-panel.tsx` | pass `.app`/`.deploy` groups through |
| `components/log-console.tsx` | folding, row grid, controls, marker render |
