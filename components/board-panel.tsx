'use client'
import { useState, useEffect } from 'react'
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
import { Bot, Check, ChevronsUpDown, FlaskConical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Board, BoardColumn, BoardRow } from '@/lib/sources/board'

type Pending = { label: string; run: () => Promise<void> } | null

const ENVS = ['dev', 'acceptance', 'staging', 'production'] as const
const ENV_SHORT: Record<string, string> = { dev: 'D', acceptance: 'A', staging: 'S', production: 'P' }

// Four fixed release-flow stages. Each Jira status column is bucketed into one
// of these by status category + name, so the board always shows 4 side-by-side.
// Done-category columns are bucketed but not rendered (we don't track finished work here).
const STAGES = [
  { id: 'todo', label: 'To Do' },
  { id: 'inprogress', label: 'In Progress' },
  { id: 'review', label: 'Code Review' },
  { id: 'acceptance', label: 'Acceptance' },
] as const

// Returns null for done-category columns — finished work is not tracked on this board.
function classify(col: BoardColumn): (typeof STAGES)[number]['id'] | null {
  if (col.statusCategory === 'done') return null
  if (/review/i.test(col.status)) return 'review'
  if (/accept/i.test(col.status)) return 'acceptance'
  if (col.statusCategory === 'new') return 'todo'
  return 'inprogress'
}

function groupIntoStages(columns: BoardColumn[]): Record<string, BoardRow[]> {
  const out: Record<string, BoardRow[]> = { todo: [], inprogress: [], review: [], acceptance: [] }
  for (const col of columns) {
    const stage = classify(col)
    if (stage) out[stage].push(...col.rows)
  }
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

type AppOption = { name: string; repo: string; baseBranch: string }
type GroupOption = { name: string; apps: AppOption[] }

/**
 * Pick a product group and which app(s) a ticket targets, then dispatch one autonomous
 * Claude agent per repo (each in its own worktree). Pre-selects the group + apps already
 * recorded on the ticket; the selection is written back as `app:<group>/<app>` labels.
 */
function DispatchDialog({ row, onClose, onDone }: { row: BoardRow; onClose: () => void; onDone: (msg: string) => void }) {
  const [groups, setGroups] = useState<GroupOption[] | null>(null)
  const [group, setGroup] = useState<string>('')
  const [sel, setSel] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/agent/apps?key=${encodeURIComponent(row.key)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (!j.ok) { setErr(j.message ?? 'Failed to load apps'); setGroups([]); return }
        const gs: GroupOption[] = j.data.groups ?? []
        setGroups(gs)
        // Recorded labels look like "auction/api"; default to their group, else the first.
        const recorded: string[] = j.data.selected ?? []
        const firstRecordedGroup = recorded[0]?.split('/')[0]
        const initial = gs.find((g) => g.name === firstRecordedGroup)?.name ?? gs[0]?.name ?? ''
        setGroup(initial)
        setSel(recorded.filter((s) => s.startsWith(`${initial}/`)).map((s) => s.slice(initial.length + 1)))
      })
      .catch(() => { if (alive) { setErr('Failed to load apps'); setGroups([]) } })
    return () => { alive = false }
  }, [row.key])

  const activeApps = groups?.find((g) => g.name === group)?.apps ?? []
  const hasGroups = !!groups && groups.length > 0
  const allSelected = activeApps.length > 0 && sel.length === activeApps.length

  const pickGroup = (name: string) => { setGroup(name); setSel([]) }
  const toggle = (name: string) =>
    setSel((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]))
  const toggleAll = () =>
    setSel(allSelected ? [] : activeApps.map((a) => a.name))

  async function dispatch(whole: boolean) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: row.key, group, apps: whole ? [] : sel }),
      })
      const j = await res.json()
      if (j.ok) {
        const n = j.data.ids?.length ?? 0
        onDone(`Dispatched ${row.key} → ${n} agent${n === 1 ? '' : 's'} (see Agents page)`)
        onClose()
      } else {
        setErr(j.message ?? 'Dispatch failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
      <div className="w-[28rem] max-w-[92vw] space-y-3 rounded-none border border-border bg-card p-4 font-mono text-sm">
        <p className="text-foreground">Dispatch <span className="text-primary">{row.key}</span> to Claude</p>
        <p className="text-[11px] text-muted-foreground">
          Autonomous: bypasses permissions, works in an isolated worktree, pushes & opens an MR per repo.
        </p>
        {err && <p className="text-[11px] text-destructive">[ FAIL ] {err}</p>}

        {groups === null ? (
          <p className="text-[11px] text-muted-foreground">loading…</p>
        ) : !hasGroups ? (
          <p className="text-[11px] text-amber-500">
            No groups configured — set AGENT_REPOS (e.g. auction/api@main).
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => pickGroup(g.name)}
                  className={cn(
                    'border px-2 py-1 text-xs',
                    g.name === group ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:bg-muted/40',
                  )}
                >
                  {g.name}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">Which application(s)? Pre-filled from the ticket.</p>
              <button type="button" onClick={toggleAll} className="text-[11px] text-primary underline underline-offset-2">
                {allSelected ? 'clear' : 'select all'}
              </button>
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto border border-border bg-background/60 p-1.5">
              {activeApps.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => toggle(a.name)}
                  className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs hover:bg-muted/40"
                >
                  <Check className={cn('size-3.5 shrink-0', sel.includes(a.name) ? 'opacity-100 text-primary' : 'opacity-0')} />
                  <span className="text-foreground">{a.repo}</span>
                  <span className="ml-auto text-muted-foreground">{a.baseBranch}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" variant="outline" onClick={() => dispatch(true)} disabled={busy || !hasGroups}>
            {busy ? '…' : `Whole ${group || 'group'} (${activeApps.length})`}
          </Button>
          <Button size="sm" onClick={() => dispatch(false)} disabled={busy || !hasGroups || sel.length === 0}>
            {busy ? 'Dispatching…' : `Dispatch ${sel.length || ''}`.trim()}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function BoardPanel() {
  const { data, loading } = usePoll<Board>('/api/board', 30_000)
  const [pending, setPending] = useState<Pending>(null)
  const [tailGroup, setTailGroup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<BoardRow | null>(null)
  const [dispatch, setDispatch] = useState<BoardRow | null>(null)

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
            {notice && <p className="font-mono text-xs text-primary">[  OK  ] {notice}</p>}

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

            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
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
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Send this ticket to a Claude agent (autonomous: pick the target app(s), works in a worktree, pushes & opens an MR)"
                                className="size-5 p-0 text-muted-foreground hover:text-primary"
                                onClick={() => setDispatch(row)}
                              >
                                <Bot className="size-3" />
                              </Button>
                              {stage.id === 'acceptance' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  title="Acceptance-test this ticket on staging (verifies the deploy, then browser-tests it; comments the result on Jira)"
                                  className="size-5 p-0 text-muted-foreground hover:text-primary"
                                  onClick={() => confirm(`Acceptance-test ${row.key} on staging`, async () => {
                                    const err = await post('/api/agent/start', { key: row.key, profile: 'acceptance' })
                                    if (err) setError(err)
                                    else setNotice(`Acceptance test dispatched for ${row.key} → see Agents page`)
                                  })}
                                >
                                  <FlaskConical className="size-3" />
                                </Button>
                              )}
                              <AssigneePicker issueKey={row.key} current={row.assignee} />
                            </div>
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
                      onClick={async () => { const p = pending; setPending(null); setError(null); setNotice(null); await p.run() }}>Confirm</Button>
                  </div>
                </div>
              </div>
            )}

            {dispatch && (
              <DispatchDialog
                row={dispatch}
                onClose={() => setDispatch(null)}
                onDone={(msg) => { setError(null); setNotice(msg) }}
              />
            )}

            <TicketDetail row={detail} onClose={() => setDetail(null)} />
          </div>
        )
      }}
    </PanelShell>
  )
}
