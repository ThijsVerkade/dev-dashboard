import { expect, test } from 'vitest'
import { ok, unconfigured, failure } from './result'

test('ok wraps data', () => {
  expect(ok(42)).toEqual({ ok: true, data: 42 })
})

test('unconfigured carries reason and message', () => {
  expect(unconfigured('set GITLAB_TOKEN')).toEqual({
    ok: false, reason: 'unconfigured', message: 'set GITLAB_TOKEN',
  })
})

test('failure carries error reason', () => {
  expect(failure('boom')).toEqual({ ok: false, reason: 'error', message: 'boom' })
})
