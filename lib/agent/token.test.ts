import { afterEach, expect, test } from 'vitest'
import { isAgentRequestAuthorized } from './token'

afterEach(() => {
  delete process.env.AGENT_TRIGGER_TOKEN
})

const h = (token?: string) => new Headers(token ? { 'x-agent-token': token } : {})

test('allows any request when AGENT_TRIGGER_TOKEN is unset', () => {
  expect(isAgentRequestAuthorized(h())).toBe(true)
  expect(isAgentRequestAuthorized(h('whatever'))).toBe(true)
})

test('allows when the header matches the configured token', () => {
  process.env.AGENT_TRIGGER_TOKEN = 's3cret-pin'
  expect(isAgentRequestAuthorized(h('s3cret-pin'))).toBe(true)
})

test('denies when the header is missing', () => {
  process.env.AGENT_TRIGGER_TOKEN = 's3cret-pin'
  expect(isAgentRequestAuthorized(h())).toBe(false)
})

test('denies when the header is wrong, including a different length', () => {
  process.env.AGENT_TRIGGER_TOKEN = 's3cret-pin'
  expect(isAgentRequestAuthorized(h('nope'))).toBe(false)
  expect(isAgentRequestAuthorized(h('s3cret-pi'))).toBe(false)
})
