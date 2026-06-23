import { NextResponse } from 'next/server'
import { cancelJob } from '@/lib/agent/runner'
import { isAgentRequestAuthorized } from '@/lib/agent/token'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRequestAuthorized(req.headers))
    return NextResponse.json(failure('Unauthorized: invalid or missing agent token'), { status: 401 })
  const { id } = await params
  return NextResponse.json(cancelJob(id))
}
