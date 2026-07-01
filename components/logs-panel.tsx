'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { LogConsole } from './log-console'
import type { ServiceMap } from '@/lib/sources/cloudwatch'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

function initialParams(): { env?: string; domain?: string } {
  if (typeof window === 'undefined') return {}
  const p = new URLSearchParams(window.location.search)
  return { env: p.get('env') ?? undefined, domain: p.get('domain') ?? undefined }
}

export function LogsPanel() {
  const [{ env: envParam, domain: domainParam }] = useState(initialParams)
  const envs = usePoll<string[]>('/api/cloudwatch/environments', 300000)
  const [env, setEnv] = useState<string>(envParam ?? '')
  const effectiveEnv = env || (envs.data?.ok ? envs.data.data[0] ?? '' : '')

  // Poll fairly often so logs reappear promptly once a re-auth completes.
  const domainsRes = usePoll<ServiceMap>(
    effectiveEnv ? `/api/cloudwatch/domains?env=${encodeURIComponent(effectiveEnv)}` : '/api/cloudwatch/domains',
    10000,
  )
  // Missing AWS creds (e.g. an expired SSO token) surface as "unconfigured".
  const authNeeded = !!(domainsRes.data && !domainsRes.data.ok && domainsRes.data.reason === 'unconfigured')

  // Local-only: ask the server to run `aws sso login` (opens the browser).
  const [loginMsg, setLoginMsg] = useState<string | null>(null)
  const attempted = useRef<Set<string>>(new Set())
  const triggerLogin = useCallback(async (targetEnv: string) => {
    if (!targetEnv) return
    setLoginMsg('Opening AWS SSO login in your browser — approve it to continue…')
    try {
      const res = await fetch(`/api/cloudwatch/login?env=${encodeURIComponent(targetEnv)}`, { method: 'POST' })
      const json = (await res.json()) as { ok: boolean; message?: string }
      if (!json.ok) setLoginMsg(json.message ?? 'Could not start AWS SSO login.')
    } catch {
      setLoginMsg('Could not reach the login endpoint.')
    }
  }, [])

  // Auto-fire the login once per env the first time its creds come back missing.
  useEffect(() => {
    if (authNeeded && effectiveEnv && !attempted.current.has(effectiveEnv)) {
      attempted.current.add(effectiveEnv)
      triggerLogin(effectiveEnv)
    }
  }, [authNeeded, effectiveEnv, triggerLogin])

  const [domain, setDomain] = useState<string>(domainParam ?? '')
  const [disabled, setDisabled] = useState<Set<string>>(new Set())

  const serviceMap = domainsRes.data?.ok ? domainsRes.data.data : {}
  const domainNames = Object.keys(serviceMap).sort()
  const effectiveDomain = domain && serviceMap[domain] ? domain : ''
  const domainServices: Record<string, string> = effectiveDomain ? serviceMap[effectiveDomain] : {}
  const allLabels = Object.keys(domainServices).sort()

  // Memoized so LogConsole's stream effect only reconnects on real changes.
  const labelsKey = allLabels.join(',')
  const disabledKey = [...disabled].sort().join(',')
  const services = useMemo(
    () => allLabels.filter((l) => !disabled.has(l)).map((label) => ({ label, group: domainServices[label] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelsKey, effectiveEnv, effectiveDomain, disabledKey],
  )

  const toggle = (label: string) =>
    setDisabled((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  return (
    <PanelShell title="CloudWatch Logs" result={envs.data} loading={envs.loading}>
      {(envList) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={effectiveEnv} onValueChange={(v) => { setEnv(v); setDomain(''); setDisabled(new Set()) }}>
              <SelectTrigger className="w-40 font-mono"><SelectValue placeholder="env…" /></SelectTrigger>
              <SelectContent className="font-mono">
                {envList.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={effectiveDomain} onValueChange={(v) => { setDomain(v); setDisabled(new Set()) }}>
              <SelectTrigger className="w-56 font-mono"><SelectValue placeholder="domain…" /></SelectTrigger>
              <SelectContent className="font-mono">
                {domainNames.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {domainsRes.data && !domainsRes.data.ok && (
            <div className="space-y-2">
              <p className={cn('font-mono text-sm', domainsRes.data.reason === 'unconfigured' ? 'text-amber-500' : 'text-destructive')}>
                {domainsRes.data.reason === 'unconfigured' ? '[ ---- ] not configured: ' : '[ FAIL ] error: '}
                {domainsRes.data.message}
              </p>
              {domainsRes.data.reason === 'unconfigured' && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => triggerLogin(effectiveEnv)}
                    className="h-8 shrink-0 rounded-none border border-primary/40 px-2 font-mono text-[11px] text-primary hover:bg-primary/10"
                  >
                    ⟳ re-authenticate (AWS SSO)
                  </button>
                  {loginMsg && <span className="font-mono text-[11px] text-muted-foreground">{loginMsg}</span>}
                </div>
              )}
            </div>
          )}

          {domainsRes.data?.ok && domainNames.length === 0 && (
            <p className="font-mono text-sm text-muted-foreground">no App Runner services discovered in {effectiveEnv}.</p>
          )}

          {effectiveDomain && (
            <div className="flex flex-wrap gap-2">
              {allLabels.map((label) => (
                <button key={label} type="button" onClick={() => toggle(label)}>
                  <Badge
                    variant="outline"
                    className={cn(
                      'rounded-none px-2 font-mono text-[11px] cursor-pointer',
                      disabled.has(label) ? 'text-muted-foreground border-border opacity-50' : 'text-primary border-primary/40',
                    )}
                  >
                    [{label}]
                  </Badge>
                </button>
              ))}
            </div>
          )}

          {effectiveDomain
            ? <LogConsole key={`${effectiveEnv}:${effectiveDomain}`} env={effectiveEnv} services={services} />
            : <p className="font-mono text-sm text-muted-foreground">select a domain to tail its services…</p>}
        </div>
      )}
    </PanelShell>
  )
}
