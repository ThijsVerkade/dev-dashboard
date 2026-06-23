import { NextResponse } from 'next/server'
import { getPipelines } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getPipelines())
}
