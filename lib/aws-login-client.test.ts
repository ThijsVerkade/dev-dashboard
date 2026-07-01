import { expect, test } from 'vitest'
import { gateEnv, nextGateState } from './aws-login-client'
import { ok, unconfigured, failure } from './result'

test('gateEnv prefers dev, else first configured env, else undefined', () => {
  expect(gateEnv(['stg', 'dev', 'prod'])).toBe('dev')
  expect(gateEnv(['stg', 'prod'])).toBe('stg')
  expect(gateEnv([])).toBeUndefined()
})

test('nextGateState maps a Result to a gate status', () => {
  expect(nextGateState(ok({}))).toBe('authed')
  expect(nextGateState(unconfigured('no creds'))).toBe('needs-login')
  expect(nextGateState(failure('boom'))).toBe('error')
})
