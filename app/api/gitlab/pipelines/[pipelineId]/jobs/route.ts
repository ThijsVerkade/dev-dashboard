import { NextRequest, NextResponse } from 'next/server'
import { getJobs } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ pipelineId: string }> },
) {
  const { pipelineId } = await params
  const project = req.nextUrl.searchParams.get('project') ?? ''
  return NextResponse.json(await getJobs(project, Number(pipelineId)))
}
