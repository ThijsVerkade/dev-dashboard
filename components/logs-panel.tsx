'use client'
import { useMemo, useState } from 'react'
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

  const domainsRes = usePoll<ServiceMap>(
    effectiveEnv ? `/api/cloudwatch/domains?env=${encodeURIComponent(effectiveEnv)}` : '/api/cloudwatch/domains',
    60000,
  )

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
