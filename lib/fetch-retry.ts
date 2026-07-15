/**
 * `fetch` with a per-attempt timeout and retry on connection-level failures.
 *
 * The upstream (Jira) has highly variable latency and occasionally the connection
 * drops or hangs — surfacing as undici's `TypeError: fetch failed`. Without a retry
 * that single blip goes straight to the UI as an error. This retries *thrown*
 * errors (network/abort) with a short backoff; it does NOT retry a completed HTTP
 * response, since a 4xx/5xx is an application answer, not a transport failure.
 */
export type FetchWithRetryOptions = {
  /** Number of retries after the first attempt (default 2 → up to 3 tries). */
  retries?: number
  /** Abort a single attempt after this many ms (default 10_000). */
  timeoutMs?: number
  /** Base backoff between attempts in ms (default 300, grows linearly). */
  backoffMs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    timeoutMs = 10_000,
    backoffMs = 300,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = opts

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal })
    } catch (err) {
      lastError = err
      if (attempt < retries) await sleep(backoffMs * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}
