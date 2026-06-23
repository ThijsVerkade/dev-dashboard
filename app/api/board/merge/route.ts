import { NextRequest, NextResponse } from 'next/server'
import { getMergeRequests, getMrApprovals, getPipelines, mergeMr } from '@/lib/sources/gitlab'
import { computeReadyToMerge, pipelineForSha } from '@/lib/sources/board'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { project?: string; iid?: number }
  try { body = await req.json() } catch { return NextResponse.json(failure('Invalid JSON body')) }
  const { project, iid } = body ?? {}
  if (!project || typeof iid !== 'number') return NextResponse.json(failure('project and iid are required'))

  const mrs = await getMergeRequests(project)
  if (!mrs.ok) return NextResponse.json(mrs)
  const mr = mrs.data.find((m) => m.iid === iid)
  if (!mr) return NextResponse.json(failure(`MR !${iid} not found in ${project}`))

  const approvals = await getMrApprovals(project, iid)
  if (!approvals.ok) return NextResponse.json(approvals)
  const pipelines = await getPipelines()
  if (!pipelines.ok) return NextResponse.json(pipelines)
  const pl = pipelineForSha(mr.sha, pipelines.data)

  if (!computeReadyToMerge(mr, approvals.data, pl?.status))
    return NextResponse.json(failure('MR is not ready to merge (approvals, pipeline, or conflicts)'))

  return NextResponse.json(await mergeMr(project, iid))
}
