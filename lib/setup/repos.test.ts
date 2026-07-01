import { describe, it, expect } from 'vitest'
import {
  bareHost, buildCloneUrl, cleanRemoteUrl, redactToken, classifyState, parseAgentRepos,
} from '@/lib/setup/repos'

describe('bareHost', () => {
  it('strips scheme and trailing slash', () => {
    expect(bareHost('https://gitlab.example.com/')).toBe('gitlab.example.com')
    expect(bareHost('http://gl.local')).toBe('gl.local')
  })
})

describe('buildCloneUrl / cleanRemoteUrl', () => {
  it('embeds the token, then produces a clean url', () => {
    expect(buildCloneUrl('https://gitlab.example.com', 'glpat-x', 'auction/api'))
      .toBe('https://oauth2:glpat-x@gitlab.example.com/auction/api.git')
    expect(cleanRemoteUrl('https://gitlab.example.com', 'auction/api'))
      .toBe('https://gitlab.example.com/auction/api.git')
  })
})

describe('redactToken', () => {
  it('replaces every occurrence of the token', () => {
    expect(redactToken('clone https://oauth2:glpat-x@h/r.git glpat-x', 'glpat-x'))
      .toBe('clone https://oauth2:***@h/r.git ***')
  })
  it('is a no-op for an empty token', () => {
    expect(redactToken('nothing', '')).toBe('nothing')
  })
})

describe('classifyState', () => {
  it('maps existence checks to a state', () => {
    expect(classifyState(false, false)).toBe('missing')
    expect(classifyState(true, false)).toBe('present-not-git')
    expect(classifyState(true, true)).toBe('present')
  })
})

describe('parseAgentRepos', () => {
  it('parses group/app + branch, sorted by repoName', () => {
    const map = { 'lease/api': 'lease/api@develop', 'auction/api': 'auction/api@main' }
    expect(parseAgentRepos(map)).toEqual([
      { group: 'auction', app: 'api', repoName: 'auction/api', baseBranch: 'main' },
      { group: 'lease', app: 'api', repoName: 'lease/api', baseBranch: 'develop' },
    ])
  })
  it('defaults the branch to main', () => {
    expect(parseAgentRepos({ 'auction/api': 'auction/api' })[0].baseBranch).toBe('main')
  })
})
