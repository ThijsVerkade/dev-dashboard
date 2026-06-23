import 'server-only'
import { timingSafeEqual } from 'node:crypto'

const HEADER = 'x-agent-token'

/** Constant-time compare; returns false (fast) when lengths differ. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Whether a mutating agent request is authorized.
 * AGENT_TRIGGER_TOKEN unset/empty => all requests allowed (back-compat).
 * Set => request must carry a matching `x-agent-token` header.
 */
export function isAgentRequestAuthorized(headers: Headers): boolean {
  const expected = process.env.AGENT_TRIGGER_TOKEN
  if (!expected) return true
  return safeEqual(headers.get(HEADER) ?? '', expected)
}
