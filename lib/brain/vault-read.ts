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
