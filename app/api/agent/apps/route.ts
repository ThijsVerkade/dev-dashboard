import { NextRequest, NextResponse } from 'next/server'
import { reposForProject, resolveAgentRepo } from '@/dashboard.config'
import { projectKeyOf, parseRepoSpec } from '@/lib/agent/prompt'
import { getIssueDetail } from '@/lib/sources/jira'
import { ok, failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

/**
 * Apps (repos) a ticket can be dispatched to, plus the ones currently recorded on it.
 * GET /api/agent/apps?key=NBDE-417
 */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')?.trim()
  if (!key) return NextResponse.json(failure('key is required'))

  const projectKey = projectKeyOf(key)
  const apps = reposForProject(projectKey).map((name) => {
    const { repo, baseBranch } = parseRepoSpec(resolveAgentRepo(projectKey, name) ?? '')
    return { name, repo, baseBranch }
  })

  const detail = await getIssueDetail(key)
  const selected = detail.ok ? (detail.data.apps ?? []) : []

  return NextResponse.json(ok({ apps, selected }))
}
