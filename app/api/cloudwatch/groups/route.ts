import { NextResponse } from 'next/server'
import { getLogGroups } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getLogGroups())
}
