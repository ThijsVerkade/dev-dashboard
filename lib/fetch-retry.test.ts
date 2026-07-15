import { expect, test, vi } from 'vitest'
import { fetchWithRetry } from './fetch-retry'

const noSleep = () => Promise.resolve()
const res = (status = 200) => new Response('{}', { status })

test('returns the response on first success without retrying', async () => {
  const fetchImpl = vi.fn(async () => res())
  const out = await fetchWithRetry('http://x', {}, { fetchImpl, sleep: noSleep })
  expect(out.status).toBe(200)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('retries after a thrown connection error and succeeds', async () => {
  const fetchImpl = vi
    .fn<() => Promise<Response>>()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(res())
  const out = await fetchWithRetry('http://x', {}, { fetchImpl, retries: 2, sleep: noSleep })
  expect(out.status).toBe(200)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test('rethrows the last error after exhausting retries', async () => {
  const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
  await expect(
    fetchWithRetry('http://x', {}, { fetchImpl, retries: 2, sleep: noSleep }),
  ).rejects.toThrow('fetch failed')
  expect(fetchImpl).toHaveBeenCalledTimes(3) // initial + 2 retries
})

test('does not retry a completed HTTP response, even an error status', async () => {
  const fetchImpl = vi.fn(async () => res(500))
  const out = await fetchWithRetry('http://x', {}, { fetchImpl, retries: 2, sleep: noSleep })
  expect(out.status).toBe(500)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('passes an abort signal to fetch so a hung request can time out', async () => {
  let seenSignal: AbortSignal | undefined
  const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined
    return res()
  })
  await fetchWithRetry('http://x', {}, { fetchImpl, timeoutMs: 50, sleep: noSleep })
  expect(seenSignal).toBeInstanceOf(AbortSignal)
})

test('preserves caller-provided init (method, headers, body)', async () => {
  let seenInit: RequestInit | undefined
  const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    seenInit = init
    return res()
  })
  await fetchWithRetry(
    'http://x',
    { method: 'POST', headers: { Accept: 'application/json' }, body: '{"a":1}' },
    { fetchImpl, sleep: noSleep },
  )
  expect(seenInit?.method).toBe('POST')
  expect((seenInit?.headers as Record<string, string>).Accept).toBe('application/json')
  expect(seenInit?.body).toBe('{"a":1}')
})
