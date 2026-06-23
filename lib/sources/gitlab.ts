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

// Drop any path equal to an exclude or nested under it (exclude + '/').
export function excludeProjects(paths: string[], excludes: string[]): string[] {
  return paths.filter((p) => !excludes.some((ex) => p === ex || p.startsWith(ex + '/')))
}

function client() {
  const cfg = env.gitlab()
  if (!cfg) return null
  return new Gitlab({ host: cfg.host, token: cfg.token })
}

async function discoverProjects(api: ReturnType<typeof client> & {}): Promise<string[]> {
  const explicit = [...dashboardConfig.gitlabProjects]

  const groupResults = await Promise.all(
    dashboardConfig.gitlabGroups.map(async (group) => {
      const projects = await api.Groups.allProjects(group, {
        includeSubgroups: true,
        archived: false,
        perPage: 100,
        maxPages: 5,
      })
      return projects.map((p: any) => p.path_with_namespace as string)
    }),
  )

  const all = [...new Set([...explicit, ...groupResults.flat()])]
  return excludeProjects(all, dashboardConfig.gitlabExcludes)
}

export async function getPipelines(): Promise<Result<Pipeline[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  if (dashboardConfig.gitlabProjects.length === 0 && dashboardConfig.gitlabGroups.length === 0)
    return unconfigured('Set GITLAB_GROUPS or GITLAB_PROJECTS in .env.local')
  try {
    const projects = await discoverProjects(api)
    const lists = await Promise.all(
      projects.map(async (project) => {
        try {
          const raw = await api.Pipelines.all(project, { perPage: 3, maxPages: 1 })
          return raw.map((p: any) => mapPipeline(p, project))
        } catch {
          return []
        }
      }),
    )
    const all = lists.flat()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 60)
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
