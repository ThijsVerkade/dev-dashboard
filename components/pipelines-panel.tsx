'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { StatusBadge } from './status-badge'
import { LiveTail } from './live-tail'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Pipeline, Job } from '@/lib/sources/gitlab'

export function PipelinesPanel() {
  const { data, loading } = usePoll<Pipeline[]>('/api/gitlab/pipelines', 30000)
  const [selectedProject, setSelectedProject] = useState('')
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [openJob, setOpenJob] = useState<{ project: string; jobId: number } | null>(null)

  const loadJobs = async (p: Pipeline) => {
    setSelectedProject(p.project)
    setJobs(null)
    setOpenJob(null)
    const res = await fetch(
      `/api/gitlab/pipelines/${p.id}/jobs?project=${encodeURIComponent(p.project)}`,
    )
    const json = await res.json()
    setJobs(json.ok ? json.data : [])
  }

  return (
    <PanelShell title="GitLab Pipelines" result={data} loading={loading}>
      {(pipelines) => (
        <div className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[88px]">status</TableHead>
                <TableHead>pipeline</TableHead>
                <TableHead className="text-right">ref</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pipelines.map((p) => (
                <TableRow key={`${p.project}-${p.id}`}>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto p-0 font-mono text-foreground"
                      onClick={() => loadJobs(p)}
                    >
                      {p.project} #<span className="tabular-nums">{p.id}</span>
                    </Button>
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">{p.ref}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {jobs && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="font-mono text-xs text-muted-foreground">
                jobs · {selectedProject}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[88px]">status</TableHead>
                    <TableHead>stage / job</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell><StatusBadge status={j.status} /></TableCell>
                      <TableCell>
                        <Button
                          variant="link"
                          className="h-auto p-0 font-mono text-foreground"
                          onClick={() => setOpenJob({ project: selectedProject, jobId: j.id })}
                        >
                          {j.stage} / {j.name}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {openJob && (
            <LiveTail
              src={`/api/gitlab/jobs/${openJob.jobId}/trace?project=${encodeURIComponent(openJob.project)}`}
            />
          )}
        </div>
      )}
    </PanelShell>
  )
}
