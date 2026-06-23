import { NextRequest } from 'next/server'
import { getEvents } from '@/lib/sources/cloudwatch'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const group = req.nextUrl.searchParams.get('group') ?? ''
  const encoder = new TextEncoder()

  const OVERLAP = 30_000 // re-query 30s back each tick so late-ingested events aren't skipped
  const stream = new ReadableStream({
    async start(controller) {
      let start = Date.now() - 5 * 60 * 1000 // last 5 minutes
      let stop = false
      const seen = new Set<string>() // dedupe by eventId across the overlapping windows
      req.signal.addEventListener('abort', () => { stop = true })
      const send = (event: string, data: string) => {
        if (stop) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        } catch { stop = true }
      }

      for (let i = 0; i < 600 && !stop; i++) {
        const r = await getEvents(group, start)
        if (!r.ok) { send('error', JSON.stringify(r)); break }
        let maxTs = start
        for (const ev of r.data) {
          if (ev.id && seen.has(ev.id)) continue
          if (ev.id) seen.add(ev.id)
          send('event', JSON.stringify(ev))
          if (ev.timestamp > maxTs) maxTs = ev.timestamp
        }
        // Advance the cursor but stay OVERLAP behind newest; dedupe drops re-seen events.
        start = Math.max(start, maxTs - OVERLAP)
        if (seen.size > 5000) seen.clear() // bound memory on long-lived tails
        await new Promise((res) => setTimeout(res, 3000))
      }
      send('done', '"end"')
      try { controller.close() } catch { /* already closed by client abort */ }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
