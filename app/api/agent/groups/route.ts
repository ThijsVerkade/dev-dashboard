import { NextResponse } from 'next/server'
import { agentGroups } from '@/dashboard.config'
import { ok } from '@/lib/result'

export const dynamic = 'force-dynamic'

/** Configured product groups for quick-send dispatch. GET /api/agent/groups */
export async function GET() {
  return NextResponse.json(ok({ groups: agentGroups() }))
}
