'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mergeLine, type LogLine } from '@/lib/log-merge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const CAP = 2000

const TAG_COLORS = ['text-sky-400', 'text-emerald-400', 'text-amber-400', 'text-fuchsia-400', 'text-rose-400']
// Stable color per service label (independent of position) so colors never shift on toggle.
function tagColor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length]
}

// Severity color for a log line: 5xx / errors → red, 4xx / warnings → amber,
// 2xx-3xx access lines → dim, everything else → normal foreground.
function severityClass(msg: string): string {
  if (/^\s*at\s/.test(msg) || /\b(Exception|Traceback)\b|Error:/.test(msg)) return 'text-red-400'
  const status = msg.match(/"[A-Z]+ [^"]*"\s+(\d{3})\b/)
  if (status) {
    const code = Number(status[1])
    if (code >= 500) return 'text-red-400'
    if (code >= 400) return 'text-amber-400'
    return 'text-primary/55'
  }
  if (/\b(ERROR|FATAL|CRITICAL|PANIC)\b/i.test(msg)) return 'text-red-400'
  if (/\b(WARN|WARNING)\b/i.test(msg)) return 'text-amber-400'
  return 'text-primary'
}

// Repetitive infrastructure noise that buries real activity:
// health/readiness probes (Apache-quoted, NestJS-unquoted, and common pollers)
// plus NestJS LoggingInterceptor per-request object dumps (correlationId/controller/handler).
function isNoise(msg: string): boolean {
  // Health / readiness probes
  if (/"[A-Z]+ \/(health|healthz|readiness|ready|ping|status)\b/i.test(msg)) return true
  if (/\b[A-Z]+ \/(health|healthz|readiness|ready|ping)\b/.test(msg)) return true
  if (/Go-http-client|ELB-HealthChecker|kube-probe/i.test(msg)) return true
  if (/HealthController|checkHealth/.test(msg)) return true
  // NestJS LoggingInterceptor object-dump scaffolding
  if (/^Object\(\d+\)\s*\{\s*$/.test(msg)) return true
  if (/^\s*(correlationId|controller|handler):/.test(msg)) return true
  if (/^\s*\}\s*$/.test(msg)) return true
  return false
}

/** Owns a single service's SSE stream; renders nothing. Mount/unmount = open/close that one stream. */
function ServiceStream({
  env, group, label, onLine,
}: {
  env: string
  group: string
  label: string
  onLine: (line: LogLine) => void
}) {
  useEffect(() => {
    const es = new EventSource(`/api/cloudwatch/tail?env=${encodeURIComponent(env)}&group=${encodeURIComponent(group)}`)
    es.addEventListener('event', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as { id: string; timestamp: number; message: string }
      onLine({ service: label, ...ev })
    })
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      if (data) onLine({ service: label, id: `err-${label}-${data}`, timestamp: Date.now(), message: `[stream error] ${data}` })
      else es.close()
    })
    es.addEventListener('done', () => es.close())
    return () => es.close()
  }, [env, group, label, onLine])
  return null
}

export function LogConsole({ env, services }: { env: string; services: { label: string; group: string }[] }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [filter, setFilter] = useState('')
  const [hideNoise, setHideNoise] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)
  const addLine = useCallback((line: LogLine) => setLines((buf) => mergeLine(buf, line, CAP)), [])

  // Only lines for currently-enabled services are shown, so toggling a chip off
  // both stops its stream (the ServiceStream unmounts) and removes its lines here.
  const enabled = useMemo(() => new Set(services.map((s) => s.label)), [services])
  const needle = filter.trim().toLowerCase()
  const visible = lines.filter((l) => {
    if (!enabled.has(l.service)) return false
    if (hideNoise && isNoise(l.message)) return false
    if (needle && !l.message.toLowerCase().includes(needle)) return false
    return true
  })

  // Autoscroll to bottom as new (visible) lines arrive.
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [visible.length])

  return (
    <div className="w-full space-y-2">
      {services.map((s) => (
        <ServiceStream key={s.label} env={env} group={s.group} label={s.label} onLine={addLine} />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter logs…"
          className="h-8 w-full max-w-xs rounded-none font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => setHideNoise((v) => !v)}
          className={cn(
            'h-8 shrink-0 rounded-none border px-2 font-mono text-[11px]',
            hideNoise ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground',
          )}
        >
          {hideNoise ? '☑' : '☐'} hide health checks
        </button>
        <span className="ml-auto select-none font-mono text-[11px] text-primary/40">
          {visible.length}{visible.length !== lines.length ? ` / ${lines.length}` : ''} lines
        </span>
      </div>

      <div
        ref={boxRef}
        className="relative z-[60] h-[70vh] w-full overflow-auto rounded-none border border-border bg-black p-3 font-mono text-xs leading-relaxed text-primary"
      >
        {visible.length === 0 ? (
          <span className="text-primary/40">{lines.length === 0 ? '— awaiting stream —' : '— no lines match —'}</span>
        ) : (
          visible.map((l) => (
            <div key={`${l.service}:${l.id}`} className="flex gap-2 whitespace-pre-wrap break-all py-0.5">
              <span className="select-none text-primary/40" aria-hidden>{new Date(l.timestamp).toISOString().slice(11, 19)}</span>
              <span className={cn('select-none', tagColor(l.service))}>[{l.service}]</span>
              <span className={cn('flex-1', severityClass(l.message))}>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
