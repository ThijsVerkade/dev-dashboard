# Dashboard Vault Route — browse the Knowledge Brain in-browser

**Date:** 2026-07-03
**Status:** Draft (awaiting review)
**Author:** Thijs Verkade

## Summary

Add a `/brain` route to the dev-dashboard that renders the Knowledge Brain vault
(`./brain/`, built by `npm run brain`) as a browsable, Obsidian-like experience:
a collapsible **tree sidebar** (Standards / Projects / ADRs) on the left and the
**rendered Markdown note** on the right, with `[[wiki-links]]` clickable as
in-app navigation. This is the "dashboard Knowledge tab" that the
[knowledge-brain spec](./2026-07-02-knowledge-brain-design.md) flagged as a future
iteration.

Today the vault can only be viewed by opening `./brain/` in Obsidian or an editor.
This route makes it a first-class dashboard destination alongside Pipelines,
Agents, Jira, etc.

## Goals

- Every note is browsable in the dashboard at its own URL.
- Wiki-links (`[[target|label]]`) navigate within the app.
- The view reflects the current on-disk vault — re-running `npm run brain` shows
  up on next load, no rebuild/restart.
- Fits existing dashboard conventions (App Router, sidebar/breadcrumb/palette).

## Non-goals

- No editing, no full-text search, no graph view (possible follow-ups).
- No "rebuild vault" button / API in this iteration (`npm run brain` stays CLI).
- No caching layer / embeddings — read Markdown directly from disk.
- Does not depend on or interact with the Obsidian MCP server (separate concern).

## Constraints

- **Next.js 16.2.9 App Router.** Per `AGENTS.md`, the implementer MUST read the
  relevant guides under `node_modules/next/dist/docs/` before writing route code —
  optional catch-all segment conventions and dynamic-rendering opt-out in
  particular may differ from training data.
- `./brain/` is **gitignored** and may be absent (never built). The route must
  degrade gracefully to an empty state, not crash.
- Vitest is the real build gate for this repo; `lib/brain/vault-read.ts` must be
  unit-tested.

## Architecture

### Route

`app/(dashboard)/brain/[[...slug]]/page.tsx` — an **optional catch-all** so:

- `/brain` → renders `brain/index.md`
- `/brain/standards/api` → renders `brain/standards/api.md`
- `/brain/adrs/ADR-0001-...` → renders that ADR note

The page is a **Server Component**, rendered **dynamically** (opt out of static
caching) so each request re-reads the vault from disk. Vault directory is resolved
from `process.env.BRAIN_DIR || 'brain'` — the same convention as
`scripts/build-brain.ts`.

### Core module — `lib/brain/vault-read.ts` (new, pure, tested)

Kept in `lib/brain/` alongside the existing render/extract modules, filesystem
access isolated here so the route stays thin and the logic is unit-testable.

- `readVaultTree(brainDir): VaultTree`
  Walks the vault directory and returns a hierarchical structure of sections and
  notes (title + slug + children). Sorted; `index.md` files surface as the section
  landing node rather than a leaf. Returns an empty tree if `brainDir` is absent.

- `readNote(brainDir, slug: string[]): NoteView | null`
  Resolves `slug` to a `.md` file **inside** `brainDir`, returns
  `{ title, frontmatter, body }` or `null` if missing. **Path-traversal guarded**:
  the resolved absolute path must stay within `brainDir`; any `..` / escape →
  treated as `null` (not an error).
  - `title` comes from the leading `# ` heading, falling back to the slug.
  - `frontmatter` is the parsed YAML block (type, tier, last-synced, etc.).
  - `body` is the Markdown with frontmatter stripped.

- `resolveWikiLinks(body, notePaths): string`
  Rewrites `[[target|label]]` and `[[target]]` into standard Markdown links
  `[label](/brain/target)` **before** react-markdown parses the body.
  - **Path-qualified** targets (`standards/api`, `adrs/ADR-0001-...`,
    `projects/auction/api`) resolve directly to `/brain/<target>`.
  - **Bare** targets (`api`, `deployment`) are resolved by unique basename match.
    On ambiguity (e.g. `api` matches `standards/api`, `projects/auction/api`,
    `projects/lease/api`), **prefer the `standards/` note** — that is what the
    project "Follows:" lines intend. *(Provisional default — see Open questions.)*
  - Unresolvable targets render as plain text (no dead link).

Types (`VaultTree`, `VaultNode`, `NoteView`) live in `lib/brain/types.ts` beside
the existing brain types.

### Rendering — `components/brain-note.tsx`

Renders the resolved Markdown body with **`react-markdown` + `remark-gfm`**
(new dependencies) — GFM covers the tables / task lists / lists the generator
emits. A small metadata header above the body surfaces frontmatter (type · tier ·
`last-synced`). Internal `/brain/...` links use the Next `Link` component;
external links open normally. Prose styling uses the existing Tailwind theme.

### Tree — `components/brain-tree.tsx` (Client Component)

Collapsible tree of the `VaultTree`. Highlights the active note (from the current
pathname). Fixed-width, independently scrollable column. *(Provisional: fixed
width rather than a draggable `react-resizable-panels` divider — see Open
questions.)*

### Navigation wiring

Add `{ href: "/brain", title: "Brain", icon: Brain }` to `components/nav-items.tsx`
(`Brain` from `lucide-react`) — this feeds the sidebar, breadcrumb, and Cmd+K
palette automatically. `components/page-breadcrumb.tsx` needs a small addition so
deep note URLs (which don't match a nav item) show `Brain / <note title>` instead
of a bare/blank crumb.

## Data flow

1. Request `/brain/<slug>` → Server Component reads `BRAIN_DIR`.
2. `readVaultTree(brainDir)` → tree (passed to `<BrainTree>`).
3. `readNote(brainDir, slug)` (slug defaults to `['index']`) → `NoteView | null`.
4. `resolveWikiLinks(body, notePaths)` → link-rewritten Markdown.
5. Page renders `<BrainTree>` + `<BrainNote>` in the two-pane layout.

## Error / empty states

- **Vault dir absent / empty tree** → friendly empty state: "No vault found. Run
  `npm run brain` to generate it." (Tree area shows the same.)
- **Unknown / traversal slug** (`readNote` returns `null`) → in-pane "Note not
  found" message with the tree still visible (not a hard 404), so the user can
  navigate elsewhere.

## Testing

Vitest units for `lib/brain/vault-read.ts`, using a small fixture vault
(reuse/extend `lib/brain/__fixtures__`):

- Tree building: nesting, `index.md` as section node, ordering, empty/absent dir.
- `readNote`: title from heading, frontmatter parse, body strip, missing file.
- **Path traversal**: `['..','..','etc','passwd']`-style slugs → `null`.
- `resolveWikiLinks`: path-qualified, bare-unique, bare-ambiguous (→ standards),
  unresolvable (→ plain text), label preserved.

Component rendering is exercised lightly; the resolution/read logic is where the
risk is and where tests concentrate.

## Open questions (provisional defaults chosen; confirm on review)

1. **Divider:** fixed-width tree (chosen) vs. draggable `react-resizable-panels`.
2. **Bare-link ambiguity:** prefer `standards/` note (chosen) vs. render ambiguous
   links as plain text.

## Out of scope / future

- Rebuild-from-UI button, full-text search, graph/backlinks view, note editing.
- Reusing this renderer to show a repo's `AGENTS.md`/standards inline elsewhere.
