import { NextRequest, NextResponse } from 'next/server'
import { assignIssue } from '@/lib/sources/jira'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { key?: string; accountId?: string | null }
  try { body = await req.json() } catch { return NextResponse.json(failure('Invalid JSON body')) }
  const { key, accountId } = body ?? {}
  if (!key) return NextResponse.json(failure('key is required'))
  if (accountId !== null && typeof accountId !== 'string')
    return NextResponse.json(failure('accountId must be a string or null'))
  return NextResponse.json(await assignIssue(key, accountId))
}
