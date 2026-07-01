import { NextRequest, NextResponse } from 'next/server'
import { getLive } from '@/lib/sources/claude-live'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get('session') ?? undefined
  return NextResponse.json(await getLive(session))
}
