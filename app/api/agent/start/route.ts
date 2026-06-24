import { NextRequest, NextResponse } from 'next/server'
import { startJob } from '@/lib/agent/runner'
import { isAgentRequestAuthorized } from '@/lib/agent/token'
import { isAgentProfile } from '@/lib/agent/profiles'
import { setIssueApps } from '@/lib/sources/jira'
import { ok, failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!isAgentRequestAuthorized(req.headers))
    return NextResponse.json(failure('Unauthorized: invalid or missing agent token'), { status: 401 })
  let body: { key?: string; profile?: string; app?: string; apps?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('Invalid JSON body'))
  }
  const key = body?.key
  if (!key || typeof key !== 'string') return NextResponse.json(failure('key is required'))
  const trimmedKey = key.trim()
  const profile = body?.profile ?? 'implement'
  if (!isAgentProfile(profile)) return NextResponse.json(failure(`Unknown profile "${profile}"`))

  // A ticket may target several repos: dispatch one isolated job per selected app.
  // Back-compat: no apps => a single job using the project's default repo.
  const apps = (Array.isArray(body.apps) ? body.apps : body.app ? [body.app] : [])
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    .map((a) => a.trim())
  const targets: (string | undefined)[] = apps.length ? apps : [undefined]

  const results = await Promise.all(targets.map((app) => startJob(trimmedKey, profile, app)))
  const ids = results.flatMap((r) => (r.ok ? [r.data.id] : []))
  const errors = results.flatMap((r, i) => (r.ok ? [] : [`${targets[i] ?? 'default'}: ${r.message}`]))

  // Record the apps that actually started, so the ticket reflects what was dispatched.
  const startedApps = targets.filter((app, i): app is string => !!app && results[i].ok)
  if (startedApps.length) void setIssueApps(trimmedKey, startedApps)

  if (!ids.length) return NextResponse.json(failure(errors.join(' | ') || 'No jobs started'))
  return NextResponse.json(ok({ ids, ...(errors.length ? { errors } : {}) }))
}
