'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { mergeLine, type LogLine } from '@/lib/log-merge'

const CAP = 2000

const TAG_COLORS = ['text-sky-400', 'text-emerald-400', 'text-amber-400', 'text-fuchsia-400', 'text-rose-400']
// Stable color per service label (independent of position) so colors never shift on toggle.
function colorFor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length]
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
  const boxRef = useRef<HTMLDivElement>(null)
  const addLine = useCallback((line: LogLine) => setLines((buf) => mergeLine(buf, line, CAP)), [])

  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [lines])

  return (
    <div
      ref={boxRef}
      className="relative z-[60] h-96 overflow-auto rounded-none border border-border bg-black p-3 font-mono text-xs leading-relaxed text-primary"
    >
      {services.map((s) => (
        <ServiceStream key={s.label} env={env} group={s.group} label={s.label} onLine={addLine} />
      ))}
      {lines.length === 0 ? (
        <span className="text-primary/40">— awaiting stream —</span>
      ) : (
        lines.map((l) => (
          <div key={`${l.service}:${l.id}`} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="select-none text-primary/40" aria-hidden>{new Date(l.timestamp).toISOString().slice(11, 19)}</span>
            <span className={`select-none ${colorFor(l.service)}`}>[{l.service}]</span>
            <span className="flex-1">{l.message}</span>
          </div>
        ))
      )}
    </div>
  )
}
