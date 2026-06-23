'use client'
import { useEffect, useRef, useState } from 'react'

export function LiveTail({ src }: { src: string }) {
  const [lines, setLines] = useState<string[]>([])
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setLines([])
    const es = new EventSource(src)
    const push = (text: string) => setLines((l) => [...l.slice(-2000), text])
    es.addEventListener('line', (e) => push(JSON.parse((e as MessageEvent).data)))
    es.addEventListener('event', (e) => {
      const ev = JSON.parse((e as MessageEvent).data)
      push(`${new Date(ev.timestamp).toISOString()}  ${ev.message}`)
    })
    // The server's named `error` event carries .data. The NATIVE EventSource
    // error (connection drop) has no .data and would auto-reconnect — which
    // restarts the server's polling loop from scratch. Close on it instead.
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      if (data) push(`[stream error] ${data}`)
      else { push('[disconnected]'); es.close() }
    })
    es.addEventListener('done', () => es.close())
    return () => es.close()
  }, [src])
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [lines])
  return (
    // z-[60] lifts the tail above the global scanline overlay (z-50) so no
    // overlay ever sits on the trace — kept maximally readable.
    <div
      ref={boxRef}
      className="relative z-[60] h-80 overflow-auto rounded-none border border-border bg-black p-3 font-mono text-xs leading-relaxed text-primary"
    >
      {lines.length === 0 ? (
        <span className="text-primary/40">— awaiting stream —</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="select-none text-primary/40" aria-hidden>&gt;</span>
            <span className="flex-1">{line}</span>
          </div>
        ))
      )}
    </div>
  )
}
