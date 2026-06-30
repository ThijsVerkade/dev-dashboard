import { expect, test } from 'vitest'
import { agentGroups, reposForGroup, resolveGroupRepo, parseEnvMapEq } from '@/dashboard.config'

// Shorthand (no ":value") and explicit-override entries coexist.
const MAP = {
  'auction/api': 'auction/api@main',
  'auction/fe': 'auction/fe@main',
  'lease/api': 'lease/api@main',
  'lease/fe-bff': 'lease/custom-bff@develop', // explicit override: repo + branch differ
}

test('agentGroups derives distinct groups in first-seen order', () => {
  expect(agentGroups(MAP)).toEqual(['auction', 'lease'])
})

test('agentGroups honours an explicit order when given', () => {
  expect(agentGroups(MAP, ['lease', 'auction'])).toEqual(['lease', 'auction'])
})

test('agentGroups ignores ordered names that have no repos', () => {
  expect(agentGroups(MAP, ['lease', 'ghost', 'auction'])).toEqual(['lease', 'auction'])
})

test('reposForGroup lists a group apps, sorted; empty for unknown group', () => {
  expect(reposForGroup('auction', MAP)).toEqual(['api', 'fe'])
  expect(reposForGroup('lease', MAP)).toEqual(['api', 'fe-bff'])
  expect(reposForGroup('nope', MAP)).toEqual([])
})

test('resolveGroupRepo returns the spec for a group+app, else undefined', () => {
  expect(resolveGroupRepo('auction', 'api', MAP)).toBe('auction/api@main')
  expect(resolveGroupRepo('lease', 'fe-bff', MAP)).toBe('lease/custom-bff@develop')
  expect(resolveGroupRepo('auction', 'ghost', MAP)).toBeUndefined()
  expect(resolveGroupRepo('ghost', 'api', MAP)).toBeUndefined()
})

test('parseEnvMapEq parses key=value pairs', () => {
  expect(parseEnvMapEq('dev=auction-dev,stg=auction-stg')).toEqual({
    dev: 'auction-dev',
    stg: 'auction-stg',
  })
})

test('parseEnvMapEq keeps colons inside the value', () => {
  expect(parseEnvMapEq('prod=role:arn:partition')).toEqual({ prod: 'role:arn:partition' })
})

test('parseEnvMapEq returns empty for undefined', () => {
  expect(parseEnvMapEq(undefined)).toEqual({})
})
