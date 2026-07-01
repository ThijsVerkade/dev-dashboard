import { NextRequest, NextResponse } from 'next/server'
import { ok, unconfigured } from '@/lib/result'
import { getStatus, selectCloneTargets, cloneRepo } from '@/lib/setup/repos'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const repoName = typeof body?.repoName === 'string' ? body.repoName : undefined
  const status = getStatus()
  if (!status.configured) {
    return NextResponse.json(unconfigured('set GITLAB_HOST and GITLAB_TOKEN to clone'))
  }
  const results = selectCloneTargets(status, repoName).map((t) => ({
    repoName: t.repoName,
    result: cloneRepo(t),
  }))
  return NextResponse.json(ok(results))
}
