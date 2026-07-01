import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { type Result, ok, unconfigured, failure } from '@/lib/result'
import { dashboardConfig } from '@/dashboard.config'
import { parseRepoSpec } from '@/lib/agent/prompt'

export type RepoState = 'present' | 'present-not-git' | 'missing'

export type RepoEntry = {
  group: string
  app: string
  /** Path segment under the install root, e.g. 'auction/api'. */
  repoName: string
  baseBranch: string
}

export type RepoStatus = RepoEntry & { state: RepoState; path: string }

export type SetupStatus = {
  /** GITLAB_HOST + GITLAB_TOKEN both present (cloning is impossible otherwise). */
  configured: boolean
  /** Absolute install root. */
  root: string
  repos: RepoStatus[]
}

/** 'https://gitlab.example.com/' -> 'gitlab.example.com'. */
export function bareHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** Authenticated clone URL. The token is embedded only for the clone, never persisted. */
export function buildCloneUrl(host: string, token: string, repoName: string): string {
  return `https://oauth2:${token}@${bareHost(host)}/${repoName}.git`
}

/** Token-less remote URL, set on origin right after cloning. */
export function cleanRemoteUrl(host: string, repoName: string): string {
  return `https://${bareHost(host)}/${repoName}.git`
}

/** Replace every occurrence of the token with '***' (no-op for an empty token). */
export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('***') : text
}

/** Pure state classifier from two existence checks. */
export function classifyState(dirExists: boolean, gitExists: boolean): RepoState {
  if (!dirExists) return 'missing'
  return gitExists ? 'present' : 'present-not-git'
}

/** Parse AGENT_REPOS into typed entries (key 'auction/api', value 'auction/api@main'). */
export function parseAgentRepos(
  map: Record<string, string> = dashboardConfig.agentRepos,
): RepoEntry[] {
  return Object.entries(map)
    .map(([key, spec]) => {
      const slash = key.indexOf('/')
      const group = slash === -1 ? key : key.slice(0, slash)
      const app = slash === -1 ? '' : key.slice(slash + 1)
      const { repo: repoName, baseBranch } = parseRepoSpec(spec)
      return { group, app, repoName, baseBranch }
    })
    .filter((e) => e.repoName)
    .sort((a, b) => a.repoName.localeCompare(b.repoName))
}

/** GitLab creds from env, or null when unset. Mirrors env.gitlab() without the 'server-only' import. */
export function resolveGitlab(): { host: string; token: string } | null {
  const host = process.env.GITLAB_HOST
  const token = process.env.GITLAB_TOKEN
  return host && token ? { host, token } : null
}

/** Absolute install root: WORKSPACE_DIR override, else <cwd>/repos. */
export function installRoot(): string {
  return dashboardConfig.workspaceDir || join(process.cwd(), 'repos')
}

function classify(path: string): RepoState {
  return classifyState(existsSync(path), existsSync(join(path, '.git')))
}

/** Present/missing status for every configured repo. */
export function getStatus(): SetupStatus {
  const root = installRoot()
  const repos = parseAgentRepos().map((e) => {
    const path = join(root, e.repoName)
    return { ...e, path, state: classify(path) }
  })
  return { configured: !!resolveGitlab(), root, repos }
}

/** Which repos a clone request targets: one named repo, or all currently missing. */
export function selectCloneTargets(status: SetupStatus, repoName?: string): RepoStatus[] {
  return repoName
    ? status.repos.filter((r) => r.repoName === repoName)
    : status.repos.filter((r) => r.state === 'missing')
}

/** Clone one repo over HTTPS, then strip the token from origin. Never overwrites an existing dir. */
export function cloneRepo(entry: RepoEntry): Result<{ repoName: string }> {
  const gl = resolveGitlab()
  if (!gl) return unconfigured('set GITLAB_HOST and GITLAB_TOKEN to clone')
  const dest = join(installRoot(), entry.repoName)
  if (existsSync(dest)) return failure(`${dest} already exists`)
  try {
    mkdirSync(dirname(dest), { recursive: true })
    execFileSync('git', ['clone', buildCloneUrl(gl.host, gl.token, entry.repoName), dest], {
      stdio: 'pipe',
      timeout: 300_000,
    })
    // Best-effort: check out the configured base branch (no-op if it's already the default).
    try {
      execFileSync('git', ['-C', dest, 'checkout', entry.baseBranch], { stdio: 'ignore' })
    } catch {
      // base branch may equal the default or not exist remotely — leave the default checkout
    }
    execFileSync('git', ['-C', dest, 'remote', 'set-url', 'origin', cleanRemoteUrl(gl.host, entry.repoName)], {
      stdio: 'ignore',
    })
    return ok({ repoName: entry.repoName })
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer | string }
    const raw = [err.message, err.stderr?.toString()].filter(Boolean).join('\n') || 'git clone failed'
    return failure(redactToken(raw, gl.token))
  }
}
