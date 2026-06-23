# Acceptance-Tester Agent Profile — Design

**Date:** 2026-06-23
**Status:** Approved (pending spec review)
**Branch:** feat/dev-dashboard

## Problem

The dashboard can dispatch a Jira ticket to a headless Claude agent that *implements* it
and opens a merge request (`lib/agent/runner.ts`, `buildAgentPrompt`). There is exactly one
hard-coded agent flow. We want a second kind of agent: an **acceptance tester** that, for a
ticket sitting in the Acceptance stage, confirms the change is actually live on the staging
environment and then exercises the ticket's acceptance criteria in a real browser, reporting
the result back to Jira.

## Goals

- Generalize the single hard-coded flow into named **agent profiles**: `implement` (existing,
  unchanged) and `acceptance` (new).
- The acceptance profile:
  1. Verifies the ticket is ready to test (in Acceptance, has acceptance criteria, has a
     configured staging URL).
  2. Confirms the staging deploy succeeded — GitLab `deploy:staging` job green **and** a clean
     CloudWatch startup.
  3. Drives a real browser (chrome-devtools MCP) against the staging URL to walk the
     acceptance criteria.
  4. Posts a pass/fail summary as a Jira comment. No status transition.
- When the ticket is missing anything needed to test, post a Jira comment listing exactly
  what's missing and **@-mention the assignee** so they can supply it.

## Non-Goals

- No automatic Jira status transitions (pass/fail is reported as a comment only).
- No auto-dispatch/polling — runs are started manually from the board (like the existing
  send-to-Claude button).
- The agent does not run the repo's own test suite and does not modify code.
- **The dashboard stores no staging credentials.** Login credentials live in the target repo
  on the PC; the dashboard never holds, persists, or passes secrets.

## Chosen Approach (A): Orchestrated gates + browser agent

The deterministic, auth-heavy steps (Jira read/write, GitLab job status, CloudWatch tail) run
**in the dashboard server** (`runner.ts`), reusing the existing `lib/sources/*` code where the
credentials already live. The headless agent does only the one thing it is uniquely good at:
driving the browser. This is more reliable than plumbing Jira/GitLab tokens into a spawned
`claude -p` process, and it produces specific, actionable failure messages.

Rejected alternatives:
- **B — fully autonomous agent** (agent does deploy-check + Jira comments itself): needs tokens/MCP
  wired into the spawned process; flakier; worse failure messaging; harder to debug.
- **C — two-stage agents**: most moving parts for no added benefit.

## Architecture

### 1. Agent profiles

Introduce a small profile registry. `startJob(key)` becomes `startJob(key, profile)` where
`profile ∈ { 'implement', 'acceptance' }` (default `'implement'` for back-compat). `JobMeta`
gains a `profile: AgentProfile` field. Each profile declares:

- `id`, `label`
- the gate/orchestration it runs (none for `implement`; readiness + deploy gates for `acceptance`)
- its prompt builder
- how its result is reported (MR-URL parse for `implement`; verdict parse + Jira comment for
  `acceptance`)

`implement` keeps today's exact behavior.

### 2. Acceptance flow (orchestrated in `runner.ts`)

1. **Fetch ticket.** Extend `getIssueDetail` to also return:
   - `status` (the Jira status name)
   - `assignee` `{ displayName, accountId }` (accountId needed for an ADF `@`-mention)
   - `acceptanceCriteria` — from an "Acceptance Criteria" heading in the description, or from a
     custom field when `ACCEPTANCE_CRITERIA_FIELD` is set.
2. **Readiness gate.** Require all of:
   - status matches `/accept/i` (same heuristic as `components/board-panel.tsx:40`)
   - acceptance criteria present
   - a staging URL configured for the ticket's Jira project
   If any are missing → post a Jira comment listing the missing items, @-mention the assignee,
   set job status `blocked`, stop.
3. **Deploy gate.** Resolve the pipeline for the branch's latest commit (reuse
   `lib/sources/board`/`gitlab`), poll until `deploy:staging` (config `stagingJobName`) is
   `success`, then tail CloudWatch for the project's staging log group briefly to confirm a
   clean startup (no crash/error markers). On failure/timeout → Jira comment (tag assignee),
   set job `blocked`/`failed`, stop. Bounded poll with a timeout.
4. **Browser test.** Spawn detached headless `claude -p` (cwd = repo path, like `implement`,
   but read-only — no branch/commit) with the chrome-devtools MCP available, given:
   - the staging base URL
   - the acceptance criteria and ticket summary/description
   The agent is instructed to use the **repo's own local credentials** (its `.env`/config in the
   checkout) for any staging login — the dashboard supplies no secrets. It then walks each
   criterion in the browser and ends its final message with a structured verdict on its own
   line, e.g. `ACCEPTANCE-RESULT: PASS` / `ACCEPTANCE-RESULT: FAIL` followed by findings.
5. **Report.** Runner parses the verdict from the agent's output (same mechanism as the
   existing MR-URL parse in `getJob`) and posts a pass/fail summary comment to Jira.

### 3. Configuration (`dashboard.config.ts`, env-driven)

Following the existing `parseEnvMap` style (keyed by Jira project key, e.g. `NBDE`):

- `STAGING_URLS="NBDE:https://staging.example.com,ERP:https://erp-stg.example.com"` — per-project
  staging base URL. Missing key ⇒ acceptance profile is not runnable for that project.
- `ACCEPTANCE_CRITERIA_FIELD` (optional) — Jira custom field id if criteria live in a field
  rather than the description.

**No credential config.** Staging login credentials are intentionally *not* a dashboard concern;
they live in the target repo on the PC and are used by the agent from that repo's checkout.

### 4. UI

A "Test in acceptance" button on ticket cards **only in the Acceptance stage** (mirrors the
existing send-to-Claude button), POSTing `{ key, profile: 'acceptance' }` to `/api/agent/start`.
The agents view shows each job's profile; the detail view shows gate progress
(readiness → deploy → test → reported).

### 5. Job status

Add a `blocked` status to `JobStatus` (distinct from `failed`) for "couldn't test — missing
info or deploy not live", so blocked-on-input is visually distinct from a real failure.

## Data flow

```
Acceptance card  ── POST /api/agent/start {key, profile:'acceptance'} ──▶  startJob(key,'acceptance')
                                                                              │
  getIssueDetail (status, assignee, criteria) ─ readiness gate ─ fail ▶ Jira comment @assignee, blocked
                                                                              │ ok
  gitlab/board: deploy:staging success?  +  cloudwatch clean startup ─ fail ▶ Jira comment @assignee, blocked/failed
                                                                              │ ok
  spawn claude -p (chrome-devtools MCP, url+criteria; creds from repo) ─▶ verdict in log
                                                                              │
  parse ACCEPTANCE-RESULT ─▶ Jira comment (PASS/FAIL + findings) ─▶ job done
```

## Error handling

- Every gate failure produces a specific Jira comment (tagging the assignee) and a clear job
  `reason`. Jira-write failures are surfaced in the job log/meta, never silently swallowed.
- Deploy gate is bounded by a timeout; a stuck/never-green deploy ends as `blocked` with reason.
- The agent never transitions the ticket and never touches code.

## Testing

Unit tests (mirroring `lib/agent/prompt.test.ts` and `lib/sources/jira.test.ts`):

- profile selection / default to `implement`
- readiness gating across permutations (missing criteria / URL / wrong status)
- the missing-info Jira comment text + assignee mention construction
- acceptance-criteria extraction (description heading and custom-field paths)
- verdict parsing (`ACCEPTANCE-RESULT: PASS|FAIL`, malformed/absent)

Deploy gate and the browser run are integration-level — verified manually against a real
Acceptance ticket.

## Dependencies / assumptions

- The chrome-devtools MCP must be available to the spawned headless agent (globally configured
  or via a project `.mcp.json`). Flagged as a setup prerequisite.
- The target repo's checkout holds whatever staging credentials its login needs.
- The dashboard server has the GitLab, Jira, and CloudWatch credentials it already uses.
- Jira write (add comment) permission for the configured Jira token.
