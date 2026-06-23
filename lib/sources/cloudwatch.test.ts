import { expect, test } from 'vitest'
import { mapEvent, isMissingCreds } from './cloudwatch'

test('mapEvent maps raw CloudWatch event', () => {
  expect(mapEvent({ eventId: 'e1', timestamp: 1718000000000, message: 'hello\n' })).toEqual({
    id: 'e1', timestamp: 1718000000000, message: 'hello',
  })
})

test('isMissingCreds detects credential errors', () => {
  expect(isMissingCreds({ name: 'CredentialsProviderError' })).toBe(true)
  expect(isMissingCreds({ name: 'SomethingElse' })).toBe(false)
})
