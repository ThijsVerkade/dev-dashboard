import { expect, test } from 'vitest'
import { mapEvent, isMissingCreds, parseServiceName, serviceLabel } from './cloudwatch'

test('mapEvent maps raw CloudWatch event', () => {
  expect(mapEvent({ eventId: 'e1', timestamp: 1718000000000, message: 'hello\n' })).toEqual({
    id: 'e1', timestamp: 1718000000000, message: 'hello',
  })
})

test('isMissingCreds detects credential errors', () => {
  expect(isMissingCreds({ name: 'CredentialsProviderError' })).toBe(true)
  expect(isMissingCreds({ name: 'SomethingElse' })).toBe(false)
})

test('parseServiceName splits domain, service, env', () => {
  expect(parseServiceName('auction-erp-bff-dev')).toEqual({ domain: 'auction', service: 'erp-bff', env: 'dev' })
  expect(parseServiceName('auction-api-dev')).toEqual({ domain: 'auction', service: 'api', env: 'dev' })
  expect(parseServiceName('auction-frontend-stg')).toEqual({ domain: 'auction', service: 'frontend', env: 'stg' })
})

test('parseServiceName leaves env undefined when no env suffix', () => {
  expect(parseServiceName('auction-api')).toEqual({ domain: 'auction', service: 'api', env: undefined })
})

test('serviceLabel maps known services and passes through unknown', () => {
  expect(serviceLabel('frontend')).toBe('fe')
  expect(serviceLabel('erp-frontend')).toBe('fe-erp')
  expect(serviceLabel('erp-bff')).toBe('bff-erp')
  expect(serviceLabel('bff')).toBe('bff')
  expect(serviceLabel('api')).toBe('api')
  expect(serviceLabel('worker')).toBe('worker')
})
