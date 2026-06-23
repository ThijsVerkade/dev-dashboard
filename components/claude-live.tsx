'use client'
import { useEffect, useRef } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ClaudeLive, LiveEvent } from '@/lib/sources/claude-live'

function StatusPill({ status }: { status: string }) {
  const kind = status.startsWith('running')
    ? 'running'
    : status.startsWith('idle')
      ? 'idle'
      : 'active'
  const className =
    kind === 'running'
      ? 'text-primary border-primary/40 animate-pulse'
      : kind === 'idle'
        ? 'text-muted-foreground border-border'
        : 'text-primary border-primary/40'
  return (
    <Badge
      variant="outline"
      className={cn('rounded-none bg-transparent px-1.5 font-mono text-[11px] tabular-nums', className)}
    >
      ● {status}
    </Badge>
  )
}

const KIND_STYLE: Record<LiveEvent['kind'], { glyph: string; className: string }> = {
  text: { glyph: '', className: 'text-foreground' },
  tool_use: { glyph: '$', className: 'text-primary' },
  tool_result: { glyph: '⮑', className: 'text-muted-foreground' },
}

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function EventRow({ event }: { event: LiveEvent }) {
  // A user text message reads as an incoming prompt; style it distinctly.
  const isPrompt = event.kind === 'text' && event.role === 'user'
  const style = KIND_STYLE[event.kind]
  const glyph = isPrompt ? '›' : style.glyph
  return (
    <div className="flex gap-2 font-mono text-xs leading-relaxed">
      <span className="shrink-0 tabular-nums text-muted-foreground/60">{timeOf(event.ts)}</span>
      <span className={cn('w-3 shrink-0 text-center', isPrompt ? 'text-amber-500' : style.className)}>
        {glyph}
      </span>
      <span className={cn('min-w-0 break-words', isPrompt ? 'text-amber-500' : style.className)}>
        {event.label}
      </span>
    </div>
  )
}

export function ClaudeLivePanel() {
  const live = usePoll<ClaudeLive>('/api/claude/live', 2500)
  const scrollRef = useRef<HTMLDivElement>(null)
  const count = live.data?.ok ? live.data.data.events.length : 0

  // Keep the newest event in view (terminal-style autoscroll).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])

  return (
    <PanelShell title="Live Activity" result={live.data} loading={live.loading}>
      {(d) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{d.project}</span>
            <span>·</span>
            <span>{d.sessionId}</span>
            {d.model && (
              <>
                <span>·</span>
                <span>{d.model}</span>
              </>
            )}
            <span className="ml-auto">
              <StatusPill status={d.status} />
            </span>
          </div>

          <div
            ref={scrollRef}
            className="h-72 space-y-0.5 overflow-y-auto rounded-none border border-border bg-muted/20 p-3"
          >
            {d.events.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">no recent activity</p>
            ) : (
              d.events.map((e, i) => <EventRow key={`${e.ts}-${i}`} event={e} />)
            )}
          </div>
        </div>
      )}
    </PanelShell>
  )
}
