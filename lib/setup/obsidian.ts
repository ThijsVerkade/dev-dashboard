import { type Result, ok, failure } from '@/lib/result'
import { persistEnvVars } from '@/lib/setup/gitlab-token'

export const DEFAULT_OBSIDIAN_HOST = 'http://127.0.0.1:27123'

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Trim and strip trailing slashes from an Obsidian base URL. */
export function normalizeObsidianHost(host: string): string {
  return host.trim().replace(/\/+$/, '')
}

/**
 * Verify the API key reaches the Obsidian Local REST API by listing the vault
 * root (`GET /vault/`). Exercises the exact auth the MCP uses.
 */
export async function validateObsidianToken(
  host: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<Result<null>> {
  const base = normalizeObsidianHost(host)
  if (!base || !token) return failure('Obsidian host and API key are both required.')
  try {
    const res = await fetchImpl(`${base}/vault/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      const hint = res.status === 401 ? ' (wrong API key)' : ''
      return failure(`Obsidian ${res.status}${hint}: check the Local REST API plugin.`)
    }
    return ok(null)
  } catch {
    return failure(
      `Could not reach Obsidian at ${base}. Is Obsidian open with the Local REST API HTTP server enabled?`,
    )
  }
}

/** Validate the credentials, then persist OBSIDIAN_HOST/OBSIDIAN_API_KEY to .env.local. */
export async function saveObsidianToken(
  host: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<Result<null>> {
  const check = await validateObsidianToken(host, token, fetchImpl)
  if (!check.ok) return check
  return persistEnvVars({ OBSIDIAN_HOST: normalizeObsidianHost(host), OBSIDIAN_API_KEY: token })
}
