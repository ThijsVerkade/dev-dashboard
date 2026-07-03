# Richer Brain Extraction — Design

**Date:** 2026-07-03
**Status:** Approved (for planning)

## Goal

The Knowledge Brain vault is structurally complete but thin: `extractProject`
reads only `package.json` (deps + scripts) and the README's first paragraph.
PHP/Laravel repos have no `package.json`, so `auction/api` and `lease/api`
render empty ("_none detected_" / "_none_"). Standards pages are `TBD` stubs.
This project deepens extraction so pages read like real docs, adds
architecture standards authored for AI-agent navigation, and ships git-activity
awareness as a Claude skill rather than a stale snapshot.

## Architecture

Extend the existing pure pipeline — `extract-project.ts` (facts) →
`render.ts` (markdown) → `vault.ts` (orchestration) — without changing its
shape. Extraction stays a pure function over the filesystem; new "detected
facts" (composer stack, env keys, layout, bounded contexts, tier tooling) are
added to `ProjectFacts` and rendered into the AUTO block, preserving the
existing human-prose merge (`mergeAutoBlock`). Architecture standards are
authored prose grounded in facts detected from the real repos. Git activity is
intentionally NOT extracted — it lives as a committed Claude skill so it is
always live.

## Detected facts (from the actual repos)

- **`auction/api`** — DDD + hexagonal: bounded contexts `Auction`, `Hexon`,
  `Inventory`, `Notification`, `Publishing`, `Shared`, each with
  `Application` / `Domain` / `Infrastructure`; `Http/` (Controllers, Requests,
  Resources) is the entry layer. `composer.json`: PHP ^8.2, Laravel ^13,
  Pest, Larastan, Pint, Symfony components.
- **`lease/api`** — lighter/transitional: `Application`, `Lease`, `Shared`,
  plus `Models`, `Repositories`, `DTO`, `Enums`.
- **FE → BFF → API** — the BFF `.env.example` declares
  `AUCTION_API_URL=http://localhost:8000`; the chain is detectable from
  `*_API_URL` env keys in BFF repos.

## Components

### 1. Composer / PHP support (`extract-project.ts`)
Read `composer.json` when present, in addition to `package.json`. New stack
detectors keyed on composer package names:
`php` → `PHP <version>` (version from the `require.php` constraint),
`laravel/framework` → `Laravel <version>`, `pestphp/pest` → `Pest`,
`larastan/larastan` → `Larastan`, `laravel/pint` → `Pint`,
`symfony/*` → `Symfony`. Composer `scripts` keys are merged into the scripts
list. npm and composer stacks/scripts coexist when both manifests exist.

### 2. Richer per-repo facts (`ProjectFacts` + AUTO block)
New fields and rendered sections:
- **`envKeys: string[]`** — variable NAMES parsed from `.env.example` (left of
  `=`, comment/blank lines skipped). Values are never read or emitted.
  Rendered as `## Configuration`.
- **`layout: string[]`** — top-level directory names, excluding
  `node_modules`, `vendor`, `.git`, `.next`, `dist`, `build`, `coverage`,
  `storage`, `bootstrap`. Rendered as `## Layout`.
- **Stack versions** — stack labels carry versions where the manifest provides
  them (`Laravel ^13.0`).
- **`boundedContexts: string[]`** (API tier only) — top-level dirs under `app/`
  that contain a `Domain` subdirectory. Rendered as `## Bounded contexts`.

### 3. Fuller README summary (`extract-project.ts`)
Replace "first non-empty paragraph" with "first section": all prose from after
the `# Title` up to the second `##` heading (i.e. through the first section
such as `## Overview`), joined, capped at ~600 characters (truncated on a word
boundary with `…`). Falls back to the old single-paragraph behavior when no
`##` sections exist.

### 4. Standards — filled

Tooling-derived (AUTO block, human prose preserved via `mergeAutoBlock`):
- **`testing.md`** — test frameworks detected across repos, grouped by tier
  (Pest → API, Vitest/Jest → FE/BFF).
- **`coding-standards.md`** — linters/formatters detected (Pint, ESLint,
  Prettier, Biome).

Authored architecture standards — a multi-level tree under `architecture/`,
written so an AI agent can navigate from overview down to a single layer:
- **`architecture/index.md`** — MOC linking the notes below; one-paragraph
  orientation.
- **`architecture/system-flow.md`** — FE → BFF → API request flow; each tier's
  responsibility; the rule that the FE never calls the API directly; the BFF
  owns aggregation + auth passthrough; the API owns the domain. Links the
  detected BFF→API wiring.
- **`architecture/domain-layer.md`** — entities, value objects, domain events,
  bounded contexts; grounded in the detected `auction/api` contexts.
- **`architecture/application-layer.md`** — use cases / application services /
  commands; orchestration boundary; no framework/HTTP concerns.
- **`architecture/infrastructure-layer.md`** — persistence, external adapters,
  hexagonal ports/adapters; Laravel/Eloquent as an infrastructure detail.

These architecture notes are **seeded once** (human-editable), like standards
stubs — re-runs preserve edits.

### 5. Git-activity Claude skill (`.claude/skills/brain-git-activity/SKILL.md`)
A committed project skill (travels with the repo on clone). It documents how
Claude should surface live git activity for the vault and `repos/` on demand —
recent commits, active branches, who last touched an app — using `git -C
<repo>` against the cloned repos, rather than reading a frozen snapshot from a
note. Referenced from `ONBOARDING.md`.

## Data flow

`discoverRepos` (unchanged) → `extractProject` (now reads composer.json,
.env.example, app/ layout, README section) → `ProjectFacts` (new fields) →
`renderProjectPage` (new AUTO sections) → `vault.ts` write. Standards tooling
detection aggregates facts across all repos before rendering
`testing.md`/`coding-standards.md`. Architecture notes are static templates
seeded by `vault.ts`.

## Error handling

All new reads are best-effort: a missing/malformed `composer.json`,
`.env.example`, or `app/` yields empty arrays, never throws. Matches the
existing `readJson`/try-catch pattern. The build never fails because a repo
lacks a given file.

## Testing

Vitest is the gate (bare tsc/lint/build are pre-broken in this repo). Unit
tests with fixtures for: composer stack/script detection, env-key parsing
(keys only, no values), layout filtering, bounded-context detection, README
section capture + cap, standards tooling aggregation. Fixtures live under
`lib/brain/__fixtures__/`. AUTO-block preservation is already covered by
existing `auto-block` tests; new render sections get assertions in
`render.test.ts`.

## Global constraints

- **Next.js 16** is not training-data Next.js — no route/page changes are in
  scope here, but if any arise, read `node_modules/next/dist/docs/` first.
- **Vitest is the real gate.** Bare `tsc`/`lint`/`build` are pre-broken; do not
  treat their output as authoritative.
- **Secrets never emitted or committed.** `.env.example` → keys only, never
  values. No `.env.local`, no tokens.
- **Do not weaken `eslint.config.mjs`** (config-protection hook blocks it) — fix
  source to satisfy the linter.
- **Preserve human prose.** Project pages and seeded standards use
  `mergeAutoBlock` / seed-once; re-runs must not clobber hand edits.
- **Pure, best-effort extraction.** No new throwing paths; missing files → empty.
