import { NextResponse } from 'next/server'
import { getSessions } from '@/lib/sources/claude'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getSessions())
}
