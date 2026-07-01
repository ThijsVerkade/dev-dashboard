import { NextResponse } from 'next/server'
import { ok } from '@/lib/result'
import { getStatus } from '@/lib/setup/repos'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(ok(getStatus()))
}
