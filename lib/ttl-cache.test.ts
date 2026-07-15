import { expect, test, vi } from 'vitest'
import { createTtlCache } from './ttl-cache'

test('serves a cached value within the TTL without calling the loader again', async () => {
  let now = 1000
  const cache = createTtlCache<number>(100, { now: () => now })
  const load = vi.fn(async () => 42)

  expect(await cache.get('k', load)).toBe(42)
  now = 1099 // still within 100ms window
  expect(await cache.get('k', load)).toBe(42)
  expect(load).toHaveBeenCalledTimes(1)
})

test('reloads once the TTL has elapsed', async () => {
  let now = 1000
  const cache = createTtlCache<number>(100, { now: () => now })
  const load = vi.fn(async () => now)

  expect(await cache.get('k', load)).toBe(1000)
  now = 1101 // past the 100ms window
  expect(await cache.get('k', load)).toBe(1101)
  expect(load).toHaveBeenCalledTimes(2)
})

test('keys are independent', async () => {
  const cache = createTtlCache<string>(1000, { now: () => 0 })
  expect(await cache.get('a', async () => 'A')).toBe('A')
  expect(await cache.get('b', async () => 'B')).toBe('B')
})

test('de-duplicates concurrent loads for the same key into one call', async () => {
  const cache = createTtlCache<number>(1000, { now: () => 0 })
  let resolve!: (v: number) => void
  const load = vi.fn(() => new Promise<number>((r) => { resolve = r }))

  const first = cache.get('k', load)
  const second = cache.get('k', load)
  resolve(7)

  expect(await first).toBe(7)
  expect(await second).toBe(7)
  expect(load).toHaveBeenCalledTimes(1)
})

test('does not cache a value the shouldCache predicate rejects', async () => {
  const cache = createTtlCache<{ ok: boolean }>(1000, {
    now: () => 0,
    shouldCache: (v) => v.ok,
  })
  const load = vi.fn(async () => ({ ok: false }))

  await cache.get('k', load)
  await cache.get('k', load)
  expect(load).toHaveBeenCalledTimes(2) // failures are never cached
})

test('does not cache a rejected load and lets the next call retry', async () => {
  const cache = createTtlCache<number>(1000, { now: () => 0 })
  const load = vi
    .fn<() => Promise<number>>()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(5)

  await expect(cache.get('k', load)).rejects.toThrow('boom')
  expect(await cache.get('k', load)).toBe(5)
  expect(load).toHaveBeenCalledTimes(2)
})

test('serves the last good value when a later refresh returns an uncacheable failure', async () => {
  let now = 0
  const cache = createTtlCache<{ ok: boolean; v: number }>(100, {
    now: () => now,
    shouldCache: (r) => r.ok,
  })
  const good = { ok: true, v: 1 }
  const bad = { ok: false, v: -1 }

  expect(await cache.get('k', async () => good)).toBe(good)
  now = 200 // expire the good entry
  expect(await cache.get('k', async () => bad)).toBe(good) // stale-on-error, not the failure
})

test('serves the last good value when a later refresh throws', async () => {
  let now = 0
  const cache = createTtlCache<number>(100, { now: () => now })

  expect(await cache.get('k', async () => 7)).toBe(7)
  now = 200 // expire
  expect(await cache.get('k', async () => { throw new Error('down') })).toBe(7)
})

test('clear() drops cached entries so the next call reloads', async () => {
  const cache = createTtlCache<number>(1000, { now: () => 0 })
  const load = vi.fn(async () => 1)

  await cache.get('k', load)
  cache.clear()
  await cache.get('k', load)
  expect(load).toHaveBeenCalledTimes(2)
})
