import { expect, test } from 'vitest'
import { isLoopbackHost, loginProfileForEnv, ssoLoginArgs } from './sso-login'

test('isLoopbackHost accepts localhost and loopback IPs, with or without port', () => {
  expect(isLoopbackHost('localhost')).toBe(true)
  expect(isLoopbackHost('localhost:3000')).toBe(true)
  expect(isLoopbackHost('127.0.0.1')).toBe(true)
  expect(isLoopbackHost('127.0.0.1:3000')).toBe(true)
  expect(isLoopbackHost('[::1]')).toBe(true)
  expect(isLoopbackHost('[::1]:3000')).toBe(true)
})

test('isLoopbackHost rejects remote hosts and null', () => {
  expect(isLoopbackHost('dashboard.example.com')).toBe(false)
  expect(isLoopbackHost('192.168.1.10:3000')).toBe(false)
  expect(isLoopbackHost('10.0.0.5')).toBe(false)
  expect(isLoopbackHost(null)).toBe(false)
  expect(isLoopbackHost('')).toBe(false)
})

test('loginProfileForEnv resolves the configured profile or undefined', () => {
  const profiles = { dev: 'platform-dev', stg: 'platform-stg', prod: 'platform-prod' }
  expect(loginProfileForEnv('stg', profiles)).toBe('platform-stg')
  expect(loginProfileForEnv('dev', profiles)).toBe('platform-dev')
  expect(loginProfileForEnv('qa', profiles)).toBeUndefined()
  expect(loginProfileForEnv('', profiles)).toBeUndefined()
})

test('ssoLoginArgs builds a non-interactive profile login invocation', () => {
  expect(ssoLoginArgs('platform-stg')).toEqual(['sso', 'login', '--profile', 'platform-stg'])
})
