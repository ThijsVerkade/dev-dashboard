import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/dashboard.config', () => ({
  dashboardConfig: {
    agentRepos: { 'auction/api': 'auction/api@main' },
    workspaceDir: '/tmp/root',
    gitlabHost: 'https://gitlab.example.com',
  },
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  // repos.ts (imported transitively) also uses these:
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

import { existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dashboardConfig } from '@/dashboard.config'
import { upsertEnv, saveGitlabToken } from '@/lib/setup/gitlab-token'

const existsMock = vi.mocked(existsSync)
const writeMock = vi.mocked(writeFileSync)
const execMock = vi.mocked(execFileSync)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.GITLAB_HOST
  delete process.env.GITLAB_TOKEN
})

describe('upsertEnv', () => {
  it('appends both keys to empty content', () => {
    const out = upsertEnv('', { GITLAB_HOST: 'https://gl.x', GITLAB_TOKEN: 't' })
    expect(out).toContain('GITLAB_HOST=https://gl.x')
    expect(out).toContain('GITLAB_TOKEN=t')
  })
  it('replaces an existing key and preserves others', () => {
    const out = upsertEnv('FOO=1\nGITLAB_TOKEN=old\n', { GITLAB_TOKEN: 'new' })
    expect(out).toContain('FOO=1')
    expect(out).toContain('GITLAB_TOKEN=new')
    expect(out).not.toContain('old')
  })
})

describe('saveGitlabToken', () => {
  it('does not persist when validation fails', () => {
    execMock.mockImplementation(() => {
      throw Object.assign(new Error('ls-remote failed for secret'), { stderr: 'HTTP 401' })
    })
    const res = saveGitlabToken('https://gl.x', 'secret')
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain('secret')
    expect(writeMock).not.toHaveBeenCalled()
    expect(process.env.GITLAB_TOKEN).toBeUndefined()
    expect(process.env.GITLAB_HOST).toBeUndefined()
  })
  it('validates then persists and sets process.env', () => {
    execMock.mockReturnValue('' as never) // ls-remote succeeds
    existsMock.mockReturnValue(false) // no existing .env.local
    const res = saveGitlabToken('https://gl.x', 'secret')
    expect(res.ok).toBe(true)
    expect(writeMock).toHaveBeenCalledTimes(1)
    const written = String(writeMock.mock.calls[0][1])
    expect(written).toContain('GITLAB_HOST=https://gl.x')
    expect(written).toContain('GITLAB_TOKEN=secret')
    expect(process.env.GITLAB_TOKEN).toBe('secret')
    expect(process.env.GITLAB_HOST).toBe('https://gl.x')
  })
  it('persists without validating when no repos are configured', () => {
    const saved = dashboardConfig.agentRepos
    ;(dashboardConfig as { agentRepos: Record<string, string> }).agentRepos = {}
    try {
      existsMock.mockReturnValue(false)
      const res = saveGitlabToken('https://gl.x', 'secret')
      expect(res.ok).toBe(true)
      expect(execMock).not.toHaveBeenCalled() // no git ls-remote validation
      expect(writeMock).toHaveBeenCalledTimes(1)
    } finally {
      ;(dashboardConfig as { agentRepos: Record<string, string> }).agentRepos = saved
    }
  })
})
