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
import { getIssueDetail } from '@/lib/sources/jira'
import { projectKeyOf, slugify, buildAgentPrompt, parseRepoSpec } from '@/lib/agent/prompt'
import { parseTranscriptTail, normalizeEvents, type LiveEvent } from '@/lib/sources/claude-live'
import { Result, ok, failure } from '@/lib/result'

export type JobStatus = 'running' | 'done' | 'failed' | 'canceled'
export type JobMeta = {
  id: string
  key: string
  repo: string
  branch: string
  baseBranch: string
  status: JobStatus
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
export async function startJob(key: string): Promise<Result<{ id: string }>> {
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
