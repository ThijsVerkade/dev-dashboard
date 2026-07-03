import { readFile, readdir } from 'node:fs/promises'
import { inferTier } from './tier'
import type { ProjectFacts, Tier } from './types'

/** Known dependency → human stack label. First match per dep wins. */
const STACK_LABELS: Array<[RegExp, string]> = [
  [/^@nestjs\//, 'NestJS'],
  [/^next$/, 'Next.js'],
  [/^react$/, 'React'],
  [/^drizzle-orm$/, 'Drizzle'],
  [/^@prisma\/client$/, 'Prisma'],
  [/^(pg|postgres)$/, 'Postgres'],
  [/^express$/, 'Express'],
  [/^@apollo\/server$/, 'Apollo'],
  [/^php$/, 'PHP'],
  [/^laravel\/framework$/, 'Laravel'],
  [/^pestphp\/pest$/, 'Pest'],
  [/^larastan\/larastan$/, 'Larastan'],
  [/^laravel\/pint$/, 'Pint'],
  [/^symfony\//, 'Symfony'],
]

/**
 * Labels that stay bare (no version suffix) even though their dep has a version string.
 * Covers family/prefix matches (Symfony) and dev-tooling labels (Pest, Larastan, Pint)
 * where the version isn't meaningful stack-identification signal.
 */
const UNVERSIONED = new Set(['Symfony', 'Pest', 'Larastan', 'Pint'])

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

function detectStack(deps: Record<string, unknown>): string[] {
  const labels = new Map<string, string>() // label -> version ('' if none)
  for (const [dep, version] of Object.entries(deps)) {
    for (const [re, label] of STACK_LABELS) {
      if (re.test(dep)) {
        if (!labels.has(label)) {
          const v = !UNVERSIONED.has(label) && typeof version === 'string' ? version : ''
          labels.set(label, v)
        }
        break
      }
    }
  }
  return [...labels].map(([label, v]) => (v ? `${label} ${v}` : label))
}

async function parseEnvKeys(path: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const keys: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const name = line.split('=', 1)[0].trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.push(name)
  }
  return keys
}

const LAYOUT_EXCLUDE = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  'storage',
  'bootstrap',
  '.idea',
])

async function listTopDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !LAYOUT_EXCLUDE.has(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function detectBoundedContexts(repoPath: string, tier: Tier): Promise<string[]> {
  if (tier !== 'api') return []
  const appDir = `${repoPath}/app`
  const out: string[] = []
  let entries
  try {
    entries = await readdir(appDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      const sub = await readdir(`${appDir}/${e.name}`, { withFileTypes: true })
      if (sub.some((s) => s.isDirectory() && s.name === 'Domain')) out.push(e.name)
    } catch {
      /* skip */
    }
  }
  return out.sort()
}

/**
 * First `# Heading` text, and the prose of the first section (up to the 2nd heading), capped.
 * When the README has no sub-heading at all, falls back to the first non-empty paragraph line.
 */
function parseReadme(md: string): { title?: string; intro?: string } {
  const lines = md.split('\n')
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l))
  const title = titleIdx >= 0 ? lines[titleIdx].replace(/^#\s+/, '').trim() : undefined
  const after = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines

  const hasSectionHeading = after.some((l) => /^#{1,6}\s+/.test(l))

  let intro: string | undefined
  if (hasSectionHeading) {
    const collected: string[] = []
    let headingsSeen = 0
    for (const l of after) {
      if (/^#{1,6}\s+/.test(l)) {
        headingsSeen++
        if (headingsSeen >= 2) break
        continue // skip the section heading itself (e.g. "## Overview")
      }
      if (l.trim()) collected.push(l.trim())
    }
    intro = collected.join(' ').replace(/\s+/g, ' ').trim() || undefined
  } else {
    intro = after.map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  }

  if (intro && intro.length > 600) {
    intro = intro.slice(0, 600).replace(/\s+\S*$/, '') + '…'
  }
  return { title, intro }
}

export async function extractProject(
  group: string,
  app: string,
  repoPath: string,
): Promise<ProjectFacts> {
  const pkg = await readJson(`${repoPath}/package.json`)
  const composer = await readJson(`${repoPath}/composer.json`)
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
    ...((composer?.require as Record<string, unknown>) ?? {}),
    ...((composer?.['require-dev'] as Record<string, unknown>) ?? {}),
  }
  const scripts = [
    ...Object.keys((pkg?.scripts as Record<string, unknown>) ?? {}),
    ...Object.keys((composer?.scripts as Record<string, unknown>) ?? {}),
  ]

  let readmeTitle: string | undefined
  let readmeIntro: string | undefined
  try {
    const md = await readFile(`${repoPath}/README.md`, 'utf8')
    const parsed = parseReadme(md)
    readmeTitle = parsed.title
    readmeIntro = parsed.intro
  } catch {
    /* no README — best effort */
  }

  const hasAgentsDoc =
    (await fileExists(`${repoPath}/AGENTS.md`)) || (await fileExists(`${repoPath}/CLAUDE.md`))

  const tier = inferTier(app)

  return {
    group,
    app,
    tier,
    repoPath,
    stack: detectStack(deps),
    scripts,
    readmeTitle,
    readmeIntro,
    hasAgentsDoc,
    envKeys: await parseEnvKeys(`${repoPath}/.env.example`),
    layout: await listTopDirs(repoPath),
    boundedContexts: await detectBoundedContexts(repoPath, tier),
  }
}
