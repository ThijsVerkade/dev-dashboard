import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { type Result } from '@/lib/result'
import type { extractProject } from './extract-project'
import { renderAdr, renderIndex, renderProjectPage, renderStandardStub, type StandardKind } from './render'
import type { VaultSummary } from './types'

export interface BuildDeps {
  extract: typeof extractProject
  fetchAdr: (idOrUrl: string) => Promise<Result<{ id: string; title: string; html: string; sourceUrl: string }>>
  htmlToMd: (html: string) => string
  syncedDate: string
}

export interface BuildOptions {
  brainDir: string
  reposDir: string
  adrPages: string[]
  check: boolean
  scope: 'all' | 'projects' | 'adrs'
}

const STANDARDS: StandardKind[] = ['coding-standards', 'api', 'frontend', 'bff', 'deployment', 'testing']

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** <reposDir>/<owner>/<group>/<app> → { group, app, repoPath }. */
export async function discoverRepos(
  reposDir: string,
): Promise<Array<{ group: string; app: string; repoPath: string }>> {
  const out: Array<{ group: string; app: string; repoPath: string }> = []
  for (const owner of await listDirs(reposDir)) {
    for (const group of await listDirs(join(reposDir, owner))) {
      for (const app of await listDirs(join(reposDir, owner, group))) {
        out.push({ group, app, repoPath: join(reposDir, owner, group, app) })
      }
    }
  }
  return out
}

export async function buildVault(opts: BuildOptions, deps: BuildDeps): Promise<VaultSummary> {
  const summary: VaultSummary = { added: [], updated: [], skipped: [], warned: [] }

  const write = async (rel: string, content: string, mode: 'refresh' | 'seed') => {
    const abs = join(opts.brainDir, rel)
    const had = await exists(abs)
    if (mode === 'seed' && had) {
      summary.skipped.push(rel)
      return
    }
    ;(had ? summary.updated : summary.added).push(rel)
    if (opts.check) return
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }

  const readExisting = async (rel: string): Promise<string | null> => {
    try {
      return await readFile(join(opts.brainDir, rel), 'utf8')
    } catch {
      return null
    }
  }

  // Standards (seed once).
  if (opts.scope !== 'adrs') {
    for (const kind of STANDARDS) {
      await write(`standards/${kind}.md`, renderStandardStub(kind), 'seed')
    }
    await write(
      'standards/index.md',
      renderIndex('Standards', STANDARDS.map((k) => ({ label: k, href: `standards/${k}` }))),
      'refresh',
    )
  }

  // Projects.
  if (opts.scope !== 'adrs') {
    const groups = new Map<string, string[]>()
    for (const { group, app, repoPath } of await discoverRepos(opts.reposDir)) {
      const facts = await deps.extract(group, app, repoPath)
      const rel = `projects/${group}/${app}.md`
      const { content, warned } = renderProjectPage(facts, await readExisting(rel), deps.syncedDate)
      await write(rel, content, 'refresh')
      if (warned) summary.warned.push(rel)
      groups.set(group, [...(groups.get(group) ?? []), app])
    }
    for (const [group, apps] of groups) {
      await write(
        `projects/${group}/index.md`,
        renderIndex(group, apps.map((a) => ({ label: a, href: `projects/${group}/${a}` }))),
        'refresh',
      )
    }
    await write(
      'projects/index.md',
      renderIndex('Projects', [...groups.keys()].map((g) => ({ label: g, href: `projects/${g}/index` }))),
      'refresh',
    )
  }

  // ADRs (full regenerate; placeholder + warn on failure).
  if (opts.scope !== 'projects') {
    const adrLinks: Array<{ label: string; href: string }> = []
    for (const idOrUrl of opts.adrPages) {
      const res = await deps.fetchAdr(idOrUrl)
      if (!res.ok) {
        const rel = `adrs/UNRESOLVED-${idOrUrl.replace(/[^\w]+/g, '-')}.md`
        await write(rel, `# Unresolved ADR\n\nCould not fetch \`${idOrUrl}\`: ${res.message}\n`, 'refresh')
        summary.warned.push(rel)
        continue
      }
      const adr = renderAdr({ ...res.data, markdown: deps.htmlToMd(res.data.html) }, deps.syncedDate)
      const rel = `adrs/${adr.slug}.md`
      await write(rel, adr.markdown, 'refresh')
      adrLinks.push({ label: adr.title, href: `adrs/${adr.slug}` })
    }
    await write('adrs/index.md', renderIndex('ADRs', adrLinks), 'refresh')
  }

  // Root MOC.
  await write(
    'index.md',
    renderIndex('Knowledge Brain', [
      { label: 'Standards', href: 'standards/index' },
      { label: 'Projects', href: 'projects/index' },
      { label: 'ADRs', href: 'adrs/index' },
    ]),
    'refresh',
  )

  return summary
}
