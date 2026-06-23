import { expect, test } from 'vitest'
import {
  matchMr, pipelineForSha, computeReadyToMerge, latestPerEnv, envOnThisTicket,
  suggestNextTag, resolveLogGroup, findStagingJob, isPlayableStagingJob, assembleBoard,
} from './board'
import type { MergeRequest, Deployment, Tag, Pipeline, Job } from './gitlab'

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  iid: 1, title: 't', webUrl: 'u', draft: false, sourceBranch: 'feature/PROJ-1-x',
  state: 'opened', sha: 's1', mergeable: true, project: 'g/p', ...over,
})

test('matchMr finds an MR whose branch contains the key, case-insensitive', () => {
  const mrs = [mr({ iid: 2, sourceBranch: 'feature/proj-1-thing' }), mr({ iid: 3, sourceBranch: 'feature/PROJ-2-y' })]
  expect(matchMr('PROJ-1', mrs)?.iid).toBe(2)
  expect(matchMr('PROJ-9', mrs)).toBeUndefined()
})

test('matchMr prefers an opened MR over a merged one', () => {
  const mrs = [mr({ iid: 5, state: 'merged' }), mr({ iid: 6, state: 'opened' })]
  expect(matchMr('PROJ-1', mrs)?.iid).toBe(6)
})

test('pipelineForSha matches by sha', () => {
  const pl: Pipeline[] = [{ id: 9, status: 'success', ref: 'main', sha: 's1', webUrl: 'w', updatedAt: '', project: 'g/p' }]
  expect(pipelineForSha('s1', pl)?.id).toBe(9)
  expect(pipelineForSha('nope', pl)).toBeUndefined()
})

test('computeReadyToMerge requires approvals met, green pipeline, mergeable', () => {
  expect(computeReadyToMerge(mr(), { required: 2, given: 2 }, 'success')).toBe(true)
  expect(computeReadyToMerge(mr(), { required: 2, given: 1 }, 'success')).toBe(false)
  expect(computeReadyToMerge(mr(), { required: 0, given: 0 }, 'running')).toBe(false)
  expect(computeReadyToMerge(mr({ mergeable: false }), { required: 0, given: 0 }, 'success')).toBe(false)
})

test('latestPerEnv keeps the most recent deployment per environment', () => {
  const deps: Deployment[] = [
    { environment: 'staging', status: 'success', sha: 'a', ref: 'main', deployedAt: '2026-06-20T09:00:00Z' },
    { environment: 'staging', status: 'success', sha: 'b', ref: 'main', deployedAt: '2026-06-21T09:00:00Z' },
    { environment: 'dev', status: 'success', sha: 'c', ref: 'main', deployedAt: '2026-06-20T09:00:00Z' },
  ]
  const out = latestPerEnv(deps)
  expect(out.find((d) => d.environment === 'staging')?.sha).toBe('b')
  expect(out).toHaveLength(2)
})

test('envOnThisTicket true only when MR merged at/before the deploy', () => {
  const dep: Deployment = { environment: 'dev', status: 'success', sha: 'x', ref: 'main', deployedAt: '2026-06-21T10:00:00Z' }
  expect(envOnThisTicket(mr({ state: 'merged', mergedAt: '2026-06-21T09:00:00Z' }), dep)).toBe(true)
  expect(envOnThisTicket(mr({ state: 'merged', mergedAt: '2026-06-21T11:00:00Z' }), dep)).toBe(false)
  expect(envOnThisTicket(mr({ state: 'opened' }), dep)).toBe(false)
})

test('suggestNextTag bumps patch of latest semver, default v0.1.0', () => {
  expect(suggestNextTag([{ name: 'v1.2.3', webUrl: '' }, { name: 'v1.2.0', webUrl: '' }])).toBe('v1.2.4')
  expect(suggestNextTag([])).toBe('v0.1.0')
})

test('resolveLogGroup looks up project:env', () => {
  const map = { 'g/p:staging': '/aws/ecs/p-stg' }
  expect(resolveLogGroup('g/p', 'staging', map)).toBe('/aws/ecs/p-stg')
  expect(resolveLogGroup('g/p', 'dev', map)).toBeUndefined()
})

test('findStagingJob + isPlayableStagingJob', () => {
  const jobs: Job[] = [
    { id: 1, name: 'build', stage: 'build', status: 'success', webUrl: 'w' },
    { id: 2, name: 'deploy:staging', stage: 'deploy', status: 'manual', webUrl: 'w' },
  ]
  const job = findStagingJob(jobs, 'deploy:staging')
  expect(job?.id).toBe(2)
  expect(isPlayableStagingJob(job!, 'success')).toBe(true)
  expect(isPlayableStagingJob(job!, 'running')).toBe(false)
})

test('assembleBoard groups rows by status and correlates a ticket', () => {
  const issues = [
    { key: 'PROJ-1', summary: 'one', status: 'In Progress', statusCategory: 'indeterminate', assignee: 'A', priority: '', updated: '', url: 'j1' },
    { key: 'PROJ-9', summary: 'lonely', status: 'To Do', statusCategory: 'new', assignee: 'B', priority: '', updated: '', url: 'j9' },
  ]
  const projects = [{
    project: 'g/p',
    mrs: [mr({ iid: 7, sourceBranch: 'feature/PROJ-1-x', sha: 's1' })],
    pipelines: [{ id: 4, status: 'success', ref: 'main', sha: 's1', webUrl: 'w', updatedAt: '', project: 'g/p' }] as Pipeline[],
    deployments: [{ environment: 'dev', status: 'success', sha: 'x', ref: 'main', deployedAt: '2026-06-22T00:00:00Z' }],
    tags: [{ name: 'v1.0.0', webUrl: 'tg' }] as Tag[],
  }]
  const mrDetails = [{ project: 'g/p', iid: 7, approvals: { required: 1, given: 1 }, stagingJob: undefined }]
  const board = assembleBoard({ issues, projects, mrDetails, logGroups: {}, canWrite: true, stagingJobName: 'deploy:staging' })

  expect(board.canWrite).toBe(true)
  expect(board.columns.map((c) => c.status)).toEqual(['In Progress', 'To Do'])
  const row = board.columns[0].rows[0]
  expect(row.key).toBe('PROJ-1')
  expect(row.mr?.iid).toBe(7)
  expect(row.mr?.sha).toBe('s1')
  expect(row.mr?.pipelineStatus).toBe('success')
  expect(row.readyToMerge).toBe(true)
  expect(row.suggestedTag).toBe('v1.0.1')
  // PROJ-9 has no MR
  expect(board.columns[1].rows[0].mr).toBeUndefined()
})
