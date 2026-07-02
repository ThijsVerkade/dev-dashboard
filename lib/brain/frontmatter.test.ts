import { describe, it, expect } from 'vitest'
import { buildFrontmatter, splitFrontmatter } from './frontmatter'

describe('buildFrontmatter', () => {
  it('serializes strings, numbers, and arrays in order', () => {
    const fm = buildFrontmatter({ type: 'project', 'adr-id': 6, stack: ['nestjs', 'drizzle'] })
    expect(fm).toBe('---\ntype: project\nadr-id: 6\nstack: [nestjs, drizzle]\n---\n')
  })
})

describe('splitFrontmatter', () => {
  it('splits a leading frontmatter block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\ntype: project\n---\nHello\n')
    expect(frontmatter).toBe('type: project')
    expect(body).toBe('Hello\n')
  })
  it('returns null frontmatter when absent', () => {
    const { frontmatter, body } = splitFrontmatter('Just body\n')
    expect(frontmatter).toBeNull()
    expect(body).toBe('Just body\n')
  })
})
