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
import type { Pipeline, Job } from '@/lib/sources/gitlab'

const shortRef = (r: string) => r.replace('refs/merge-requests/', 'mr!').replace(/\/head$/, '')

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-xs text-foreground">{children}</div>
    </div>
  )
}

export function TicketDetail({ row, onClose }: { row: BoardRow | null; onClose: () => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [openJob, setOpenJob] = useState<number | null>(null)

  useEffect(() => {
    setJobs(null)
    setJobsError(null)
    setOpenJob(null)
    if (!row?.mr || !row.repo) return
    const project = row.repo.project
    const sha = row.mr.sha
    let active = true
    ;(async () => {
      try {
        const plRes = await fetch('/api/gitlab/pipelines')
        const plJson = await plRes.json()
        if (!plJson.ok) { if (active) setJobsError(plJson.message ?? 'Failed to load pipelines'); return }
        const pl = (plJson.data as Pipeline[]).find((p) => p.project === project && p.sha === sha)
        if (!pl) { if (active) setJobs([]); return }
        const jRes = await fetch(`/api/gitlab/pipelines/${pl.id}/jobs?project=${encodeURIComponent(project)}`)
        const jJson = await jRes.json()
        if (!active) return
        if (jJson.ok) setJobs(jJson.data)
        else setJobsError(jJson.message ?? 'Failed to load jobs')
      } catch {
        if (active) setJobsError('Failed to load jobs')
      }
    })()
    return () => { active = false }
  }, [row])

  const mr = row?.mr
  const project = row?.repo?.project

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
              <div className="space-y-2 border-t border-border pt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">pipeline jobs</div>
                {jobsError && <p className="font-mono text-xs text-destructive">[ FAIL ] {jobsError}</p>}
                {!jobs && !jobsError && (
                  <div className="space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
                )}
                {jobs && jobs.length === 0 && !jobsError && (
                  <p className="font-mono text-xs text-muted-foreground">No pipeline found for {mr.sha.slice(0, 8)}.</p>
                )}
                {jobs && jobs.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[88px]">status</TableHead>
                        <TableHead>stage / job</TableHead>
                        <TableHead className="text-right">trace</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map((j) => (
                        <TableRow key={j.id}>
                          <TableCell><StatusBadge status={j.status} /></TableCell>
                          <TableCell className="font-mono">{j.stage} / {j.name}</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
                              onClick={() => setOpenJob(openJob === j.id ? null : j.id)}>
                              {openJob === j.id ? 'hide' : 'tail'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {openJob !== null && project && (
                  <LiveTail src={`/api/gitlab/jobs/${openJob}/trace?project=${encodeURIComponent(project)}`} />
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
