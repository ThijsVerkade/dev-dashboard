'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { JobMeta, JobDetail } from '@/lib/agent/runner'

const STATUS_CLASS: Record<JobMeta['status'], string> = {
  running: 'text-primary border-primary/40 animate-pulse',
  done: 'text-primary border-primary/40',
  failed: 'text-destructive border-destructive/40',
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

function JobView({ id }: { id: string }) {
  const job = usePoll<JobDetail>(`/api/agent/jobs/${id}`, 3000)
  if (!job.data?.ok) return null
  const { meta, events, mrUrl } = job.data.data
  return (
    <Card className="gap-0">
      <CardHeader className="border-b border-border [.border-b]:pb-4">
        <CardTitle className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm">
          <span className="text-muted-foreground">$ </span>
          <span>{meta.key}</span>
          <span className="text-muted-foreground">{meta.repo}</span>
          <span className="text-muted-foreground">{meta.branch}</span>
          <span className="ml-auto">
            <StatusPill status={meta.status} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {mrUrl && (
          <a
            href={mrUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-primary underline underline-offset-2"
          >
            → {mrUrl}
          </a>
        )}
        <div className="h-80 space-y-0.5 overflow-y-auto rounded-none border border-border bg-muted/20 p-3">
          {events.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground">waiting for output…</p>
          ) : (
            events.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="flex gap-2 font-mono text-xs leading-relaxed">
                <span className="shrink-0 tabular-nums text-muted-foreground/60">{timeOf(e.ts)}</span>
                <span className={cn('w-3 shrink-0 text-center', KIND_CLASS[e.kind])}>
                  {e.kind === 'tool_use' ? '$' : e.kind === 'tool_result' ? '⮑' : ''}
                </span>
                <span className={cn('min-w-0 break-words', KIND_CLASS[e.kind])}>{e.label}</span>
              </div>
            ))
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
  const jobs = usePoll<JobMeta[]>('/api/agent/jobs', 3000)

  async function send() {
    const k = key.trim()
    if (!k || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k }),
      })
      const json = await res.json()
      if (json.ok) {
        setMsg(`Dispatched ${k}`)
        setKey('')
        setSelected(json.data.id)
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
        <CardHeader className="border-b border-border [.border-b]:pb-4">
          <CardTitle className="font-mono text-sm tracking-tight">
            <span className="text-muted-foreground">$ </span>Send Ticket to Claude
          </CardTitle>
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
                  <span className="text-muted-foreground">{j.repo}</span>
                  <span className="truncate text-muted-foreground">{j.branch}</span>
                  <span className="ml-auto text-muted-foreground/60">{timeOf(j.startedAt)}</span>
                  <StatusPill status={j.status} />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && <JobView id={selected} />}
    </div>
  )
}
