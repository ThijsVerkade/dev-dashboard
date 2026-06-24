import { expect, test } from 'vitest'
import {
  mapPipeline, getPipelines, excludeProjects,
  mapMergeRequest, mapDeployment, mapTag, hasApiScope,
  isValidNewTag, mapJob, mapNote, toUserNotes,
  getMrNotes, getMrPipelines,
} from './gitlab'

test('mapPipeline maps raw GitLab pipeline to our shape', () => {
  const raw = {
    id: 101,
    status: 'success',
    ref: 'main',
    sha: 'abc123def456',
    web_url: 'https://gitlab.example.com/g/p/-/pipelines/101',
    updated_at: '2026-06-23T10:00:00Z',
  }
  expect(mapPipeline(raw, 'g/p')).toEqual({
    id: 101,
    status: 'success',
    ref: 'main',
    sha: 'abc123def456',
    webUrl: 'https://gitlab.example.com/g/p/-/pipelines/101',
    updatedAt: '2026-06-23T10:00:00Z',
    project: 'g/p',
  })
})

test('getPipelines reports unconfigured when env missing', async () => {
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
  const r = await getPipelines()
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unconfigured')
})

test('excludeProjects drops an exact match and any nested paths', () => {
  expect(excludeProjects(['a/b', 'a/b/c', 'a/d'], ['a/b'])).toEqual(['a/d'])
})

test('excludeProjects returns all paths when excludes is empty', () => {
  expect(excludeProjects(['a/b', 'a/b/c', 'a/d'], [])).toEqual(['a/b', 'a/b/c', 'a/d'])
})

test('mapMergeRequest normalises fields and computes mergeable', () => {
  const raw = {
    iid: 7, title: 'PROJ-12 add thing', web_url: 'https://gl/x/-/merge_requests/7',
    draft: false, source_branch: 'feature/PROJ-12-add-thing', state: 'opened',
    sha: 'deadbeef', merged_at: null, detailed_merge_status: 'mergeable',
  }
  expect(mapMergeRequest(raw, 'x/y')).toEqual({
    iid: 7, title: 'PROJ-12 add thing', webUrl: 'https://gl/x/-/merge_requests/7',
    draft: false, sourceBranch: 'feature/PROJ-12-add-thing', state: 'opened',
    sha: 'deadbeef', mergedAt: undefined, mergeable: true, project: 'x/y',
  })
})

test('mapMergeRequest is not mergeable when draft or status not mergeable', () => {
  expect(mapMergeRequest({ iid: 1, draft: true, detailed_merge_status: 'mergeable', source_branch: 'b', state: 'opened' }, 'p').mergeable).toBe(false)
  expect(mapMergeRequest({ iid: 1, draft: false, detailed_merge_status: 'ci_still_running', source_branch: 'b', state: 'opened' }, 'p').mergeable).toBe(false)
})

test('mapMergeRequest falls back to legacy merge_status', () => {
  expect(mapMergeRequest({ iid: 1, source_branch: 'b', state: 'opened', merge_status: 'can_be_merged' }, 'p').mergeable).toBe(true)
})

test('mapDeployment reads environment name and timestamps', () => {
  expect(mapDeployment({
    status: 'success', sha: 'abc', ref: 'main',
    created_at: '2026-06-20T10:00:00Z', updated_at: '2026-06-20T10:05:00Z',
    environment: { name: 'staging' },
  })).toEqual({ environment: 'staging', status: 'success', sha: 'abc', ref: 'main', deployedAt: '2026-06-20T10:05:00Z' })
})

test('mapTag builds a web url under the project tags path', () => {
  expect(mapTag({ name: 'v1.2.3' }, 'g/p', 'https://gl')).toEqual({
    name: 'v1.2.3', webUrl: 'https://gl/g/p/-/tags/v1.2.3',
  })
})

test('hasApiScope detects api scope', () => {
  expect(hasApiScope(['read_api', 'api'])).toBe(true)
  expect(hasApiScope(['read_api'])).toBe(false)
})

test('isValidNewTag rejects blank, bad format, and duplicates', () => {
  expect(isValidNewTag('v1.2.3', []).ok).toBe(true)
  expect(isValidNewTag('', []).ok).toBe(false)
  expect(isValidNewTag('not a tag', []).ok).toBe(false)
  expect(isValidNewTag('v1.0.0', [{ name: 'v1.0.0', webUrl: '' }]).ok).toBe(false)
})

test('mapJob maps raw GitLab job to our shape', () => {
  const raw = { id: 9, name: 'All Tests', stage: 'Test', status: 'success', web_url: 'https://gl/x/-/jobs/9' }
  expect(mapJob(raw)).toEqual({ id: 9, name: 'All Tests', stage: 'Test', status: 'success', webUrl: 'https://gl/x/-/jobs/9' })
})

test('mapNote normalises author, edited flag and diff path', () => {
  const raw = {
    id: 377825,
    author: { name: 'Jeramai Faber', username: 'jeramai.faber', web_url: 'https://gl/jeramai.faber', avatar_url: 'https://gl/avatar.png' },
    body: 'looks good',
    created_at: '2026-06-24T05:47:26.011Z',
    updated_at: '2026-06-24T06:00:00.000Z',
    resolvable: true,
    resolved: false,
    position: { new_path: 'src/NoteRepository.php' },
  }
  expect(mapNote(raw)).toEqual({
    id: 377825,
    author: 'Jeramai Faber',
    authorUrl: 'https://gl/jeramai.faber',
    avatarUrl: 'https://gl/avatar.png',
    body: 'looks good',
    createdAt: '2026-06-24T05:47:26.011Z',
    edited: true,
    resolvable: true,
    resolved: false,
    path: 'src/NoteRepository.php',
  })
})

test('mapNote marks unedited note and omits path for non-diff comments', () => {
  const n = mapNote({ id: 1, author: { username: 'bob' }, body: 'hi', created_at: 't', updated_at: 't' })
  expect(n.edited).toBe(false)
  expect(n.path).toBeUndefined()
  expect(n.author).toBe('bob')
})

test('toUserNotes drops system notes and empty bodies, oldest first', () => {
  const raw = [
    { id: 3, system: false, body: 'second', author: { username: 'a' }, created_at: '2026-06-24T05:00:00Z' },
    { id: 2, system: true, body: 'added 1 commit', author: { username: 'a' }, created_at: '2026-06-24T04:30:00Z' },
    { id: 1, system: false, body: 'first', author: { username: 'a' }, created_at: '2026-06-24T04:00:00Z' },
    { id: 4, system: false, body: '   ', author: { username: 'a' }, created_at: '2026-06-24T06:00:00Z' },
  ]
  const out = toUserNotes(raw)
  expect(out.map((n) => n.id)).toEqual([1, 3])
})

test('getMrNotes reports unconfigured when env missing', async () => {
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
  const r = await getMrNotes('g/p', 1)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unconfigured')
})

test('getMrPipelines reports unconfigured when env missing', async () => {
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
  const r = await getMrPipelines('g/p', 1)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unconfigured')
})
