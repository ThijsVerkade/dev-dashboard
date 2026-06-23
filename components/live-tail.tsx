'use client'
import { useEffect, useRef, useState } from 'react'

export function LiveTail({ src }: { src: string }) {
  const [lines, setLines] = useState<string[]>([])
  const boxRef = useRef<HTMLPreElement>(null)
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
    <pre ref={boxRef} className="h-80 overflow-auto rounded bg-black p-3 text-xs text-green-200">
      {lines.join('\n')}
    </pre>
  )
}
