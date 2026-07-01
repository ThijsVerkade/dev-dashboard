import { describe, it, expect } from 'vitest'
import { reposGateState, createTokenUrl, createJiraTokenUrl } from '@/lib/setup/repos-client'
import type { SetupStatus } from '@/lib/setup/repos'

function status(
  states: Array<'present' | 'missing' | 'present-not-git'>,
  jiraConfigured = true,
): SetupStatus {
  return {
    configured: true,
    root: '/r',
    host: 'https://gl.x',
    jiraConfigured,
    jiraHost: '',
    repos: states.map((state, i) => ({
      group: 'g', app: `a${i}`, repoName: `g/a${i}`, baseBranch: 'main', path: `/r/g/a${i}`, state,
    })),
  }
}

describe('reposGateState', () => {
  it('is complete when all repos are present and Jira is connected', () => {
    expect(reposGateState(status(['present', 'present']))).toBe('complete')
  })
  it('is complete when no repos are configured and Jira is connected', () => {
    expect(reposGateState(status([]))).toBe('complete')
  })
  it('is needs-setup when any repo is missing or not-git', () => {
    expect(reposGateState(status(['present', 'missing']))).toBe('needs-setup')
    expect(reposGateState(status(['present-not-git']))).toBe('needs-setup')
  })
  it('is needs-setup when repos are present but Jira is not connected', () => {
    expect(reposGateState(status(['present', 'present'], false))).toBe('needs-setup')
    expect(reposGateState(status([], false))).toBe('needs-setup')
  })
})

describe('createTokenUrl', () => {
  it('builds a pre-filled PAT URL, trimming a trailing slash', () => {
    expect(createTokenUrl('https://gitlab.bastrucks.com/')).toBe(
      'https://gitlab.bastrucks.com/-/user_settings/personal_access_tokens?name=dev-dashboard&scopes=read_repository',
    )
  })
})

describe('createJiraTokenUrl', () => {
  it('points at the Atlassian API-token page', () => {
    expect(createJiraTokenUrl()).toBe('https://id.atlassian.com/manage-profile/security/api-tokens')
  })
})
