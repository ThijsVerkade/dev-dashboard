import { NextRequest } from 'next/server'
import { getJobTrace } from '@/lib/sources/gitlab'

export const dynamic = 'force-dynamic'

// GitLab traces contain ANSI colour codes and bare carriage returns (progress
// redraws). Strip the escapes and treat \r as a line break so the <pre> renders
// clean lines instead of literal escape sequences and overwritten garbage.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
function toLines(text: string): string[] {
  return text.replace(ANSI, '').split(/\r\n|\r|\n/)
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const project = req.nextUrl.searchParams.get('project') ?? ''
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let lastLength = 0
      let stop = false
      req.signal.addEventListener('abort', () => { stop = true })
      // Guard every send: after a client abort the controller is cancelled and
      // enqueue() throws. Checking `stop` and try/catch prevents an unhandled
      // rejection on the trailing 'done'.
      const send = (event: string, data: string) => {
        if (stop) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        } catch { stop = true }
      }

      for (let i = 0; i < 600 && !stop; i++) {
        const r = await getJobTrace(project, Number(jobId))
        if (!r.ok) { send('error', JSON.stringify(r)); break }
        if (r.data.length > lastLength) {
          // GitLab has no incremental trace endpoint, so we re-fetch the whole
          // trace each tick but only emit the newly-appended slice.
          const chunk = r.data.slice(lastLength)
          lastLength = r.data.length
          for (const line of toLines(chunk)) send('line', JSON.stringify(line))
        }
        await new Promise((res) => setTimeout(res, 2000))
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
