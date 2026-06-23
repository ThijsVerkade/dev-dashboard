# Live Claude Activity — Design

**Date:** 2026-06-23
**Status:** Approved

## Goal

A read-only, auto-refreshing feed on the Claude page that shows what the
most-recently-active Claude Code session is doing right now — a terminal-style
timeline of messages and tool calls, plus a live status line. It answers the
question "what is Claude in my terminal busy with?" without any control surface.

Out of scope: sending input to a session, controlling a session, or chatting
with a dashboard-owned headless Claude. This feature is observability only.

## Data source

Claude Code streams every session to a JSONL transcript at
`~/.claude/projects/<encoded-project>/<session-id>.jsonl`. Each line is a JSON
object. Relevant shape:

- `type`: `assistant` | `user` | (other metadata types we ignore)
- `timestamp`: ISO string
- `message.model`: e.g. `claude-opus-4-8` (assistant lines)
- `message.content`: array of blocks (or a string). Block kinds we care about:
  - `text` — assistant prose / user message
  - `thinking` — assistant reasoning (**hidden from the feed**)
  - `tool_use` — has `name` (and `input`)
  - `tool_result`

## New API route — `/api/claude/live`

Server-only. Follows the existing `Result` pattern (`ok` / `failure` /
`unconfigured`) used by the other Claude sources.

1. **Find the active session:** scan `~/.claude/projects/*/*.jsonl`, pick the
   file with the newest mtime. Cache this directory scan for ~5s (poll rate is
   ~2.5s) — keep tailing the same file between scans.
2. **Tail-read only** the last ~256 KB of that file (files reach 14 MB+, never
   parse the whole thing). Read the trailing chunk, split on newlines, drop a
   possibly-truncated leading partial line, `JSON.parse` the remainder.
3. **Normalize** the last ~40 `user`/`assistant` lines into events:
   `{ ts, role, kind, label }` where `kind ∈ text | tool_use | tool_result`
   (`thinking` blocks are skipped entirely). `label` is a short snippet:
   - `text` → first ~120 chars of the text
   - `tool_use` → tool `name` + a brief arg summary (Bash `command`,
     Read/Edit/Write `file_path`, etc.), truncated
   - `tool_result` → short marker (no full output dump)
4. **Return** events + metadata: `project` (derived from the dir name), short
   `sessionId`, `model`, `lastActivity`, and a derived `status`:
   - last line is `tool_use` with no following `tool_result` → `running <tool>`
   - last line is assistant `text` → `responding`
   - last activity older than ~60s → `idle <Ns>`

### Edge cases
- No JSONL files found → `unconfigured("no Claude sessions found")`.
- Read / parse errors → `failure(...)`.

## UI

New client component (e.g. `components/claude-live.tsx`), mounted at the **top**
of the existing Claude page (`app/claude/page.tsx`); the usage-stats panel stays
below. Reuses `usePoll('/api/claude/live', 2500)` and `PanelShell`.

- **Status header:** project · short session id · model · a status pill
  (`● running Bash`, `idle 12s`, `responding`) in the hacker-terminal palette.
- **Timeline:** scrolling list, newest at bottom (terminal-like). Each event
  shows a kind icon/color, a timestamp, and its truncated label. Tool calls
  render distinctly from prose.

## Liveness

`usePoll` at ~2.5s. No streaming/SSE infrastructure — consistent with the rest
of the dashboard.

## Privacy note

This surfaces transcript content (prompts, code snippets, tool output) in the
browser. Acceptable for a localhost dev dashboard; documented here so it is a
conscious choice.

## Testable core

The tail-read + line-parse + normalize logic is pure and should be unit-tested:
- tail chunk with a truncated leading line → partial line dropped, rest parsed
- mixed content blocks → `thinking` skipped, others mapped with correct labels
- status derivation for the running / responding / idle cases
