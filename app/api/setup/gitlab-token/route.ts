import { NextRequest, NextResponse } from 'next/server'
import { failure } from '@/lib/result'
import { isLoopbackHost } from '@/lib/sso-login'
import { saveGitlabToken } from '@/lib/setup/gitlab-token'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // Local-only: this writes a secret to .env.local, so it must never be reachable off-host.
  if (!isLoopbackHost(req.headers.get('host'))) {
    return NextResponse.json(failure('GitLab token can only be set locally.'), { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const host = typeof body?.host === 'string' ? body.host.trim() : ''
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  if (!token) return NextResponse.json(failure('A GitLab token is required.'))
  if (!host) return NextResponse.json(failure('A GitLab host is required.'))
  return NextResponse.json(saveGitlabToken(host, token))
}
