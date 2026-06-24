'use client'
import { useEffect, useRef, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { JobMeta, JobDetail } from '@/lib/agent/runner'
import { AGENT_PROFILES } from '@/lib/agent/profiles'
import { MobileQrDialog } from '@/components/mobile-qr-dialog'
import {
  buildTriggerHeaders,
  loadAgentToken,
  saveAgentToken,
  clearAgentToken,
} from '@/lib/agent-token-client'

const STATUS_CLASS: Record<JobMeta['status'], string> = {
  running: 'text-primary border-primary/40 animate-pulse',
  done: 'text-primary border-primary/40',
  failed: 'text-destructive border-destructive/40',
  canceled: 'text-muted-foreground border-border',
  blocked: 'text-amber-500 border-amber-500/40',
}

function elapsed(fromIso: string, toIso?: string): string {
  const from = new Date(fromIso).getTime()
  const to = toIso ? new Date(toIso).getTime() : Date.now()
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

async function postJson(url: string, token: string | null): Promise<{ ok: boolean; data?: any; message?: string }> {
  const res = await fetch(url, { method: 'POST', headers: buildTriggerHeaders(token) })
  return res.json()
}

function StatusPill({ status }: { status: JobMeta['status'] }) {
  return (
    <Badge
      variant="outline"
      className={cn('rounded-none bg-transparent px-1.5 font-mono text-[11px]', STATUS_CLASS[status])}
    >
      ● {status}
    </Badge>
  )
}

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

const KIND_CLASS: Record<string, string> = {
  text: 'text-foreground',
  tool_use: 'text-primary',
  tool_result: 'text-muted-foreground',
}

function JobView({ id, token, onSelect }: { id: string; token: string | null; onSelect: (id: string) => void }) {
  const job = usePoll<JobDetail>(`/api/agent/jobs/${id}`, 3000)
  const [busy, setBusy] = useState(false)
  const [cancelErr, setCancelErr] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const count = job.data?.ok ? job.data.data.events.length : 0

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])

  if (!job.data?.ok) return null
  const { meta, events, mrUrl } = job.data.data
  const running = meta.status === 'running'

  async function cancel() {
    setBusy(true)
    setCancelErr(null)
    try {
      const res = await postJson(`/api/agent/jobs/${id}/cancel`, token)
      if (!res.ok) setCancelErr(res.message ?? 'Cancel failed')
    } finally {
      setBusy(false)
    }
  }
  async function retry() {
    setBusy(true)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: buildTriggerHeaders(token),
        body: JSON.stringify({ key: meta.key }),
      })
      const json = await res.json()
      if (json.ok) onSelect(json.data.ids?.[0] ?? id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="gap-0">
      <CardHeader className="border-b border-border [.border-b]:pb-4">
        <CardTitle className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm">
          <span className="text-muted-foreground">$ </span>
          <span>{meta.key}</span>
          <span className="text-muted-foreground">{meta.repo}</span>
          {meta.profile === 'acceptance' ? (
            <span className="text-muted-foreground">{AGENT_PROFILES.acceptance.label}{meta.phase ? ` · ${meta.phase}` : ''}{meta.result ? ` · ${meta.result}` : ''}</span>
          ) : (
            <span className="text-muted-foreground">{meta.baseBranch} ← {meta.branch}</span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {running ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={cancel}
                className="h-6 rounded-none px-2 text-[11px]"
              >
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={retry}
                className="h-6 rounded-none px-2 text-[11px]"
              >
                Retry
              </Button>
            )}
            <StatusPill status={meta.status} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>started {timeOf(meta.startedAt)}</span>
          {running && <span>elapsed {elapsed(meta.startedAt)}</span>}
          <span>{events.length} events</span>
        </div>
        {cancelErr && <p className="font-mono text-[11px] text-destructive">{cancelErr}</p>}
        {mrUrl && (
          <a
            href={mrUrl}
            target="_blank"
            rel="noreferrer"
            className="block font-mono text-xs text-primary underline underline-offset-2"
          >
            → {mrUrl}
          </a>
        )}
        <div
          ref={scrollRef}
          className="h-80 space-y-0.5 overflow-y-auto rounded-none border border-border bg-muted/20 p-3"
        >
          {events.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground">waiting for output…</p>
          ) : (
            events.map((e, i) => {
              const isPrompt = e.kind === 'text' && e.role === 'user'
              return (
                <div key={`${e.ts}-${i}`} className="flex gap-2 font-mono text-xs leading-relaxed">
                  <span className="shrink-0 tabular-nums text-muted-foreground/60">{timeOf(e.ts)}</span>
                  <span className={cn('w-3 shrink-0 text-center', isPrompt ? 'text-amber-500' : KIND_CLASS[e.kind])}>
                    {isPrompt ? '›' : e.kind === 'tool_use' ? '$' : e.kind === 'tool_result' ? '⮑' : ''}
                  </span>
                  <span className={cn('min-w-0 break-words', isPrompt ? 'text-amber-500' : KIND_CLASS[e.kind])}>
                    {e.label}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function AgentsPanel() {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  useEffect(() => {
    setToken(loadAgentToken())
  }, [])
  const jobs = usePoll<JobMeta[]>('/api/agent/jobs', 3000)

  async function send() {
    const k = key.trim()
    if (!k || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: buildTriggerHeaders(token),
        body: JSON.stringify({ key: k }),
      })
      const json = await res.json()
      if (json.ok) {
        setMsg(`Dispatched ${k}`)
        setKey('')
        setSelected(json.data.ids?.[0] ?? null)
      } else {
        setMsg(json.message ?? 'Failed to start')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  const list = jobs.data?.ok ? jobs.data.data : []

  return (
    <div className="space-y-4">
      <Card className="gap-0">
        <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-border [.border-b]:pb-4">
          <CardTitle className="font-mono text-sm tracking-tight">
            <span className="text-muted-foreground">$ </span>Send Ticket to Claude
          </CardTitle>
          <MobileQrDialog />
        </CardHeader>
        <CardContent className="space-y-2 pt-4">
          <div className="flex gap-2">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="Jira ticket key, e.g. NBDE-817"
              className="rounded-none font-mono text-sm"
            />
            <Button onClick={send} disabled={busy} className="rounded-none font-mono">
              {busy ? 'Sending…' : 'Send to Claude'}
            </Button>
          </div>
          {msg && <p className="font-mono text-xs text-muted-foreground">{msg}</p>}
          {token ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              PIN set ·{' '}
              <button
                type="button"
                onClick={() => { clearAgentToken(); setToken(null) }}
                className="text-primary underline underline-offset-2"
              >
                forget
              </button>
            </p>
          ) : (
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="Trigger PIN (only if AGENT_TRIGGER_TOKEN is set)"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const v = (e.target as HTMLInputElement).value.trim()
                  if (v) { saveAgentToken(v); setToken(v) }
                }}
                className="rounded-none font-mono text-xs"
              />
            </div>
          )}
          <p className="font-mono text-[11px] text-amber-500">
            ⚠ Runs an autonomous agent with bypassed permissions; pushes a branch and opens an MR.
          </p>
        </CardContent>
      </Card>

      <Card className="gap-0">
        <CardHeader className="border-b border-border [.border-b]:pb-4">
          <CardTitle className="font-mono text-sm tracking-tight">
            <span className="text-muted-foreground">$ </span>Agent Jobs
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {list.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground">no jobs yet</p>
          ) : (
            <div className="space-y-1">
              {list.map((j) => (
                <button
                  key={j.id}
                  onClick={() => setSelected(j.id)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-x-3 gap-y-1 border border-transparent px-2 py-1.5 text-left font-mono text-xs hover:border-border hover:bg-muted/40',
                    selected === j.id && 'border-border bg-muted/40',
                  )}
                >
                  <span className="font-semibold text-foreground">{j.key}</span>
                  <span className="rounded-none border border-border px-1 text-[10px] uppercase text-muted-foreground">{j.profile}</span>
                  <span className="text-muted-foreground">{j.repo}</span>
                  {j.profile === 'acceptance'
                    ? <span className="truncate text-muted-foreground">{j.reason ?? j.phase ?? ''}</span>
                    : <span className="truncate text-muted-foreground">{j.branch}</span>}
                  <span className="ml-auto text-muted-foreground/60">{timeOf(j.startedAt)}</span>
                  <StatusPill status={j.status} />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && <JobView id={selected} token={token} onSelect={setSelected} />}
    </div>
  )
}
