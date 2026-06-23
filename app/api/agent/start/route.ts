import { NextRequest, NextResponse } from 'next/server'
import { startJob } from '@/lib/agent/runner'
import { isAgentRequestAuthorized } from '@/lib/agent/token'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!isAgentRequestAuthorized(req.headers))
    return NextResponse.json(failure('Unauthorized: invalid or missing agent token'), { status: 401 })
  let body: { key?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(failure('Invalid JSON body'))
  }
  const key = body?.key
  if (!key || typeof key !== 'string') return NextResponse.json(failure('key is required'))
  return NextResponse.json(await startJob(key.trim()))
}
