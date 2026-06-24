import { NextRequest, NextResponse } from 'next/server'
import { startJob } from '@/lib/agent/runner'
import { isAgentRequestAuthorized } from '@/lib/agent/token'
import { isAgentProfile } from '@/lib/agent/profiles'
import { setIssueApps } from '@/lib/sources/jira'
import { ok, failure } from '@/lib/result'
import { agentGroups, reposForGroup } from '@/dashboard.config'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!isAgentRequestAuthorized(req.headers))
    return NextResponse.json(failure('Unauthorized: invalid or missing agent token'), { status: 401 })
  let body: { key?: string; profile?: string; group?: string; app?: string; apps?: unknown }
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

  const group = typeof body?.group === 'string' ? body.group.trim() : ''
  if (!group) return NextResponse.json(failure('group is required'))
  if (!agentGroups().includes(group)) return NextResponse.json(failure(`Unknown group "${group}"`))

  // A ticket may target several repos: dispatch one isolated job per selected app.
  // Empty apps => the whole group (every repo configured under it).
  const picked = (Array.isArray(body.apps) ? body.apps : body.app ? [body.app] : [])
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    .map((a) => a.trim())
  const apps = picked.length ? picked : reposForGroup(group)
  if (!apps.length) return NextResponse.json(failure(`Group "${group}" has no repos configured`))

  const results = await Promise.all(apps.map((app) => startJob(trimmedKey, profile, group, app)))
  const ids = results.flatMap((r) => (r.ok ? [r.data.id] : []))
  const errors = results.flatMap((r, i) => (r.ok ? [] : [`${apps[i]}: ${r.message}`]))

  // Record the apps that actually started (group-qualified), so the ticket reflects it.
  const startedApps = apps.filter((_, i) => results[i].ok).map((app) => `${group}/${app}`)
  if (startedApps.length) void setIssueApps(trimmedKey, startedApps)

  if (!ids.length) return NextResponse.json(failure(errors.join(' | ') || 'No jobs started'))
  return NextResponse.json(ok({ ids, ...(errors.length ? { errors } : {}) }))
}
