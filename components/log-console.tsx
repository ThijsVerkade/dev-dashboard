'use client'
import { useEffect, useRef, useState } from 'react'
import { mergeLine, type LogLine } from '@/lib/log-merge'

const CAP = 2000

// Stable color per service slot so each tag is visually distinct.
const TAG_COLORS = ['text-sky-400', 'text-emerald-400', 'text-amber-400', 'text-fuchsia-400', 'text-rose-400']

export function LogConsole({ env, services }: { env: string; services: { label: string; group: string }[] }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  // Reset the buffer when env or the set of service labels changes.
  const key = `${env}|${services.map((s) => s.label).sort().join(',')}`
  useEffect(() => { setLines([]) }, [key])

  useEffect(() => {
    const sources = services.map(({ label, group }) => {
      const es = new EventSource(`/api/cloudwatch/tail?env=${encodeURIComponent(env)}&group=${encodeURIComponent(group)}`)
      es.addEventListener('event', (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as { id: string; timestamp: number; message: string }
        setLines((buf) => mergeLine(buf, { service: label, ...ev }, CAP))
      })
      es.addEventListener('error', (e) => {
        const data = (e as MessageEvent).data
        if (data) setLines((buf) => mergeLine(buf, { service: label, id: `err-${label}-${data}`, timestamp: Date.now(), message: `[stream error] ${data}` }, CAP))
        else es.close()
      })
      es.addEventListener('done', () => es.close())
      return es
    })
    return () => sources.forEach((es) => es.close())
  }, [env, services])

  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [lines])

  const colorFor = (label: string) => TAG_COLORS[Math.max(0, services.findIndex((s) => s.label === label)) % TAG_COLORS.length]

  return (
    <div
      ref={boxRef}
      className="relative z-[60] h-96 overflow-auto rounded-none border border-border bg-black p-3 font-mono text-xs leading-relaxed text-primary"
    >
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
