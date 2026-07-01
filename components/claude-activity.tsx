'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import type { ActiveSession, ClaudeLive, LiveEvent } from '@/lib/sources/claude-live'

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

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: ActiveSession
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-left font-mono text-xs',
        selected
          ? 'border-primary bg-muted/40'
          : 'border-transparent hover:bg-muted/20',
      )}
    >
      <span className="min-w-0 shrink-0 truncate font-semibold text-foreground">{session.project}</span>
      {session.model && <span className="shrink-0 text-muted-foreground/70">{session.model}</span>}
      <span className="ml-auto shrink-0">
        <StatusPill status={session.status} />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{session.lastEventLabel}</span>
    </button>
  )
}

export function ClaudeActivity() {
  const sessions = usePoll<ActiveSession[]>('/api/claude/sessions/live', 3000)
  const list = sessions.data?.ok ? sessions.data.data : []

  const [selected, setSelected] = useState<string | null>(null)
  // Effective selection: the chosen session if still active, else the newest.
  const effective = useMemo(() => {
    if (selected && list.some((s) => s.sessionId === selected)) return selected
    return list[0]?.sessionId ?? null
  }, [selected, list])

  const liveUrl = effective
    ? `/api/claude/live?session=${encodeURIComponent(effective)}`
    : '/api/claude/live'
  const live = usePoll<ClaudeLive>(liveUrl, 2500)

  const scrollRef = useRef<HTMLDivElement>(null)
  const count = live.data?.ok ? live.data.data.events.length : 0
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, effective])

  return (
    <Card className="flex h-full flex-col gap-0 overflow-hidden">
      <CardHeader className="shrink-0 border-b border-border [.border-b]:pb-4">
        <CardTitle className="font-mono text-sm tracking-tight">
          <span className="text-muted-foreground">$ </span>Claude Activity
        </CardTitle>
      </CardHeader>

      <ResizablePanelGroup direction="vertical" autoSaveId="claude-activity-v" className="min-h-0 flex-1">
        <ResizablePanel id="sessions" order={1} defaultSize={35} minSize={15}>
          <div className="h-full overflow-y-auto p-2">
            {sessions.loading && !sessions.data && (
              <div className="space-y-2 p-1">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            )}
            {sessions.data && !sessions.data.ok && (
              <p
                className={cn(
                  'p-1 font-mono text-xs',
                  sessions.data.reason === 'unconfigured' ? 'text-amber-500' : 'text-destructive',
                )}
              >
                {sessions.data.reason === 'unconfigured' ? '[ ---- ] ' : '[ FAIL ] '}
                {sessions.data.message}
              </p>
            )}
            {sessions.data?.ok && list.length === 0 && (
              <p className="p-1 font-mono text-xs text-muted-foreground">no active sessions</p>
            )}
            {list.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                selected={s.sessionId === effective}
                onSelect={() => setSelected(s.sessionId)}
              />
            ))}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="feed" order={2} defaultSize={65} minSize={20}>
          <div ref={scrollRef} className="h-full space-y-0.5 overflow-y-auto bg-muted/20 p-3">
            {live.data?.ok && live.data.data.events.length > 0 ? (
              live.data.data.events.map((e, i) => <EventRow key={`${e.ts}-${i}`} event={e} />)
            ) : (
              <p className="font-mono text-xs text-muted-foreground">no recent activity</p>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Card>
  )
}
