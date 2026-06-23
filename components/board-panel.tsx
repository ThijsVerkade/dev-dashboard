'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from '@/components/panel-shell'
import { LiveTail } from '@/components/live-tail'
import { AssigneePicker } from '@/components/assignee-picker'
import { TicketDetail } from '@/components/ticket-detail'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Board, BoardColumn, BoardRow } from '@/lib/sources/board'

type Pending = { label: string; run: () => Promise<void> } | null

const ENVS = ['dev', 'acceptance', 'staging', 'production'] as const
const ENV_SHORT: Record<string, string> = { dev: 'D', acceptance: 'A', staging: 'S', production: 'P' }

// Five fixed release-flow stages. Each Jira status column is bucketed into one
// of these by status category + name, so the board always shows 5 side-by-side.
const STAGES = [
  { id: 'todo', label: 'To Do' },
  { id: 'inprogress', label: 'In Progress' },
  { id: 'review', label: 'Code Review' },
  { id: 'acceptance', label: 'Acceptance' },
  { id: 'done', label: 'Done' },
] as const

function classify(col: BoardColumn): (typeof STAGES)[number]['id'] {
  if (col.statusCategory === 'done') return 'done'
  if (/review/i.test(col.status)) return 'review'
  if (/accept/i.test(col.status)) return 'acceptance'
  if (col.statusCategory === 'new') return 'todo'
  return 'inprogress'
}

function groupIntoStages(columns: BoardColumn[]): Record<string, BoardRow[]> {
  const out: Record<string, BoardRow[]> = { todo: [], inprogress: [], review: [], acceptance: [], done: [] }
  for (const col of columns) out[classify(col)].push(...col.rows)
  return out
}

function pipelineTone(status?: string): string {
  if (status === 'success') return 'text-primary'
  if (status === 'failed') return 'text-destructive'
  if (status === 'running' || status === 'pending') return 'text-amber-500'
  return 'text-muted-foreground'
}

function FlowPills({ row }: { row: BoardRow }) {
  const mr = row.mr
  const apprOk = mr ? mr.approvalsGiven >= mr.approvalsRequired : false
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px]">
      <span className={mr ? 'text-primary' : 'text-muted-foreground'}>br{mr ? '✓' : '·'}</span>
      <span className={mr ? 'text-primary' : 'text-muted-foreground'}>mr{mr ? '✓' : '·'}</span>
      {mr && (
        <span className={apprOk ? 'text-primary' : 'text-amber-500'} title="approvals">
          apr {mr.approvalsGiven}/{mr.approvalsRequired}
        </span>
      )}
      {mr && (
        <span className={pipelineTone(mr.pipelineStatus)} title={`pipeline ${mr.pipelineStatus ?? 'none'}`}>
          pl {mr.pipelineStatus ? mr.pipelineStatus.slice(0, 4) : '·'}
        </span>
      )}
      <span className="ml-1 flex items-center gap-1 text-muted-foreground" title="dev / acceptance / staging / production">
        {ENVS.map((name) => {
          const on = row.envs.some((e) => e.name === name && e.onThisTicket)
          return (
            <span key={name} className={on ? 'text-primary' : 'text-muted-foreground/40'}>
              {ENV_SHORT[name]}
            </span>
          )
        })}
      </span>
    </div>
  )
}

async function post(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  return json.ok ? null : json.message ?? 'Action failed'
}

export function BoardPanel() {
  const { data, loading } = usePoll<Board>('/api/board', 30_000)
  const [pending, setPending] = useState<Pending>(null)
  const [tailGroup, setTailGroup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<BoardRow | null>(null)

  const confirm = (label: string, run: () => Promise<void>) => setPending({ label, run })

  return (
    <PanelShell<Board> title="Release Flow" result={data} loading={loading}>
      {(board) => {
        const stages = groupIntoStages(board.columns)
        const assignees = [...new Set(board.columns.flatMap((c) => c.rows.map((r) => r.assignee)))].sort()
        const match = (rows: BoardRow[]) => (selected.length === 0 ? rows : rows.filter((r) => selected.includes(r.assignee)))
        const total = Object.values(stages).reduce((n, rows) => n + match(rows).length, 0)
        const triggerLabel = selected.length === 0 ? 'All assignees' : selected.length === 1 ? selected[0] : `${selected.length} assignees`
        const toggle = (a: string) => setSelected((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]))
        return (
          <div className="space-y-3">
            {!board.canWrite && (
              <p className="font-mono text-[11px] text-amber-500">[ ---- ] read-only GitLab token — merge/deploy/tag disabled.</p>
            )}
            {error && <p className="font-mono text-xs text-destructive">[ FAIL ] {error}</p>}

            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="text-muted-foreground">filter assignee:</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 w-56 justify-between font-mono text-xs">
                    <span className="truncate">{triggerLabel}</span>
                    <ChevronsUpDown className="size-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-0 font-mono">
                  <Command>
                    <CommandInput placeholder="search assignee…" className="text-xs" />
                    <CommandList>
                      <CommandEmpty>No assignee.</CommandEmpty>
                      <CommandGroup>
                        {assignees.map((a) => (
                          <CommandItem key={a} value={a} onSelect={() => toggle(a)} className="text-xs">
                            <Check className={cn('size-3.5', selected.includes(a) ? 'opacity-100' : 'opacity-0')} />
                            <span className="truncate">{a}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selected.length > 0 && (
                <>
                  <span className="text-muted-foreground tabular-nums">{total} ticket{total === 1 ? '' : 's'}</span>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setSelected([])}>clear</Button>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
              {STAGES.map((stage) => {
                const rows = match(stages[stage.id])
                return (
                  <div key={stage.id} className="flex min-w-0 flex-col rounded-none border border-border bg-card/40">
                    <h3 className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/95 px-2 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                      <span className="truncate">{stage.label}</span>
                      <span className="text-primary tabular-nums">{rows.length}</span>
                    </h3>
                    <div className="flex max-h-[68vh] flex-col gap-1.5 overflow-y-auto p-1.5">
                      {rows.length === 0 && <p className="px-1 py-2 font-mono text-[10px] text-muted-foreground/50">—</p>}
                      {rows.map((row) => (
                        <div key={row.key} className="space-y-1 rounded-none border border-border bg-background/60 p-1.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <button type="button" onClick={() => setDetail(row)} className="shrink-0 font-mono text-primary hover:underline">{row.key}</button>
                            <AssigneePicker issueKey={row.key} current={row.assignee} />
                          </div>
                          <button type="button" onClick={() => setDetail(row)} className="block w-full truncate text-left text-foreground/90 hover:text-foreground" title={row.summary}>{row.summary}</button>
                          <FlowPills row={row} />
                          {(row.mr || row.repo || row.envs.some((e) => e.onThisTicket && e.logGroup)) && (
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {row.mr && (
                                <Button
                                  size="sm"
                                  disabled={!board.canWrite || !row.readyToMerge}
                                  title={!board.canWrite ? 'Needs api-scoped token' : !row.readyToMerge ? 'Not ready (approvals/pipeline/conflicts)' : ''}
                                  className="h-5 px-1.5 text-[10px]"
                                  onClick={() => confirm(`Merge MR !${row.mr!.iid} into main`, async () => {
                                    setError(await post('/api/board/merge', { project: row.repo!.project, iid: row.mr!.iid }))
                                  })}
                                >Merge</Button>
                              )}
                              {row.stagingJob && row.mr && row.repo && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={!board.canWrite || !row.stagingJob.playable}
                                  title={!row.stagingJob.playable ? 'Pipeline not green or job not manual' : ''}
                                  className="h-5 px-1.5 text-[10px]"
                                  onClick={() => confirm(`Play deploy:staging for ${row.key}`, async () => {
                                    setError(await post('/api/board/deploy-staging', { project: row.repo!.project, sha: row.mr!.sha }))
                                  })}
                                >Staging</Button>
                              )}
                              {row.repo && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!board.canWrite}
                                  className="h-5 px-1.5 text-[10px]"
                                  onClick={() => {
                                    const name = prompt('New production tag (on main):', row.suggestedTag ?? 'v0.1.0')
                                    if (!name) return
                                    confirm(`Create tag ${name} on main`, async () => {
                                      setError(await post('/api/board/tag', { project: row.repo!.project, name }))
                                    })
                                  }}
                                >Tag</Button>
                              )}
                              {row.envs.filter((e) => e.onThisTicket && e.logGroup).map((e) => (
                                <Button key={e.name} size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
                                  onClick={() => setTailGroup(e.logGroup!)}>log:{ENV_SHORT[e.name] ?? e.name}</Button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            {tailGroup && (
              <div className="space-y-1">
                <div className="flex justify-between font-mono text-xs"><span>{tailGroup}</span>
                  <button className="text-muted-foreground hover:text-foreground" onClick={() => setTailGroup(null)}>close</button></div>
                <LiveTail src={`/api/cloudwatch/tail?group=${encodeURIComponent(tailGroup)}`} />
              </div>
            )}

            {pending && (
              <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
                <div className="space-y-3 rounded-none border border-border bg-card p-4 text-sm">
                  <p className="font-mono">{pending.label}?</p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
                    <Button size="sm"
                      onClick={async () => { const p = pending; setPending(null); setError(null); await p.run() }}>Confirm</Button>
                  </div>
                </div>
              </div>
            )}

            <TicketDetail row={detail} onClose={() => setDetail(null)} />
          </div>
        )
      }}
    </PanelShell>
  )
}
