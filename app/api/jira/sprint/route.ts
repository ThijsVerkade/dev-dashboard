import { NextResponse } from 'next/server'
import { getActiveSprint } from '@/lib/sources/jira'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getActiveSprint())
}
