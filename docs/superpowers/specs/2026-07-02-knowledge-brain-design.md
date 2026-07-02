# Knowledge Brain — Obsidian vault generator

**Date:** 2026-07-02
**Status:** Approved (design)
**Author:** Thijs Verkade

## Summary

A generator (`npm run brain`) that reads the repos cloned under `./repos` and a
configured list of Confluence ADR links, and produces a linked-markdown **Obsidian
vault** at `./brain/`. Re-running the command re-syncs the vault. The output serves
two audiences equally: humans browsing in Obsidian (onboarding, "how do we do X
here") and an LLM/agent that is pointed at `brain/` as structured context before
working in a repo.

The vault consolidates three kinds of knowledge:

1. **Standards** — the shared, org-wide conventions ("in common"), split by tier:
   API, Frontend, BFF, plus cross-cutting coding standards, testing, and deployment.
2. **ADRs** — architecture decision records fetched from Confluence links.
3. **Projects** — one page per repo describing what it is, what it does/can do, and
   which standards + ADRs it must follow.

## Goals

- One command builds/refreshes a browsable, LLM-consumable knowledge base.
- Standards are authored once and never clobbered by re-runs.
- Project facts are auto-extracted from the repos and kept fresh on each run.
- ADRs are pulled from Confluence (same Atlassian token already used for Jira).
- Nothing internal leaks into git (`./brain/` is gitignored, like `./repos/`).

## Non-goals

- No live/continuous sync — it is a manual re-run, like `npm run setup`.
- No RAG index / embeddings in this iteration; the LLM reads the markdown directly.
- No UI. (A dashboard "Knowledge" tab is a possible later iteration, out of scope.)
- No writing back to Confluence or the repos.

## Vault structure

```
brain/
  index.md                     ← Map of Content: entry point, links to everything
  standards/
    index.md
    coding-standards.md        ← cross-cutting: naming, structure, git/merge (ADR-6)
    api.md                     ← API service standards
    frontend.md                ← Frontend standards
    bff.md                     ← BFF standards
    deployment.md              ← where & how we deploy
    testing.md
  adrs/
    index.md
    ADR-####-<slug>.md         ← one per configured Confluence link
  projects/
    index.md
    <group>/
      index.md                 ← what the group is + its apps
      <app>.md                 ← one per repo (api, fe, web-bff, …)
  _templates/                  ← Obsidian templates: new ADR, new project, new standard
```

The **"in common"** knowledge is `standards/`. Every project page links to the
standards it must follow and the ADRs that apply to it.

## Content model & frontmatter

Every page carries YAML frontmatter so both Obsidian (tags/graph) and an LLM get
consistent, structured metadata. Fields by page type:

**Project page**
```yaml
---
type: project
group: auction
app: api
tier: api            # api | frontend | bff  (inferred, see below)
repo: repos/basworld/auction/api
stack: [nestjs, drizzle, postgres]   # detected
status: active
last-synced: 2026-07-02
---
```

**Standard page**
```yaml
---
type: standard
tier: api            # or: cross-cutting | frontend | bff | deployment | testing
status: authored
---
```

**ADR page**
```yaml
---
type: adr
adr-id: 6
title: Use BAS standard for merge commit messages
source-url: https://<confluence>/wiki/spaces/.../pages/....
status: accepted
last-synced: 2026-07-02
---
```

## How each part is filled

### Project pages (auto + hand-authored)

For each repo directory under `./repos/<group>/<app>` the generator extracts:

- **Stack**: from `package.json` (deps like `next`, `@nestjs/*`, `drizzle-orm`),
  `composer.json`, or other manifests present.
- **Tier**: inferred by name + contents — `api` → API, `*fe*`/`app-fe` → Frontend,
  `*bff*`/`web-bff` → BFF. Fallback: unknown (leaves tier blank, links no tier std).
- **Docs**: pulls the repo `README` title/intro and any `AGENTS.md` / `CLAUDE.md`.
- **Scripts**: notable `package.json` scripts (dev/build/test/deploy).

These land inside an auto-managed block:

```markdown
<!-- AUTO:start — regenerated each run, do not edit by hand -->
## Stack
- NestJS, Drizzle, Postgres
## Scripts
- `npm run start:dev` …
<!-- AUTO:end -->

## What this does
<!-- hand-authored prose below the AUTO block is preserved on re-run -->
```

The generator replaces only the content between the AUTO markers; everything else
(the hand-authored "What this does" prose) is preserved. On first creation the
hand-authored section is a short template stub.

Each project page auto-links its tier standard and deployment:
`Follows: [[api]] · [[deployment]] · [[coding-standards]]`.

### ADRs (auto-fetched from Confluence)

Config holds a list of Confluence page identifiers. For each, the generator calls
the Confluence Cloud REST API (`GET /wiki/api/v2/pages/{id}?body-format=storage` or
the equivalent `content` endpoint) using the Atlassian email + API token already in
`.env.local` (`JIRA_EMAIL` / token). The HTML storage body is converted to markdown,
written to `adrs/ADR-####-<slug>.md` with `source-url` + `last-synced` frontmatter,
and the file is fully regenerated each run (ADRs are source-of-truth in Confluence).

If a page can't be fetched (auth/404), the run logs a warning and continues; a
placeholder file with the link is written so the vault still references it.

### Standards (seeded once, then hand-authored)

The generator ensures each `standards/*.md` file exists. If missing, it writes a
template with the standard headings and a stub. It **never** overwrites an existing
standard file. Files:

- `coding-standards.md` — naming, project structure, git & merge (links ADR-6).
- `api.md` — API service conventions (endpoints, validation, error format, auth).
- `frontend.md` — frontend conventions (structure, state, components, a11y).
- `bff.md` — BFF conventions (aggregation, contracts to FE, auth passthrough).
- `deployment.md` — **pre-seeded with real facts** from `dashboard.config.ts`:
  GitLab CI staging job (`deploy:staging`), AWS App Runner + CloudWatch logs,
  dev/stg/prod profiles, per-group staging URLs, and the Release Flow (merge →
  staging → tag prod) as reflected by the dashboard.
- `testing.md` — testing expectations per tier.

### Indexes (auto)

`index.md` (root MOC) and each `*/index.md` are regenerated each run to list current
children with links, so the Obsidian graph and navigation stay complete.

## Configuration

New optional entries (env-driven, consistent with `dashboard.config.ts`):

- `BRAIN_DIR` — output vault dir (default `./brain`).
- `ADR_PAGES` — comma-separated Confluence page IDs (or full URLs from which the ID
  is parsed), e.g. `ADR_PAGES="123456,https://….../pages/234567/ADR-6"`.
- `CONFLUENCE_HOST` — defaults to the Jira host if it's the same Atlassian site.

Repos to document come from the existing `./repos` tree (same source the dashboard
already clones), so no new repo list is needed.

## CLI behaviour

`npm run brain` (a `tsx scripts/build-brain.ts`, mirroring `scripts/setup-repos.ts`):

- Default: build/refresh the vault, then print a summary of added / updated /
  skipped (preserved) / warned files — like `setup-repos --check`.
- `--check`: report what *would* change without writing.
- `--adrs-only` / `--projects-only`: scope a run to one section.

## Module boundaries

Kept small and independently testable (pure functions where possible):

- `lib/brain/extract-project.ts` — repo dir → project facts (stack, tier, docs,
  scripts). Pure given a filesystem read; unit-testable with fixture dirs.
- `lib/brain/confluence.ts` — fetch a Confluence page by id → `{title, html, url}`.
- `lib/brain/html-to-md.ts` — Confluence storage HTML → markdown.
- `lib/brain/render.ts` — facts → markdown pages + frontmatter; owns the AUTO-block
  merge (preserve hand-authored regions).
- `lib/brain/vault.ts` — write files idempotently, build indexes, collect the run
  summary.
- `scripts/build-brain.ts` — thin CLI wiring the above + arg parsing.

## Error handling

- Missing Atlassian creds → skip ADR fetch with a clear warning; still build the
  rest of the vault.
- Unreadable/partial repo → document what's available, note gaps, continue.
- AUTO-block merge: if markers are missing/corrupt in an existing file, do not
  guess — write the new AUTO block at top and log a warning naming the file.

## Testing

Vitest (the project's real gate) with fixtures:

- `extract-project`: fixture repo dirs (nest api, next fe, bff) → asserts stack +
  tier inference.
- `render` / AUTO-merge: given an existing page with hand-authored prose, a re-render
  preserves the prose and replaces only the AUTO block.
- `html-to-md`: sample Confluence storage HTML → expected markdown.
- `confluence`: mocked fetch → parsed `{title, html, url}`; auth-failure path.

## Open questions (defaults chosen; override anytime)

- Vault location default `./brain/` gitignored — confirmed unless you prefer an
  external folder.
- Standards start as authored stubs (with `deployment.md` pre-seeded from config)
  rather than fully written — you fill the prose.
