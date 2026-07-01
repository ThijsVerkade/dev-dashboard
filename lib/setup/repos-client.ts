// Client-safe helpers for the repo-setup gate. NO `node:*` / `server-only` imports —
// these run in the browser. The SetupStatus import is type-only (erased at build).
import type { SetupStatus } from '@/lib/setup/repos'

/** Gate passes when every configured repo is present (or none are configured). */
export function reposGateState(status: SetupStatus): 'complete' | 'needs-setup' {
  return status.repos.every((r) => r.state === 'present') ? 'complete' : 'needs-setup'
}

/** Pre-filled GitLab personal-access-token creation URL (read_repository scope). */
export function createTokenUrl(host: string): string {
  const base = host.replace(/\/+$/, '')
  return `${base}/-/user_settings/personal_access_tokens?name=dev-dashboard&scopes=read_repository`
}
