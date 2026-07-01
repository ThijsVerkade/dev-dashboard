/**
 * Clone the AGENT_REPOS this dashboard is configured for into <dashboard>/repos
 * (or WORKSPACE_DIR). Idempotent: clones only what's missing, never touches existing
 * clones. `--check` reports status and warns without cloning (used by predev).
 */
import _nextEnv from '@next/env'
// @next/env is a CJS module; named imports are not available in ESM — use default + destructure.
const { loadEnvConfig } = _nextEnv as typeof import('@next/env')

loadEnvConfig(process.cwd())

// Import AFTER env is loaded — dashboard.config reads process.env at module-eval time.
const { getStatus, cloneRepo, selectCloneTargets } = await import('@/lib/setup/repos')

const checkOnly = process.argv.includes('--check')
const status = getStatus()

const LABEL: Record<string, string> = {
  present: '✓ present',
  'present-not-git': '! not a git repo',
  missing: '✗ missing',
}

console.log(`\nConfigured repos (install root: ${status.root}):`)
for (const r of status.repos) {
  console.log(`  ${LABEL[r.state].padEnd(18)} ${r.repoName}@${r.baseBranch}`)
}
if (status.repos.length === 0) {
  console.log('  (none — set AGENT_REPOS in .env.local)')
}

const missing = status.repos.filter((r) => r.state === 'missing')

if (checkOnly) {
  if (missing.length > 0) {
    console.warn(
      `\n⚠ ${missing.length} configured repo(s) not installed — run \`npm run setup\` or use the dashboard Setup panel.\n`,
    )
  }
  process.exit(0)
}

if (!status.configured) {
  console.error(
    '\nCannot clone: set GITLAB_HOST and GITLAB_TOKEN in .env.local (token needs the read_repository scope).\n',
  )
  process.exit(1)
}

if (missing.length === 0) {
  console.log('\nAll configured repos are already installed.\n')
  process.exit(0)
}

let failed = 0
for (const entry of selectCloneTargets(status)) {
  process.stdout.write(`\nCloning ${entry.repoName}@${entry.baseBranch} … `)
  const res = cloneRepo(entry)
  if (res.ok) {
    console.log('done')
  } else {
    failed++
    console.log('FAILED')
    console.error(`  ${res.message}`)
  }
}

console.log(
  `\nSummary: cloned ${missing.length - failed}, failed ${failed}, present ${status.repos.length - missing.length}.\n`,
)
process.exit(failed > 0 ? 1 : 0)
