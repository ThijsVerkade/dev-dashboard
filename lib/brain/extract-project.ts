import { readFile } from 'node:fs/promises'
import { inferTier } from './tier'
import type { ProjectFacts } from './types'

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
]

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
  const labels = new Set<string>()
  for (const dep of Object.keys(deps)) {
    for (const [re, label] of STACK_LABELS) {
      if (re.test(dep)) labels.add(label)
    }
  }
  return [...labels]
}

/** First `# Heading` text and the first non-empty paragraph after it. */
function parseReadme(md: string): { title?: string; intro?: string } {
  const lines = md.split('\n')
  const titleLine = lines.find((l) => /^#\s+/.test(l))
  const title = titleLine?.replace(/^#\s+/, '').trim()
  const afterTitle = titleLine ? lines.slice(lines.indexOf(titleLine) + 1) : lines
  const intro = afterTitle.map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'))
  return { title, intro }
}

export async function extractProject(
  group: string,
  app: string,
  repoPath: string,
): Promise<ProjectFacts> {
  const pkg = await readJson(`${repoPath}/package.json`)
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
  }
  const scripts = Object.keys((pkg?.scripts as Record<string, unknown>) ?? {})

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

  return {
    group,
    app,
    tier: inferTier(app),
    repoPath,
    stack: detectStack(deps),
    scripts,
    readmeTitle,
    readmeIntro,
    hasAgentsDoc,
  }
}
