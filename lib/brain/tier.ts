import type { Tier } from './types'

/**
 * Infer a repo's tier from its app name. Order matters: "bff" is checked before
 * "fe" because a frontend-BFF ("fe-bff") is a BFF, not a frontend.
 */
export function inferTier(app: string): Tier {
  const name = app.toLowerCase()
  if (name.includes('bff')) return 'bff'
  if (name === 'api' || name.includes('api')) return 'api'
  if (name.includes('fe')) return 'frontend'
  return 'unknown'
}
