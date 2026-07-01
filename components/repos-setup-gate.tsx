'use client'
import { useEffect, useRef, useState } from 'react'
import type { Result } from '@/lib/result'
import type { SetupStatus } from '@/lib/setup/repos'
import { reposGateState } from '@/lib/setup/repos-client'
import { ReposSetup } from '@/components/repos-setup'

const POLL_MS = 3000

export function ReposSetupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'complete' | 'needs-setup'>('checking')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const tick = async () => {
      try {
        const res = await fetch('/api/setup/repos')
        const json = (await res.json()) as Result<SetupStatus>
        if (!alive.current) return
        if (json.ok) setState(reposGateState(json.data))
      } catch {
        // transient — keep the current state and retry on the next tick
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [])

  if (state === 'complete') return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-3">
        <h1 className="font-mono text-lg text-primary">dev-dashboard — repo setup required</h1>
        {state === 'checking' ? (
          <p className="font-mono text-sm text-muted-foreground">Checking repositories…</p>
        ) : (
          <ReposSetup />
        )}
      </div>
    </div>
  )
}

export default ReposSetupGate
