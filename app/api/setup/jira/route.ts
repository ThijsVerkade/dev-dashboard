import { NextRequest, NextResponse } from 'next/server'
import { failure } from '@/lib/result'
import { isLoopbackHost } from '@/lib/sso-login'
import { saveJiraCreds } from '@/lib/setup/jira-token'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // Local-only: this writes secrets to .env.local, so it must never be reachable off-host.
  if (!isLoopbackHost(req.headers.get('host'))) {
    return NextResponse.json(failure('Jira credentials can only be set locally.'), { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const host = typeof body?.host === 'string' ? body.host.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  if (!host || !email || !token) {
    return NextResponse.json(failure('Jira host, email, and API token are all required.'))
  }
  return NextResponse.json(await saveJiraCreds(host, email, token))
}
