'use client'
import { useState } from 'react'
import { usePoll } from '@/lib/use-poll'
import { PanelShell } from './panel-shell'
import { StatusBadge } from './status-badge'
import { LiveTail } from './live-tail'
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
        <div className="space-y-2">
          {pipelines.map((p) => (
            <div key={`${p.project}-${p.id}`} className="flex items-center gap-2 text-sm">
              <StatusBadge status={p.status} />
              <button className="underline" onClick={() => loadJobs(p)}>
                {p.project} #{p.id} ({p.ref})
              </button>
            </div>
          ))}
          {jobs && (
            <div className="mt-3 space-y-1 border-t pt-2 text-sm">
              {jobs.map((j) => (
                <div key={j.id} className="flex items-center gap-2">
                  <StatusBadge status={j.status} />
                  <button className="underline"
                    onClick={() => setOpenJob({ project: selectedProject, jobId: j.id })}>
                    {j.stage} / {j.name}
                  </button>
                </div>
              ))}
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
