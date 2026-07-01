'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  gateEnv, nextGateState, triggerSsoLogin, fetchAuthStatus, type GateState,
} from '@/lib/aws-login-client'
import type { Result } from '@/lib/result'

const POLL_MS = 2000

export function AwsLoginGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const env = useRef<string>('dev')
  const alive = useRef(true)

  // Resolve the gate env, then probe once on mount.
  useEffect(() => {
    alive.current = true
    ;(async () => {
      try {
        const res = await fetch('/api/cloudwatch/environments')
        const json = (await res.json()) as Result<string[]>
        if (json.ok) env.current = gateEnv(json.data) ?? 'dev'
      } catch {
        // fall back to 'dev'
      }
      const status = await fetchAuthStatus(env.current)
      if (!alive.current) return
      const next = nextGateState(status)
      setState(next)
      if (!status.ok) setMessage(status.message)
    })()
    return () => {
      alive.current = false
    }
  }, [])

  // Trigger `aws sso login`, then poll until creds are valid.
  const logIn = useCallback(async () => {
    setBusy(true)
    setMessage('Opening AWS SSO login in your browser — approve it to continue…')
    const started = await triggerSsoLogin(env.current)
    if (!started.ok) {
      setMessage(started.message ?? 'Could not start AWS SSO login.')
      setBusy(false)
      return
    }
    const poll = async () => {
      if (!alive.current) return
      const status = await fetchAuthStatus(env.current)
      if (!alive.current) return
      if (status.ok) {
        setState('authed')
        setBusy(false)
        return
      }
      setTimeout(poll, POLL_MS)
    }
    setTimeout(poll, POLL_MS)
  }, [])

  if (state === 'authed') return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 border border-border bg-card p-6 font-mono">
        <h1 className="text-lg text-primary">dev-dashboard</h1>
        {state === 'checking' ? (
          <p className="text-sm text-muted-foreground">Checking AWS session…</p>
        ) : (
          <>
            <p className="text-sm text-amber-500">
              {message ?? 'AWS sign-in required to use the dashboard.'}
            </p>
            <button
              type="button"
              onClick={logIn}
              disabled={busy}
              className="h-9 rounded-none border border-primary/40 px-3 text-sm text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {busy ? '… waiting for approval' : 'Log in to AWS SSO'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default AwsLoginGate
