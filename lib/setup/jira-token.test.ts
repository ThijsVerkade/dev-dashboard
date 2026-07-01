import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/dashboard.config', () => ({
  dashboardConfig: { agentRepos: {}, workspaceDir: '/tmp/root', gitlabHost: 'https://gl.x', jiraHost: '' },
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

import { existsSync, writeFileSync } from 'node:fs'
import { validateJiraCreds, saveJiraCreds } from '@/lib/setup/jira-token'

const existsMock = vi.mocked(existsSync)
const writeMock = vi.mocked(writeFileSync)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.JIRA_HOST
  delete process.env.JIRA_EMAIL
  delete process.env.JIRA_TOKEN
})

describe('validateJiraCreds', () => {
  it('is ok when /myself returns 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    const res = await validateJiraCreds('https://acme.atlassian.net', 'a@b.co', 't')
    expect(res.ok).toBe(true)
  })
  it('fails clearly on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const res = await validateJiraCreds('https://acme.atlassian.net', 'a@b.co', 'bad')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.message).toContain('rejected')
  })
})

describe('saveJiraCreds', () => {
  it('does not persist when validation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const res = await saveJiraCreds('https://acme.atlassian.net', 'a@b.co', 'bad')
    expect(res.ok).toBe(false)
    expect(writeMock).not.toHaveBeenCalled()
    expect(process.env.JIRA_TOKEN).toBeUndefined()
    expect(process.env.JIRA_HOST).toBeUndefined()
  })
  it('validates then persists all three vars and sets process.env', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    existsMock.mockReturnValue(false)
    const res = await saveJiraCreds('https://acme.atlassian.net', 'a@b.co', 'good')
    expect(res.ok).toBe(true)
    expect(writeMock).toHaveBeenCalledTimes(1)
    const written = String(writeMock.mock.calls[0][1])
    expect(written).toContain('JIRA_HOST=https://acme.atlassian.net')
    expect(written).toContain('JIRA_EMAIL=a@b.co')
    expect(written).toContain('JIRA_TOKEN=good')
    expect(process.env.JIRA_TOKEN).toBe('good')
    expect(process.env.JIRA_EMAIL).toBe('a@b.co')
    expect(process.env.JIRA_HOST).toBe('https://acme.atlassian.net')
  })
  it('requires all three fields', async () => {
    const res = await saveJiraCreds('https://acme.atlassian.net', '', 't')
    expect(res.ok).toBe(false)
    expect(writeMock).not.toHaveBeenCalled()
  })
})
