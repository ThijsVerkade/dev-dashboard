---
name: brain-git-activity
description: Use when the user asks about recent git activity, active branches, who last changed an app, or "what's been happening" in the BAS repos or the Knowledge Brain vault. Surface it live from git — never from a note.
---

# Brain git activity

The Knowledge Brain notes under `brain/` describe each app's **stable** facts
(stack, scripts, config, architecture). They deliberately do NOT record git
activity, which goes stale the moment it is written. Pull activity **live**
from the cloned repos instead.

## Where the repos are

`repos/<owner>/<group>/<app>` (e.g. `repos/basworld/auction/api`). A brain note
at `brain/projects/<group>/<app>.md` carries the repo path in its `repo:`
frontmatter.

## How to answer common questions

- **Recent commits for an app:**
  `git -C repos/basworld/<group>/<app> log --oneline -20`
- **Who last touched it / when:**
  `git -C repos/basworld/<group>/<app> log -1 --format='%an, %ar — %s'`
- **Active branches:**
  `git -C repos/basworld/<group>/<app> branch -a --sort=-committerdate`
- **What changed across all apps this week:** loop over the app dirs and run
  `git -C <dir> log --since='1 week ago' --oneline`.
- **Uncommitted work:** `git -C <dir> status --short`.

## Rules

- Always run against the actual repo path; never quote activity from a note.
- Read-only: never commit, push, or mutate a repo when answering an activity
  question unless the user explicitly asks.
- If a repo dir is missing, tell the user to run `npm run setup` to clone it.
