# Domain-scoped multi-service CloudWatch logs

**Date:** 2026-06-30
**Status:** Approved (design)

## Problem

The current Logs panel lets you pick a single CloudWatch log group from a flat
dropdown and tail it. Real debugging spans a whole domain: a request flows
`fe → bff → api`, and the ERP variants (`fe-erp`, `bff-erp`) live alongside.
You want to pick a **domain** (e.g. `auction`), see **all its services at once**
in one place, **toggle services in and out**, and **filter by environment** —
where environments are separate AWS accounts.

## Infrastructure facts (the reality this design targets)

- Services run on **AWS App Runner**, not ECS. App Runner publishes to CloudWatch
  under `/aws/apprunner/<service-name>/<service-id>/application` (app stdout/stderr)
  and `/aws/apprunner/<service-name>/<service-id>/service` (deploy/system events).
  **This feature uses `application` only.**
- Service names look like `auction-erp-bff-dev`, `auction-bff-dev`,
  `auction-api-dev`, `auction-frontend-dev`, `auction-erp-frontend-dev`.
  Shape: `<domain>-<service>-<env>`, dash-separated, env is the trailing token.
- **Environments are separate AWS accounts** (dev / stg / prod), each reached via a
  named AWS profile (SSO or static). Region is `eu-central-1`.

## Approach

**Auto-discover** everything from the selected environment's account — no
per-service or per-domain config to maintain. The dashboard lists App Runner
log groups, parses domain/service/env from the names, and builds the
domain → services tree live. The only configuration is the env → AWS-profile
mapping and the region.

The combined view opens **one SSE stream per enabled service** (reusing the
existing tail route's polling/dedupe logic) and the client merges them into a
single timestamp-sorted console. Toggling a service opens/closes exactly that
one stream, leaving the others undisturbed.

## Configuration

Added to `dashboard.config.ts`, sourced from env:

| Key | Env var | Example | Meaning |
|-----|---------|---------|---------|
| `cloudwatchEnvProfiles` | `CW_ENV_PROFILES` | `dev=auction-dev,stg=auction-stg,prod=auction-prod` | env → AWS named profile |
| `cloudwatchRegion` | `CW_REGION` | `eu-central-1` | CloudWatch region; falls back to `AWS_REGION` |

Note: the existing `parseEnvMap` splits on the first `:`. The env→profile entries
use `=` to avoid colliding with values that may contain `:`. The plan will add an
`=`-based parse (or a small variant) for this key. Default resolution: if
`CW_ENV_PROFILES` is unset, fall back to the default credential chain for a single
implicit `dev` env (preserves today's behavior).

The old `cloudwatchLogGroups` explicit map is **removed** — discovery replaces it.

## Server (`lib/sources/cloudwatch.ts`)

### Client per environment
```ts
function client(env: string): CloudWatchLogsClient
```
Resolves the profile for `env` from `cloudwatchEnvProfiles`, builds a client with
`fromIni({ profile })` + `cloudwatchRegion`. If no profile is mapped and `env` is
the implicit default, use the default credential chain (today's behavior).

### Discovery
```ts
type ServiceMap = Record<string /*domain*/, Record<string /*service label*/, string /*logGroupName*/>>
export async function getServiceMap(env: string): Promise<Result<ServiceMap>>
```
- `DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/apprunner/' })`, paginated
  via `nextToken`.
- Keep only names ending `/application`.
- Parse the `<service-name>` segment (between `/aws/apprunner/` and the next `/`):
  - strip trailing env token (`-dev` | `-stg` | `-prod`),
  - first dash-segment = **domain**,
  - remainder = **raw service**.
- Map raw service → friendly label:
  `frontend→fe`, `bff→bff`, `api→api`, `erp-frontend→fe-erp`, `erp-bff→bff-erp`.
  Unknown raw services pass through unchanged (forward-compatible with new services).
- Build `domain → { label → logGroupName }`. Domains sorted alphabetically.

Pure parsing/label helpers (`parseServiceName`, `serviceLabel`) are exported and
unit-tested without AWS.

### Tail (per service)
`getEvents(logGroup, startTime, env)` — same as today plus an `env` arg threaded
into `client(env)`. Polling/overlap/dedupe logic unchanged.

### Environments
```ts
export function logEnvironments(): string[]   // keys of cloudwatchEnvProfiles, or ['dev']
```

## API routes

- `GET /api/cloudwatch/domains?env=<env>` → `Result<ServiceMap>` for that env.
- `GET /api/cloudwatch/tail?env=<env>&group=<logGroupName>` → SSE, as today plus
  `env`. The client resolves a service's log group from the domains response and
  passes the resolved `group` here, so the tail route stays a thin per-group tail.
- `GET /api/cloudwatch/environments` → `Result<string[]>` (env list for the
  selector). Small; keeps the panel client-only and consistent with the existing
  `usePoll` pattern.

The old `GET /api/cloudwatch/groups` (flat list) is **removed**.

## UI (`components/logs-panel.tsx` + a new combined-console component)

Top controls:
- **Environment selector** (dev / stg / prod) — drives which account is queried.
- **Domain selector** — discovered domains for the current env.
- **Service toggle chips** — one per service present in `domain × env`
  (`fe bff api fe-erp bff-erp`), each independently on/off. Default: all on.

Combined console (`components/log-console.tsx`, new):
- Manages **one `EventSource` per enabled service**, keyed by service label.
- Each event is tagged `{ service, timestamp, message }` and pushed into a single
  buffer **sorted by timestamp**, capped ~2000 lines.
- Each line renders a colored `[service]` tag + ISO time + message, in the same
  terminal style as today's `LiveTail`.
- Toggling a chip opens/closes only that service's stream; existing streams and
  the merged buffer are untouched.
- Reused dedupe is per-stream (existing logic); the merged buffer additionally
  dedupes on `service + eventId`.

Deep-link: the page reads `?domain=<d>&env=<e>` from the URL for initial state, so
a domain click on the board / release-flow can open logs pre-scoped. Absent params
→ first env in the list, no domain selected (empty console with a hint).

## Error / edge handling

- **Missing/expired profile** (e.g. SSO token expired) → CloudWatch throws a
  credentials error; mapped to the existing `unconfigured` Result with a
  re-auth hint, shown per-env. Other envs keep working.
- **Domain with no application log groups in that env** → empty state, not an error.
- **Unknown raw service name** → shown under its raw label (no crash, no drop).
- **A single service stream errors** (e.g. its log group was deleted) → that
  stream shows `[stream error]` inline; the other services keep tailing.

## Testing

Unit (vitest, no AWS):
- `parseServiceName('auction-erp-bff-dev')` → `{ domain: 'auction', service: 'erp-bff', env: 'dev' }`.
- env-token stripping for `-dev/-stg/-prod`; names with extra dashes
  (`erp-frontend`); names without a recognized env token (leave env undefined / skip).
- `serviceLabel` mapping incl. pass-through for unknown services.
- `getServiceMap` builds the tree from a mocked `DescribeLogGroups` page set
  (mock the SDK client `.send`), incl. pagination via `nextToken` and dropping
  non-`/application` groups.
- `logEnvironments` from a parsed `CW_ENV_PROFILES`, and the single-`dev` fallback.

Existing `mapEvent` / `isMissingCreds` tests stay.

## Scope boundaries (YAGNI)

**In:** auto-discovered domains/services, env (account) filter, per-service toggles,
combined timestamp-sorted live tail, application logs only, `?domain=&env=`
deep-link.

**Out (deferred):** App Runner `service`/deploy log groups, historical date-range
queries, text search/grep, log download/export. A client-side substring filter is
trivial and may be added later but is not part of this scope.
