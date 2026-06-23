const KEY = 'agent-trigger-token'
const HEADER = 'x-agent-token'

/** Headers for a mutating agent request; attaches the PIN when present. */
export function buildTriggerHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers[HEADER] = token
  return headers
}

export function loadAgentToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(KEY)
}

export function saveAgentToken(token: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, token)
}

export function clearAgentToken(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(KEY)
}
