import { NextRequest, NextResponse } from 'next/server'
import { playJob } from '@/lib/sources/gitlab'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const project = req.nextUrl.searchParams.get('project')
  const id = Number(jobId)
  if (!project || !Number.isFinite(id)) return NextResponse.json(failure('project and jobId are required'))
  return NextResponse.json(await playJob(project, id))
}
