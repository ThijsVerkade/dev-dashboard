import { describe, it, expect } from 'vitest'
import { mergeAutoBlock, AUTO_START, AUTO_END } from './auto-block'

describe('mergeAutoBlock', () => {
  it('creates a new body with auto block + stub when none exists', () => {
    const { body, warned } = mergeAutoBlock(null, '## Stack\n- NestJS', '## What this does\nTODO')
    expect(body).toBe(`${AUTO_START}\n## Stack\n- NestJS\n${AUTO_END}\n\n## What this does\nTODO`)
    expect(warned).toBe(false)
  })

  it('replaces only the auto block, preserving prose above and below', () => {
    const existing = `intro\n${AUTO_START}\nOLD\n${AUTO_END}\n\n## What this does\nMy prose`
    const { body, warned } = mergeAutoBlock(existing, '## Stack\n- New', '## What this does\nTODO')
    expect(body).toBe(`intro\n${AUTO_START}\n## Stack\n- New\n${AUTO_END}\n\n## What this does\nMy prose`)
    expect(warned).toBe(false)
  })

  it('warns and prepends when markers are missing from an existing file', () => {
    const { body, warned } = mergeAutoBlock('hand written only', '## Stack\n- New', 'STUB')
    expect(warned).toBe(true)
    expect(body).toBe(`${AUTO_START}\n## Stack\n- New\n${AUTO_END}\n\nhand written only`)
  })
})
