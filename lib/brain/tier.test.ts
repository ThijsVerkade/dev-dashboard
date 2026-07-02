import { describe, it, expect } from 'vitest'
import { inferTier } from './tier'

describe('inferTier', () => {
  it('maps api apps', () => {
    expect(inferTier('api')).toBe('api')
  })
  it('maps bff apps (bff wins over fe in "fe-bff")', () => {
    expect(inferTier('web-bff')).toBe('bff')
    expect(inferTier('bff-erp')).toBe('bff')
    expect(inferTier('fe-bff')).toBe('bff')
  })
  it('maps frontend apps', () => {
    expect(inferTier('fe')).toBe('frontend')
    expect(inferTier('fe-erp')).toBe('frontend')
    expect(inferTier('app-fe')).toBe('frontend')
  })
  it('falls back to unknown', () => {
    expect(inferTier('inventory-capture-ext')).toBe('unknown')
  })
})
