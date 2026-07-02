# Non-blocking AWS logging + Docker finalize — Design

**Date:** 2026-07-02
**Status:** Approved (approach), pending spec review

## Context

The dev-dashboard is a **local-development-only** Next.js/TypeScript tool. Two goals:

1. **AWS logging must not block the whole app.** Today `app/(dashboard)/layout.tsx` wraps everything
   in `<AwsLoginGate>`, so nobody can use the dashboard until they complete `aws sso login`. But the
   only feature that needs AWS is the CloudWatch **Logs** panel. Board actions (deploy-staging, merge,
   tag, play job), Jira, and agent triggers are pure GitLab / Jira / local — no AWS. Product owners
   will use the dashboard to trigger those, so AWS must become optional and scoped to logs.

2. **Finalize the Docker setup** (local-only): give it an obvious local access link, install the
   `claude` CLI so agent-triggering works inside the container, and verify it boots end-to-end.

## Piece 1 — Make AWS logging non-blocking (approach A: scope into Logs panel)

**Insight:** the Logs panel already handles its own AWS auth inline. `components/logs-panel.tsx`
detects `unconfigured` credential results, auto-fires `aws sso login` once per env, and renders a
"⟳ re-authenticate (AWS SSO)" button. So the panel is already self-sufficient.

The *only* thing making AWS app-wide-blocking is the `<AwsLoginGate>` wrapper.

**Change:**
- `app/(dashboard)/layout.tsx`: remove the `<AwsLoginGate>…</AwsLoginGate>` wrapper and its import.
  `<ReposSetupGate>` (repo setup) stays — that gate is still required for the app to function.
- Delete `components/aws-login-gate.tsx` — it becomes dead code (only the layout imported it).
- Keep `lib/aws-login-client.ts` and its test — still used by the Logs panel (`triggerSsoLogin`).

**Result:** the dashboard renders immediately after repo setup. AWS SSO is prompted only inside the
Logs panel, only when someone opens logs and creds are missing. Nothing a product owner triggers is
gated on AWS.

**Non-goal:** changing `lib/agent/deploy-gate.ts` (it uses CloudWatch for the agent *acceptance*
profile and already degrades gracefully via `Result` — not a PO trigger path).

## Piece 2 — Finalize Docker (local-only)

### 2a. Local access link

Inside the container Next binds `0.0.0.0`, so it prints a non-clickable `http://0.0.0.0:3000`. Make
the startup print a clickable local link. Change the `Dockerfile` `CMD` to a shell form that echoes
the URL then execs the dev server (so signals still propagate):

```dockerfile
CMD ["sh", "-c", "echo '\\n  ➜  dev-dashboard ready at: http://localhost:3000\\n' && exec npx next dev -H 0.0.0.0 -p 3000"]
```

README Docker section leads with **open http://localhost:3000**.

### 2b. Install the `claude` CLI in the image

The agent runner spawns `CLAUDE_BIN` (default `claude`) headlessly (`runner.ts:183`). The CLI is not
in the image today, so agent-triggering from the container fails. Add to the `Dockerfile`:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Auth + transcripts live in `~/.claude`, which the compose file mounts from the host. The agent runner
*writes* there (Claude Code stores project transcripts/session state), so the mount must be **rw**,
not the current `ro`. Update `docker-compose.yml`:

```yaml
- ${HOME}/.claude:/root/.claude:rw   # was :ro — Claude Code needs to write session/transcript state
```

**Verification caveat to confirm during implementation:** on a macOS host, Claude Code may store its
credentials in the macOS Keychain rather than in `~/.claude/.credentials.json`. If so, the container's
`claude` won't be authenticated via the mount alone. Implementation step must verify how the host
stores credentials and document the actual requirement (e.g. run `claude` once to produce a file-based
token, or set an API key env var) rather than assuming the mount is sufficient.

### 2c. Verify end-to-end

Build the image and boot via `docker compose up`; confirm:
- the startup log prints the `http://localhost:3000` link,
- the dashboard loads without an AWS gate (repo setup gate still shows if repos aren't set up),
- `claude` resolves on PATH inside the container (`docker compose exec dashboard claude --version`).

## Files touched

- `app/(dashboard)/layout.tsx` — remove AWS gate wrapper + import.
- `components/aws-login-gate.tsx` — delete (dead).
- `Dockerfile` — `CMD` link echo; `npm i -g @anthropic-ai/claude-code`.
- `docker-compose.yml` — `~/.claude` mount `ro` → `rw`; comment refresh.
- `README.md` — Docker section: lead with the link; note claude CLI in image + rw mount.

## Testing

Little new pure logic to unit-test (removal + infra). Existing suites (`npm test`) must stay green.
The gate removal is verified by the Docker end-to-end boot (2c) and by `npx tsc --noEmit` /
`npm run lint` staying clean after the component deletion.
