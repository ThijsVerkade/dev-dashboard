import { NextRequest, NextResponse } from 'next/server'
import { getJobs, getPipelines, playJob } from '@/lib/sources/gitlab'
import { findStagingJob, isPlayableStagingJob, pipelineForSha } from '@/lib/sources/board'
import { dashboardConfig } from '@/dashboard.config'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { project?: string; sha?: string }
  try { body = await req.json() } catch { return NextResponse.json(failure('Invalid JSON body')) }
  const { project, sha } = body ?? {}
  if (!project || !sha) return NextResponse.json(failure('project and sha are required'))

  const pipelines = await getPipelines()
  if (!pipelines.ok) return NextResponse.json(pipelines)
  const pl = pipelineForSha(sha, pipelines.data)
  if (!pl) return NextResponse.json(failure('No pipeline found for that commit'))

  const jobs = await getJobs(project, pl.id)
  if (!jobs.ok) return NextResponse.json(jobs)
  const job = findStagingJob(jobs.data, dashboardConfig.stagingJobName)
  if (!job) return NextResponse.json(failure(`No "${dashboardConfig.stagingJobName}" job on pipeline #${pl.id}`))
  if (!isPlayableStagingJob(job, pl.status))
    return NextResponse.json(failure('Staging job is not playable (pipeline not green or job not manual)'))

  return NextResponse.json(await playJob(project, job.id))
}
