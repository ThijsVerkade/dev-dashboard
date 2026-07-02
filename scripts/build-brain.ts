/**
 * Build/refresh the Knowledge Brain Obsidian vault from ./repos + Confluence ADRs.
 * Mirrors scripts/setup-repos.ts: load env via @next/env, then dynamic-import lib.
 *
 *   npm run brain                # build/refresh
 *   npm run brain -- --check     # report, write nothing
 *   npm run brain -- --projects-only | --adrs-only
 */
import _nextEnv from '@next/env'
const { loadEnvConfig } = _nextEnv as typeof import('@next/env')
loadEnvConfig(process.cwd())

const { buildVault } = await import('@/lib/brain/vault')
const { extractProject } = await import('@/lib/brain/extract-project')
const { confluenceCreds, fetchConfluencePage } = await import('@/lib/brain/confluence')
const { htmlToMarkdown } = await import('@/lib/brain/html-to-md')

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const scope: 'all' | 'projects' | 'adrs' = argv.includes('--projects-only')
  ? 'projects'
  : argv.includes('--adrs-only')
    ? 'adrs'
    : 'all'

const brainDir = process.env.BRAIN_DIR || 'brain'
const reposDir = process.env.WORKSPACE_DIR || 'repos'
const adrPages = (process.env.ADR_PAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const creds = confluenceCreds()
if (adrPages.length && !creds) {
  console.warn('⚠ ADR_PAGES set but no Confluence/Jira creds — ADRs will be written as placeholders.')
}

const fetchAdr = async (idOrUrl: string) =>
  creds
    ? fetchConfluencePage(creds, idOrUrl)
    : ({ ok: false as const, reason: 'unconfigured' as const, message: 'No Confluence credentials configured.' })

const summary = await buildVault(
  { brainDir, reposDir, adrPages, check, scope },
  { extract: extractProject, fetchAdr, htmlToMd: htmlToMarkdown, syncedDate: new Date().toISOString().slice(0, 10) },
)

const line = (label: string, items: string[]) =>
  console.log(`  ${label.padEnd(9)} ${items.length}${items.length ? ` — ${items.join(', ')}` : ''}`)

console.log(`\nKnowledge Brain (${check ? 'check' : 'build'}) → ${brainDir}`)
line('added', summary.added)
line('updated', summary.updated)
line('preserved', summary.skipped)
if (summary.warned.length) {
  console.warn('\n⚠ warnings:')
  line('warned', summary.warned)
}
console.log('')
