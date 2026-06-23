import { NextResponse } from 'next/server'
import { getJob } from '@/lib/agent/runner'
import { ok, failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = getJob(id)
  return NextResponse.json(job ? ok(job) : failure('job not found'))
}
