import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/dashboard.config', () => ({
  dashboardConfig: {
    agentRepos: { 'auction/api': 'auction/api@main', 'lease/api': 'lease/api@main' },
    workspaceDir: '/tmp/root',
    gitlabHost: 'https://gitlab.example.com',
    jiraHost: 'https://acme.atlassian.net',
  },
}))
vi.mock('node:fs', () => ({ existsSync: vi.fn(), mkdirSync: vi.fn(), rmSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

import { existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { getStatus, selectCloneTargets, cloneRepo, installRoot } from '@/lib/setup/repos'

const existsMock = vi.mocked(existsSync)
const execMock = vi.mocked(execFileSync)
const rmMock = vi.mocked(rmSync)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
  delete process.env.JIRA_HOST
  delete process.env.JIRA_EMAIL
  delete process.env.JIRA_TOKEN
})

describe('installRoot', () => {
  it('uses the workspaceDir override', () => {
    expect(installRoot()).toBe('/tmp/root')
  })
})

describe('getStatus', () => {
  it('classifies each configured repo; configured=false without creds', () => {
    existsMock.mockImplementation((p) => String(p).startsWith('/tmp/root/auction/api'))
    const s = getStatus()
    expect(s.configured).toBe(false)
    expect(s.repos.find((r) => r.repoName === 'auction/api')?.state).toBe('present')
    expect(s.repos.find((r) => r.repoName === 'lease/api')?.state).toBe('missing')
  })
  it('configured=true when host and token are set', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 't'
    existsMock.mockReturnValue(false)
    expect(getStatus().configured).toBe(true)
  })
  it('reports jira config: false without all creds, true with host+email+token, plus jiraHost', () => {
    existsMock.mockReturnValue(false)
    expect(getStatus().jiraConfigured).toBe(false)
    expect(getStatus().jiraHost).toBe('https://acme.atlassian.net')
    process.env.JIRA_HOST = 'https://acme.atlassian.net'
    process.env.JIRA_EMAIL = 'a@b.co'
    process.env.JIRA_TOKEN = 't'
    expect(getStatus().jiraConfigured).toBe(true)
  })
  it('includes the configured gitlab host', () => {
    existsMock.mockReturnValue(false)
    expect(getStatus().host).toBe('https://gitlab.example.com')
  })
})

describe('selectCloneTargets', () => {
  it('returns all missing when no name is given', () => {
    existsMock.mockReturnValue(false)
    expect(selectCloneTargets(getStatus()).map((r) => r.repoName)).toEqual(['auction/api', 'lease/api'])
  })
  it('returns only the named repo', () => {
    existsMock.mockReturnValue(false)
    expect(selectCloneTargets(getStatus(), 'lease/api').map((r) => r.repoName)).toEqual(['lease/api'])
  })
})

describe('cloneRepo', () => {
  const entry = { group: 'auction', app: 'api', repoName: 'auction/api', baseBranch: 'main' }
  it('is unconfigured without creds', () => {
    const res = cloneRepo(entry)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toBe('unconfigured')
  })
  it('clones with the token URL, then strips the token from origin', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(false)
    const res = cloneRepo(entry)
    expect(res.ok).toBe(true)
    expect(res.ok === true && typeof res.data.branch).toBe('string')
    const argLists = execMock.mock.calls.map((c) => c[1] as string[])
    expect(argLists[0]).toEqual(['clone', 'https://oauth2:secret@gl.x/auction/api.git', '/tmp/root/auction/api'])
    const setUrl = argLists.find((a) => a.includes('set-url'))
    expect(setUrl).toContain('https://gl.x/auction/api.git')
    expect(JSON.stringify(setUrl)).not.toContain('secret')
  })
  it('redacts the token from clone errors', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(false)
    execMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: git clone https://oauth2:secret@gl.x/auction/api.git'), {
        stderr: 'auth for secret failed',
      })
    })
    const res = cloneRepo(entry)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('secret')
  })
  it('refuses to overwrite an existing directory and does not clone', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(true) // dest already exists
    const res = cloneRepo(entry)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.message).toContain('git repository')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('removes the partial clone (and its leaked token) if set-url fails after cloning', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(false)
    execMock.mockImplementation((_bin, args) => {
      if ((args as string[]).includes('set-url')) throw new Error('set-url failed for secret')
      return '' as never
    })
    const res = cloneRepo(entry)
    expect(res.ok).toBe(false)
    expect(rmMock).toHaveBeenCalledWith('/tmp/root/auction/api', { recursive: true, force: true })
    expect(JSON.stringify(res)).not.toContain('secret')
  })

  it('warns when the requested base branch is not the checked-out branch', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    existsMock.mockReturnValue(false)
    execMock.mockImplementation((_bin, args) => {
      const a = args as string[]
      if (a.includes('rev-parse')) return 'master\n' as never // HEAD ended up on master
      return '' as never
    })
    const res = cloneRepo(entry) // entry.baseBranch === 'main'
    expect(res.ok).toBe(true)
    expect(res.ok === true && res.data.branch).toBe('master')
    expect(res.ok === true && res.data.warning).toContain('main')
  })

  it('force re-clones a present-not-git dir: removes it, then clones', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    // dest exists, but dest/.git does not => present-not-git
    existsMock.mockImplementation((p) => String(p) === '/tmp/root/auction/api')
    const res = cloneRepo(entry, { force: true })
    expect(res.ok).toBe(true)
    expect(rmMock).toHaveBeenCalledWith('/tmp/root/auction/api', { recursive: true, force: true })
    const argLists = execMock.mock.calls.map((c) => c[1] as string[])
    expect(argLists.some((a) => a[0] === 'clone')).toBe(true)
  })

  it('force refuses to delete a valid git repo (present)', () => {
    process.env.GITLAB_HOST = 'https://gl.x'
    process.env.GITLAB_TOKEN = 'secret'
    // both dest and dest/.git exist => present (healthy)
    existsMock.mockReturnValue(true)
    const res = cloneRepo(entry, { force: true })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.message).toContain('git repository')
    expect(rmMock).not.toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled()
  })
})
