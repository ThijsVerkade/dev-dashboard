'use client'
import { useEffect, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import {
  buildTriggerHeaders,
  loadAgentToken,
  saveAgentToken,
  clearAgentToken,
} from '@/lib/agent-token-client'
import type { Issue } from '@/lib/sources/jira'
import type { JobMeta, JobDetail } from '@/lib/agent/runner'

const STATUS_COLOR: Record<JobMeta['status'], string> = {
  running: 'text-primary',
  done: 'text-primary',
  failed: 'text-destructive',
  canceled: 'text-muted-foreground',
  blocked: 'text-yellow-600',
}

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function PinBar({ token, onSave, onClear }: {
  token: string | null
  onSave: (t: string) => void
  onClear: () => void
}) {
  const [value, setValue] = useState('')
  if (token) {
    return (
      <div className="flex items-center justify-between border border-border p-3 font-mono text-xs">
        <span className="text-muted-foreground">PIN saved on this device</span>
        <button onClick={onClear} className="text-primary underline underline-offset-2">
          Forget
        </button>
      </div>
    )
  }
  return (
    <div className="flex gap-2 border border-border p-3">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Trigger PIN"
        className="min-w-0 flex-1 bg-transparent font-mono text-base outline-none"
      />
      <button
        onClick={() => value && onSave(value)}
        className="shrink-0 border border-border px-3 py-2 font-mono text-sm text-primary"
      >
        Save
      </button>
    </div>
  )
}

function MobileJobDetail({ id, token }: { id: string; token: string | null }) {
  const job = usePoll<JobDetail>(`/api/agent/jobs/${id}`, 3000)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!job.data?.ok) return null
  const { meta, events, mrUrl } = job.data.data
  const running = meta.status === 'running'

  async function cancel() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/agent/jobs/${id}/cancel`, { method: 'POST', headers: buildTriggerHeaders(token) })
      const json = await res.json()
      if (!json.ok) setErr(json.message ?? 'Cancel failed')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Cancel failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border border-border p-3">
      <div className="flex items-center gap-2 font-mono text-sm">
        <span className="font-semibold">{meta.key}</span>
        <span className={STATUS_COLOR[meta.status]}>● {meta.status}</span>
        {running && (
          <button
            onClick={cancel}
            disabled={busy}
            className="ml-auto border border-border px-2 py-1 text-xs"
          >
            Cancel
          </button>
        )}
      </div>
      {err && <p className="font-mono text-xs text-destructive">{err}</p>}
      {mrUrl && (
        <a href={mrUrl} target="_blank" rel="noreferrer" className="block font-mono text-xs text-primary underline">
          → {mrUrl}
        </a>
      )}
      <div className="max-h-72 space-y-0.5 overflow-y-auto bg-muted/20 p-2 font-mono text-xs">
        {events.length === 0 ? (
          <p className="text-muted-foreground">waiting for output…</p>
        ) : (
          events.slice(-40).map((e, i) => (
            <div key={`${e.ts}-${i}`} className="break-words">
              <span className="text-muted-foreground/60">{timeOf(e.ts)} </span>
              {e.label}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function MobileAgents() {
  const [token, setToken] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    setToken(loadAgentToken())
  }, [])

  const tickets = usePoll<Issue[]>('/api/jira/my', 20000)
  const jobs = usePoll<JobMeta[]>('/api/agent/jobs', 3000)
  const ticketList = tickets.data?.ok ? tickets.data.data : []
  const jobList = jobs.data?.ok ? jobs.data.data : []

  async function dispatch(key: string) {
    setBusyKey(key)
    setMsg(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: buildTriggerHeaders(token),
        body: JSON.stringify({ key }),
      })
      const json = await res.json()
      if (json.ok) {
        setMsg(`Dispatched ${key}`)
        setSelected(json.data.id)
      } else {
        setMsg(json.message ?? 'Failed to start')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4 font-mono">
      <h1 className="text-sm tracking-tight text-muted-foreground">$ agents — mobile</h1>

      <PinBar
        token={token}
        onSave={(t) => { saveAgentToken(t); setToken(t) }}
        onClear={() => { clearAgentToken(); setToken(null) }}
      />

      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

      <section className="space-y-2">
        <h2 className="text-xs text-muted-foreground">My tickets</h2>
        {ticketList.length === 0 ? (
          <p className="text-xs text-muted-foreground">no tickets</p>
        ) : (
          ticketList.map((t) => (
            <div key={t.key} className="flex items-center gap-2 border border-border p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t.key}</div>
                <div className="truncate text-xs text-muted-foreground">{t.summary}</div>
              </div>
              <button
                onClick={() => dispatch(t.key)}
                disabled={busyKey === t.key}
                className="shrink-0 border border-primary/40 px-3 py-2 text-sm text-primary disabled:opacity-50"
              >
                {busyKey === t.key ? '…' : 'Dispatch'}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs text-muted-foreground">Running jobs</h2>
        {jobList.length === 0 ? (
          <p className="text-xs text-muted-foreground">no jobs yet</p>
        ) : (
          jobList.map((j) => (
            <button
              key={j.id}
              onClick={() => setSelected(j.id === selected ? null : j.id)}
              className="flex w-full items-center gap-2 border border-border p-3 text-left text-xs"
            >
              <span className="font-semibold">{j.key}</span>
              <span className="truncate text-muted-foreground">{j.branch}</span>
              <span className={`ml-auto ${STATUS_COLOR[j.status]}`}>● {j.status}</span>
            </button>
          ))
        )}
      </section>

      {selected && <MobileJobDetail id={selected} token={token} />}
    </div>
  )
}
