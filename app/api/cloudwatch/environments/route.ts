import { NextResponse } from 'next/server'
import { ok } from '@/lib/result'
import { logEnvironments } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(ok(logEnvironments()))
}
