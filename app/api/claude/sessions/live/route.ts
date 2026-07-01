import { NextResponse } from 'next/server'
import { getActiveSessions } from '@/lib/sources/claude-live'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getActiveSessions())
}
