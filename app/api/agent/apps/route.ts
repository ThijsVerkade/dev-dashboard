import { NextRequest, NextResponse } from 'next/server'
import { agentGroups, reposForGroup, resolveGroupRepo } from '@/dashboard.config'
import { parseRepoSpec } from '@/lib/agent/prompt'
import { getIssueDetail } from '@/lib/sources/jira'
import { ok, failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

/**
 * Groups + their apps a ticket can be dispatched to, plus the group-qualified apps
 * (`<group>/<app>`) currently recorded on it. GET /api/agent/apps?key=NBDE-417
 */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')?.trim()
  if (!key) return NextResponse.json(failure('key is required'))

  const groups = agentGroups().map((name) => ({
    name,
    apps: reposForGroup(name).map((app) => {
      const { repo, baseBranch } = parseRepoSpec(resolveGroupRepo(name, app) ?? '')
      return { name: app, repo, baseBranch }
    }),
  }))

  const detail = await getIssueDetail(key)
  const selected = detail.ok ? (detail.data.apps ?? []) : []

  return NextResponse.json(ok({ groups, selected }))
}
