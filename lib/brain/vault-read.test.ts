import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVaultTree, readNote } from './vault-read'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-'))
  writeFileSync(join(dir, 'index.md'), '# Knowledge Brain\n\n- [[standards/index|Standards]]\n')
  mkdirSync(join(dir, 'standards'))
  writeFileSync(join(dir, 'standards', 'index.md'), '# Standards\n\n- [[standards/api|api]]\n')
  writeFileSync(
    join(dir, 'standards', 'api.md'),
    '---\ntype: standard\ntier: api\nlast-synced: 2026-07-02\n---\n\n# API Standard\n\nBody text.\n',
  )
  mkdirSync(join(dir, 'projects'))
  mkdirSync(join(dir, 'projects', 'auction'))
  writeFileSync(join(dir, 'projects', 'auction', 'api.md'), '# auction/api\n\nStuff.\n')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readVaultTree', () => {
  it('builds a nested tree with section index titles', () => {
    const tree = readVaultTree(dir)
    const standards = tree.nodes.find((n) => n.slug === 'standards')
    expect(standards?.title).toBe('Standards')
    expect(standards?.href).toBe('/brain/standards')
    expect(standards?.children.map((c) => c.slug)).toContain('standards/api')
  })

  it('collects all note slugs in notePaths', () => {
    const tree = readVaultTree(dir)
    expect(tree.notePaths).toEqual(
      expect.arrayContaining(['index', 'standards/index', 'standards/api', 'projects/auction/api']),
    )
  })

  it('returns an empty tree for a missing directory', () => {
    const tree = readVaultTree(join(dir, 'does-not-exist'))
    expect(tree.nodes).toEqual([])
    expect(tree.notePaths).toEqual([])
  })
})

describe('readNote', () => {
  it('reads the root index for an empty slug', () => {
    expect(readNote(dir, [])?.title).toBe('Knowledge Brain')
  })

  it('resolves a section slug to its index.md', () => {
    expect(readNote(dir, ['standards'])?.title).toBe('Standards')
  })

  it('parses frontmatter and strips it from the body', () => {
    const note = readNote(dir, ['standards', 'api'])
    expect(note?.frontmatter.tier).toBe('api')
    expect(note?.frontmatter['last-synced']).toBe('2026-07-02')
    expect(note?.body).not.toContain('type: standard')
    expect(note?.body).toContain('Body text.')
  })

  it('returns null for a missing note', () => {
    expect(readNote(dir, ['nope'])).toBeNull()
  })

  it('rejects path traversal', () => {
    expect(readNote(dir, ['..', '..', 'etc', 'passwd'])).toBeNull()
  })
})
