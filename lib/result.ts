export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'unconfigured' | 'error'; message: string }

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function unconfigured(message: string): Result<never> {
  return { ok: false, reason: 'unconfigured', message }
}

export function failure(message: string): Result<never> {
  return { ok: false, reason: 'error', message }
}
