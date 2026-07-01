// Client-safe helpers for the local AWS SSO login flow. Shared by the login
// gate and the Logs panel. NO `server-only` import — these run in the browser.
import type { Result } from '@/lib/result'

export type GateState = 'checking' | 'authed' | 'needs-login' | 'error'

/** Which env the gate probes / logs in for: prefer 'dev', else the first. */
export function gateEnv(envs: string[]): string | undefined {
  if (envs.includes('dev')) return 'dev'
  return envs[0]
}

/** Map an auth-status Result to a gate status. */
export function nextGateState(result: Result<unknown>): GateState {
  if (result.ok) return 'authed'
  return result.reason === 'unconfigured' ? 'needs-login' : 'error'
}

/** Ask the server to run `aws sso login` (opens the browser). Never throws. */
export async function triggerSsoLogin(env: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`/api/cloudwatch/login?env=${encodeURIComponent(env)}`, { method: 'POST' })
    return (await res.json()) as { ok: boolean; message?: string }
  } catch {
    return { ok: false, message: 'Could not reach the login endpoint.' }
  }
}

/** Fetch current AWS auth status for an env. */
export async function fetchAuthStatus(env: string): Promise<Result<{ profile?: string }>> {
  const res = await fetch(`/api/cloudwatch/auth-status?env=${encodeURIComponent(env)}`)
  return (await res.json()) as Result<{ profile?: string }>
}
