import { NextResponse } from 'next/server'
import { listJobs } from '@/lib/agent/runner'
import { ok } from '@/lib/result'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(ok(listJobs()))
}
