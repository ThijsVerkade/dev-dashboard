# Dashboard Vault Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/brain` route to the dev-dashboard that renders the Knowledge Brain vault (`./brain/`) as an Obsidian-like tree-sidebar + rendered-note view, with clickable wiki-links.

**Architecture:** A pure, unit-tested `lib/brain/vault-read.ts` module isolates all filesystem access (tree walk, note read, wiki-link resolution). A Server Component route `app/(dashboard)/brain/[[...slug]]/page.tsx` reads the vault per-request and renders a client tree (`brain-tree.tsx`) beside a client Markdown renderer (`brain-note.tsx`, react-markdown + remark-gfm). Nav wiring reuses the existing `nav-items.tsx` fan-out.

**Tech Stack:** Next.js 16.2.9 App Router (RSC), React 19, TypeScript, Tailwind v4, Vitest, `react-markdown` + `remark-gfm` (new deps), `lucide-react`.

## Global Constraints

- **Next.js 16 — read the docs first.** Per `AGENTS.md`, consult `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md` before writing route code.
- `params` in pages is a **Promise** — always `await` it. Optional catch-all type is `{ slug?: string[] }`.
- `export const dynamic = 'force-dynamic'` is valid **only because Cache Components is NOT enabled** (empty `next.config.ts`). Verify this holds (Task 5); if Cache Components is on, wrap runtime reads in `<Suspense>` instead.
- Vault dir resolves from `process.env.BRAIN_DIR || 'brain'` (matches `scripts/build-brain.ts`).
- `./brain/` is gitignored and may be absent — never crash; degrade to an empty state.
- Vitest is the real gate: `npm test`. Test files live at `lib/**/*.test.ts` (per `vitest.config.ts`), env `node`, alias `@` → repo root.
- Reuse existing helpers: `splitFrontmatter` from `lib/brain/frontmatter.ts`, `slugify` from `lib/brain/render.ts`. Do NOT reimplement them.
- Internal links render via Next `<Link>`; the vault view lives inside the existing `(dashboard)` layout (sidebar/header already provided).

---

## Task 1: Vault types + tree/note reading

**Files:**
- Modify: `lib/brain/types.ts` (append new interfaces)
- Create: `lib/brain/vault-read.ts`
- Test: `lib/brain/vault-read.test.ts`

**Interfaces:**
- Consumes: `splitFrontmatter` from `./frontmatter`.
- Produces:
  - `interface VaultNode { title: string; slug: string; href: string; children: VaultNode[] }`
  - `interface VaultTree { nodes: VaultNode[]; notePaths: string[] }`
  - `interface NoteView { title: string; frontmatter: Record<string, string>; body: string }`
  - `function readVaultTree(brainDir: string): VaultTree`
  - `function readNote(brainDir: string, slug: string[]): NoteView | null`
  - (`resolveWikiLinks` is added in Task 2, same file.)

- [ ] **Step 1: Append types to `lib/brain/types.ts`**

```ts
export interface VaultNode {
  /** Display label, from the note's leading `# ` heading (fallback: last slug segment). */
  title: string
  /** Vault-relative slug without extension, e.g. "standards/api"; "" for the root index. */
  slug: string
  /** In-app URL, e.g. "/brain" or "/brain/standards/api". */
  href: string
  /** Child nodes; empty for leaf notes. */
  children: VaultNode[]
}

export interface VaultTree {
  /** Top-level section nodes (standards, projects, adrs, …). */
  nodes: VaultNode[]
  /** Every note slug in the vault (e.g. "index", "standards/api", "adrs/ADR-0001-…"), for wiki-link resolution. */
  notePaths: string[]
}

export interface NoteView {
  title: string
  /** Flat key→value frontmatter (arrays kept as their raw `[a, b]` string). */
  frontmatter: Record<string, string>
  /** Markdown body with frontmatter stripped. */
  body: string
}
```

- [ ] **Step 2: Write the failing test `lib/brain/vault-read.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVaultTree, readNote } from './vault-read'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-'))
  writeFileSync(join(dir, 'index.md'), '# Knowledge Brain\n\n- [[standards/index|Standards]]\n')
  mkdirSync(join(dir, 'standards'))
  writeFileSync(join(dir, 'standards', 'index.md'), '# Standards\n\n- [[standards/api|api]]\n')
  writeFileSync(
    join(dir, 'standards', 'api.md'),
    '---\ntype: standard\ntier: api\nlast-synced: 2026-07-02\n---\n\n# API Standard\n\nBody text.\n',
  )
  mkdirSync(join(dir, 'projects'))
  mkdirSync(join(dir, 'projects', 'auction'))
  writeFileSync(join(dir, 'projects', 'auction', 'api.md'), '# auction/api\n\nStuff.\n')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readVaultTree', () => {
  it('builds a nested tree with section index titles', () => {
    const tree = readVaultTree(dir)
    const standards = tree.nodes.find((n) => n.slug === 'standards')
    expect(standards?.title).toBe('Standards')
    expect(standards?.href).toBe('/brain/standards')
    expect(standards?.children.map((c) => c.slug)).toContain('standards/api')
  })

  it('collects all note slugs in notePaths', () => {
    const tree = readVaultTree(dir)
    expect(tree.notePaths).toEqual(
      expect.arrayContaining(['index', 'standards/index', 'standards/api', 'projects/auction/api']),
    )
  })

  it('returns an empty tree for a missing directory', () => {
    const tree = readVaultTree(join(dir, 'does-not-exist'))
    expect(tree.nodes).toEqual([])
    expect(tree.notePaths).toEqual([])
  })
})

describe('readNote', () => {
  it('reads the root index for an empty slug', () => {
    expect(readNote(dir, [])?.title).toBe('Knowledge Brain')
  })

  it('resolves a section slug to its index.md', () => {
    expect(readNote(dir, ['standards'])?.title).toBe('Standards')
  })

  it('parses frontmatter and strips it from the body', () => {
    const note = readNote(dir, ['standards', 'api'])
    expect(note?.frontmatter.tier).toBe('api')
    expect(note?.frontmatter['last-synced']).toBe('2026-07-02')
    expect(note?.body).not.toContain('type: standard')
    expect(note?.body).toContain('Body text.')
  })

  it('returns null for a missing note', () => {
    expect(readNote(dir, ['nope'])).toBeNull()
  })

  it('rejects path traversal', () => {
    expect(readNote(dir, ['..', '..', 'etc', 'passwd'])).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- vault-read`
Expected: FAIL — `readVaultTree`/`readNote` not exported (module has no such export).

- [ ] **Step 4: Implement `lib/brain/vault-read.ts` (tree + note; wiki-links come in Task 2)**

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { splitFrontmatter } from './frontmatter'
import type { NoteView, VaultNode, VaultTree } from './types'

function titleOf(body: string, fallback: string): string {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m)
  return m ? m[1] : fallback
}

function parseFrontmatter(raw: string | null): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

/** Read a note file's raw content and derive its display title. */
function loadFile(absPath: string, fallbackTitle: string): { title: string; note: NoteView } {
  const raw = readFileSync(absPath, 'utf8')
  const { frontmatter, body } = splitFrontmatter(raw)
  const title = titleOf(body, fallbackTitle)
  return { title, note: { title, frontmatter: parseFrontmatter(frontmatter), body } }
}

/** Recursively build tree nodes for a directory; also push every note slug into `notePaths`. */
function walk(brainDir: string, relDir: string, notePaths: string[]): VaultNode[] {
  const absDir = join(brainDir, relDir)
  const entries = readdirSync(absDir).sort()
  const nodes: VaultNode[] = []

  for (const name of entries) {
    const abs = join(absDir, name)
    const rel = relDir ? `${relDir}/${name}` : name
    if (statSync(abs).isDirectory()) {
      const children = walk(brainDir, rel, notePaths)
      const indexAbs = join(abs, 'index.md')
      const title = existsSync(indexAbs) ? loadFile(indexAbs, name).title : name
      if (existsSync(indexAbs)) notePaths.push(`${rel}/index`)
      nodes.push({ title, slug: rel, href: `/brain/${rel}`, children })
    } else if (name.endsWith('.md') && name !== 'index.md') {
      const slug = rel.replace(/\.md$/, '')
      notePaths.push(slug)
      nodes.push({ title: loadFile(abs, basename(slug)).title, slug, href: `/brain/${slug}`, children: [] })
    }
  }
  return nodes
}

export function readVaultTree(brainDir: string): VaultTree {
  if (!existsSync(brainDir)) return { nodes: [], notePaths: [] }
  const notePaths: string[] = []
  if (existsSync(join(brainDir, 'index.md'))) notePaths.push('index')
  const nodes = walk(brainDir, '', notePaths)
  return { nodes, notePaths }
}

/** Resolve a slug to `<slug>.md` or `<slug>/index.md` inside brainDir; guarded against traversal. */
export function readNote(brainDir: string, slug: string[]): NoteView | null {
  const base = resolve(brainDir)
  const relParts = slug.length ? slug : ['index']
  for (const candidate of [`${relParts.join('/')}.md`, `${relParts.join('/')}/index.md`]) {
    const abs = resolve(base, candidate)
    if (abs !== base && !abs.startsWith(base + sep)) return null // traversal escape
    if (existsSync(abs) && statSync(abs).isFile()) {
      return loadFile(abs, relParts[relParts.length - 1]).note
    }
  }
  return null
}
```

> Note: `readNote(dir, [])` maps to `index.md` (relParts = `['index']` → `index.md`). `readNote(dir, ['standards'])` finds no `standards.md`, falls through to `standards/index.md`. ✓

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- vault-read`
Expected: PASS (all `readVaultTree` + `readNote` cases).

- [ ] **Step 6: Commit**

```bash
git add lib/brain/types.ts lib/brain/vault-read.ts lib/brain/vault-read.test.ts
git commit -m "feat(brain): vault-read tree + note loading with traversal guard"
```

---

## Task 2: Wiki-link resolution

**Files:**
- Modify: `lib/brain/vault-read.ts` (add `resolveWikiLinks`)
- Test: `lib/brain/vault-read.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `notePaths: string[]` from `VaultTree` (Task 1).
- Produces: `function resolveWikiLinks(body: string, notePaths: string[]): string` — rewrites `[[target|label]]` / `[[target]]` into `[label](/brain/<target>)`.

- [ ] **Step 1: Add the failing tests to `lib/brain/vault-read.test.ts`**

```ts
import { resolveWikiLinks } from './vault-read'

describe('resolveWikiLinks', () => {
  const paths = ['index', 'standards/index', 'standards/api', 'adrs/ADR-0001-x', 'projects/auction/api', 'projects/lease/api']

  it('rewrites a path-qualified link with a label', () => {
    expect(resolveWikiLinks('see [[standards/api|API]]', paths)).toBe('see [API](/brain/standards/api)')
  })

  it('rewrites a bare link, defaulting the label to the target', () => {
    expect(resolveWikiLinks('[[adrs/ADR-0001-x]]', paths)).toBe('[adrs/ADR-0001-x](/brain/adrs/ADR-0001-x)')
  })

  it('resolves a bare ambiguous link to the standards note', () => {
    // "api" matches standards/api, projects/auction/api, projects/lease/api → prefer standards
    expect(resolveWikiLinks('[[api]]', paths)).toBe('[api](/brain/standards/api)')
  })

  it('maps a trailing /index target to the section href', () => {
    expect(resolveWikiLinks('[[standards/index|Standards]]', paths)).toBe('[Standards](/brain/standards)')
  })

  it('leaves an unresolvable target as plain text', () => {
    expect(resolveWikiLinks('[[does/not/exist|X]]', paths)).toBe('X')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- vault-read`
Expected: FAIL — `resolveWikiLinks` is not exported.

- [ ] **Step 3: Implement `resolveWikiLinks` in `lib/brain/vault-read.ts`**

```ts
/** Rewrite [[target|label]] / [[target]] into markdown links, resolving against known note slugs. */
export function resolveWikiLinks(body: string, notePaths: string[]): string {
  const set = new Set(notePaths)
  const hrefFor = (target: string): string => `/brain/${target.replace(/\/index$/, '')}`

  return body.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_full, rawTarget: string, rawLabel?: string) => {
    const target = rawTarget.trim()
    const label = (rawLabel ?? target).trim()

    // Path-qualified: exact match wins.
    if (set.has(target)) return `[${label}](${hrefFor(target)})`

    // Bare: match by last path segment.
    const matches = notePaths.filter((p) => basename(p) === target)
    if (matches.length === 0) return label // unresolvable → plain text
    const chosen = matches.find((p) => p.startsWith('standards/')) ?? (matches.length === 1 ? matches[0] : null)
    return chosen ? `[${label}](${hrefFor(chosen)})` : label
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- vault-read`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/brain/vault-read.ts lib/brain/vault-read.test.ts
git commit -m "feat(brain): resolve wiki-links (path-qualified, bare, standards-preferred)"
```

---

## Task 3: Markdown note renderer

**Files:**
- Modify: `package.json` (add deps)
- Create: `components/brain-note.tsx`

**Interfaces:**
- Consumes: `NoteView` (Task 1); the pre-resolved markdown string is passed in as `body`.
- Produces: `function BrainNote(props: { title: string; frontmatter: Record<string, string>; body: string }): JSX.Element`

- [ ] **Step 1: Install dependencies**

Run: `npm install react-markdown@^9 remark-gfm@^4`
Expected: added to `package.json` dependencies, no peer-dep errors against React 19.

- [ ] **Step 2: Create `components/brain-note.tsx`**

```tsx
"use client"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ComponentPropsWithoutRef } from "react"

type NoteProps = {
  title: string
  frontmatter: Record<string, string>
  body: string
}

const META_KEYS = ["type", "tier", "last-synced"] as const

export function BrainNote({ title, frontmatter, body }: NoteProps) {
  const meta = META_KEYS.filter((k) => frontmatter[k]).map((k) => `${k}: ${frontmatter[k]}`)

  return (
    <article className="min-w-0 max-w-3xl">
      <h1 className="mb-1 font-mono text-2xl text-primary">{title}</h1>
      {meta.length > 0 && (
        <p className="mb-6 font-mono text-xs text-muted-foreground">{meta.join(" · ")}</p>
      )}
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) =>
              href?.startsWith("/") ? (
                <Link href={href} className="text-primary underline underline-offset-2">
                  {children}
                </Link>
              ) : (
                <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" {...rest}>
                  {children}
                </a>
              ),
            h1: (p) => <h2 className="mt-4 font-mono text-xl text-foreground" {...p} />,
            h2: (p) => <h2 className="mt-4 font-mono text-lg text-foreground" {...p} />,
            h3: (p) => <h3 className="mt-2 font-mono text-base text-foreground" {...p} />,
            ul: (p) => <ul className="list-disc pl-5" {...p} />,
            ol: (p) => <ol className="list-decimal pl-5" {...p} />,
            blockquote: (p) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...p} />,
            code: (p) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...p} />,
            table: (p) => <table className="w-full border-collapse text-left" {...p} />,
            th: (p) => <th className="border border-border px-2 py-1 font-mono text-xs" {...p} />,
            td: (p) => <td className="border border-border px-2 py-1" {...p} />,
          }}
        >
          {body}
        </ReactMarkdown>
      </div>
    </article>
  )
}
```

- [ ] **Step 3: Verify it type-checks / build compiles**

Run: `npx tsc --noEmit 2>&1 | grep -i brain-note || echo "no brain-note type errors"`
Expected: `no brain-note type errors` (bare `tsc` may report unrelated pre-existing issues; only brain-note lines matter).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json components/brain-note.tsx
git commit -m "feat(brain): markdown note renderer (react-markdown + remark-gfm)"
```

---

## Task 4: Tree sidebar component

**Files:**
- Create: `components/brain-tree.tsx`

**Interfaces:**
- Consumes: `VaultNode[]` (Task 1).
- Produces: `function BrainTree(props: { nodes: VaultNode[] }): JSX.Element` — renders a nested, collapsible list; highlights the node whose `href` matches the current pathname.

- [ ] **Step 1: Create `components/brain-tree.tsx`**

```tsx
"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import type { VaultNode } from "@/lib/brain/types"

function TreeNode({ node, depth }: { node: VaultNode; depth: number }) {
  const pathname = usePathname()
  const active = pathname === node.href
  const hasChildren = node.children.length > 0
  const [open, setOpen] = useState(true)

  return (
    <li>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button onClick={() => setOpen((o) => !o)} className="text-muted-foreground" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Link
          href={node.href}
          className={cn(
            "truncate rounded px-1.5 py-0.5 font-mono text-xs hover:bg-muted",
            active ? "text-primary" : "text-foreground",
          )}
        >
          {node.title}
        </Link>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.slug} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function BrainTree({ nodes }: { nodes: VaultNode[] }) {
  return (
    <nav className="w-64 shrink-0 overflow-y-auto border-r border-border pr-2">
      <ul className="flex flex-col gap-0.5">
        {nodes.map((n) => (
          <TreeNode key={n.slug} node={n} depth={0} />
        ))}
      </ul>
    </nav>
  )
}
```

> Verify `cn` exists at `lib/utils.ts` (shadcn default). If not, drop `cn` and inline the class strings with a ternary.

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit 2>&1 | grep -i brain-tree || echo "no brain-tree type errors"`
Expected: `no brain-tree type errors`.

- [ ] **Step 3: Commit**

```bash
git add components/brain-tree.tsx
git commit -m "feat(brain): collapsible vault tree sidebar"
```

---

## Task 5: The `/brain` route

**Files:**
- Create: `app/(dashboard)/brain/[[...slug]]/page.tsx`

**Interfaces:**
- Consumes: `readVaultTree`, `readNote`, `resolveWikiLinks` (Tasks 1–2); `BrainTree` (Task 4); `BrainNote` (Task 3).
- Produces: the default-exported async page component.

- [ ] **Step 1: Confirm Cache Components is OFF (guards the `dynamic` export)**

Run: `grep -i "cacheComponents\|dynamicIO" next.config.ts || echo "cache components OFF — force-dynamic is valid"`
Expected: `cache components OFF — force-dynamic is valid`. (If it prints a match, use a `<Suspense>` boundary around the reads instead of `export const dynamic`.)

- [ ] **Step 2: Create `app/(dashboard)/brain/[[...slug]]/page.tsx`**

```tsx
import { BrainTree } from "@/components/brain-tree"
import { BrainNote } from "@/components/brain-note"
import { readNote, readVaultTree, resolveWikiLinks } from "@/lib/brain/vault-read"

// Read the vault from disk on every request so `npm run brain` refreshes show up.
// Valid because Cache Components is not enabled (see plan Task 5, Step 1).
export const dynamic = "force-dynamic"

function brainDir() {
  return process.env.BRAIN_DIR || "brain"
}

export default async function BrainPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const dir = brainDir()
  const tree = readVaultTree(dir)

  if (tree.nodes.length === 0) {
    return (
      <div className="font-mono text-sm text-muted-foreground">
        No vault found. Run <code className="rounded bg-muted px-1">npm run brain</code> to generate it.
      </div>
    )
  }

  const note = readNote(dir, slug ?? [])

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <BrainTree nodes={tree.nodes} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        {note ? (
          <BrainNote title={note.title} frontmatter={note.frontmatter} body={resolveWikiLinks(note.body, tree.notePaths)} />
        ) : (
          <p className="font-mono text-sm text-muted-foreground">Note not found. Pick one from the tree.</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify the route renders (manual)**

Run: `npm run dev` (in a separate terminal), then load `http://localhost:3000/brain`.
Expected: tree sidebar (Standards / Projects / ADRs) + rendered `index.md`. If `brain/` is empty, run `npm run brain` first. Click a wiki-link and a tree entry — both navigate. Then stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/brain/[[...slug]]/page.tsx"
git commit -m "feat(brain): /brain route rendering the vault (tree + note)"
```

---

## Task 6: Navigation + breadcrumb wiring

**Files:**
- Modify: `components/nav-items.tsx`
- Modify: `components/page-breadcrumb.tsx`

**Interfaces:**
- Consumes: `navItems` (existing), `usePathname` (existing).
- Produces: a `/brain` nav entry; breadcrumb that shows `Brain / <segment>` for deep note URLs.

- [ ] **Step 1: Add the nav item in `components/nav-items.tsx`**

Add `Brain` to the lucide import and a new entry:

```tsx
import { Brain, FolderGit2, GitBranch, LayoutDashboard, Rocket, SquareKanban, Workflow } from "lucide-react"
// …
export const navItems: NavItem[] = [
  { href: "/dashboard", title: "Dashboard", icon: LayoutDashboard },
  { href: "/", title: "Release Flow", icon: Rocket },
  { href: "/pipelines", title: "Pipelines", icon: GitBranch },
  { href: "/agents", title: "Agents", icon: Workflow },
  { href: "/jira", title: "Jira", icon: SquareKanban },
  { href: "/brain", title: "Brain", icon: Brain },
  { href: "/setup", title: "Setup", icon: FolderGit2 },
]
```

- [ ] **Step 2: Make the breadcrumb prefix-match and show deep segments in `components/page-breadcrumb.tsx`**

Replace the `const item = …` line and the trailing `BreadcrumbPage` with prefix matching plus an optional sub-crumb:

```tsx
  const pathname = usePathname()
  // Longest-prefix match so deep routes (e.g. /brain/standards/api) resolve to their section nav item.
  const item =
    [...navItems]
      .sort((a, b) => b.href.length - a.href.length)
      .find((n) => pathname === n.href || (n.href !== "/" && pathname.startsWith(n.href + "/"))) ?? navItems[0]
  const rest = item.href !== "/" && pathname.startsWith(item.href + "/") ? pathname.slice(item.href.length + 1) : ""
  const sub = rest ? rest.split("/").pop()! : ""
```

Then render `item.title`, and when `sub` is non-empty add a separator + `BreadcrumbPage` showing `sub`. Keep the existing `~/ops $ dev-dashboard` home crumb. Example tail:

```tsx
        <BreadcrumbSeparator className="text-muted-foreground" />
        <BreadcrumbItem>
          <BreadcrumbPage className="font-mono text-primary">
            {item.title}
            {!sub && <span className="terminal-cursor" aria-hidden>█</span>}
          </BreadcrumbPage>
        </BreadcrumbItem>
        {sub && (
          <>
            <BreadcrumbSeparator className="text-muted-foreground" />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono text-primary">
                {sub}
                <span className="terminal-cursor" aria-hidden>█</span>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
```

- [ ] **Step 3: Verify nav + breadcrumb (manual)**

Run: `npm run dev`, load `/brain`, confirm "Brain" appears in the sidebar and Cmd+K palette, and that navigating to `/brain/standards/api` shows `Brain / api` in the breadcrumb. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add components/nav-items.tsx components/page-breadcrumb.tsx
git commit -m "feat(brain): add Brain to nav + deep-path breadcrumb"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `lib/brain/vault-read.test.ts`.

- [ ] **Step 2: Lint the new/changed files**

Run: `npm run lint`
Expected: no new errors in `lib/brain/vault-read.ts`, `components/brain-*.tsx`, the route, `nav-items.tsx`, `page-breadcrumb.tsx`.

- [ ] **Step 3: Manual end-to-end pass**

Run: `npm run brain` (ensure a fresh vault), then `npm run dev`. Visit `/brain`, browse Standards / Projects / ADRs, click wiki-links (including a bare "Follows:" link → lands on the standards note), and confirm the empty state by temporarily pointing `BRAIN_DIR` at a missing dir if desired. Stop the dev server.

- [ ] **Step 4: Final review commit (if any cleanup)**

```bash
git status   # confirm working tree clean or commit remaining polish
```

---

## Self-Review

**Spec coverage:**
- Route `/brain` optional catch-all, server component, dynamic → Task 5. ✓
- `lib/brain/vault-read.ts` (readVaultTree / readNote / resolveWikiLinks, traversal guard) → Tasks 1–2. ✓
- Bare-link ambiguity prefers standards → Task 2 test + impl. ✓
- react-markdown + remark-gfm renderer, frontmatter metadata header → Task 3. ✓
- Tree sidebar (fixed width, collapsible, active highlight) → Task 4. ✓
- Nav item + breadcrumb tweak → Task 6. ✓
- Empty state + not-found state → Task 5. ✓
- Vitest units incl. traversal → Tasks 1–2, run in Task 7. ✓
- Next 16 constraints (Promise params, dynamic-vs-Cache-Components) → Global Constraints + Task 5 Step 1. ✓

**Placeholder scan:** No TBD/TODO; all code steps show full code. ✓

**Type consistency:** `VaultNode`/`VaultTree`/`NoteView` defined in Task 1 and consumed unchanged in Tasks 3–5; `readVaultTree`/`readNote`/`resolveWikiLinks` signatures match across tasks. ✓
