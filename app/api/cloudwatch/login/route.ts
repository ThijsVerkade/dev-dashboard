import { spawn } from 'node:child_process'
import { NextRequest, NextResponse } from 'next/server'
import { dashboardConfig } from '@/dashboard.config'
import { ok, failure, unconfigured } from '@/lib/result'
import { isLoopbackHost, loginProfileForEnv, ssoLoginArgs } from '@/lib/sso-login'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Profiles whose `aws sso login` is currently running, so we don't spawn a
// second browser flow while one is already open. Module scope = per dev server.
const inFlight = new Set<string>()

export async function POST(req: NextRequest) {
  // Local-only: this shells out to the AWS CLI, so it must never be reachable
  // from a deployed instance.
  if (!isLoopbackHost(req.headers.get('host'))) {
    return NextResponse.json(failure('SSO login can only be triggered locally.'), { status: 403 })
  }

  const env = req.nextUrl.searchParams.get('env') ?? 'dev'
  const profile = loginProfileForEnv(env, dashboardConfig.cloudwatchEnvProfiles)
  if (!profile) {
    return NextResponse.json(
      unconfigured(`No AWS profile configured for "${env}" (set CW_ENV_PROFILES).`),
    )
  }

  if (inFlight.has(profile)) {
    return NextResponse.json(ok({ started: false, profile, reason: 'already in progress' }))
  }

  try {
    const child = spawn('aws', ssoLoginArgs(profile), {
      stdio: 'ignore',
      detached: true,
    })
    inFlight.add(profile)
    child.once('error', () => inFlight.delete(profile)) // e.g. aws not on PATH
    child.once('exit', () => inFlight.delete(profile))
    child.unref()
    return NextResponse.json(ok({ started: true, profile }))
  } catch (e) {
    inFlight.delete(profile)
    return NextResponse.json(failure(e instanceof Error ? e.message : 'Failed to start aws sso login'))
  }
}
