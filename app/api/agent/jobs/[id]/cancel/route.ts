import { NextResponse } from 'next/server'
import { cancelJob } from '@/lib/agent/runner'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return NextResponse.json(cancelJob(id))
}
