# Mobile agent trigger over Tailscale

## Problem

The dashboard's Agents tab dispatches a Jira ticket to a headless `claude`
agent that runs **on this Mac** (`lib/agent/runner.ts` spawns a detached
`claude --dangerously-skip-permissions` process). Today this can only be
triggered from the dashboard running on the Mac. We want to trigger and
monitor these jobs from a phone, while the agent keeps running on the Mac.

## Approach

The phone reaches the Mac over **Tailscale** (a private WireGuard mesh VPN),
so there is no public-internet exposure — tailnet membership is the primary
security boundary. A new mobile-optimized page (`/m`) is a thin client over
the **existing** agent/Jira APIs. A shared-secret PIN provides defense in
depth on the mutating endpoints.

## 1. Network access

The dashboard server must bind to all interfaces so the Tailscale address
resolves to it.

- Add npm scripts:
  - `dev:lan` → `next dev -H 0.0.0.0`
  - `start:lan` → `next start -H 0.0.0.0`
- On the Mac: run `npm run dev:lan` (or `start:lan`).
- On the phone: open `http://<mac>.<tailnet>.ts.net:3000/m` (Tailscale
  MagicDNS name).
- The page's API calls are same-origin (relative URLs), so no client config
  changes are needed.

**Trade-off:** `0.0.0.0` also exposes the port on any other network the Mac
joins (e.g. café WiFi). The PIN (section 3) mitigates this. A tighter option
— binding to the Tailscale interface IP (`100.x.y.z`) — is left as a future
refinement, since that IP is per-machine and less convenient.

## 2. Mobile page (`/m`)

A single-column, large-tap-target page. New files only; no new backend.

- `app/m/page.tsx` — route, renders the client component.
- `components/mobile-agents.tsx` — client component:
  - **My tickets**: fetched from `GET /api/jira/my`. Each row shows the key +
    summary with a large **Dispatch** button that `POST`s to
    `/api/agent/start` (`{ key }`). A manual "enter key" input is the
    fallback.
  - **Running jobs**: fetched from `GET /api/agent/jobs` (polled, reusing
    `lib/use-poll.ts`). Compact list with status pills. Tapping a job shows a
    slim event tail + MR link from `GET /api/agent/jobs/[id]` (same
    `JobDetail` shape `AgentsPanel`'s `JobView` already renders).
  - Ensure a mobile viewport (`viewport` export / meta) so the page renders
    at phone width.

## 3. PIN / shared-secret auth

- New env var `AGENT_TRIGGER_TOKEN`.
- **When set**, the mutating agent endpoints require a matching
  `x-agent-token` request header:
  - `POST /api/agent/start`
  - `POST /api/agent/jobs/[id]/cancel`
- **When unset**, behavior is unchanged (back-compat — no gate).
- Read-only endpoints (`/api/agent/jobs`, `/api/agent/jobs/[id]`,
  `/api/jira/my`) are not gated; they sit behind the tailnet.
- Comparison uses a timing-safe equality check.

Helpers:

- Server: `requireAgentToken(req)` in `lib/agent/` — reads
  `process.env.AGENT_TRIGGER_TOKEN`, allows when unset, otherwise compares the
  `x-agent-token` header timing-safely. Returns a Result/boolean the routes
  use to short-circuit with a failure response.
- Client: a small helper that reads the PIN from `localStorage` and returns
  the header object to spread into `fetch`. A first-use prompt stores the PIN.

Both the **mobile page** and the existing desktop `AgentsPanel` use the
client helper, so the PIN is entered once per device and remembered. The
secret stays server-side; the user types it on the device — it is never in
the client bundle. Over Tailscale the header travels inside WireGuard
encryption, so a plaintext token is acceptable.

## 4. Testing

- Unit-test `requireAgentToken`:
  - token unset → allow (regardless of header)
  - token set + correct header → allow
  - token set + missing header → deny
  - token set + wrong header → deny
- Route test: `POST /api/agent/start` with `AGENT_TRIGGER_TOKEN` set and no
  header → rejected (does not spawn).
- Existing Jira/jobs endpoints already have coverage. The mobile page is thin
  UI over tested APIs.

## Out of scope (YAGNI)

- Push notifications to the phone.
- Public-internet exposure (no tunnel/ngrok; Tailscale only).
- Multi-user accounts / per-user tokens.
