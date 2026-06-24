import { expect, test } from 'vitest'
import { isAgentProfile, AGENT_PROFILES } from './profiles'

test('isAgentProfile accepts the two known profiles and rejects anything else', () => {
  expect(isAgentProfile('implement')).toBe(true)
  expect(isAgentProfile('acceptance')).toBe(true)
  expect(isAgentProfile('nope')).toBe(false)
  expect(isAgentProfile(undefined)).toBe(false)
  expect(isAgentProfile(123)).toBe(false)
})

test('AGENT_PROFILES has a label for each profile', () => {
  expect(AGENT_PROFILES.implement.label).toBeTruthy()
  expect(AGENT_PROFILES.acceptance.label).toBeTruthy()
})
