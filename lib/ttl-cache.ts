/**
 * A tiny in-memory, per-key TTL cache with in-flight de-duplication.
 *
 * Purpose: upstream sources (Jira, GitLab) are polled every 60s and re-fetched
 * on every navigation, with no caching — each read is a live round-trip. This
 * serves a value for `ttlMs`, and collapses concurrent requests for the same key
 * into a single load, so a slow upstream is hit at most once per key per window.
 *
 * Serves stale-on-error: once a key has a cached value, a later refresh that fails
 * (rejects, or resolves to a value `shouldCache` rejects) yields the last good value
 * instead of the failure — so a transient upstream blip is invisible rather than a
 * hard error. Stale entries are kept and re-attempted on each call until one succeeds.
 *
 * Single-process only (a plain Map) — fine for this single-instance dashboard.
 */
export type TtlCache<T> = {
  /** Return the cached value for `key` if fresh, else run `load`, cache it, and return it. */
  get(key: string, load: () => Promise<T>): Promise<T>
  /** Drop every cached entry (e.g. after a write that invalidates reads). */
  clear(): void
}

type Entry<T> = { value: T; expires: number }

export function createTtlCache<T>(
  ttlMs: number,
  opts: { now?: () => number; shouldCache?: (value: T) => boolean } = {},
): TtlCache<T> {
  const now = opts.now ?? Date.now
  const shouldCache = opts.shouldCache ?? (() => true)
  const store = new Map<string, Entry<T>>()
  const inflight = new Map<string, Promise<T>>()

  function get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = store.get(key)
    if (hit && hit.expires > now()) return Promise.resolve(hit.value)

    const flying = inflight.get(key)
    if (flying) return flying

    const promise = load().then(
      (value) => {
        inflight.delete(key)
        if (shouldCache(value)) {
          store.set(key, { value, expires: now() + ttlMs })
          return value
        }
        // Refresh produced an uncacheable value (e.g. a failure Result): fall back
        // to the last good value if we still have one, else surface the value.
        const stale = store.get(key)
        return stale ? stale.value : value
      },
      (err) => {
        inflight.delete(key)
        // Refresh threw: serve the last good value if we have one, else propagate.
        const stale = store.get(key)
        if (stale) return stale.value
        throw err
      },
    )
    inflight.set(key, promise)
    return promise
  }

  function clear(): void {
    store.clear()
    inflight.clear()
  }

  return { get, clear }
}
