import { expect, test } from 'vitest'
import { buildTriggerHeaders } from './agent-token-client'

test('always includes JSON content-type', () => {
  expect(buildTriggerHeaders(null)['Content-Type']).toBe('application/json')
})

test('omits the token header when there is no token', () => {
  expect('x-agent-token' in buildTriggerHeaders(null)).toBe(false)
  expect('x-agent-token' in buildTriggerHeaders('')).toBe(false)
})

test('attaches the token header when a token is provided', () => {
  expect(buildTriggerHeaders('pin123')['x-agent-token']).toBe('pin123')
})
