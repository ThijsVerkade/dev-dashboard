import 'server-only'
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dashboardConfig } from '@/dashboard.config'
import { getIssueDetail, getAcceptanceDetail, addComment } from '@/lib/sources/jira'
import { projectKeyOf, slugify, buildAgentPrompt, parseRepoSpec } from '@/lib/agent/prompt'
import { parseTranscriptTail, normalizeEvents, type LiveEvent } from '@/lib/sources/claude-live'
import { Result, ok, failure } from '@/lib/result'
import { type AgentProfile } from '@/lib/agent/profiles'
import {
  buildAcceptancePrompt, parseVerdict, checkReadiness,
  buildMissingInfoComment, buildResultComment, type AcceptanceDetail,
} from '@/lib/agent/acceptance-logic'
import { checkStagingDeploy } from '@/lib/agent/deploy-gate'

export type JobStatus = 'running' | 'done' | 'failed' | 'canceled' | 'blocked'
export type JobMeta = {
  id: string
  key: string
  repo: string
  branch: string
  baseBranch: string
  profile: AgentProfile
  status: JobStatus
  phase?: string
  reason?: string
  result?: 'pass' | 'fail'
  startedAt: string
  pid: number
}
export type JobDetail = { meta: JobMeta; events: LiveEvent[]; mrUrl: string | null }

const JOBS_DIR = join(process.cwd(), '.agent-jobs')
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const TAIL_BYTES = 256 * 1024

const workspaceDir = () => dashboardConfig.workspaceDir || join(homedir(), 'workspace')
const metaPath = (id: string) => join(JOBS_DIR, `${id}.json`)
const logPath = (id: string) => join(JOBS_DIR, `${id}.log`)

function writeMeta(m: JobMeta): void {
  mkdirSync(JOBS_DIR, { recursive: true })
  writeFileSync(metaPath(m.id), JSON.stringify(m, null, 2))
}
function readMeta(id: string): JobMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf8')) as JobMeta
  } catch {
    return null
  }
}
function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
/** A running job whose process has died is reported as failed. */
function reconcile(m: JobMeta): JobMeta {
  if (m.status === 'running' && !pidAlive(m.pid)) {
    m.status = 'failed'
    writeMeta(m)
  }
  return m
}

/** Resolve repo, build the prompt from the ticket, spawn a detached headless agent. */
export async function startJob(key: string, profile: AgentProfile = 'implement'): Promise<Result<{ id: string }>> {
  if (profile === 'acceptance') return startAcceptanceJob(key)
  const projectKey = projectKeyOf(key)
  const spec = dashboardConfig.agentRepos[projectKey]
  if (!spec)
    return failure(`No repo mapped for project "${projectKey}". Set AGENT_REPOS (e.g. ${projectKey}:my-repo or ${projectKey}:my-repo@develop).`)

  const { repo: repoName, baseBranch } = parseRepoSpec(spec)
  const repoPath = join(workspaceDir(), repoName)
  if (!existsSync(join(repoPath, '.git'))) return failure(`Git repo not found at ${repoPath}`)

  const detail = await getIssueDetail(key)
  if (!detail.ok) return detail

  const branch = `feat/${detail.data.key}-${slugify(detail.data.summary) || 'work'}`
  const prompt = buildAgentPrompt(detail.data, { branch, baseBranch })
  const id = `${detail.data.key}-${Date.now()}`

  try {
    mkdirSync(JOBS_DIR, { recursive: true })
    const out = openSync(logPath(id), 'a')
    const child = spawn(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      { cwd: repoPath, detached: true, stdio: ['ignore', out, out] },
    )
    closeSync(out)

    const meta: JobMeta = {
      id,
      key: detail.data.key,
      repo: repoName,
      branch,
      baseBranch,
      profile: 'implement',
      status: 'running',
      startedAt: new Date().toISOString(),
      pid: child.pid ?? 0,
    }
    writeMeta(meta)
    child.on('exit', (code) => {
      const m = readMeta(id)
      if (m) {
        m.status = code === 0 ? 'done' : 'failed'
        writeMeta(m)
      }
    })
    child.on('error', () => {
      const m = readMeta(id)
      if (m) {
        m.status = 'failed'
        writeMeta(m)
      }
    })
    child.unref()
    return ok({ id })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Failed to spawn agent')
  }
}

export function listJobs(): JobMeta[] {
  if (!existsSync(JOBS_DIR)) return []
  return readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readMeta(f.slice(0, -5)))
    .filter((m): m is JobMeta => !!m)
    .map(reconcile)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** Terminate a running job's process (group), and mark it canceled. */
export function cancelJob(id: string): Result<{ id: string }> {
  const meta = readMeta(id)
  if (!meta) return failure('job not found')
  if (meta.status === 'running' && meta.pid) {
    try {
      process.kill(-meta.pid, 'SIGTERM') // detached child is its own group leader
    } catch {
      try {
        process.kill(meta.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }
  meta.status = 'canceled'
  writeMeta(meta)
  return ok({ id })
}

export function getJob(id: string): JobDetail | null {
  const meta = readMeta(id)
  if (!meta) return null
  reconcile(meta)
  let log = ''
  try {
    log = readTail(logPath(id), TAIL_BYTES)
  } catch {
    // no log yet
  }
  const events = normalizeEvents(parseTranscriptTail(log), 60)
  const mr = log.match(/https?:\/\/\S*?merge_requests\/\d+/)
  return { meta, events, mrUrl: mr ? mr[0] : null }
}

function setPhase(id: string, phase: string): void {
  const m = readMeta(id)
  if (m) { m.phase = phase; writeMeta(m) }
}
function finish(id: string, status: JobStatus, extra: Partial<JobMeta> = {}): void {
  const m = readMeta(id)
  if (m) { Object.assign(m, extra, { status }); writeMeta(m) }
}

/**
 * Acceptance profile: verify readiness + staging deploy (in-process), then spawn a
 * headless browser-testing agent and post the verdict to Jira. Gates run async after
 * the job id is returned; the dashboard server must stay up for the run to complete.
 */
async function startAcceptanceJob(key: string): Promise<Result<{ id: string }>> {
  const projectKey = projectKeyOf(key)
  const stagingUrl = dashboardConfig.stagingUrls[projectKey]
  const spec = dashboardConfig.agentRepos[projectKey]
  if (!spec) return failure(`No repo mapped for project "${projectKey}". Set AGENT_REPOS.`)
  const { repo: repoName } = parseRepoSpec(spec)
  const repoPath = join(workspaceDir(), repoName)
  if (!existsSync(join(repoPath, '.git'))) return failure(`Git repo not found at ${repoPath}`)

  const detailRes = await getAcceptanceDetail(key)
  if (!detailRes.ok) return detailRes
  const detail = detailRes.data

  const id = `${detail.key}-${Date.now()}`
  mkdirSync(JOBS_DIR, { recursive: true })
  const meta: JobMeta = {
    id, key: detail.key, repo: repoName, branch: '', baseBranch: '',
    profile: 'acceptance', status: 'running', phase: 'readiness',
    startedAt: new Date().toISOString(), pid: 0,
  }
  writeMeta(meta)

  // Run gates + agent without blocking the HTTP response.
  void runAcceptance(id, repoPath, stagingUrl, detail).catch((e) => {
    finish(id, 'failed', { reason: e instanceof Error ? e.message : 'acceptance run crashed' })
  })
  return ok({ id })
}

async function runAcceptance(
  id: string,
  repoPath: string,
  stagingUrl: string | undefined,
  detail: AcceptanceDetail,
): Promise<void> {
  // 1. Readiness
  if (!stagingUrl) {
    finish(id, 'blocked', { reason: `No staging URL for ${projectKeyOf(detail.key)} (set STAGING_URLS)` })
    return
  }
  const missing = checkReadiness(detail)
  if (missing.length > 0) {
    await addComment(detail.key, buildMissingInfoComment(detail, missing))
    finish(id, 'blocked', { reason: missing.join('; ') })
    return
  }

  // 2. Deploy gate
  setPhase(id, 'deploy')
  const deploy = await checkStagingDeploy(detail.key)
  if (!deploy.ok) {
    await addComment(detail.key, buildMissingInfoComment(detail, [`cannot test yet: ${deploy.message}`]))
    finish(id, 'blocked', { reason: deploy.message })
    return
  }

  // 3. Browser test (headless agent)
  setPhase(id, 'test')
  const prompt = buildAcceptancePrompt(detail, { stagingUrl })
  const out = openSync(logPath(id), 'a')
  const child = spawn(
    CLAUDE_BIN,
    ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
    { cwd: repoPath, detached: true, stdio: ['ignore', out, out] },
  )
  closeSync(out)
  const started = readMeta(id)
  if (started) { started.pid = child.pid ?? 0; writeMeta(started) }

  child.on('exit', () => {
    // 4. Report
    let log = ''
    try { log = readTail(logPath(id), TAIL_BYTES) } catch { /* no log */ }
    const verdict = parseVerdict(log)
    if (verdict.result === 'unknown') {
      finish(id, 'failed', { reason: 'agent produced no ACCEPTANCE-RESULT verdict' })
      return
    }
    void addComment(detail.key, buildResultComment(verdict))
    finish(id, 'done', { phase: 'reported', result: verdict.result })
  })
  child.on('error', () => finish(id, 'failed', { reason: 'failed to spawn browser agent' }))
  child.unref()
}
