'use client'
import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { LiveTail } from '@/components/live-tail'
import type { BoardRow } from '@/lib/sources/board'
import type { Job, MrNote, PipelineWithJobs } from '@/lib/sources/gitlab'

const shortRef = (r: string) => r.replace('refs/merge-requests/', 'mr!').replace(/\/head$/, '')

// Group jobs by pipeline stage, preserving first-seen order, so the dialog can
// render them left-to-right like a pipeline graph (one column per stage).
function groupByStage(jobs: Job[]): [string, Job[]][] {
  const order: string[] = []
  const map = new Map<string, Job[]>()
  for (const j of jobs) {
    if (!map.has(j.stage)) { order.push(j.stage); map.set(j.stage, []) }
    map.get(j.stage)!.push(j)
  }
  return order.map((s) => [s, map.get(s)!] as [string, Job[]])
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-xs text-foreground">{children}</div>
    </div>
  )
}

export function TicketDetail({ row, onClose }: { row: BoardRow | null; onClose: () => void }) {
  const [pipelines, setPipelines] = useState<PipelineWithJobs[] | null>(null)
  const [pipelinesError, setPipelinesError] = useState<string | null>(null)
  const [notes, setNotes] = useState<MrNote[] | null>(null)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [openJob, setOpenJob] = useState<number | null>(null)
  const [playBusy, setPlayBusy] = useState<number | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)

  useEffect(() => {
    setPipelines(null)
    setPipelinesError(null)
    setNotes(null)
    setNotesError(null)
    setOpenJob(null)
    if (!row?.mr || !row.repo) return
    const project = row.repo.project
    const iid = row.mr.iid
    const q = `?project=${encodeURIComponent(project)}`
    let active = true
    ;(async () => {
      try {
        const res = await fetch(`/api/gitlab/merge_requests/${iid}/pipelines${q}`)
        const json = await res.json()
        if (!active) return
        if (json.ok) setPipelines(json.data)
        else setPipelinesError(json.message ?? 'Failed to load pipelines')
      } catch {
        if (active) setPipelinesError('Failed to load pipelines')
      }
    })()
    ;(async () => {
      try {
        const res = await fetch(`/api/gitlab/merge_requests/${iid}/notes${q}`)
        const json = await res.json()
        if (!active) return
        if (json.ok) setNotes(json.data)
        else setNotesError(json.message ?? 'Failed to load comments')
      } catch {
        if (active) setNotesError('Failed to load comments')
      }
    })()
    return () => { active = false }
  }, [row])

  const mr = row?.mr
  const project = row?.repo?.project

  const play = async (job: Job) => {
    if (!project) return
    if (!window.confirm(`Run manual job ${job.stage} / ${job.name}?`)) return
    setPlayBusy(job.id)
    setPlayError(null)
    try {
      const res = await fetch(`/api/gitlab/jobs/${job.id}/play?project=${encodeURIComponent(project)}`, { method: 'POST' })
      const json = await res.json()
      if (json.ok) {
        setPipelines((cur) => cur && cur.map((p) => ({
          ...p,
          jobs: p.jobs.map((j) => (j.id === job.id ? { ...j, status: 'running' } : j)),
        })))
      } else setPlayError(json.message ?? 'Play failed')
    } catch {
      setPlayError('Play failed')
    } finally {
      setPlayBusy(null)
    }
  }

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] w-[92vw] overflow-x-hidden overflow-y-auto font-mono sm:max-w-3xl">
        {row && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-mono">
                <span className="text-primary">{row.key}</span>
                <StatusBadge status={row.status} />
              </DialogTitle>
              <DialogDescription className="font-mono text-foreground/90">{row.summary}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-3 text-xs">
              <Field label="assignee">{row.assignee}</Field>
              <a className="self-end text-primary hover:underline" href={row.url} target="_blank" rel="noreferrer">open in Jira ↗</a>
              {mr && <a className="self-end text-primary hover:underline" href={mr.webUrl} target="_blank" rel="noreferrer">open MR !{mr.iid} ↗</a>}
            </div>

            {mr ? (
              <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-3">
                <Field label="branch">{mr.sourceBranch} → main</Field>
                <Field label="state">{mr.state}{mr.draft ? ' (draft)' : ''}</Field>
                <Field label="sha">{mr.sha.slice(0, 8)}</Field>
                <Field label="approvals">{mr.approvalsGiven}/{mr.approvalsRequired}</Field>
                <Field label="pipeline">{mr.pipelineStatus ? <StatusBadge status={mr.pipelineStatus} /> : '—'}</Field>
                <Field label="mergeable">{mr.mergeable ? 'yes' : 'no'}</Field>
                <Field label="ready to merge">{row.readyToMerge ? 'yes' : 'no'}</Field>
                {mr.mergedAt && <Field label="merged at">{new Date(mr.mergedAt).toLocaleString()}</Field>}
              </div>
            ) : (
              <p className="border-t border-border pt-3 font-mono text-xs text-muted-foreground">No matching merge request for this ticket.</p>
            )}

            {row.envs.length > 0 && (
              <div className="space-y-1 border-t border-border pt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">environments</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>env</TableHead>
                      <TableHead>state</TableHead>
                      <TableHead>ref</TableHead>
                      <TableHead>deployed</TableHead>
                      <TableHead className="text-right">this ticket</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {row.envs.map((e) => (
                      <TableRow key={e.name}>
                        <TableCell className="font-mono">{e.name}</TableCell>
                        <TableCell className="font-mono text-muted-foreground">{e.state}</TableCell>
                        <TableCell className="font-mono text-muted-foreground"><span className="whitespace-nowrap">{shortRef(e.ref)}</span> <span className="text-muted-foreground/60">{e.sha.slice(0, 8)}</span></TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-muted-foreground">{e.deployedAt ? new Date(e.deployedAt).toLocaleDateString() : '—'}</TableCell>
                        <TableCell className="text-right font-mono">{e.onThisTicket ? <span className="text-primary">✓</span> : '·'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {(row.latestTag || row.suggestedTag) && (
              <div className="flex flex-wrap gap-4 border-t border-border pt-3">
                {row.latestTag && (
                  <Field label="latest tag">
                    <a className="text-primary hover:underline" href={row.latestTag.webUrl} target="_blank" rel="noreferrer">{row.latestTag.name} ↗</a>
                  </Field>
                )}
                {row.suggestedTag && <Field label="suggested next tag">{row.suggestedTag}</Field>}
              </div>
            )}

            {mr && (
              <div className="space-y-3 border-t border-border pt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">pipelines</div>
                {pipelinesError && <p className="font-mono text-xs text-destructive">[ FAIL ] {pipelinesError}</p>}
                {!pipelines && !pipelinesError && (
                  <div className="space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
                )}
                {pipelines && pipelines.length === 0 && !pipelinesError && (
                  <p className="font-mono text-xs text-muted-foreground">No pipelines for this merge request.</p>
                )}
                {pipelines && pipelines.map((pl) => (
                  <div key={pl.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
                      <StatusBadge status={pl.status} />
                      <a className="text-primary hover:underline" href={pl.webUrl} target="_blank" rel="noreferrer">#{pl.id} ↗</a>
                      <span>{pl.sha.slice(0, 8)}</span>
                      {pl.source && <span className="text-muted-foreground/60">{pl.source}</span>}
                    </div>
                    {pl.jobs.length === 0 ? (
                      <p className="font-mono text-xs text-muted-foreground">No jobs.</p>
                    ) : (
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {groupByStage(pl.jobs).map(([stage, stageJobs]) => (
                          <div key={stage} className="flex w-[160px] shrink-0 flex-col gap-1">
                            <div className="border-b border-border pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{stage}</div>
                            {stageJobs.map((j) => (
                              <div key={j.id} className="space-y-1 rounded-none border border-border bg-background/60 p-1.5">
                                <StatusBadge status={j.status} />
                                <div className="truncate font-mono text-[11px]" title={j.name}>{j.name}</div>
                                <div className="flex flex-wrap gap-1">
                                  {j.status === 'manual' && (
                                    <Button size="sm" variant="outline" disabled={playBusy === j.id} className="h-5 px-1.5 text-[10px]"
                                      onClick={() => play(j)}>{playBusy === j.id ? '…' : '▶ run'}</Button>
                                  )}
                                  <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
                                    onClick={() => setOpenJob(openJob === j.id ? null : j.id)}>{openJob === j.id ? 'hide' : 'tail'}</Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {playError && <p className="font-mono text-xs text-destructive">[ FAIL ] {playError}</p>}
                {openJob !== null && project && (
                  <LiveTail src={`/api/gitlab/jobs/${openJob}/trace?project=${encodeURIComponent(project)}`} />
                )}
              </div>
            )}

            {mr && (
              <div className="space-y-2 border-t border-border pt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  comments{notes && notes.length > 0 ? ` (${notes.length})` : ''}
                </div>
                {notesError && <p className="font-mono text-xs text-destructive">[ FAIL ] {notesError}</p>}
                {!notes && !notesError && <Skeleton className="h-4 w-1/2" />}
                {notes && notes.length === 0 && !notesError && (
                  <p className="font-mono text-xs text-muted-foreground">No comments.</p>
                )}
                {notes && notes.map((n) => (
                  <div key={n.id} className="space-y-1 rounded-none border border-border bg-background/60 p-2">
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
                      <a className="text-primary hover:underline" href={n.authorUrl} target="_blank" rel="noreferrer">{n.author}</a>
                      <span>{new Date(n.createdAt).toLocaleString()}</span>
                      {n.edited && <span className="text-muted-foreground/60">(edited)</span>}
                      {n.path && <span className="text-muted-foreground/60">on {n.path}</span>}
                      {n.resolvable && <span className={n.resolved ? 'text-primary' : 'text-destructive'}>{n.resolved ? 'resolved' : 'unresolved'}</span>}
                    </div>
                    <div className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{n.body}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
