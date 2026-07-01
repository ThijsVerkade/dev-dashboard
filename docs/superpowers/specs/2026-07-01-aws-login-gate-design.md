# AWS login gate for the dashboard

**Date:** 2026-07-01
**Status:** Approved — ready for planning

## Goal

When you open the desktop dashboard, nothing renders until a valid AWS SSO
session exists. You see a login screen; clicking it triggers `aws sso login`
(browser flow); once credentials are valid, the full dashboard reveals. This is
a **hard block** — there is no "continue without AWS" escape hatch.

## Background / current state

AWS login already happens two ways today:

1. `scripts/ensure-sso.sh` runs as a `predev` hook before `npm run dev`, doing
   `aws sso login` for the configured SSO session if the token is missing.
2. The CloudWatch **Logs panel** (`components/logs-panel.tsx`) lazily triggers
   login via `POST /api/cloudwatch/login` only when its creds come back
   `unconfigured`, showing a "⟳ re-authenticate (AWS SSO)" button.

So login is currently **scoped to the Logs panel**, not the dashboard as a
whole. The `/api/cloudwatch/login` route (loopback-only, spawns `aws sso login`)
and `lib/sso-login.ts` pure helpers already exist.

This feature promotes login to a **dashboard-wide gate** on the desktop surface.

## Architecture

### 1. Auth-status probe (server)

A cheap "are AWS creds valid right now?" check.

- Add `probeAuth(env: string): Promise<Result<{ profile?: string }>>` to
  `lib/sources/cloudwatch.ts`. It issues one `DescribeLogGroups` call with
  `limit: 1` against the env's profile/region and maps the outcome through the
  existing `isMissingCreds` helper:
  - success → `ok`
  - `isMissingCreds(err)` → `unconfigured` (needs login)
  - any other error → `failure`
- Add route `GET /api/cloudwatch/auth-status?env=<env>` returning that `Result`.
  Uses the same profile/region resolution the Logs panel already relies on, so
  the auth signal matches what the panel sees.

### 2. The gate (client)

`components/aws-login-gate.tsx` (`'use client'`), wrapping `children` inside the
`app/(dashboard)/layout.tsx` body.

States:

- `checking` → minimal "Checking AWS session…" splash.
- `authed` → renders `{children}` (the real dashboard).
- `needs-login` / `error` → login screen: heading, the message returned by the
  probe, and a **"Log in to AWS SSO"** button.

Flow on button click:

1. `POST /api/cloudwatch/login?env=<gateEnv>` (existing route) — opens the
   browser SSO flow.
2. Poll `GET /api/cloudwatch/auth-status?env=<gateEnv>` every ~2s, showing
   "Waiting for you to approve in your browser…", until it returns `ok`.
3. Transition to `authed` and reveal the dashboard.

### 3. Gate env selection

Add a pure helper `gateEnv(envs: string[]): string | undefined`:

- Prefer `'dev'` if present, else the first configured env, else `undefined`.

Rationale: `aws sso login` for one profile authorizes every profile sharing that
SSO session, so probing/logging in for a single env is sufficient. The env list
comes from `logEnvironments()` (keys of `cloudwatchEnvProfiles`).

## Reused / unchanged

- `/api/cloudwatch/login` route and `lib/sso-login.ts` — no change.
- The **Logs panel's own re-auth button stays.** The gate only checks on mount,
  so the panel continues to handle *mid-session* token expiry. They are
  complementary.
- To avoid duplicated fetch logic between the gate and the Logs panel, extract a
  small shared client helper `lib/aws-login-client.ts` (functions to trigger
  login and to fetch auth-status). Both the gate and `logs-panel.tsx` use it.
- `predev` / `ensure-sso.sh` stays — it means the gate usually passes instantly
  on first load.

## Scope / edge cases

- **Mobile untouched.** The `app/(mobile)/layout.tsx` surface (phone view over
  LAN) gets no gate — the login route is loopback-only (would 403 from a LAN IP)
  and browser SSO isn't practical from a phone. The shared dev-server process
  already holds valid creds from `predev`, so the mobile view reads logs fine.
- **No profile configured** → probe returns `unconfigured`; the gate shows the
  login screen; clicking surfaces the existing "No AWS profile configured"
  message from the login route. Diagnosable, consistent with the hard-block
  choice.
- **Deployed / non-loopback** — this is a local dev tool. On loopback everything
  works. On a deployed box, IAM-role credentials make the probe return `ok`, so
  the gate passes straight through without ever showing the login button.

## Testing (TDD)

- Pure helpers unit-tested with vitest:
  - `gateEnv(envs)` — prefers `dev`, falls back to first, handles empty.
  - `nextGateState(result)` — maps a `Result` to a gate status
    (`authed` / `needs-login` / `error`).
- The gate component stays thin, delegating to those pure functions plus the
  shared client helper. No React Testing Library / jsdom is configured in the
  repo, so component-level tests are out of scope unless we choose to wire up
  jsdom separately.

## Out of scope

- Any "skip / continue without AWS" path (explicitly rejected — hard block).
- Gating the mobile surface.
- Changing how `ensure-sso.sh` / `predev` works.
