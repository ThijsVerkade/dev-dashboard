import { expect, test } from 'vitest'
import { parseTailscaleSelfName, buildMobileUrl } from './mobile-url'

test('parseTailscaleSelfName extracts Self.DNSName and strips the trailing dot', () => {
  const raw = JSON.stringify({ Self: { DNSName: 'macbook.tail1234.ts.net.' } })
  expect(parseTailscaleSelfName(raw)).toBe('macbook.tail1234.ts.net')
})

test('parseTailscaleSelfName returns null when DNSName is missing or json is invalid', () => {
  expect(parseTailscaleSelfName(JSON.stringify({ Self: {} }))).toBeNull()
  expect(parseTailscaleSelfName('not json')).toBeNull()
})

test('buildMobileUrl prefers the env base and trims trailing slashes', () => {
  expect(buildMobileUrl({ envBase: 'http://host:3000', tailscaleName: 'x', port: 3000 })).toBe('http://host:3000/m')
  expect(buildMobileUrl({ envBase: 'http://host:3000//' })).toBe('http://host:3000/m')
})

test('buildMobileUrl builds from the tailscale name + port when no env base', () => {
  expect(buildMobileUrl({ tailscaleName: 'macbook.tail1234.ts.net', port: 3000 })).toBe(
    'http://macbook.tail1234.ts.net:3000/m',
  )
  expect(buildMobileUrl({ tailscaleName: 'macbook.tail1234.ts.net' })).toBe('http://macbook.tail1234.ts.net/m')
})

test('buildMobileUrl returns null when neither source is available', () => {
  expect(buildMobileUrl({})).toBeNull()
  expect(buildMobileUrl({ envBase: '   ' })).toBeNull()
})
