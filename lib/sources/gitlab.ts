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
// A pipeline plus its jobs, as returned for a single merge request.
export type PipelineWithJobs = Pipeline & { source?: string; jobs: Job[] }
// A human comment on a merge request (system notes are filtered out).
export type MrNote = {
  id: number; author: string; authorUrl: string; avatarUrl: string
  body: string; createdAt: string; edited: boolean
  resolvable: boolean; resolved: boolean; path?: string
}

export type MergeRequest = {
  iid: number; title: string; webUrl: string; draft: boolean
  sourceBranch: string; state: 'opened' | 'merged' | 'closed'
  sha: string; mergedAt?: string; mergeable: boolean; project: string
}
export type Deployment = { environment: string; status: string; sha: string; ref: string; deployedAt: string }
export type Tag = { name: string; webUrl: string }
export type Approvals = { required: number; given: number }

export function mapMergeRequest(raw: any, project: string): MergeRequest {
  const draft = raw.draft ?? raw.work_in_progress ?? false
  const detailed = raw.detailed_merge_status ?? (raw.merge_status === 'can_be_merged' ? 'mergeable' : raw.merge_status)
  return {
    iid: raw.iid,
    title: raw.title ?? '',
    webUrl: raw.web_url ?? '',
    draft,
    sourceBranch: raw.source_branch ?? '',
    state: raw.state,
    sha: raw.sha ?? '',
    mergedAt: raw.merged_at ?? undefined,
    mergeable: detailed === 'mergeable' && !draft,
    project,
  }
}

export function mapDeployment(raw: any): Deployment {
  return {
    environment: raw.environment?.name ?? '',
    status: raw.status ?? raw.deployable?.status ?? '',
    sha: raw.sha ?? '',
    ref: raw.ref ?? '',
    deployedAt: raw.updated_at ?? raw.created_at ?? '',
  }
}

export function mapTag(raw: any, project: string, host: string): Tag {
  return { name: raw.name, webUrl: `${host}/${project}/-/tags/${encodeURIComponent(raw.name)}` }
}

export function hasApiScope(scopes: string[]): boolean {
  return scopes.includes('api')
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

export function mapJob(raw: any): Job {
  return { id: raw.id, name: raw.name, stage: raw.stage, status: raw.status, webUrl: raw.web_url }
}

export function mapNote(raw: any): MrNote {
  return {
    id: raw.id,
    author: raw.author?.name ?? raw.author?.username ?? 'unknown',
    authorUrl: raw.author?.web_url ?? '',
    avatarUrl: raw.author?.avatar_url ?? '',
    body: raw.body ?? '',
    createdAt: raw.created_at ?? '',
    edited: !!raw.updated_at && raw.updated_at !== raw.created_at,
    resolvable: raw.resolvable ?? false,
    resolved: raw.resolved ?? false,
    path: raw.position?.new_path ?? raw.position?.old_path ?? undefined,
  }
}

// Keep human comments only (drop GitLab system notes like "added 1 commit" and
// empty bodies), oldest first so they read like the MR discussion.
export function toUserNotes(raw: any[]): MrNote[] {
  return raw
    .filter((n) => !n.system && (n.body ?? '').trim().length > 0)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(mapNote)
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

// Project discovery paginates over whole GitLab groups and rarely changes, so
// cache it briefly. This also dedupes the two discovery call sites within a
// single board load (getDiscoveredProjects + getPipelines).
const DISCOVER_TTL_MS = 5 * 60_000
let discoverCache: { value: string[]; expires: number } | null = null

async function discoverProjects(api: ReturnType<typeof client> & {}): Promise<string[]> {
  const now = Date.now()
  if (discoverCache && discoverCache.expires > now) return discoverCache.value

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
  const result = excludeProjects(all, dashboardConfig.gitlabExcludes)
  discoverCache = { value: result, expires: now + DISCOVER_TTL_MS }
  return result
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

// Recent pipelines for a single project. The board uses this to fetch pipelines
// only for sprint-matched projects (instead of every discovered project). perPage
// is generous enough that a matched MR's head-sha pipeline is present.
export async function getProjectPipelines(project: string): Promise<Result<Pipeline[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Pipelines.all(project, { perPage: 20, maxPages: 1 })
    return ok(raw.map((p) => mapPipeline(p, project)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getJobs(projectId: string, pipelineId: number): Promise<Result<Job[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Jobs.all(projectId, { pipelineId })
    return ok(raw.map(mapJob))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

// All pipelines that ran for a single merge request, each with its jobs.
// Uses the MR-scoped endpoint so pipelines are found by MR iid rather than by
// matching a SHA against the globally-capped recent-pipelines list.
export async function getMrPipelines(project: string, iid: number): Promise<Result<PipelineWithJobs[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.MergeRequests.allPipelines(project, iid, { perPage: 20, maxPages: 1 })
    const withJobs = await Promise.all(
      (raw as any[]).map(async (p) => {
        let jobs: Job[] = []
        try {
          const jraw = await api.Jobs.all(project, { pipelineId: p.id })
          jobs = (jraw as any[]).map(mapJob)
        } catch {
          jobs = []
        }
        return { ...mapPipeline(p, project), source: p.source, jobs }
      }),
    )
    return ok(withJobs)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

// Human comments on a merge request, oldest first (system notes excluded).
export async function getMrNotes(project: string, iid: number): Promise<Result<MrNote[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.MergeRequestNotes.all(project, iid, { perPage: 100, maxPages: 1 })
    return ok(toUserNotes(raw as any[]))
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

export async function getDiscoveredProjects(): Promise<Result<string[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  if (dashboardConfig.gitlabProjects.length === 0 && dashboardConfig.gitlabGroups.length === 0)
    return unconfigured('Set GITLAB_GROUPS or GITLAB_PROJECTS in .env.local')
  try {
    return ok(await discoverProjects(api))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getMergeRequests(project: string): Promise<Result<MergeRequest[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const opened = await api.MergeRequests.all({ projectId: project, state: 'opened', targetBranch: 'main', perPage: 100, maxPages: 1 })
    const merged = await api.MergeRequests.all({ projectId: project, state: 'merged', orderBy: 'updated_at', perPage: 50, maxPages: 1 })
    return ok([...opened, ...merged].map((m: any) => mapMergeRequest(m, project)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getDeployments(project: string): Promise<Result<Deployment[]>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Deployments.all(project, { orderBy: 'created_at', sort: 'desc', perPage: 100, maxPages: 1 })
    return ok(raw.map((d: any) => mapDeployment(d)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getTags(project: string): Promise<Result<Tag[]>> {
  const api = client()
  const cfg = env.gitlab()
  if (!api || !cfg) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Tags.all(project, { orderBy: 'updated', sort: 'desc', perPage: 50, maxPages: 1 })
    return ok(raw.map((t: any) => mapTag(t, project, cfg.host)))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export async function getMrApprovals(project: string, iid: number): Promise<Result<Approvals>> {
  const cfg = env.gitlab()
  if (!cfg) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const res = await fetch(
      `${cfg.host}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}/approvals`,
      { headers: { 'PRIVATE-TOKEN': cfg.token } },
    )
    if (!res.ok) return failure(`GitLab ${res.status}`)
    const j = await res.json()
    const required = j.approvals_required ?? 0
    const given = Array.isArray(j.approved_by) ? j.approved_by.length : Math.max(0, required - (j.approvals_left ?? 0))
    return ok({ required, given })
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab request failed')
  }
}

export function isValidNewTag(name: string, existing: Tag[]): { ok: true } | { ok: false; message: string } {
  if (!name.trim()) return { ok: false, message: 'Tag name is required' }
  if (!/^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(name)) return { ok: false, message: `Invalid tag format: ${name}` }
  if (existing.some((t) => t.name === name)) return { ok: false, message: `Tag ${name} already exists` }
  return { ok: true }
}

export async function mergeMr(project: string, iid: number): Promise<Result<true>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    await api.MergeRequests.merge(project, iid)
    return ok(true)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab merge failed')
  }
}

export async function playJob(project: string, jobId: number): Promise<Result<true>> {
  const api = client()
  if (!api) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    await api.Jobs.play(project, jobId)
    return ok(true)
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab job play failed')
  }
}

export async function createTag(project: string, name: string, ref: string): Promise<Result<Tag>> {
  const api = client()
  const cfg = env.gitlab()
  if (!api || !cfg) return unconfigured('Set GITLAB_HOST and GITLAB_TOKEN in .env.local')
  try {
    const raw = await api.Tags.create(project, name, ref)
    return ok(mapTag(raw as any, project, cfg.host))
  } catch (e) {
    return failure(e instanceof Error ? e.message : 'GitLab tag create failed')
  }
}

// Probe token scopes; default to false (no writes) on any failure.
export async function getCanWrite(): Promise<boolean> {
  const cfg = env.gitlab()
  if (!cfg) return false
  try {
    const res = await fetch(`${cfg.host}/api/v4/personal_access_tokens/self`, { headers: { 'PRIVATE-TOKEN': cfg.token } })
    if (!res.ok) return false
    const j = await res.json()
    return Array.isArray(j.scopes) && hasApiScope(j.scopes)
  } catch {
    return false
  }
}
