import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Result, ok, failure } from '@/lib/result'
import { buildCloneUrl, redactToken, parseAgentRepos } from '@/lib/setup/repos'

/** Upsert KEY=value lines into an .env file's content. Replaces existing keys, appends new ones, preserves the rest. */
export function upsertEnv(content: string, updates: Record<string, string>): string {
  const remaining = { ...updates }
  const lines = content.split('\n').map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/)
    if (m && m[1] in remaining) {
      const key = m[1]
      const value = remaining[key]
      delete remaining[key]
      return `${key}=${value}`
    }
    return line
  })
  let result = lines.join('\n')
  const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`)
  if (appended.length) {
    if (result.length && !result.endsWith('\n')) result += '\n'
    result += appended.join('\n') + '\n'
  }
  return result
}

/** Verify a token has read access to a repo via `git ls-remote`. Exercises the read_repository scope. */
export function validateGitlabToken(host: string, token: string, repoName: string): Result<null> {
  try {
    execFileSync('git', ['ls-remote', '--heads', buildCloneUrl(host, token, repoName)], {
      stdio: 'pipe',
      timeout: 30_000,
    })
    return ok(null)
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer | string }
    const raw = [err.message, err.stderr?.toString()].filter(Boolean).join('\n') || 'git ls-remote failed'
    return failure(redactToken(raw, token))
  }
}

/** Write GITLAB_HOST/GITLAB_TOKEN to .env.local and apply them to this process's env immediately. */
export function persistGitlabCreds(host: string, token: string): Result<null> {
  const path = join(process.cwd(), '.env.local')
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(path, upsertEnv(existing, { GITLAB_HOST: host, GITLAB_TOKEN: token }))
    process.env.GITLAB_HOST = host
    process.env.GITLAB_TOKEN = token
    return ok(null)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'Failed to write .env.local')
  }
}

/** Validate a token against the first configured repo (if any), then persist it. */
export function saveGitlabToken(host: string, token: string): Result<null> {
  if (!host || !token) return failure('GitLab host and token are both required.')
  const repos = parseAgentRepos()
  if (repos.length > 0) {
    const check = validateGitlabToken(host, token, repos[0].repoName)
    if (!check.ok) return check
  }
  return persistGitlabCreds(host, token)
}
