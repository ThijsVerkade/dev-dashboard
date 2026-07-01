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
