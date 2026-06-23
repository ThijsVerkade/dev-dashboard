import { NextRequest, NextResponse } from 'next/server'
import { getAssignableUsers } from '@/lib/sources/jira'
import { failure } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json(failure('key is required'))
  return NextResponse.json(await getAssignableUsers(key))
}
