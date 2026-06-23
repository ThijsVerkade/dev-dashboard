import 'server-only'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { Result, ok, failure, unconfigured } from '@/lib/result'

const run = promisify(execFile)

export type ClaudeSummary = {
  totalCost: number; totalTokens: number
  days: { date: string; cost: number; tokens: number }[]
}
export type ClaudeSession = {
  sessionId: string; project: string; cost: number; tokens: number; lastActivity: string
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function parseDaily(json: unknown): ClaudeSummary {
  const j = (json ?? {}) as any
  const days = Array.isArray(j.daily)
    ? j.daily.map((d: any) => ({
        date: str(d.date ?? d.period), cost: num(d.totalCost), tokens: num(d.totalTokens),
      }))
    : []
  return {
    totalCost: num(j.totals?.totalCost),
    totalTokens: num(j.totals?.totalTokens),
    days,
  }
}

export function parseSessions(json: unknown): ClaudeSession[] {
  const j = (json ?? {}) as any
  // ccusage@20 returns { session: [...] } (not "sessions")
  // Each item has: period (UUID used as sessionId), agent (string), metadata.lastActivity, totalCost, totalTokens
  const arr = Array.isArray(j.session) ? j.session : Array.isArray(j.sessions) ? j.sessions : []
  return arr.map((s: any) => ({
    sessionId: str(s.period ?? s.sessionId),
    project: str(s.agent ?? s.project),
    cost: num(s.totalCost),
    tokens: num(s.totalTokens),
    lastActivity: str(s.metadata?.lastActivity ?? s.lastActivity),
  }))
}

// Resolve the locally-installed ccusage binary; spawning `npx --yes` on every
// poll (2x/min) would re-resolve the package each time.
const CCUSAGE_BIN = join(process.cwd(), 'node_modules', '.bin', 'ccusage')
const cache = new Map<string, { value: unknown; expires: number }>()
const TTL_MS = 60_000

async function ccusage(subcommand: string): Promise<unknown> {
  const now = Date.now()
  const hit = cache.get(subcommand)
  if (hit && hit.expires > now) return hit.value
  const { stdout } = await run(CCUSAGE_BIN, [subcommand, '--json'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const value = JSON.parse(stdout)
  cache.set(subcommand, { value, expires: now + TTL_MS })
  return value
}

export async function getSummary(): Promise<Result<ClaudeSummary>> {
  try {
    return ok(parseDaily(await ccusage('daily')))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return unconfigured('ccusage not found — run: npm install')
    return failure(e instanceof Error ? e.message : 'Failed to run ccusage')
  }
}

export async function getSessions(): Promise<Result<ClaudeSession[]>> {
  try {
    return ok(parseSessions(await ccusage('session')))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return unconfigured('ccusage not found — run: npm install')
    return failure(e instanceof Error ? e.message : 'Failed to run ccusage')
  }
}
