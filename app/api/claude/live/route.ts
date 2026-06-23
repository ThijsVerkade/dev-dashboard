import { NextResponse } from 'next/server'
import { getLive } from '@/lib/sources/claude-live'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getLive())
}
