import 'server-only'
import { Gitlab } from '@gitbeaker/rest'
import { env } from '@/lib/env'
import { dashboardConfig } from '@/dashboard.config'
import { Result, ok, unconfigured, failure } from '@/lib/result'

export type Pipeline = {
  id: number; status: string; ref: string; sha: string
  webUrl: string; updatedAt: string; project: string
}
export type Job = {
  id: number; name: string; stage: string; status: string; webUrl: string
}

export function mapPipeline(raw: any, project: string): Pipeline {
  return {
    id: raw.id,
    status: raw.status,
    ref: raw.ref,
    sha: raw.sha,
    webUrl: raw.web_url,
    updatedAt: raw.updated_at,
    project,
  }
}

function client() {
  const cfg = env.gitlab()
  if (!cfg) return null
  return new Gitlab({ host: cfg.host, token: cfg.token })
}

export async function getPipelines(): Promise<Result<Pipeline[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  if (dashboardConfig.gitlabProjects.length === 0)
    return unconfigured('Set GITLAB_PROJECTS in .env.local')
  try {
    const lists = await Promise.all(
      dashboardConfig.gitlabProjects.map(async (project) => {
        const raw = await api.Pipelines.all(project, { perPage: 10, maxPages: 1 })
        return raw.map((p) => mapPipeline(p, project))
      }),
    )
    const all = lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return ok(all)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getJobs(projectId: string, pipelineId: number): Promise<Result<Job[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Jobs.all(projectId, { pipelineId })
    const jobs = raw.map((j: any) => ({
      id: j.id, name: j.name, stage: j.stage, status: j.status, webUrl: j.web_url,
    }))
    return ok(jobs)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getJobTrace(projectId: string, jobId: number): Promise<Result<string>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const trace = await api.Jobs.showLog(projectId, jobId)
    return ok(typeof trace === 'string' ? trace : String(trace))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}
