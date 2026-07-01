import { NextRequest, NextResponse } from 'next/server'
import { probeAuth } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get('env') ?? 'dev'
  return NextResponse.json(await probeAuth(env))
}
