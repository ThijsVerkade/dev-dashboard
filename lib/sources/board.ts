import 'server-only'
import { getActiveSprint } from './jira'
import {
  getDiscoveredProjects, getMergeRequests, getDeployments, getTags,
  getMrApprovals, getCanWrite, getJobs, getPipelines,
} from './gitlab'
import { dashboardConfig } from '@/dashboard.config'
import { ok, type Result } from '@/lib/result'
import type { Issue } from './jira'
import type { MergeRequest, Deployment, Tag, Approvals, Pipeline, Job } from './gitlab'

export type BoardEnv = {
  name: string; state: string; sha: string; ref: string; deployedAt: string
  onThisTicket: boolean; logGroup?: string
}
export type BoardRow = {
  key: string; summary: string; assignee: string; status: string; url: string
  repo?: { project: string; webUrl: string }
  mr?: {
    iid: number; title: string; webUrl: string; draft: boolean; sourceBranch: string; sha: string
    state: 'opened' | 'merged' | 'closed'
    approvalsRequired: number; approvalsGiven: number
    pipelineStatus?: string; mergeable: boolean; mergedAt?: string
  }
  readyToMerge: boolean
  stagingJob?: { id: number; status: string; playable: boolean }
  envs: BoardEnv[]
  latestTag?: { name: string; webUrl: string }
  suggestedTag?: string
}
export type BoardColumn = { status: string; statusCategory: string; rows: BoardRow[] }
export type Board = { columns: BoardColumn[]; canWrite: boolean }

export type ProjectData = {
  project: string; mrs: MergeRequest[]; pipelines: Pipeline[]; deployments: Deployment[]; tags: Tag[]
}
export type MrDetail = { project: string; iid: number; approvals: Approvals; stagingJob?: Job }

export function matchMr(key: string, mrs: MergeRequest[]): MergeRequest | undefined {
  const k = key.toUpperCase()
  const hits = mrs.filter((m) => m.sourceBranch.toUpperCase().includes(k))
  if (hits.length === 0) return undefined
  // Prefer an opened MR; otherwise the first (lists are newest-first).
  return hits.find((m) => m.state === 'opened') ?? hits[0]
}

export function pipelineForSha(sha: string, pipelines: Pipeline[]): Pipeline | undefined {
  return pipelines.find((p) => p.sha === sha)
}

export function computeReadyToMerge(mr: MergeRequest, approvals: Approvals, pipelineStatus?: string): boolean {
  return mr.mergeable && approvals.given >= approvals.required && pipelineStatus === 'success'
}

export function latestPerEnv(deps: Deployment[]): Deployment[] {
  const byEnv = new Map<string, Deployment>()
  for (const d of deps) {
    const cur = byEnv.get(d.environment)
    if (!cur || d.deployedAt > cur.deployedAt) byEnv.set(d.environment, d)
  }
  return [...byEnv.values()]
}

export function envOnThisTicket(mr: MergeRequest | undefined, dep: Deployment): boolean {
  if (!mr || mr.state !== 'merged' || !mr.mergedAt || !dep.deployedAt) return false
  return mr.mergedAt <= dep.deployedAt
}

export function suggestNextTag(tags: Tag[]): string {
  const semver = /^v?(\d+)\.(\d+)\.(\d+)$/
  for (const t of tags) {
    const m = t.name.match(semver)
    if (m) return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`
  }
  return 'v0.1.0'
}

export function resolveLogGroup(project: string, env: string, map: Record<string, string>): string | undefined {
  return map[`${project}:${env}`]
}

export function findStagingJob(jobs: Job[], name: string): Job | undefined {
  return jobs.find((j) => j.name === name)
}

export function isPlayableStagingJob(job: Job, pipelineStatus?: string): boolean {
  return pipelineStatus === 'success' && job.status === 'manual'
}

export function assembleBoard(args: {
  issues: Issue[]
  projects: ProjectData[]
  mrDetails: MrDetail[]
  logGroups: Record<string, string>
  canWrite: boolean
  stagingJobName: string
}): Board {
  const { issues, projects, mrDetails } = args
  const allMrs = projects.flatMap((p) => p.mrs)
  const byProject = new Map(projects.map((p) => [p.project, p]))

  const rows: BoardRow[] = issues.map((issue) => {
    const matched = matchMr(issue.key, allMrs)
    const base: BoardRow = {
      key: issue.key, summary: issue.summary, assignee: issue.assignee,
      status: issue.status, url: issue.url, readyToMerge: false, envs: [],
    }
    if (!matched) return base

    const pd = byProject.get(matched.project)
    const pipeline = pd ? pipelineForSha(matched.sha, pd.pipelines) : undefined
    const detail = mrDetails.find((d) => d.project === matched.project && d.iid === matched.iid)
    const approvals = detail?.approvals ?? { required: 0, given: 0 }

    const envs: BoardEnv[] = pd
      ? latestPerEnv(pd.deployments).map((d) => ({
          name: d.environment, state: d.status, sha: d.sha, ref: d.ref, deployedAt: d.deployedAt,
          onThisTicket: envOnThisTicket(matched, d),
          logGroup: resolveLogGroup(matched.project, d.environment, args.logGroups),
        }))
      : []

    const stagingJob = detail?.stagingJob
      ? { id: detail.stagingJob.id, status: detail.stagingJob.status, playable: isPlayableStagingJob(detail.stagingJob, pipeline?.status) }
      : undefined

    return {
      ...base,
      repo: { project: matched.project, webUrl: matched.webUrl },
      mr: {
        iid: matched.iid, title: matched.title, webUrl: matched.webUrl, draft: matched.draft,
        sourceBranch: matched.sourceBranch, sha: matched.sha, state: matched.state,
        approvalsRequired: approvals.required, approvalsGiven: approvals.given,
        pipelineStatus: pipeline?.status, mergeable: matched.mergeable, mergedAt: matched.mergedAt,
      },
      readyToMerge: computeReadyToMerge(matched, approvals, pipeline?.status),
      stagingJob,
      envs,
      latestTag: pd?.tags[0],
      suggestedTag: pd ? suggestNextTag(pd.tags) : undefined,
    }
  })

  // Group into columns, preserving first-seen status order.
  const order: string[] = []
  const cols = new Map<string, BoardColumn>()
  for (const issue of issues) {
    if (!cols.has(issue.status)) {
      order.push(issue.status)
      cols.set(issue.status, { status: issue.status, statusCategory: issue.statusCategory, rows: [] })
    }
  }
  for (const row of rows) cols.get(row.status)!.rows.push(row)
  return { columns: order.map((s) => cols.get(s)!), canWrite: args.canWrite }
}

export async function getBoard(): Promise<Result<Board>> {
  const sprint = await getActiveSprint()
  if (!sprint.ok) return sprint

  const projectsRes = await getDiscoveredProjects()
  if (!projectsRes.ok) return projectsRes

  const pipelinesRes = await getPipelines()
  const allPipelines = pipelinesRes.ok ? pipelinesRes.data : []

  // Per project: MRs, deployments, tags. Failures degrade to empty for that project.
  const projects: ProjectData[] = await Promise.all(
    projectsRes.data.map(async (project) => {
      const [mrs, deployments, tags] = await Promise.all([getMergeRequests(project), getDeployments(project), getTags(project)])
      return {
        project,
        mrs: mrs.ok ? mrs.data : [],
        pipelines: allPipelines.filter((p) => p.project === project),
        deployments: deployments.ok ? deployments.data : [],
        tags: tags.ok ? tags.data : [],
      }
    }),
  )

  // For only the MRs matched to a sprint ticket, fetch approvals + staging job (bounded by sprint size).
  const allMrs = projects.flatMap((p) => p.mrs)
  const matched = sprint.data
    .map((issue) => matchMr(issue.key, allMrs))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
  const uniqueMatched = [...new Map(matched.map((m) => [`${m.project}#${m.iid}`, m])).values()]

  const mrDetails: MrDetail[] = await Promise.all(
    uniqueMatched.map(async (m) => {
      const approvalsRes = await getMrApprovals(m.project, m.iid)
      const pd = projects.find((p) => p.project === m.project)
      const pipeline = pd ? pipelineForSha(m.sha, pd.pipelines) : undefined
      let stagingJob
      if (pipeline) {
        const jobsRes = await getJobs(m.project, pipeline.id)
        if (jobsRes.ok) stagingJob = findStagingJob(jobsRes.data, dashboardConfig.stagingJobName)
      }
      return {
        project: m.project, iid: m.iid,
        approvals: approvalsRes.ok ? approvalsRes.data : { required: 0, given: 0 },
        stagingJob,
      }
    }),
  )

  const canWrite = await getCanWrite()
  return ok(assembleBoard({
    issues: sprint.data, projects, mrDetails,
    logGroups: dashboardConfig.cloudwatchLogGroups, canWrite,
    stagingJobName: dashboardConfig.stagingJobName,
  }))
}
