import { expect, test } from 'vitest'
import { mapPipeline, getPipelines, excludeProjects } from './gitlab'

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
