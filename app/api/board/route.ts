import { NextResponse } from 'next/server'
import { getBoard } from '@/lib/sources/board'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await getBoard())
}
