# Send Ticket to Claude — Agent Orchestrator

**Date:** 2026-06-23
**Status:** Approved — Phase 1

## Goal

From the dashboard, dispatch a Jira ticket to a headless Claude Code agent that
runs **on this machine, in the matching local repo**, implements the ticket on a
fresh branch, pushes, and opens a merge request. The dashboard resolves the
repo, builds a prompt from the ticket, spawns the agent as a tracked background
job, and lets the user monitor it.

**Design principle: thin orchestrator.** The dashboard does NOT do git/MR work.
It spawns a full Claude Code agent and the agent branches, implements, commits
(BAS ADR-6 standard via the `bas-merge-commit-messages` skill), pushes, and
opens the MR.

### User-chosen configuration (explicit, high-risk)
- Repo mapping: **config map by Jira project key**.
- Output: **full — push + open MR**.
- Autonomy: **`--dangerously-skip-permissions`** (agent runs unattended).

### Guardrails (enforced regardless)
- Agent works on a **fresh branch only, never `main`**.
- Every run is **recorded** to `.agent-jobs/` (metadata + log).
- Dashboard is localhost-only.

### Risk (consciously owned)
A Jira ticket can trigger fully autonomous code that runs any command and lands
an MR with zero prompts. This is the sharp-knife configuration the user chose.

## Phase 1 scope (this spec)

The full end-to-end loop, minimal UI:
1. Config repo map + workspace resolution.
2. Jira ticket detail fetch (summary + description).
3. Prompt builder (pure, unit-tested).
4. Background job runner (spawn headless agent, track, log).
5. APIs: start a job, list jobs, get one job (status + streamed events).
6. Minimal **Agents** page: enter a ticket key → send; list jobs with status;
   open a job to watch its streamed output and grab the MR link.

Phase 2 (later, not now): in-ticket "Send to Claude" button on the Release Flow
board, richer detail view, MR-link extraction polish, cancel/retry.

## Components

### Config — `dashboard.config.ts`
Add a literal, editable map (no secrets, no absolute paths):
```ts
agentRepos: { 'NBDE': 'auction-api' } as Record<string, string> // project key → repo dir name
```
Base dir resolved server-side as `process.env.WORKSPACE_DIR ?? ~/workspace`.
Repo path = `join(workspaceDir, agentRepos[projectKey])`. Unmapped key → error.

### Jira detail — `lib/sources/jira.ts`
- `flattenAdf(node): string` — pure; recursively extracts text from Atlassian
  Document Format (and tolerates a plain string). Unit-tested.
- `getIssueDetail(key): Result<IssueDetail>` where
  `IssueDetail = { key, summary, description, url }`. Fetches
  `/rest/api/3/issue/{key}?fields=summary,description`.

### Pure agent helpers — `lib/agent/prompt.ts` (unit-tested)
- `projectKeyOf(issueKey)` → `'NBDE-817'` ⇒ `'NBDE'`.
- `slugify(summary)` → kebab-case, capped ~40 chars.
- `buildAgentPrompt(detail, { branch, baseBranch })` → the instruction string:
  ticket key/summary/description; create `branch` off `baseBranch` (never main);
  implement; run build/tests if present; commit + push via
  `git push -o merge_request.create -o merge_request.target=<baseBranch>`
  (no glab/gh installed); use `bas-merge-commit-messages` skill for the MR text;
  report the MR URL.

### Job runner — `lib/agent/runner.ts`
- `JobMeta = { id, key, repo, branch, status: 'running'|'done'|'failed', startedAt, pid }`.
- `startJob(key): Result<{ id }>` — resolve repo (error if unmapped), fetch
  detail, derive branch `feat/<KEY>-<slug>`, build prompt, then spawn:
  ```
  claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions
  ```
  detached, `cwd` = repo path, stdout+stderr → `.agent-jobs/<id>.log`. Persist
  `<id>.json`. On exit, update status from exit code. `unref()` so it survives
  the request; exit handler still fires while the server lives.
- `listJobs(): JobMeta[]` — read `.agent-jobs/*.json`, newest first; if a
  `running` job's pid is no longer alive, report `failed` (best-effort).
- `getJob(id): { meta, events, mrUrl }` — tail the log, reuse
  `parseTranscriptTail` + `normalizeEvents` from `claude-live` (stream-json
  shares the assistant/user message shape), regex the log for a `merge_requests/<n>`
  URL.

### APIs
- `POST /api/agent/start` `{ key }` → `Result<{ id }>`.
- `GET /api/agent/jobs` → `Result<JobMeta[]>`.
- `GET /api/agent/jobs/[id]` → `Result<{ meta, events, mrUrl }>`.

### UI — `app/agents/page.tsx` + `components/agents-panel.tsx`
- Ticket-key input + "Send to Claude" button → POST start.
- Job list (poll `/api/agent/jobs`, ~3s): status pill, ticket, repo, branch, time.
- Selected job detail (poll `/api/agent/jobs/[id]`): streamed events in the Live
  Activity style + MR link when present.
- New nav item **Agents** (`components/nav-items.tsx`).

## Edge cases
- Project key not in `agentRepos` → `failure` with the key.
- Repo path missing on disk → `failure`.
- `claude` binary missing → `failure` (ENOENT).
- Jira unconfigured → existing `unconfigured` path.

## Testable core
- `flattenAdf`: nested paragraphs/text → joined text; plain string passthrough.
- `projectKeyOf`, `slugify`: boundary cases.
- `buildAgentPrompt`: contains branch, base, key, and the push-option line; never
  instructs committing to main.
